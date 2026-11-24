/**
 * Serial image-generation runtime. Slow module calls (reconciliation and
 * ComfyUI rendering) run here, decoupled from ordinary chat: a turn's reply
 * publishes first, and the image appears later as its own thread message.
 * Durable job state (see `store.ts`) survives restarts; a crash mid-render
 * is recovered by resetting `running` jobs to pending at startup.
 */

import { ImageClientError } from "./client.ts";
import { isPhotoWorthy } from "./gate.ts";
import { IMAGE_MESSAGE_MARKER, type ImageJob } from "./types.ts";
import type { ImageServiceClients } from "./client.ts";
import type { ImageStore } from "./store.ts";

export interface ImageRuntime {
  readonly close: () => Promise<void>;
  /** Nudge the loop after a job is enqueued; the poll timer also covers it. */
  readonly notify: () => void;
}

const RENDER_BACKOFF_MS = 30_000;

export function startImageRuntime(input: {
  readonly store: ImageStore;
  readonly clients: ImageServiceClients;
  readonly patternIds: readonly string[];
  readonly maxAttempts: number;
  readonly pollMs: number;
  /**
   * Publish one rendered job as a standalone assistant message through the
   * conversation domain's scheduled-message transaction. Resolves false
   * when publication is refused (a turn is in flight); the job stays
   * `rendered` and publication retries on a later pass.
   */
  readonly publishImageMessage: (job: ImageJob) => Promise<boolean>;
  readonly log?: (message: string) => void;
}): ImageRuntime {
  const log = input.log ?? (() => {});
  let closed = false;
  let queued = false;
  let tail: Promise<void> = Promise.resolve();

  const publishRendered = async (): Promise<void> => {
    const job = await input.store.nextRendered();
    if (job === null) return;
    const published = await input.publishImageMessage(job);
    if (!published) {
      await input.store.releaseRendered(job.id);
      log(
        `[IMAGE] publication deferred for turn ${job.turnId} (thread busy); will retry`,
      );
    }
  };

  const processJob = async (job: ImageJob): Promise<void> => {
    if (
      !isPhotoWorthy({
        patternId: job.patternId,
        userText: job.userText,
        patternIds: input.patternIds,
      })
    ) {
      await input.store.markSkipped(job.id, "not_photo_worthy");
      return;
    }

    try {
      const snapshot = await input.clients.reconcile({
        turnId: job.turnId,
        userText: job.userText,
        companionResponse: job.companionResponse,
        localDateTime: job.localDateTime,
      });

      if (
        !isPhotoWorthy({
          patternId: job.patternId,
          userText: job.userText,
          patternIds: input.patternIds,
          roleplayInScene: snapshot.roleplay?.inScene ?? false,
        })
      ) {
        await input.store.markSkipped(job.id, "not_photo_worthy");
        return;
      }

      const priorPose = await input.store.loadPriorPose();
      const rendered = await input.clients.render({
        turnId: job.turnId,
        userText: job.userText,
        companionResponse: job.companionResponse,
        localDateTime: job.localDateTime,
        snapshot,
        priorPose,
      });
      await input.store.saveRendered(job.id, rendered);
      log(
        `[IMAGE] rendered turn ${job.turnId} prompt=${rendered.promptId} images=${String(rendered.images.length)}`,
      );
    } catch (error) {
      const category =
        error instanceof ImageClientError ? error.category : "image_internal_error";
      await input.store.failJob({
        jobId: job.id,
        category,
        maxAttempts: input.maxAttempts,
        backoffMs: RENDER_BACKOFF_MS,
      });
      log(
        `[IMAGE] job for turn ${job.turnId} failed category=${category} attempt=${String(job.attempts)}`,
      );
    }
  };

  const pass = async (): Promise<void> => {
    await publishRendered();
    const job = await input.store.claimNextDue();
    if (job !== null) {
      await processJob(job);
      await publishRendered();
    }
  };

  const enqueue = (): Promise<void> => {
    if (queued || closed) return tail;
    queued = true;
    const next = tail.then(async () => {
      queued = false;
      if (closed) return;
      try {
        await pass();
      } catch {
        log("[IMAGE] pass failed; the next pass will retry durable jobs");
      }
    });
    tail = next.catch(() => undefined);
    return tail;
  };

  void input.store
    .resetStaleRunning()
    .then((reset) => {
      if (reset > 0) {
        log(`[IMAGE] reset ${String(reset)} stale running job(s) to pending`);
      }
    })
    .catch(() => undefined);

  const timer = setInterval(() => {
    void enqueue();
  }, input.pollMs);
  void enqueue();

  return {
    notify: () => {
      void enqueue();
    },
    close: async () => {
      closed = true;
      clearInterval(timer);
      await tail;
    },
  };
}

/** Thread content carried by the standalone image message. */
export const IMAGE_MESSAGE_CONTENT = IMAGE_MESSAGE_MARKER;
