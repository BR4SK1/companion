import type { SemanticShadowRequest } from "./runtime.ts";

export interface SemanticScheduler {
  enqueueReconciliation(): void;
  enqueueShadow(request: SemanticShadowRequest): void;
  close(): Promise<void>;
}

/** One coalescing semantic worker, independent of the ordinary memory queue. */
export function createSemanticScheduler(input: {
  readonly reconcile: () => Promise<void>;
  readonly compare: (request: SemanticShadowRequest) => Promise<void>;
  readonly log: (message: string) => void;
  readonly errorCategory: (error: unknown) => string;
}): SemanticScheduler {
  let closed = false;
  let busy = false;
  let currentTask: Promise<void> | undefined;

  const start = (label: string, task: () => Promise<void>): void => {
    if (closed || busy) return;
    busy = true;
    const running = Promise.resolve()
      .then(task)
      .catch((error: unknown) => {
        input.log(`[MEMORY] ${label} failed: ${input.errorCategory(error)}`);
      })
      .finally(() => {
        busy = false;
        currentTask = undefined;
      });
    currentTask = running;
  };

  return {
    enqueueReconciliation: () => {
      if (closed || busy) return;
      start("semantic embedding reconciliation", input.reconcile);
    },
    enqueueShadow: (request) => {
      if (closed) return;
      if (busy) {
        input.log("[MEMORY] semantic shadow comparison skipped (bounded worker busy)");
        return;
      }
      start("semantic shadow comparison", () => input.compare(request));
    },
    close: async () => {
      closed = true;
      await currentTask;
    },
  };
}
