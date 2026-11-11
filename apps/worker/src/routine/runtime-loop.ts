import type { RoutineStore } from "./store.ts";

const DEFAULT_RECONCILIATION_MS = 15_000;

export interface RoutineRuntime {
  readonly reconcileNow: () => Promise<void>;
  readonly close: () => Promise<void>;
}

/**
 * A small serial reconciliation loop. Durable state is reconstructed from
 * enabled schedule occurrences, so startup and every later pass are idempotent.
 */
export function startRoutineRuntime(input: {
  readonly store: RoutineStore;
  /** Conversation-domain transaction that publishes the pending schedule notice. */
  readonly publishPendingAnnouncement?: () => Promise<boolean>;
  readonly intervalMs?: number;
  readonly log?: (message: string) => void;
}): RoutineRuntime {
  const intervalMs = input.intervalMs ?? DEFAULT_RECONCILIATION_MS;
  if (!Number.isFinite(intervalMs) || intervalMs < 1) {
    throw new Error("routine reconciliation interval must be positive");
  }
  const log = input.log ?? (() => {});
  let closed = false;
  let queued = false;
  let tail: Promise<void> = Promise.resolve();

  const enqueue = (): Promise<void> => {
    if (queued) return tail;
    queued = true;
    const next = tail.then(async () => {
      queued = false;
      if (closed) return;
      try {
        await input.store.reconcile();
        await input.publishPendingAnnouncement?.();
      } catch {
        // The applied cursor and pending notice are durable. The next pass
        // retries; an ongoing unavailable period is revalidated before publish.
        log("[ROUTINE] reconciliation or announcement publication failed; the next pass will retry if the absence is ongoing");
      }
    });
    tail = next.catch(() => undefined);
    return tail;
  };

  const timer = setInterval(() => { void enqueue(); }, intervalMs);
  void enqueue();

  return {
    reconcileNow: enqueue,
    close: async () => {
      closed = true;
      clearInterval(timer);
      await tail;
    },
  };
}
