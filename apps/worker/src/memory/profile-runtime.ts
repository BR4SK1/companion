/**
 * Profile v2 upkeep.
 *
 * Runs once at startup (the fingerprint check heals a crashed or freshly
 * deployed profile for free when unchanged) and then once per day at the
 * configured local hour in the provisioned behavioral timezone — the
 * behavioral-day cadence the temporal pipeline uses. The fingerprint gate inside
 * `generateProfileIfNeeded` still applies: an unchanged observation set costs
 * zero LLM calls even on the scheduled run.
 */

import type { PostgresPool } from "@companion/postgres";

import type { MemoryConfig } from "./config.ts";
import type { MemoryLlmCaller } from "./llm.ts";
import type { MemorySubject, PromptConfig } from "./types.ts";
import { generateProfileIfNeeded, type ProfileGenerateSummary } from "./profiles-v2.ts";
import { nextLocalHourDelay, type BehaviorTime } from "./time.ts";
import { memoryErrorCategory, memoryOutputErrorReason } from "./errors.ts";
import { MEMORY_PROFILE_PROMPT_VERSION } from "./prompts.ts";

export function computeNextProfileRunDelay(now: Date, hour: number, timezone: string): number {
  return nextLocalHourDelay(now, hour, timezone);
}

export interface ProfileRuntimeDeps {
  readonly pool: PostgresPool;
  readonly config: MemoryConfig;
  /** The behavioral-day boundary (provisioned configuration). */
  readonly behavior: BehaviorTime;
  /** Profile-enabled subjects, in presentation order. */
  readonly profileSubjects: readonly MemorySubject[];
  readonly observationProfilePrompt: PromptConfig;
  readonly callLlm: MemoryLlmCaller;
  readonly log?: (message: string) => void;
  /** Optional operation trace hook (metadata-only). */
  readonly onResult?: (result: {
    readonly subject: string;
    readonly trigger: string;
    readonly outcome: "ok" | "failed";
    readonly detail: string;
    readonly model?: string;
    readonly promptVersion?: string;
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly llmCalls?: number;
    readonly startedAt: Date;
    readonly finishedAt: Date;
  }) => Promise<void>;
}

export interface ProfileRuntime {
  /** Trigger an immediate serialized profile regeneration pass (e.g. after promotion). */
  trigger(reason?: string): void;
  close(): Promise<void>;
}

async function runAllProfiles(
  deps: ProfileRuntimeDeps,
  trigger: string,
): Promise<void> {
  const log = deps.log ?? ((message: string) => console.log(message));
  const profileDeps = {
    pool: deps.pool,
    config: deps.config,
    systemPrompt: deps.observationProfilePrompt.systemPrompt,
    callLlm: deps.callLlm,
  };
  for (const subject of deps.profileSubjects) {
    const startedAt = new Date();
    try {
      const result: ProfileGenerateSummary = await generateProfileIfNeeded(
        profileDeps,
        subject.id,
      );
      const trimmedSuffix =
        result.trimmedCount !== undefined && result.trimmedCount > 0
          ? ` trimmed=${String(result.trimmedCount)}`
          : "";
      const droppedClaimsSuffix =
        result.droppedClaims !== undefined && result.droppedClaims > 0
          ? ` droppedClaims=${String(result.droppedClaims)}`
          : "";
      if (result.regenerated) {
        log(
          `[MEMORY] profile ${subject.id} regenerated (${trigger}): sources=${String(result.sourceCount)}${trimmedSuffix}${droppedClaimsSuffix}` +
            `${result.skippedReason !== undefined ? ` [${result.skippedReason}]` : ""}`,
        );
      }
      await deps.onResult?.({
        subject: subject.id,
        trigger,
        outcome: "ok",
        detail: `trigger=${trigger} regenerated=${String(result.regenerated)}` +
          `${result.skippedReason !== undefined ? ` skipped=${result.skippedReason}` : ""}` +
          ` sources=${String(result.sourceCount)}${trimmedSuffix}${droppedClaimsSuffix}`,
        ...(result.model !== undefined ? { model: result.model } : {}),
        ...(result.promptVersion !== undefined ? { promptVersion: result.promptVersion } : {}),
        ...(result.inputTokens !== undefined ? { inputTokens: result.inputTokens } : {}),
        ...(result.outputTokens !== undefined ? { outputTokens: result.outputTokens } : {}),
        ...(result.llmCalls !== undefined ? { llmCalls: result.llmCalls } : {}),
        startedAt,
        finishedAt: new Date(),
      });
    } catch (error) {
      const category = memoryErrorCategory(error);
      const reason = memoryOutputErrorReason(error);
      const reasonSuffix = reason !== null ? ` reason=${reason}` : "";
      console.error(
        `[MEMORY] profile ${subject.id} generation failed (${trigger}):`,
        `${category}${reasonSuffix}`,
      );
      await deps.onResult?.({
        subject: subject.id,
        trigger,
        outcome: "failed",
        detail: `trigger=${trigger} error=${category}${reasonSuffix}`,
        model: deps.config.model,
        promptVersion: MEMORY_PROFILE_PROMPT_VERSION,
        startedAt,
        finishedAt: new Date(),
      }).catch(() => undefined);
    }
  }
}

export function startProfileRuntime(deps: ProfileRuntimeDeps): ProfileRuntime {
  if (!deps.config.profilesEnabled || deps.profileSubjects.length === 0) {
    return {
      trigger: () => undefined,
      close: async () => undefined,
    };
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  // Serializing state: a startup run may still be in flight when a scheduled or
  // post-promotion trigger fires; never run two passes concurrently, and coalesce
  // multiple triggers arriving while a pass is already running into one follow-up
  // pass on the same durable promise chain so close() awaits all triggered work.
  let running = false;
  let pendingTrigger: string | null = null;
  let inFlight: Promise<void> = Promise.resolve();

  const drainPasses = async (initialTrigger: string): Promise<void> => {
    let nextTrigger: string | null = initialTrigger;
    while (nextTrigger !== null) {
      const trigger = nextTrigger;
      nextTrigger = null;
      try {
        await runAllProfiles(deps, trigger);
      } catch (error) {
        console.error(
          `[MEMORY] profile ${trigger} run failed: ${memoryErrorCategory(error)}`,
        );
      }
      if (pendingTrigger !== null) {
        nextTrigger = pendingTrigger;
        pendingTrigger = null;
      }
    }
  };

  const launchPass = (trigger: string): void => {
    if (closed) return;
    if (running) {
      pendingTrigger = trigger;
      return;
    }
    running = true;
    inFlight = inFlight
      .then(() => drainPasses(trigger))
      .finally(() => {
        running = false;
      });
  };

  const scheduleNext = (): void => {
    if (closed) return;
    if (timer !== undefined) clearTimeout(timer);
    const delay = computeNextProfileRunDelay(new Date(), deps.config.profilesGenerateHour, deps.behavior.timezone);
    timer = setTimeout(() => {
      timer = undefined;
      launchPass("scheduled");
      scheduleNext();
    }, delay);
  };

  launchPass("startup");
  scheduleNext();

  return {
    trigger: (reason = "promotion"): void => {
      launchPass(reason);
    },
    close: async () => {
      closed = true;
      if (timer !== undefined) clearTimeout(timer);
      // Await the in-flight pass (bounded by per-call LLM timeouts) so
      // shutdown never abandons a half-finished profile write.
      await inFlight;
    },
  };
}
