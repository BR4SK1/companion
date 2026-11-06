/**
 * Memory runtime: the in-process scheduler that keeps the memory pipeline
 * moving on one owner's data.
 *
 * Responsibilities (all serial per concern, all reconciling, all traced
 * metadata-only in `memory_operation`):
 *
 * - Ingest: a completed turn triggers a settled, debounced ingest attempt;
 *   a reconciliation sweep covers turns published while the worker was down.
 *   The queue is an in-process serial chain — durable ordering lives in the
 *   watermark and extraction cache, not in queue state.
 * - Consolidation: after each ingest attempt, the threshold/interval check
 *   decides whether a bounded consolidation run happens; with auto-promotion
 *   enabled the run's promotion plan is built and applied with its own
 *   confirmation token (exact-plan atomicity; idempotent by promotion id).
 * - Temporal: a sweep regenerates every closed near-term period (day/week/
 *   month aggregates cascade through their children); fingerprint-gated, so
 *   an unchanged set costs no LLM calls.
 * - Profiles v1: separately configured (`WORKER_MEMORY_PROFILE_SUMMARIES_ENABLED`,
 *   default off — the chat prompt consumes recent temporal summaries and v2
 *   profiles only); when enabled, v1 sheets refresh in the same sweep.
 * - Profiles v2: startup + daily generation at the configured local hour,
 *   behind the observation-set
 *   fingerprint gate (`profile-runtime.ts`).
 *
 * Every failure is logged and traced, never thrown into the engine loop:
 * memory work must never break a chat turn or the worker process.
 */

import type { PostgresPool } from "@companion/postgres";

import type { MemoryConfig } from "./config.ts";
import type { MemoryConfiguration } from "./subjects.ts";
import type { MemoryLlmCaller } from "./llm.ts";
import { ingestTurns } from "./ingest.ts";
import {
  runScheduledConsolidation,
  type ConsolidationRunResult,
} from "./consolidation.ts";
import {
  buildPromotionPlan,
  promoteRun,
  resumePromotionForRun,
  selectPendingPromotionRunIds,
  PROMOTION_RECONCILE_BACKOFF_MS,
} from "./promotion.ts";
import {
  promptContentHash,
  FACT_EXTRACTION_PROMPT_VERSION,
  OBSERVATION_CONSOLIDATION_PROMPT_VERSION,
  TEMPORAL_SUMMARY_PROMPT_VERSION,
} from "./prompts.ts";
import { generateProfileSummary } from "./profiles-v1.ts";
import { generateProfileIfNeeded } from "./profiles-v2.ts";
import { startProfileRuntime } from "./profile-runtime.ts";
import {
  generateTemporalSummary,
  type TemporalGeneratorDeps,
} from "./temporal/generator.ts";
import { getClosedTemporalSummaryPeriods } from "./temporal/periods.ts";
import { getIngestState } from "./facts.ts";
import { memoryErrorCategory } from "./errors.ts";

export type MemoryOperationKind =
  | "fact_extraction"
  | "observation_consolidation"
  | "promotion"
  | "retraction"
  | "temporal_summary"
  | "profile_summary"
  | "observation_profile"
  | "recall"
  | "article_ingestion"
  | "article_memory_share";

export interface MemoryOperationInput {
  readonly kind: MemoryOperationKind;
  readonly turnId?: string;
  readonly runId?: string;
  readonly promotionId?: string;
  readonly outcome: "ok" | "failed";
  /** Metadata only: counts, ids, and reason codes — never content. */
  readonly detail?: string;
  readonly model?: string;
  readonly promptVersion?: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly llmCalls?: number;
  readonly startedAt: Date;
  readonly finishedAt?: Date;
}

/** Record one memory operation trace. Metadata-only by schema contract. */
export async function recordMemoryOperation(
  pool: PostgresPool,
  input: MemoryOperationInput,
): Promise<void> {
  await pool.query(
    `INSERT INTO memory_operation
       (kind, turn_id, run_id, promotion_id, outcome, detail, model,
        prompt_version, input_tokens, output_tokens, llm_calls, started_at,
        finished_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [
      input.kind,
      input.turnId ?? null,
      input.runId ?? null,
      input.promotionId ?? null,
      input.outcome,
      input.detail ?? null,
      input.model ?? null,
      input.promptVersion ?? null,
      input.inputTokens ?? null,
      input.outputTokens ?? null,
      input.llmCalls ?? null,
      input.startedAt,
      input.finishedAt ?? null,
    ],
  );
}

export interface MemoryRuntimeDeps {
  readonly pool: PostgresPool;
  readonly config: MemoryConfig;
  readonly configuration: MemoryConfiguration;
  readonly callLlm: MemoryLlmCaller;
  readonly log?: (message: string) => void;
}

export interface MemoryRuntime {
  /** Notify the runtime that a turn was published (fire-and-forget). */
  onTurnPublished(turnId: string): void;
  close(): Promise<void>;
}

class SerialQueue {
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;

  enqueue(task: () => Promise<void>): void {
    this.pending += 1;
    this.tail = this.tail
      .then(task)
      .catch(() => undefined)
      .finally(() => {
        this.pending -= 1;
      });
  }

  get busy(): boolean {
    return this.pending > 0;
  }

  async drain(): Promise<void> {
    await this.tail;
  }
}

export function startMemoryRuntime(deps: MemoryRuntimeDeps): MemoryRuntime {
  const { pool, config, configuration } = deps;
  const log = deps.log ?? ((message: string) => console.log(message));
  const queue = new SerialQueue();

  const subjectIds = configuration.subjects.map((subject) => subject.id);
  const profileSubjects = configuration.subjects.filter(
    (subject) => subject.profileEnabled,
  );
  const behavior = configuration.behavior;

  const callLlm = deps.callLlm;

  const ingestDeps = {
    pool,
    config,
    subjects: subjectIds,
    systemPrompt: configuration.prompts["fact_extraction"]!.systemPrompt,
    userLabel: configuration.userSubject.sourceLabel,
    assistantLabel: configuration.assistantSubject.sourceLabel,
    callLlm,
  };

  const temporalDeps: TemporalGeneratorDeps = {
    pool,
    config,
    behavior,
    systemPrompt: configuration.prompts["temporal_summary"]!.systemPrompt,
    userLabel: configuration.userSubject.sourceLabel,
    assistantLabel: configuration.assistantSubject.sourceLabel,
    callLlm,
  };

  async function runIngest(reason: "turn-complete" | "reconciliation"): Promise<void> {
    // Gate: ingest (and everything downstream of it — consolidation and
    // auto-promotion) only ever runs when ingest is enabled. The flag is
    // checked here, at every enqueue site, and at the timer setup, so a
    // disabled pipeline never schedules, never executes, and never makes a
    // provider call.
    if (!config.ingestEnabled) return;
    const startedAt = new Date();
    try {
      const summary = await ingestTurns(ingestDeps, reason);
      log(
        `[MEMORY] ingest (${reason}): turns=${String(summary.extractedTurns)}/${String(summary.selectedTurns)} facts=${String(summary.factsInserted)} cacheHits=${String(summary.cacheHits)} llmCalls=${String(summary.llmCalls)}`,
      );
      await recordMemoryOperation(pool, {
        kind: "fact_extraction",
        outcome: "ok",
        detail:
          `reason=${reason} selected=${String(summary.selectedTurns)}` +
          ` extracted=${String(summary.extractedTurns)} skipped=${String(summary.oversizedTurnsSkipped)}` +
          ` facts=${String(summary.factsInserted)} cacheHits=${String(summary.cacheHits)}` +
          ` emptyHits=${String(summary.emptyHits)}` +
          (summary.watermarkInitialized ? " initializedWatermark=true" : ""),
        model: config.model,
        promptVersion: FACT_EXTRACTION_PROMPT_VERSION,
        llmCalls: summary.llmCalls,
        startedAt,
        finishedAt: new Date(),
      });
      if (summary.watermarkInitialized) {
        log(
          "[MEMORY] ingest initialized the watermark at the newest existing completed turn; pre-existing history is not processed (new turns only)",
        );
      }
      await maybeConsolidate(startedAt);
    } catch (error) {
      const category = memoryErrorCategory(error);
      log(`[MEMORY] ingest (${reason}) failed: ${category}`);
      await recordMemoryOperation(pool, {
        kind: "fact_extraction",
        outcome: "failed",
        detail: `reason=${reason} error=${category}`,
        model: config.model,
        promptVersion: FACT_EXTRACTION_PROMPT_VERSION,
        startedAt,
        finishedAt: new Date(),
      }).catch(() => undefined);
    }
    // Manifest recovery is INDEPENDENT of extraction: it runs after every
    // ingest pass — on success and on failure alike — because it is SQL-only
    // (promotion planning and applying never call the LLM) and must never be
    // held hostage by an extraction failure. A crash between artifact write
    // and promotion completion is recovered on the next pass even while new
    // extraction keeps failing.
    if (config.autopromoteEnabled) {
      try {
        await reconcilePendingPromotions();
      } catch (error) {
        log(
          `[MEMORY] promotion reconciliation failed: ${memoryErrorCategory(error)}`,
        );
      }
    }
  }

  /**
   * Crash recovery for automatic transitions: a consolidation run whose
   * artifacts are durable but whose promotion did not complete (process died
   * between the two) is retried here. Called at the end of every ingest pass
   — independent of extraction success — and bounded, autopromote-only, and
   * SQL-only (promotion planning and applying never call the LLM). A run is
   * pending while it has no recorded successful promotion operation; failed
   * attempts stay pending and are retried on the next sweep. Existing
   * manifests are recovered from their immutable staged items (see
   * resumePromotionForRun), never re-planned.
   */
  async function reconcilePendingPromotions(): Promise<void> {
    // Bounded batch with a failure backoff and FAIR retry ordering (see
    // selectPendingPromotionRunIds): repeatedly failing runs rotate out of
    // the batch after each attempt, so pending runs behind them are selected
    // instead of being starved by head-of-line failures.
    const pending = await selectPendingPromotionRunIds(
      pool,
      PROMOTION_RECONCILE_BACKOFF_MS,
      10,
    );
    for (const runId of pending) {
      log(`[MEMORY] reconciling pending promotion for run ${runId}`);
      await autoPromote(runId, new Date());
    }
  }

  async function maybeConsolidate(now: Date): Promise<void> {
    // Note: pending-manifest reconciliation is NOT gated here — it runs at
    // the end of every ingest pass regardless of extraction outcome (see
    // runIngest). This function only gates NEW consolidation work.
    const state = await getIngestState(pool);
    const newFacts = state?.newFactsSinceConsolidation ?? 0;
    const factsThresholdMet = newFacts >= config.consolidationNewFactsThreshold;
    const intervalMet =
      state?.lastConsolidatedAt === undefined ||
      state.lastConsolidatedAt === null ||
      now.getTime() - state.lastConsolidatedAt.getTime() >= config.consolidationIntervalMs;
    if (!factsThresholdMet && !intervalMet) return;
    // Zero-fact guard: an interval-only trigger with no new facts since the
    // last consolidation would re-derive the same artifacts from the same
    // window — skip the run (cost hygiene). Recovery does not depend on this:
    // pending promotions are reconciled at the end of every ingest pass by
    // promotion id, independent of extraction outcome.
    if (!factsThresholdMet && newFacts === 0) return;

    let result: ConsolidationRunResult;
    try {
      result = await runScheduledConsolidation(
        {
          pool,
          config,
          subjects: subjectIds,
          systemPrompt: configuration.prompts["observation_consolidation"]!.systemPrompt,
          factExtractionPromptContentHash: promptContentHash(
            configuration.prompts["fact_extraction"]!.systemPrompt,
          ),
          callLlm,
          behavior,
          log,
        },
        new Date(),
      );
      await recordMemoryOperation(pool, {
        kind: "observation_consolidation",
        outcome: "ok",
        runId: result.runId,
        detail:
          `turns=${String(result.selectedTurnCount)} facts=${String(result.factCount)}` +
          ` observations=${String(result.observations)} omissions=${String(result.omissions)}` +
          ` llmCalls=${String(result.llmCalls)}`,
        model: config.model,
        promptVersion: OBSERVATION_CONSOLIDATION_PROMPT_VERSION,
        llmCalls: result.llmCalls,
        startedAt: now,
        finishedAt: new Date(),
      });
    } catch (error) {
      const category = memoryErrorCategory(error);
      log(`[MEMORY] scheduled consolidation failed: ${category}`);
      await recordMemoryOperation(pool, {
        kind: "observation_consolidation",
        outcome: "failed",
        detail: `error=${category}`,
        startedAt: now,
        finishedAt: new Date(),
      }).catch(() => undefined);
      return;
    }

    await autoPromote(result.runId, now);
  }

  async function autoPromote(runId: string, startedAt: Date): Promise<void> {
    if (!config.autopromoteEnabled) return;
    try {
      // Manifest-first: a run that already has a promotion manifest is
      // resolved from its immutable staged items and stored history — never
      // re-planned. Re-planning after concurrent state changes (retractions,
      // later promotions during a crash window) can wrongly report "nothing
      // eligible" and abandon live staged work, or reject a completed
      // manifest against a fresh plan it was never built from.
      const recovered = await resumePromotionForRun(pool, { runId });
      if (recovered !== null) {
        log(
          `[MEMORY] auto-promotion ${recovered.promotionId}: ${recovered.status} (recovered from the stored manifest) items=${String(recovered.itemCount)} created=${String(recovered.created)} revised=${String(recovered.revised)} unchanged=${String(recovered.unchanged)} skippedInactive=${String(recovered.skippedInactive)} superseded=${String(recovered.superseded)}`,
        );
        await recordMemoryOperation(pool, {
          kind: "promotion",
          outcome: "ok",
          runId,
          promotionId: recovered.promotionId,
          detail:
            `status=${recovered.status} recovered=true items=${String(recovered.itemCount)}` +
            ` created=${String(recovered.created)} revised=${String(recovered.revised)}` +
            ` unchanged=${String(recovered.unchanged)}` +
            ` skippedInactive=${String(recovered.skippedInactive)}` +
            ` superseded=${String(recovered.superseded)} history=${String(recovered.historyEvents)}`,
          startedAt,
          finishedAt: new Date(),
        });
        return;
      }
      const plan = await buildPromotionPlan(pool, { runId, skipTentative: true, behavior });
      if (plan.itemCount === 0) {
        log(
          `[MEMORY] auto-promotion ${plan.promotionId}: nothing eligible (policyBlocked=${String(plan.summary.policyBlocked)}, inactiveSkipped=${String(plan.summary.inactiveArtifactsSkipped)})`,
        );
        // Recorded so promotion reconciliation treats this run as settled
        // instead of re-planning it on every sweep.
        await recordMemoryOperation(pool, {
          kind: "promotion",
          outcome: "ok",
          runId,
          promotionId: plan.promotionId,
          detail:
            `status=nothing-eligible policyBlocked=${String(plan.summary.policyBlocked)}` +
            ` inactiveSkipped=${String(plan.summary.inactiveArtifactsSkipped)}`,
          startedAt,
          finishedAt: new Date(),
        });
        return;
      }
      const result = await promoteRun(pool, {
        runId,
        confirmationToken: plan.confirmationToken,
        skipTentative: true,
        behavior,
      });
      log(
        `[MEMORY] auto-promotion ${result.promotionId}: ${result.status} created=${String(result.created)} revised=${String(result.revised)} unchanged=${String(result.unchanged)} skippedInactive=${String(result.skippedInactive)} superseded=${String(result.superseded)}`,
      );
      await recordMemoryOperation(pool, {
        kind: "promotion",
        outcome: "ok",
        runId,
        promotionId: result.promotionId,
        detail:
          `status=${result.status} items=${String(result.itemCount)} created=${String(result.created)}` +
          ` revised=${String(result.revised)} unchanged=${String(result.unchanged)}` +
          ` skippedInactive=${String(result.skippedInactive)} history=${String(result.historyEvents)}`,
        startedAt,
        finishedAt: new Date(),
      });
    } catch (error) {
      const category = memoryErrorCategory(error);
      log(`[MEMORY] auto-promotion for run ${runId} failed: ${category}`);
      await recordMemoryOperation(pool, {
        kind: "promotion",
        outcome: "failed",
        runId,
        detail: `error=${category}`,
        startedAt,
        finishedAt: new Date(),
      }).catch(() => undefined);
    }
  }

  async function runTemporalSweep(): Promise<void> {
    const now = new Date();
    const periods = getClosedTemporalSummaryPeriods(now, behavior);
    let generated = 0;
    for (const period of periods) {
      const startedAt = new Date();
      try {
        const summary = await generateTemporalSummary(temporalDeps, period, now);
        if (summary !== null) {
          generated += 1;
          await recordMemoryOperation(pool, {
            kind: "temporal_summary",
            outcome: "ok",
            detail:
              `kind=${period.kind} periodKey=${period.periodKey} messages=${String(summary.messageCount)}` +
              ` calls=${String(summary.callCount)}`,
            model: config.model,
            promptVersion: TEMPORAL_SUMMARY_PROMPT_VERSION,
            inputTokens: summary.inputTokens,
            outputTokens: summary.outputTokens,
            llmCalls: summary.callCount,
            startedAt,
            finishedAt: new Date(),
          });
        }
      } catch (error) {
        const category = memoryErrorCategory(error);
        log(`[MEMORY] temporal summary ${period.kind} ${period.periodKey} failed: ${category}`);
        await recordMemoryOperation(pool, {
          kind: "temporal_summary",
          outcome: "failed",
          detail: `kind=${period.kind} periodKey=${period.periodKey} error=${category}`,
          model: config.model,
          promptVersion: "temporal-v6",
          startedAt,
          finishedAt: new Date(),
        }).catch(() => undefined);
      }
    }

    // v1 profile summaries: separately configured (see the config flag
    // comment — the chat prompt consumes recent temporal summaries and v2
    // profiles only, so this generator defaults off to avoid billable calls
    // with no consumer) and fingerprint-gated, so unchanged day summaries
    // cost no LLM calls.
    for (const subject of config.profileSummariesEnabled ? profileSubjects : []) {
      const startedAt = new Date();
      try {
        const summary = await generateProfileSummary(
          {
            pool,
            config,
            subjects: configuration.subjects,
            systemPrompt: configuration.prompts["profile_summary"]!.systemPrompt,
            callLlm,
          },
          subject.id,
          now,
        );
        if (summary !== null) {
          await recordMemoryOperation(pool, {
            kind: "profile_summary",
            outcome: "ok",
            detail: `subject=${subject.id} sources=${String(summary.sourceSummaryKeys.length)}`,
            model: summary.model,
            promptVersion: summary.promptVersion,
            startedAt,
            finishedAt: new Date(),
          });
        }
      } catch (error) {
        const category = memoryErrorCategory(error);
        log(`[MEMORY] profile summary for ${subject.id} failed: ${category}`);
        await recordMemoryOperation(pool, {
          kind: "profile_summary",
          outcome: "failed",
          detail: `subject=${subject.id} error=${category}`,
          startedAt,
          finishedAt: new Date(),
        }).catch(() => undefined);
      }
    }
    if (generated > 0) {
      log(`[MEMORY] temporal sweep generated ${String(generated)} summary(ies)`);
    }
  }

  // --- Ingest scheduling -------------------------------------------------

  let ingestTimer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  // Coalescing: at most one pending ingest and one pending temporal sweep sit
  // in the serial queue at a time. Timer ticks that arrive while work is
  // queued (or running) collapse into the pending pass — the flag clears when
  // the task starts, so activity during a pass still schedules the next one.
  let ingestQueued = false;
  let temporalQueued = false;

  const enqueueIngest = (reason: "turn-complete" | "reconciliation"): void => {
    if (closed || !config.ingestEnabled) return;
    if (ingestQueued) return;
    ingestQueued = true;
    queue.enqueue(async () => {
      ingestQueued = false;
      await runIngest(reason);
    });
  };

  const enqueueTemporalSweep = (): void => {
    if (closed) return;
    if (temporalQueued) return;
    temporalQueued = true;
    queue.enqueue(async () => {
      temporalQueued = false;
      await runTemporalSweep();
    });
  };

  const scheduleSettledIngest = (): void => {
    if (closed || !config.ingestEnabled || ingestTimer !== undefined) return;
    // First-wins: one attempt after the settle window covers every turn
    // published meanwhile (the selector is watermark-driven and bounded).
    ingestTimer = setTimeout(() => {
      ingestTimer = undefined;
      enqueueIngest("turn-complete");
    }, config.ingestSettleMs);
  };

  // No reconciliation timer at all when ingest is disabled: a disabled
  // pipeline must not schedule, execute, or initialize state.
  const reconciliationTimer = setInterval(() => {
    enqueueIngest("reconciliation");
  }, config.ingestReconciliationMs);

  const temporalTimer = setInterval(() => {
    enqueueTemporalSweep();
  }, config.temporalReconciliationMs);

  // Initial reconciliation: cover turns published while this process was
  // down. The ingest pipeline itself stays new-turn-only: on a fresh
  // database (no watermark) it initializes the cursor at the newest existing
  // completed turn instead of processing history.
  enqueueIngest("reconciliation");
  // Initial temporal sweep: closed periods since the last process lifetime.
  enqueueTemporalSweep();
  if (!config.profileSummariesEnabled) {
    log(
      "[MEMORY] v1 profile summaries disabled (WORKER_MEMORY_PROFILE_SUMMARIES_ENABLED); the chat prompt uses recent temporal summaries and v2 profiles only",
    );
  }

  const profileRuntime = startProfileRuntime({
    pool,
    config,
    behavior,
    profileSubjects,
    observationProfilePrompt: configuration.prompts["observation_profile"]!,
    callLlm,
    log,
    onResult: async (result) => {
      await recordMemoryOperation(pool, {
        kind: "observation_profile",
        outcome: result.outcome,
        detail: `subject=${result.subject} ${result.detail}`,
        startedAt: new Date(),
        finishedAt: new Date(),
      }).catch(() => undefined);
    },
  });

  return {
    onTurnPublished: (turnId: string): void => {
      void turnId;
      scheduleSettledIngest();
    },
    close: async () => {
      closed = true;
      if (ingestTimer !== undefined) clearTimeout(ingestTimer);
      clearInterval(reconciliationTimer);
      clearInterval(temporalTimer);
      await profileRuntime.close();
      await queue.drain();
    },
  };
}
