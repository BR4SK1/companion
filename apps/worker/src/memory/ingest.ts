/**
 * Production fact ingestion: the watermark-driven pipeline over completed
 * conversation turns.
 *
 * One attempt selects complete, settled turns strictly after the watermark,
 * extracts facts through the per-turn cache, writes them durably, then
 * advances the watermark to the newest considered turn (extracted or skipped
 * as oversized). A crash replays the same turns with cache hits and
 * idempotent fact inserts. A single turn larger than the batch character cap
 * would poison every future attempt, so it is skipped permanently and the
 * omission is reported instead.
 *
 * The cursor is new-turn-only: on a fresh database (no watermark yet) the
 * first attempt initializes the watermark at the newest existing completed
 * turn and extracts nothing. Memory enabled later never backfills
 * pre-existing history — only turns published after enablement are
 * processed. The initialization is guarded, so a concurrent attempt cannot
 * double-write or race a real watermark advance.
 */

import type { PostgresPool } from "@companion/postgres";

import type { MemoryConfig } from "./config.ts";
import {
  extractTurnItems,
  type ExtractionCacheSummary,
  type ExtractionStats,
  type TurnExtractionConfig,
} from "./extraction.ts";
import { taskPresets } from "./llm.ts";
import {
  normalizeProductionFact,
  updateIngestState,
  upsertProductionFactsAndAdvance,
  getIngestState,
} from "./facts.ts";
import {
  FACT_EXTRACTION_PROMPT_VERSION,
  factGenerationSignature,
  promptContentHash,
  renderFactSource,
} from "./prompts.ts";
import {
  selectTurnsAfterWatermark,
  selectNewestCompletedTurnPosition,
  type WatermarkPosition,
} from "./source.ts";
import type { MemoryFact, SourceTurn } from "./types.ts";

export type MemoryIngestReason = "turn-complete" | "reconciliation" | "manual";

export interface IngestRunSummary {
  readonly selectedTurns: number;
  readonly extractedTurns: number;
  readonly oversizedTurnsSkipped: number;
  readonly factsWritten: number;
  readonly factsInserted: number;
  readonly cacheHits: number;
  readonly emptyHits: number;
  readonly llmCalls: number;
  readonly watermark: { turnId: string; endAt: string } | null;
  readonly reason: MemoryIngestReason;
  /** True when this attempt created the initial new-turn-only cursor. */
  readonly watermarkInitialized?: boolean;
}

export interface IngestDeps {
  readonly pool: PostgresPool;
  readonly config: MemoryConfig;
  readonly subjects: readonly string[];
  readonly systemPrompt: string;
  readonly userLabel: string;
  readonly assistantLabel: string;
  readonly callLlm: TurnExtractionConfig["callLlm"];
}

function toWatermark(
  watermarkTurnId: string | null,
  watermarkEndAt: Date | null,
): WatermarkPosition | null {
  if (watermarkTurnId === null || watermarkEndAt === null) return null;
  return { turnId: watermarkTurnId, endAt: watermarkEndAt };
}

/** Run one production ingest attempt. */
export async function ingestTurns(
  deps: IngestDeps,
  reason: MemoryIngestReason,
  now: Date = new Date(),
): Promise<IngestRunSummary> {
  let state = await getIngestState(deps.pool);

  // New-turn-only initial cursor: the first attempt after enablement marks
  // every existing completed turn as already covered (the cursor starts at
  // the newest existing completed turn, or at "nothing exists yet") and
  // extracts nothing this pass. From then on a null watermark means
  // "everything completed so far is new" — never "backfill history". The
  // guarded write means a concurrent attempt cannot double-initialize.
  if (state === null || state.initializedAt === null) {
    const newest = await selectNewestCompletedTurnPosition(deps.pool);
    const initialized = await initializeIngestCursor(deps.pool, newest);
    if (initialized) {
      return {
        ...emptySummary(reason),
        ...(newest !== null
          ? { watermark: { turnId: newest.turnId, endAt: newest.endAt.toISOString() } }
          : {}),
        watermarkInitialized: true,
      };
    }
    // Another attempt initialized the cursor first; proceed with its state.
    state = await getIngestState(deps.pool);
    if (state === null || state.initializedAt === null) {
      return { ...emptySummary(reason), watermark: null };
    }
  }

  const watermark = toWatermark(state.watermarkTurnId, state.watermarkEndAt);
  return ingestWithWatermark(deps, watermark, reason, now);
}

function emptySummary(reason: MemoryIngestReason): IngestRunSummary {
  return {
    selectedTurns: 0,
    extractedTurns: 0,
    oversizedTurnsSkipped: 0,
    factsWritten: 0,
    factsInserted: 0,
    cacheHits: 0,
    emptyHits: 0,
    llmCalls: 0,
    watermark: null,
    reason,
  };
}

/**
 * Guarded cursor initialization: stamps `initialized_at` (and the newest
 * completed turn's position, when one exists) only when the cursor has never
 * been established, returning false when another attempt moved first.
 */
async function initializeIngestCursor(
  pool: PostgresPool,
  newest: WatermarkPosition | null,
): Promise<boolean> {
  await pool.query(
    `INSERT INTO memory_ingest_state (id) VALUES (true) ON CONFLICT (id) DO NOTHING`,
  );
  const result = await pool.query<{ id: boolean }>(
    `UPDATE memory_ingest_state
     SET initialized_at = now(),
         watermark_turn_id = $1,
         watermark_end_at = $2,
         last_ingest_at = now(),
         updated_at = now()
     WHERE id = true AND initialized_at IS NULL
     RETURNING id`,
    [newest?.turnId ?? null, newest?.endAt ?? null],
  );
  return result.rows.length > 0;
}

async function ingestWithWatermark(
  deps: IngestDeps,
  /** Null after cursor initialization with no prior turns: everything
   *  completed so far is new. Never selects pre-cursor history. */
  watermark: WatermarkPosition | null,
  reason: MemoryIngestReason,
  now: Date,
): Promise<IngestRunSummary> {
  const state = await getIngestState(deps.pool);
  const selected = await selectTurnsAfterWatermark(deps.pool, {
    watermark,
    maxTurns: deps.config.ingestMaxTurns,
    settleMs: deps.config.ingestSettleMs,
    now,
  });

  const generationSignature = factGenerationSignature(FACT_EXTRACTION_PROMPT_VERSION, {
    model: deps.config.model,
    providerBaseUrl: deps.config.openrouterBaseUrl,
    taskMaxTokens: 8000,
    taskTemperature: 0.1,
    batchTurns: deps.config.factBatchTurns,
    batchMaxChars: deps.config.factBatchMaxChars,
    promptContentHash: promptContentHash(deps.systemPrompt),
  });

  const baseSummary: IngestRunSummary = {
    selectedTurns: selected.length,
    extractedTurns: 0,
    oversizedTurnsSkipped: 0,
    factsWritten: 0,
    factsInserted: 0,
    cacheHits: 0,
    emptyHits: 0,
    llmCalls: 0,
    watermark: watermark
      ? { turnId: watermark.turnId, endAt: watermark.endAt.toISOString() }
      : null,
    reason,
  };
  if (selected.length === 0) {
    await updateIngestState(deps.pool, { lastIngestAt: now });
    return baseSummary;
  }

  const extractable: SourceTurn[] = [];
  const oversized: SourceTurn[] = [];
  for (const turn of selected) {
    if (
      renderFactSource([turn], deps.userLabel, deps.assistantLabel).length <=
        deps.config.factBatchMaxChars
    ) {
      extractable.push(turn);
    } else {
      oversized.push(turn);
    }
  }

  let extractedTurns = 0;
  let llmCalls = 0;
  let cacheHits = 0;
  let emptyHits = 0;
  const facts: Array<Omit<MemoryFact, "id">> = [];
  const sourceMessageIdsByTurn = new Map<string, readonly string[]>(
    selected.map((turn) => [turn.turnKey, turn.sourceMessageIds]),
  );

  if (extractable.length > 0) {
    const extractionConfig: TurnExtractionConfig & {
      userLabel: string;
      assistantLabel: string;
    } = {
      generationSignature,
      extractionVersion: FACT_EXTRACTION_PROMPT_VERSION,
      producerId: `ingest`,
      subjects: deps.subjects,
      systemPrompt: deps.systemPrompt,
      model: deps.config.model,
      taskPreset: taskPresets(deps.config).memoryFactExtraction,
      callLlm: deps.callLlm,
      batchTurns: deps.config.factBatchTurns,
      batchMaxChars: deps.config.factBatchMaxChars,
      userLabel: deps.userLabel,
      assistantLabel: deps.assistantLabel,
    };
    const extraction = await extractTurnItems(deps.pool, extractable, extractionConfig);
    llmCalls = extraction.stats.calls;
    cacheHits = extraction.cacheSummary.cacheHits;
    emptyHits = extraction.cacheSummary.emptyHits;
    for (const turn of extractable) {
      for (const item of extraction.itemsByTurn.get(turn.turnKey) ?? []) {
        facts.push(
          normalizeProductionFact(
            {
              subject: item.subject,
              kind: item.kind,
              claim: item.claim,
              topics: item.topics,
              ...(item.condition !== undefined ? { condition: item.condition } : {}),
              ...(item.consequence !== undefined ? { consequence: item.consequence } : {}),
              explicitness: item.explicitness,
              evidenceBasis: item.evidenceBasis,
            },
            turn,
            FACT_EXTRACTION_PROMPT_VERSION,
            generationSignature,
          ),
        );
      }
    }
    extractedTurns = extractable.length;
  }
  if (oversized.length > 0) {
    console.warn(
      `[MEMORY] Ingest skipped ${oversized.length} oversized turn(s): ${oversized.map((turn) => turn.turnKey).join(", ")}`,
    );
  }

  // Deduplicate within the batch, then write durably: facts, their source
  // links, the watermark advance, and the consolidation counter commit in
  // ONE transaction, so a crash cannot leave durable facts without their
  // accounting (a retry would under-count forever via the zero-fact guard).
  const uniqueFacts = [...new Map(facts.map((fact) => [fact.factKey, fact])).values()];

  const lastTurn = selected[selected.length - 1]!;
  const inserted = await upsertProductionFactsAndAdvance(
    deps.pool,
    uniqueFacts,
    sourceMessageIdsByTurn,
    {
      watermark: { turnId: lastTurn.turnId, endAt: lastTurn.endAt },
      lastIngestAt: now,
    },
  );

  return {
    ...baseSummary,
    extractedTurns,
    oversizedTurnsSkipped: oversized.length,
    factsWritten: uniqueFacts.length,
    factsInserted: inserted,
    cacheHits,
    emptyHits,
    llmCalls,
    watermark: { turnId: lastTurn.turnId, endAt: lastTurn.endAt.toISOString() },
  };
}

export type { ExtractionCacheSummary, ExtractionStats };
