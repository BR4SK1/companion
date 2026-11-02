/**
 * Production facts and ingest state.
 *
 * Facts are durable, source-linked memory evidence: each fact carries the
 * turn it came from and the exact source messages, so every downstream
 * observation keeps a verifiable evidence chain. Facts are immutable once
 * written (`$setOnInsert` semantics via ON CONFLICT DO NOTHING); the
 * watermark only advances after facts are durably written.
 */

import {
  withTransaction,
  type PostgresPool,
  type PostgresPoolClient,
} from "@companion/postgres";

import type { MemoryFact, SourceTurn } from "./types.ts";
import { factKeyOf } from "./prompts.ts";

/** Anything that can run SQL: the pool itself or a transaction client. */
type SqlExecutor = PostgresPool | PostgresPoolClient;

interface FactRow {
  id: string;
  fact_key: string;
  turn_id: string;
  subject_id: string;
  kind: string;
  claim: string;
  condition: string | null;
  consequence: string | null;
  topics: string[];
  observed_at: Date;
  explicitness: string;
  evidence_basis: string;
  extraction_version: string;
  ingest_version: string;
}

export interface IngestState {
  readonly initializedAt: Date | null;
  readonly watermarkTurnId: string | null;
  readonly watermarkEndAt: Date | null;
  readonly lastIngestAt: Date | null;
  readonly newFactsSinceConsolidation: number;
  readonly lastConsolidatedAt: Date | null;
}

export async function getIngestState(pool: PostgresPool): Promise<IngestState | null> {
  const result = await pool.query<{
    initialized_at: Date | null;
    watermark_turn_id: string | null;
    watermark_end_at: Date | null;
    last_ingest_at: Date | null;
    new_facts_since_consolidation: number;
    last_consolidated_at: Date | null;
  }>(
    `SELECT initialized_at, watermark_turn_id, watermark_end_at, last_ingest_at,
            new_facts_since_consolidation, last_consolidated_at
     FROM memory_ingest_state WHERE id = true`,
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  return {
    initializedAt: row.initialized_at,
    watermarkTurnId: row.watermark_turn_id,
    watermarkEndAt: row.watermark_end_at,
    lastIngestAt: row.last_ingest_at,
    newFactsSinceConsolidation: row.new_facts_since_consolidation,
    lastConsolidatedAt: row.last_consolidated_at,
  };
}

/**
 * Patch ingest-state fields. `createdAt` is set only on insert; `updatedAt` is
 * always stamped. Callers must only supply forward watermark motion.
 */
export interface IngestStateUpdate {
  /** Advance the watermark; guarded monotonic, never moves backward. */
  readonly watermark?: { readonly turnId: string; readonly endAt: Date };
  /** Atomically add newly inserted facts to the consolidation counter. */
  readonly addFacts?: number;
  /**
   * Atomically subtract the facts a consolidation run accounted for
   * (relative, so a concurrent ingest's increments are never lost).
   */
  readonly consumeFacts?: number;
  readonly lastIngestAt?: Date;
  readonly lastConsolidatedAt?: Date;
}

/**
 * Update ingest state with single-statement atomic semantics: the watermark
 * only moves forward, and consolidation counters are relative increments, so
 * concurrent ingest passes (multiple workers, CLI runs) can never lose fact
 * counts or regress the cursor.
 */
export async function updateIngestState(
  pool: PostgresPool,
  fields: IngestStateUpdate,
): Promise<void> {
  return applyIngestStateUpdate(pool, fields);
}

/**
 * Apply an ingest-state patch on any executor (pool or open transaction).
 * Same single-statement atomic semantics as `updateIngestState`; the
 * executor parameter lets the fact write and the accounting update share
 * one transaction.
 */
export async function applyIngestStateUpdate(
  executor: SqlExecutor,
  fields: IngestStateUpdate,
): Promise<void> {
  await executor.query(
    `INSERT INTO memory_ingest_state (id) VALUES (true) ON CONFLICT (id) DO NOTHING`,
  );
  const values: unknown[] = [];
  let index = 1;
  const watermarkEnd = fields.watermark !== undefined ? index : undefined;
  if (fields.watermark !== undefined) {
    values.push(fields.watermark.endAt, fields.watermark.turnId);
    index += 2;
  }
  const addFactsParam = fields.addFacts !== undefined ? index++ : undefined;
  if (addFactsParam !== undefined) values.push(fields.addFacts);
  const consumeFactsParam = fields.consumeFacts !== undefined ? index++ : undefined;
  if (consumeFactsParam !== undefined) values.push(fields.consumeFacts);
  const lastIngestParam = fields.lastIngestAt !== undefined ? index++ : undefined;
  if (lastIngestParam !== undefined) values.push(fields.lastIngestAt);
  const lastConsolidatedParam = fields.lastConsolidatedAt !== undefined ? index++ : undefined;
  if (lastConsolidatedParam !== undefined) values.push(fields.lastConsolidatedAt);

  const assignments: string[] = [];
  if (watermarkEnd !== undefined) {
    // Monotonic guard: an older pass's watermark never overwrites a newer
    // one (tuple comparison on end_at, then turn id as the tiebreaker).
    assignments.push(
      `watermark_end_at = GREATEST(COALESCE(memory_ingest_state.watermark_end_at, '-infinity'::timestamptz), $${watermarkEnd}::timestamptz)`,
      `watermark_turn_id = CASE
         WHEN memory_ingest_state.watermark_end_at IS NULL
           OR memory_ingest_state.watermark_end_at < $${watermarkEnd}::timestamptz
         THEN $${watermarkEnd + 1}::uuid
         WHEN memory_ingest_state.watermark_end_at = $${watermarkEnd}::timestamptz
              AND memory_ingest_state.watermark_turn_id < $${watermarkEnd + 1}::uuid
         THEN $${watermarkEnd + 1}::uuid
         ELSE memory_ingest_state.watermark_turn_id END`,
    );
  }
  if (addFactsParam !== undefined) {
    assignments.push(
      `new_facts_since_consolidation = memory_ingest_state.new_facts_since_consolidation + $${addFactsParam}`,
    );
  }
  if (consumeFactsParam !== undefined) {
    assignments.push(
      `new_facts_since_consolidation = GREATEST(0, memory_ingest_state.new_facts_since_consolidation - $${consumeFactsParam})`,
    );
  }
  if (lastIngestParam !== undefined) {
    assignments.push(`last_ingest_at = $${lastIngestParam}`);
  }
  if (lastConsolidatedParam !== undefined) {
    assignments.push(`last_consolidated_at = $${lastConsolidatedParam}`);
  }
  if (assignments.length === 0) return;
  assignments.push("updated_at = now()");
  await executor.query(
    `UPDATE memory_ingest_state SET ${assignments.join(", ")} WHERE id = true`,
    values,
  );
}

export function normalizeProductionFact(
  item: {
    subject: string;
    kind: MemoryFact["kind"];
    claim: string;
    topics: readonly string[];
    condition?: string;
    consequence?: string;
    explicitness: MemoryFact["explicitness"];
    evidenceBasis: MemoryFact["evidenceBasis"];
  },
  sourceTurn: SourceTurn,
  extractionVersion: string,
  ingestVersion: string,
): Omit<MemoryFact, "id"> {
  const claim = item.claim.replace(/\s+/g, " ").trim().slice(0, 1_000);
  if (!claim) throw new Error("Fact claim was empty after normalization");
  const condition = item.condition !== undefined
    ? (item.condition.replace(/\s+/g, " ").trim().slice(0, 500) || undefined)
    : undefined;
  const consequence = item.consequence !== undefined
    ? (item.consequence.replace(/\s+/g, " ").trim().slice(0, 500) || undefined)
    : undefined;
  return {
    factKey: factKeyOf({
      turnKey: sourceTurn.turnKey,
      subject: item.subject,
      kind: item.kind,
      claim,
      condition,
      consequence,
      topics: item.topics,
      explicitness: item.explicitness,
    }),
    turnId: sourceTurn.turnId,
    turnKey: sourceTurn.turnKey,
    subject: item.subject,
    kind: item.kind,
    claim,
    topics: [...item.topics],
    condition: condition ?? null,
    consequence: consequence ?? null,
    observedAt: sourceTurn.endAt,
    explicitness: item.explicitness,
    evidenceBasis: item.evidenceBasis,
    extractionVersion,
    ingestVersion,
  };
}

/** Insert facts idempotently; returns how many were newly inserted. */
export async function upsertProductionFacts(
  pool: PostgresPool,
  facts: readonly Omit<MemoryFact, "id">[],
  sourceMessageIdsByTurn: ReadonlyMap<string, readonly string[]>,
): Promise<number> {
  if (facts.length === 0) return 0;
  // One transaction for the whole batch: a fact row and its per-message
  // source links commit together, so a crash can never leave a durable fact
  // without its provenance (and the watermark has not advanced yet, so the
  // replay re-runs the same batch idempotently).
  return withTransaction(pool, (client) =>
    insertProductionFacts(client, facts, sourceMessageIdsByTurn),
  );
}

/**
 * Write the fact batch and advance the ingest accounting in ONE transaction:
 * facts, their source links, the watermark advance, and the
 * `new_facts_since_consolidation` counter all commit together or not at all.
 *
 * This closes the crash window where facts were durable but the accounting
 * was not: a retry after a crash replays the same batch, the idempotent
 * inserts report zero new rows, and the counter would otherwise be
 * permanently under-counted (which could starve consolidation through the
 * zero-fact guard). Because the counter increment is part of the same
 * transaction as the inserts, a replay either sees both (already committed)
 * or neither.
 */
export async function upsertProductionFactsAndAdvance(
  pool: PostgresPool,
  facts: readonly Omit<MemoryFact, "id">[],
  sourceMessageIdsByTurn: ReadonlyMap<string, readonly string[]>,
  advance: {
    readonly watermark: { readonly turnId: string; readonly endAt: Date };
    readonly lastIngestAt: Date;
  },
): Promise<number> {
  return withTransaction(pool, async (client) => {
    const insertedCount = facts.length === 0
      ? 0
      : await insertProductionFacts(client, facts, sourceMessageIdsByTurn);
    await applyIngestStateUpdate(client, {
      watermark: advance.watermark,
      lastIngestAt: advance.lastIngestAt,
      addFacts: insertedCount,
    });
    return insertedCount;
  });
}

async function insertProductionFacts(
  client: PostgresPoolClient,
  facts: readonly Omit<MemoryFact, "id">[],
  sourceMessageIdsByTurn: ReadonlyMap<string, readonly string[]>,
): Promise<number> {
  let insertedCount = 0;
  for (const fact of facts) {
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO memory_fact
         (fact_key, turn_id, subject_id, kind, claim, condition, consequence, topics,
          observed_at, explicitness, evidence_basis, extraction_version, ingest_version)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       ON CONFLICT (fact_key) DO NOTHING
       RETURNING id`,
      [
        fact.factKey,
        fact.turnId,
        fact.subject,
        fact.kind,
        fact.claim,
        fact.condition ?? null,
        fact.consequence ?? null,
        fact.topics,
        fact.observedAt,
        fact.explicitness,
        fact.evidenceBasis,
        fact.extractionVersion,
        fact.ingestVersion,
      ],
    );
    const row = inserted.rows[0];
    if (row === undefined) continue;
    insertedCount += 1;
    const sourceMessageIds = sourceMessageIdsByTurn.get(fact.turnKey) ?? [];
    if (sourceMessageIds.length > 0) {
      await client.query(
        `INSERT INTO memory_fact_source_message (fact_id, position, message_id)
         SELECT $1, i.ord - 1, i.message_id
         FROM unnest($2::uuid[]) WITH ORDINALITY AS i(message_id, ord)`,
        [row.id, sourceMessageIds],
      );
    }
  }
  return insertedCount;
}

function mapFact(row: FactRow): MemoryFact {
  return {
    id: row.id,
    factKey: row.fact_key,
    turnId: row.turn_id,
    turnKey: row.turn_id,
    subject: row.subject_id,
    kind: row.kind as MemoryFact["kind"],
    claim: row.claim,
    condition: row.condition,
    consequence: row.consequence,
    topics: row.topics,
    observedAt: row.observed_at,
    explicitness: row.explicitness as MemoryFact["explicitness"],
    evidenceBasis: row.evidence_basis as MemoryFact["evidenceBasis"],
    extractionVersion: row.extraction_version,
    ingestVersion: row.ingest_version,
  };
}

const FACT_COLUMNS = `id, fact_key, turn_id, subject_id, kind, claim, condition,
  consequence, topics, observed_at, explicitness, evidence_basis,
  extraction_version, ingest_version`;

export async function getFactsByKeys(
  pool: PostgresPool,
  factKeys: readonly string[],
): Promise<MemoryFact[]> {
  if (factKeys.length === 0) return [];
  const result = await pool.query<FactRow>(
    `SELECT ${FACT_COLUMNS} FROM memory_fact WHERE fact_key = ANY($1::text[])`,
    [factKeys],
  );
  return result.rows.map(mapFact);
}

export async function getFactsByTurns(
  pool: PostgresPool,
  turnIds: readonly string[],
): Promise<MemoryFact[]> {
  if (turnIds.length === 0) return [];
  const result = await pool.query<FactRow>(
    `SELECT ${FACT_COLUMNS} FROM memory_fact
     WHERE turn_id = ANY($1::uuid[])
     ORDER BY observed_at, fact_key`,
    [turnIds],
  );
  return result.rows.map(mapFact);
}

export async function getFactsByTurn(
  pool: PostgresPool,
  turnId: string,
): Promise<MemoryFact[]> {
  return getFactsByTurns(pool, [turnId]);
}
