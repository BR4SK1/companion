import { ImageClientError, type ImageServiceClients } from "./client.ts";
import type { OfflineImageStore } from "./offline-store.ts";
import {
  parseOfflinePhotoEvent,
  type OfflinePhotoEvent,
} from "./offline-plan.ts";
import type { PhotoAccess } from "./photo-access.ts";
import type { ImageStore } from "./store.ts";

export function createOfflinePhotoRuntime(input: {
  readonly store: OfflineImageStore;
  readonly images: Pick<ImageStore, "saveRendered">;
  readonly clients: Pick<ImageServiceClients, "renderOfflineShot">;
  readonly loadAccess: () => Promise<PhotoAccess>;
  readonly publishAlbum: (eventId: string) => Promise<boolean>;
  readonly timeoutMs: number;
  readonly maxAttempts: number;
  readonly log: (message: string) => void;
}) {
  let active: OfflinePhotoEvent | null = null;

  async function publishReady(): Promise<void> {
    await input.store.expireAlbums();
    const eventId = await input.store.nextAlbum();
    if (eventId !== null) await input.publishAlbum(eventId);
  }

  return {
    observeTick: async (response: unknown): Promise<boolean> => {
      if (
        typeof response !== "object" ||
        response === null ||
        !("offlinePhotoEvent" in response)
      )
        return false;
      const event = parseOfflinePhotoEvent(response.offlinePhotoEvent);
      if (event === null) {
        input.log("[IMAGE] ignored invalid offline event");
        return false;
      }
      if (event.completedAt !== null) {
        await input.store.markReturned(event);
        if (active?.id === event.id) active = null;
        // The scheduled return can arrive while a later candidate is still
        // rendering. Publish the ready subset without waiting for the GPU.
        await publishReady();
        return true;
      }
      if (active?.id === event.id || Date.parse(event.returnAt) <= Date.now())
        return false;
      await input.store.register(event, await input.loadAccess());
      active = event;
      return true;
    },

    renderNext: async (): Promise<boolean> => {
      const event = active;
      if (event === null || Date.parse(event.returnAt) <= Date.now())
        return false;
      const access = await input.loadAccess();
      if (access === 0) return false;
      const claim = await input.store.claimShot(
        event.id,
        access,
        input.timeoutMs + 30_000,
        input.maxAttempts,
      );
      if (claim === null) return false;
      try {
        const shot = event.shots.find(
          (candidate) => candidate.position === claim.position,
        );
        if (shot === undefined) throw new Error("Missing offline recipe");
        const rendered = await input.clients.renderOfflineShot(event.id, shot);
        await input.images.saveRendered(claim.id, {
          ...rendered,
          images: rendered.images.slice(0, 1),
          offlineLease: { eventId: event.id, token: claim.token },
        });
      } catch (error) {
        const category =
          error instanceof ImageClientError
            ? error.category
            : "image_internal_error";
        await input.store.failShot(claim, category, input.maxAttempts);
        input.log(`[IMAGE] offline shot failed category=${category}`);
      }
      return true;
    },

    publishReady,
  };
}
