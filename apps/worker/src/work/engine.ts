/**
 * Worker engine loop: claim → decide → chat → publish, with lease fencing.
 *
 * One cycle claims at most one turn (the grouped snapshot), processes it with
 * the injected processor, records the decision diagnostics (fenced-safe),
 * publishes the reply (fenced, idempotent), or records a failure (fenced).
 * A heartbeat renews the lease while the turn is in flight (cadence: one
 * third of the lease, at least 1000ms — see `work/timing.ts`); if renewal
 * reports the lease is lost, publication is still fenced by the store, so a
 * stale worker can never overwrite the work of a reclaiming worker.
 *
 * Shutdown is graceful: an aborted signal stops new claims and lets the
 * in-flight cycle finish (including publication) before returning.
 */

import { randomUUID } from "node:crypto";

import type { ConversationStore } from "../conversation/store.ts";
import type { TurnWork } from "../conversation/types.ts";
import type { TurnOutcome } from "./processor.ts";
import { heartbeatIntervalMs, MIN_LEASE_SECONDS } from "./timing.ts";

export interface EngineDeps {
  readonly store: ConversationStore;
  readonly processTurn: (work: TurnWork) => Promise<TurnOutcome>;
  readonly leaseSeconds: number;
  readonly pollSeconds: number;
  /** Stable-ish label for logs; the claim token itself is always unique. */
  readonly ownerLabel?: string;
  readonly log?: (message: string) => void;
}

export type EngineCycleResult = "worked" | "idle";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Run exactly one engine cycle. Resolves `"worked"` when a turn was claimed
 * and driven to a terminal recorded state (published, duplicate, fenced, or
 * failed), `"idle"` when nothing was claimable.
 */
export async function runEngineOnce(deps: EngineDeps): Promise<EngineCycleResult> {
  if (!(deps.leaseSeconds >= MIN_LEASE_SECONDS)) {
    throw new Error(
      `leaseSeconds must be at least ${String(MIN_LEASE_SECONDS)} so the heartbeat (lease/3, at least 1000ms) renews before expiry; got ${String(deps.leaseSeconds)}`,
    );
  }
  const owner = `${deps.ownerLabel ?? "worker"}:${randomUUID()}`;
  const claim = await deps.store.claimNextTurn({
    owner,
    leaseSeconds: deps.leaseSeconds,
  });
  if (claim.kind !== "claimed") {
    return "idle";
  }
  const work = claim.work;
  const log = deps.log ?? (() => {});
  log(
    `claimed turn ${work.turn.id} (attempt ${String(work.turn.attempt)}) with ${String(work.messages.length)} message(s)`,
  );

  // Aligned with the lease (see `work/timing.ts`): one third of the lease,
  // never below one second, and configuration guarantees the lease is long
  // enough for the unclamped cadence.
  const heartbeatMs = heartbeatIntervalMs(deps.leaseSeconds);
  const heartbeat = setInterval(() => {
    void deps.store
      .renewLease({
        turnId: work.turn.id,
        leaseOwner: owner,
        leaseSeconds: deps.leaseSeconds,
      })
      .then((renewed) => {
        if (!renewed) {
          log(`lost lease on turn ${work.turn.id}; publication will be fenced`);
        }
      })
      .catch((error: unknown) => {
        log(`lease renewal failed on turn ${work.turn.id}: ${errorMessage(error)}`);
      });
  }, heartbeatMs);

  try {
    const outcome = await deps.processTurn(work);
    // Record diagnostics while the turn is still in flight; fenced-safe, so
    // a stale worker's diagnostics cannot overwrite a reclaiming worker's.
    await deps.store.recordTurnDecision({
      turnId: work.turn.id,
      leaseOwner: owner,
      selectedPatternId: outcome.selectedPatternId,
      decision: outcome.decision,
    });
    const publish = await deps.store.publishReply({
      turnId: work.turn.id,
      leaseOwner: owner,
      content: outcome.reply,
    });
    if (publish === "fenced") {
      log(`publication fenced for turn ${work.turn.id}; turn owned elsewhere`);
    } else if (publish === "already_published") {
      log(`reply for turn ${work.turn.id} already published; duplicate no-op`);
    } else {
      log(`published reply for turn ${work.turn.id}`);
    }
  } catch (error) {
    const fail = await deps.store.failTurn({
      turnId: work.turn.id,
      leaseOwner: owner,
      error: errorMessage(error),
    });
    if (fail === "fenced") {
      log(
        `turn ${work.turn.id} failed but the lease was lost; failure left to the current owner`,
      );
    } else {
      log(`turn ${work.turn.id} failed: ${errorMessage(error)}`);
    }
  } finally {
    clearInterval(heartbeat);
  }
  return "worked";
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const finish = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
  });
}

/**
 * Run engine cycles until the signal aborts. The in-flight cycle at abort
 * time finishes first (graceful shutdown); new claims stop immediately.
 */
export async function runEngineLoop(
  deps: EngineDeps,
  options: { readonly signal: AbortSignal },
): Promise<void> {
  while (!options.signal.aborted) {
    const result = await runEngineOnce(deps);
    if (options.signal.aborted) {
      break;
    }
    if (result === "idle") {
      await sleep(deps.pollSeconds * 1000, options.signal);
    }
  }
}
