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
import { memoryErrorCategory } from "./errors.ts";

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
  }) => Promise<void>;
}

export interface ProfileRuntime {
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
    try {
      const result: ProfileGenerateSummary = await generateProfileIfNeeded(
        profileDeps,
        subject.id,
      );
      if (result.regenerated) {
        log(
          `[MEMORY] profile ${subject.id} regenerated (${trigger}): sources=${String(result.sourceCount)}` +
            `${result.skippedReason !== undefined ? ` [${result.skippedReason}]` : ""}`,
        );
      }
      await deps.onResult?.({
        subject: subject.id,
        trigger,
        outcome: "ok",
        detail: `trigger=${trigger} regenerated=${String(result.regenerated)}` +
          `${result.skippedReason !== undefined ? ` skipped=${result.skippedReason}` : ""}` +
          ` sources=${String(result.sourceCount)}`,
      });
    } catch (error) {
      const category = memoryErrorCategory(error);
      console.error(
        `[MEMORY] profile ${subject.id} generation failed (${trigger}):`,
        category,
      );
      await deps.onResult?.({
        subject: subject.id,
        trigger,
        outcome: "failed",
        detail: `trigger=${trigger} error=${category}`,
      }).catch(() => undefined);
    }
  }
}

export function startProfileRuntime(deps: ProfileRuntimeDeps): ProfileRuntime {
  if (!deps.config.profilesEnabled || deps.profileSubjects.length === 0) {
    return { close: async () => undefined };
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  // Serializing flag: a startup run may still be in flight when the first
  // scheduled run fires; never run two passes concurrently.
  let running = false;
  // The pass actually in flight, so close() can await it instead of leaving
  // an LLM-backed write running past shutdown.
  let inFlight: Promise<void> = Promise.resolve();

  const scheduleNext = (): void => {
    if (closed) return;
    const delay = computeNextProfileRunDelay(new Date(), deps.config.profilesGenerateHour, deps.behavior.timezone);
    timer = setTimeout(() => {
      if (closed || running) {
        scheduleNext();
        return;
      }
      running = true;
      inFlight = runAllProfiles(deps, "scheduled")
        .catch((error) => {
          console.error(
            `[MEMORY] profile scheduled run failed: ${memoryErrorCategory(error)}`,
          );
        })
        .finally(() => {
          running = false;
          scheduleNext();
        });
    }, delay);
  };

  inFlight = runAllProfiles(deps, "startup")
    .catch((error) => {
      console.error(
        `[MEMORY] profile startup run failed: ${memoryErrorCategory(error)}`,
      );
    })
    .finally(scheduleNext);

  return {
    close: async () => {
      closed = true;
      if (timer !== undefined) clearTimeout(timer);
      // Await the in-flight pass (bounded by per-call LLM timeouts) so
      // shutdown never abandons a half-finished profile write.
      await inFlight;
    },
  };
}
