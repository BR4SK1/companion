/**
 * Fact extraction with the per-turn artifact cache.
 *
 * This is the shared extraction loop for the ingest pipeline and
 * consolidation runs: batch packing, cache reads and writes, retry on invalid
 * model output, and response splitting behave identically everywhere. The
 * cache is keyed by the source turn's content fingerprint plus the extraction
 * generation signature, so overlapping work and retries are free.
 */

import { withTransaction, type PostgresPool } from "@companion/postgres";

import type { MemoryLlmCaller, TaskPreset } from "./llm.ts";
import { hashPayload } from "./hashing.ts";
import {
  buildFactExtractionPrompt,
  buildFactExtractionResponseFormat,
  parseFactExtractionOutput,
  renderFactSource,
} from "./prompts.ts";
import { sourceFingerprint } from "./source.ts";
import type { FactExtractionItem, SourceTurn } from "./types.ts";

export const FACT_TURN_CACHE_KEY_VERSION = 1;
const FACT_EXTRACTION_MAX_ATTEMPTS = 3;

export const FACT_EXTRACTION_PROMPT_VERSION = "memory-facts-prompt-v7";

export interface ExtractionStats {
  calls: number;
  inputTokens: number;
  outputTokens: number;
}

export interface ExtractionCacheSummary {
  readonly policy: "read-write";
  readonly keyVersion: number;
  readonly selectedTurns: number;
  cacheHits: number;
  emptyHits: number;
  misses: number;
  bypassed: number;
  invalidReads: number;
  writes: number;
  raceLosses: number;
  conflicts: number;
  cachedItems: number;
  generatedItems: number;
  baselineCalls: number;
  actualCalls: number;
  unknownSourceRefs: number;
  duplicateSourceRefs: number;
  missingSourceEnvelopes: number;
  malformedResponses: number;
  legacyResponses: number;
}

export function emptyFactTurnCacheSummary(
  selectedTurns: number,
  baselineCalls: number,
): ExtractionCacheSummary {
  return {
    policy: "read-write",
    keyVersion: FACT_TURN_CACHE_KEY_VERSION,
    selectedTurns,
    cacheHits: 0,
    emptyHits: 0,
    misses: 0,
    bypassed: 0,
    invalidReads: 0,
    writes: 0,
    raceLosses: 0,
    conflicts: 0,
    cachedItems: 0,
    generatedItems: 0,
    baselineCalls,
    actualCalls: 0,
    unknownSourceRefs: 0,
    duplicateSourceRefs: 0,
    missingSourceEnvelopes: 0,
    malformedResponses: 0,
    legacyResponses: 0,
  };
}

export function makeFactTurnCacheKey(
  turn: SourceTurn,
  factGenerationSignature: string,
): string {
  // All parts are NUL-free by construction (uuid turn key, hex fingerprints),
  // so a plain colon separator keeps the stored text key Postgres-safe. The
  // fingerprint already binds the turn's content; the key version keeps the
  // namespace evolvable.
  return `${FACT_TURN_CACHE_KEY_VERSION}:${turn.turnKey}:${
    sourceFingerprint([turn])
  }:${factGenerationSignature}`;
}

export interface TurnExtractionConfig {
  readonly generationSignature: string;
  readonly extractionVersion: string;
  readonly producerId: string;
  readonly subjects: readonly string[];
  readonly systemPrompt: string;
  readonly model: string;
  readonly taskPreset: TaskPreset;
  readonly callLlm: MemoryLlmCaller;
  readonly batchTurns: number;
  readonly batchMaxChars: number;
}

export function batchTurns(
  turns: readonly SourceTurn[],
  config: { userLabel: string; assistantLabel: string; batchTurns: number; batchMaxChars: number },
): SourceTurn[][] {
  const batches: SourceTurn[][] = [];
  let current: SourceTurn[] = [];
  let currentChars = 0;
  for (const turn of turns) {
    const turnChars = renderFactSource([turn], config.userLabel, config.assistantLabel).length;
    if (turnChars > config.batchMaxChars) {
      throw new Error(
        `Turn ${turn.turnKey} is ${turnChars} characters; reduce the source or increase the batch character cap`,
      );
    }
    if (
      current.length > 0 &&
      (current.length >= config.batchTurns || currentChars + turnChars > config.batchMaxChars)
    ) {
      batches.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(turn);
    currentChars += turnChars;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

export type FactExtractionAttributionErrorReason =
  | "unknown_source"
  | "missing_source"
  | "duplicate_source";

export class FactExtractionAttributionError extends Error {
  readonly reason: FactExtractionAttributionErrorReason;

  constructor(reason: FactExtractionAttributionErrorReason, message: string) {
    super(message);
    this.name = "FactExtractionAttributionError";
    this.reason = reason;
  }
}

export function isRetryableFactExtractionError(error: unknown): boolean {
  if (error instanceof FactExtractionAttributionError) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /response was truncated|response was not valid JSON|response was not an object|field .* was invalid|facts must be an array|topics must|source envelope/i
    .test(message);
}

export function isSplittableFactExtractionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /more than twelve facts|response was truncated|source envelope|response was not valid JSON|topics must|field .* was invalid/i
    .test(message);
}

export function assertCompleteResponse(
  finishReason: string | null | undefined,
  description: string,
): void {
  if (finishReason === "length") {
    throw new Error(
      `${description} response was truncated; reduce the source or increase the output budget`,
    );
  }
}

export function partitionFactExtractionOutput(
  output: ReturnType<typeof parseFactExtractionOutput>,
  turns: readonly SourceTurn[],
): { itemsByTurn: Map<string, FactExtractionItem[]>; completeEnvelope: boolean } {
  const itemsByTurn = new Map<string, FactExtractionItem[]>(
    turns.map((turn) => [turn.turnKey, [] as FactExtractionItem[]]),
  );
  const turnsByKey = new Map(turns.map((turn) => [turn.turnKey, turn]));
  if (!output.sources) {
    for (const item of output.facts) {
      if (!turnsByKey.has(item.sourceTurnId)) {
        throw new FactExtractionAttributionError(
          "unknown_source",
          `Fact referenced an unknown source turn: ${item.sourceTurnId}`,
        );
      }
      itemsByTurn.get(item.sourceTurnId)!.push(item);
    }
    return { itemsByTurn, completeEnvelope: false };
  }

  const seenSourceIds = new Set<string>();
  for (const source of output.sources) {
    if (!turnsByKey.has(source.sourceTurnId)) {
      throw new FactExtractionAttributionError(
        "unknown_source",
        `Fact envelope referenced an unknown source turn: ${source.sourceTurnId}`,
      );
    }
    if (seenSourceIds.has(source.sourceTurnId)) {
      throw new FactExtractionAttributionError(
        "duplicate_source",
        `Fact envelope duplicated source turn: ${source.sourceTurnId}`,
      );
    }
    seenSourceIds.add(source.sourceTurnId);
    itemsByTurn.set(
      source.sourceTurnId,
      source.facts.map((item) => ({ sourceTurnId: source.sourceTurnId, ...item })),
    );
  }
  if (seenSourceIds.size !== turns.length) {
    throw new FactExtractionAttributionError(
      "missing_source",
      "Fact extraction did not return one envelope for every source turn",
    );
  }
  return { itemsByTurn, completeEnvelope: true };
}

interface CachedArtifactRow {
  cache_key: string;
  source_fingerprint: string;
  generation_signature: string;
  extraction_version: string;
  item_count: number;
  empty: boolean;
  payload_hash: string;
  items: Array<{
    subject: string;
    kind: string;
    claim: string;
    condition: string | null;
    consequence: string | null;
    topics: string[];
    explicitness: string;
    evidence_basis: string;
  }>;
}

/** Validate a cached artifact against the turn and the current configuration. */
function validCachedArtifact(
  artifact: CachedArtifactRow,
  config: TurnExtractionConfig,
  turn: SourceTurn,
): boolean {
  if (
    artifact.cache_key !== makeFactTurnCacheKey(turn, config.generationSignature) ||
    artifact.source_fingerprint !== sourceFingerprint([turn]) ||
    artifact.generation_signature !== config.generationSignature ||
    artifact.extraction_version !== config.extractionVersion ||
    artifact.item_count !== artifact.items.length ||
    artifact.empty !== (artifact.items.length === 0) ||
    artifact.payload_hash !==
      hashPayload(artifact.items.map((item) => ({
        sourceTurnId: turn.turnKey,
        subject: item.subject,
        kind: item.kind,
        claim: item.claim,
        topics: item.topics,
        ...(item.condition ? { condition: item.condition } : {}),
        ...(item.consequence ? { consequence: item.consequence } : {}),
        explicitness: item.explicitness,
        evidenceBasis: item.evidence_basis,
      })))
  ) return false;
  try {
    const parsed = parseFactExtractionOutput(
      JSON.stringify({
        sources: [{
          sourceTurnId: turn.turnKey,
          facts: artifact.items.map((item) => ({
            subject: item.subject,
            kind: item.kind,
            claim: item.claim,
            topics: item.topics,
            condition: item.condition ?? "",
            consequence: item.consequence ?? "",
            explicitness: item.explicitness,
            evidenceBasis: item.evidence_basis,
          })),
        }],
      }),
      config.subjects,
    );
    return parsed.facts.every((item) => item.sourceTurnId === turn.turnKey);
  } catch {
    return false;
  }
}

async function readCachedArtifacts(
  pool: PostgresPool,
  cacheKeys: readonly string[],
): Promise<Map<string, CachedArtifactRow>> {
  if (cacheKeys.length === 0) return new Map();
  const result = await pool.query<CachedArtifactRow>(
    `SELECT e.cache_key, e.source_fingerprint, e.generation_signature, e.extraction_version,
            e.item_count, e.empty, e.payload_hash,
            coalesce((
              SELECT json_agg(json_build_object(
                'subject', i.subject_id, 'kind', i.kind, 'claim', i.claim,
                'condition', i.condition, 'consequence', i.consequence,
                'topics', i.topics, 'explicitness', i.explicitness,
                'evidence_basis', i.evidence_basis) ORDER BY i.position)
              FROM memory_turn_extraction_item i
              WHERE i.extraction_id = e.id
            ), '[]'::json) AS items
     FROM memory_turn_extraction e
     WHERE e.cache_key = ANY($1::text[])`,
    [cacheKeys],
  );
  return new Map(result.rows.map((row) => [row.cache_key, row]));
}

async function writeCachedArtifacts(
  pool: PostgresPool,
  artifacts: ReadonlyArray<{
    turn: SourceTurn;
    items: readonly FactExtractionItem[];
    config: TurnExtractionConfig;
  }>,
): Promise<{ writes: number; raceLosses: number; conflicts: number }> {
  if (artifacts.length === 0) return { writes: 0, raceLosses: 0, conflicts: 0 };
  let writes = 0;
  let raceLosses = 0;
  let conflicts = 0;
  for (const artifact of artifacts) {
    const normalizedItems = artifact.items.map((item) => ({
      sourceTurnId: artifact.turn.turnKey,
      subject: item.subject,
      kind: item.kind,
      claim: item.claim,
      topics: [...item.topics],
      ...(item.condition !== undefined ? { condition: item.condition } : {}),
      ...(item.consequence !== undefined ? { consequence: item.consequence } : {}),
      explicitness: item.explicitness,
      evidenceBasis: item.evidenceBasis,
    }));
    const cacheKey = makeFactTurnCacheKey(artifact.turn, artifact.config.generationSignature);
    const sourceFp = sourceFingerprint([artifact.turn]);
    const payloadHash = hashPayload(normalizedItems);
    // One transaction per cache entry: the entry row and its item rows commit
    // together, so a crash can never leave a cache entry claiming items it
    // does not have (a replay would then cache-hit with missing facts).
    const outcome = await withTransaction(pool, async (client) => {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO memory_turn_extraction
           (turn_id, key_version, cache_key, source_fingerprint, generation_signature,
            extraction_version, item_count, empty, payload_hash, producer)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (cache_key) DO NOTHING
         RETURNING id`,
        [
          artifact.turn.turnId,
          FACT_TURN_CACHE_KEY_VERSION,
          cacheKey,
          sourceFp,
          artifact.config.generationSignature,
          artifact.config.extractionVersion,
          normalizedItems.length,
          normalizedItems.length === 0,
          payloadHash,
          artifact.config.producerId,
        ],
      );
      const row = inserted.rows[0];
      if (row === undefined) return "lost-race" as const;
      if (normalizedItems.length > 0) {
        await client.query(
          `INSERT INTO memory_turn_extraction_item
             (extraction_id, position, subject_id, kind, claim, condition, consequence,
              topics, explicitness, evidence_basis)
           SELECT $1, i.ord - 1, i.subject, i.kind, i.claim, i.condition, i.consequence,
                  i.topics, i.explicitness, i.evidence_basis
           FROM jsonb_to_recordset($2::jsonb)
             AS i(ord int, subject text, kind text, claim text, condition text,
                  consequence text, topics text[], explicitness text, evidence_basis text)`,
          [
            row.id,
            JSON.stringify(normalizedItems.map((item, index) => ({
              ord: index + 1,
              subject: item.subject,
              kind: item.kind,
              claim: item.claim,
              condition: item.condition ?? null,
              consequence: item.consequence ?? null,
              topics: item.topics,
              explicitness: item.explicitness,
              evidence_basis: item.evidenceBasis,
            }))),
          ],
        );
      }
      return "written" as const;
    });
    if (outcome === "written") {
      writes += 1;
    } else {
      raceLosses += 1;
      const existing = await pool.query<{ payload_hash: string }>(
        `SELECT payload_hash FROM memory_turn_extraction WHERE cache_key = $1`,
        [cacheKey],
      );
      const storedHash = existing.rows[0]?.payload_hash;
      if (storedHash !== undefined && storedHash !== payloadHash) conflicts += 1;
    }
  }
  return { writes, raceLosses, conflicts };
}

export interface TurnExtractionResult {
  readonly itemsByTurn: Map<string, FactExtractionItem[]>;
  readonly stats: ExtractionStats;
  readonly cacheSummary: ExtractionCacheSummary;
}

/**
 * Extract fact items for the given complete turns using the per-turn cache.
 * Batches are packed to the configured caps; repeated invalid model output
 * splits a batch in half; source-envelope attribution is enforced.
 */
export async function extractTurnItems(
  pool: PostgresPool,
  turns: readonly SourceTurn[],
  config: TurnExtractionConfig & { userLabel: string; assistantLabel: string },
): Promise<TurnExtractionResult> {
  const stats: ExtractionStats = { calls: 0, inputTokens: 0, outputTokens: 0 };
  const allBatches = batchTurns(turns, config);
  const cacheSummary = emptyFactTurnCacheSummary(turns.length, allBatches.length);
  const itemsByTurn = new Map<string, FactExtractionItem[]>();
  const missingTurns: SourceTurn[] = [];
  const generatedArtifacts: Array<{
    turn: SourceTurn;
    items: FactExtractionItem[];
    config: TurnExtractionConfig & { userLabel: string; assistantLabel: string };
  }> = [];

  const cacheKeysByTurn = new Map<string, string>();
  for (const turn of turns) {
    cacheKeysByTurn.set(turn.turnKey, makeFactTurnCacheKey(turn, config.generationSignature));
  }

  const cachedArtifacts = await readCachedArtifacts(pool, [...cacheKeysByTurn.values()]);
  for (const turn of turns) {
    const artifact = cachedArtifacts.get(cacheKeysByTurn.get(turn.turnKey)!);
    if (!artifact || !validCachedArtifact(artifact, config, turn)) {
      if (artifact !== undefined) cacheSummary.invalidReads += 1;
      missingTurns.push(turn);
      continue;
    }
    const items: FactExtractionItem[] = artifact.items.map((item) => ({
      sourceTurnId: turn.turnKey,
      subject: item.subject,
      kind: item.kind as FactExtractionItem["kind"],
      claim: item.claim,
      topics: item.topics,
      ...(item.condition !== null ? { condition: item.condition } : {}),
      ...(item.consequence !== null ? { consequence: item.consequence } : {}),
      explicitness: item.explicitness as FactExtractionItem["explicitness"],
      evidenceBasis: item.evidence_basis as FactExtractionItem["evidenceBasis"],
    }));
    itemsByTurn.set(turn.turnKey, items);
    if (artifact.empty) cacheSummary.emptyHits += 1;
    else cacheSummary.cacheHits += 1;
    cacheSummary.cachedItems += artifact.item_count;
  }

  cacheSummary.misses = missingTurns.length;
  const pendingBatches = batchTurns(missingTurns, config);
  let processedBatchCount = 0;
  while (pendingBatches.length > 0) {
    const batch = pendingBatches.shift()!;
    const batchNumber = processedBatchCount + 1;
    const prompt = buildFactExtractionPrompt(
      config.systemPrompt,
      renderFactSource(batch, config.userLabel, config.assistantLabel),
    );
    let partitioned: ReturnType<typeof partitionFactExtractionOutput> | undefined;
    let splitBatch = false;
    for (let attempt = 1; attempt <= FACT_EXTRACTION_MAX_ATTEMPTS; attempt += 1) {
      try {
        const result = await config.callLlm({
          systemPrompt: prompt.systemPrompt,
          userMessage: prompt.messages[0]!.content,
          taskPreset: config.taskPreset,
          responseFormat:
            buildFactExtractionResponseFormat(config.subjects) as Record<string, unknown>,
        });
        stats.calls += 1;
        stats.inputTokens += result.inputTokens;
        stats.outputTokens += result.outputTokens;
        assertCompleteResponse(
          result.finishReason,
          `Memory fact extraction batch ${batchNumber}`,
        );
        let output: ReturnType<typeof parseFactExtractionOutput>;
        try {
          output = parseFactExtractionOutput(result.text, config.subjects);
        } catch (error) {
          cacheSummary.malformedResponses += 1;
          throw error;
        }
        try {
          if (!output.sources) {
            cacheSummary.legacyResponses += 1;
            cacheSummary.missingSourceEnvelopes += 1;
            throw new FactExtractionAttributionError(
              "missing_source",
              "Fact extraction must return source envelopes for the current prompt version",
            );
          }
          partitioned = partitionFactExtractionOutput(output, batch);
        } catch (error) {
          if (error instanceof FactExtractionAttributionError) {
            if (error.reason === "unknown_source") cacheSummary.unknownSourceRefs += 1;
            if (error.reason === "duplicate_source") cacheSummary.duplicateSourceRefs += 1;
            if (error.reason === "missing_source") cacheSummary.missingSourceEnvelopes += 1;
          } else {
            cacheSummary.malformedResponses += 1;
          }
          throw error;
        }
        break;
      } catch (error) {
        if (attempt === FACT_EXTRACTION_MAX_ATTEMPTS || !isRetryableFactExtractionError(error)) {
          if (batch.length > 1 && isSplittableFactExtractionError(error)) {
            const midpoint = Math.ceil(batch.length / 2);
            pendingBatches.unshift(batch.slice(midpoint), batch.slice(0, midpoint));
            splitBatch = true;
            break;
          }
          throw error;
        }
      }
    }
    if (splitBatch) continue;
    if (!partitioned) {
      throw new Error(
        `Fact extraction batch ${batchNumber} did not produce a usable response`,
      );
    }
    if (!partitioned.completeEnvelope) cacheSummary.missingSourceEnvelopes += 1;
    for (const turn of batch) {
      const items = partitioned.itemsByTurn.get(turn.turnKey) ?? [];
      itemsByTurn.set(turn.turnKey, items);
      cacheSummary.generatedItems += items.length;
      generatedArtifacts.push({ turn, items, config });
    }
    processedBatchCount += 1;
  }

  const writeResult = await writeCachedArtifacts(pool, generatedArtifacts);
  cacheSummary.writes = writeResult.writes;
  cacheSummary.raceLosses = writeResult.raceLosses;
  cacheSummary.conflicts = writeResult.conflicts;
  cacheSummary.actualCalls = stats.calls;

  return { itemsByTurn, stats, cacheSummary };
}
