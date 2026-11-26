import { randomInt } from "node:crypto";
import {
  withTransaction,
  type PostgresPool,
  type PostgresPoolClient,
} from "@companion/postgres";

import { offlineShotAccess, type OfflinePhotoEvent } from "./offline-plan.ts";
import type { PhotoAccess } from "./photo-access.ts";
import type { ImageStore } from "./store.ts";

interface OfflineShotClaim {
  readonly id: string;
  readonly position: number;
  readonly token: string;
  readonly requiredAccess: PhotoAccess;
}

export interface ReadyAlbum {
  readonly id: string;
  readonly publishBy: Date;
  readonly jobIds: readonly string[];
}

export function createOfflineImageStore(
  pool: PostgresPool,
  images: Pick<ImageStore, "linkMessage">,
) {
  async function closeAlbum(
    client: PostgresPoolClient,
    id: string,
    messageId: string | null,
  ): Promise<void> {
    const closed = await client.query(
      `UPDATE image_offline_event SET closed_at = clock_timestamp(), message_id = $2
       WHERE id = $1 AND closed_at IS NULL`,
      [id, messageId],
    );
    if (closed.rowCount !== 1) return;
    await client.query(
      `DELETE FROM image_asset AS asset USING image_job AS job
       WHERE asset.job_id = job.id AND job.offline_event_id = $1 AND asset.message_id IS NULL`,
      [id],
    );
    await client.query(
      `UPDATE image_job
       SET status = 'skipped', skip_reason = 'offline_album_closed', finished_at = now(), updated_at = now(),
           offline_lease_token = NULL, offline_lease_until = NULL
       WHERE offline_event_id = $1 AND status IN ('pending', 'running', 'rendered')`,
      [id],
    );
  }

  return {
    register: async (
      event: OfflinePhotoEvent,
      access: PhotoAccess,
    ): Promise<void> => {
      await withTransaction(pool, async (client) => {
        const result = await client.query(
          `INSERT INTO image_offline_event (id, started_at, return_at, publish_by, photo_access)
           SELECT $1, $2, $3, $4, $5 WHERE $3::timestamptz > clock_timestamp()
           ON CONFLICT (id) DO NOTHING`,
          [event.id, event.startedAt, event.returnAt, event.publishBy, access],
        );
        if (result.rowCount !== 1) return;
        for (const shot of event.shots) {
          const requiredAccess = offlineShotAccess(shot);
          if (access < requiredAccess) continue;
          await client.query(
            `INSERT INTO image_job (user_text, companion_response, local_date_time, photo_access,
                                    offline_event_id, offline_position, offline_rank)
             VALUES ('', '', $1, $2, $3, $4, $5)`,
            [
              shot.localDateTime,
              requiredAccess,
              event.id,
              shot.position,
              shot.rank,
            ],
          );
        }
      });
    },

    markReturned: async (event: OfflinePhotoEvent): Promise<void> => {
      await pool.query(
        `UPDATE image_offline_event SET completed_at = $4
         WHERE id = $1 AND started_at = $2 AND return_at = $3
           AND completed_at IS NULL AND closed_at IS NULL`,
        [event.id, event.startedAt, event.returnAt, event.completedAt],
      );
    },

    claimShot: async (
      eventId: string,
      access: PhotoAccess,
      leaseMs: number,
      maxAttempts: number,
    ): Promise<OfflineShotClaim | null> => {
      const result = await pool.query<{
        id: string;
        offline_position: number;
        photo_access: PhotoAccess;
        offline_lease_token: string;
      }>(
        `WITH candidate AS (
           SELECT job.id FROM image_job AS job
           JOIN image_offline_event AS event ON event.id = job.offline_event_id
           WHERE job.offline_event_id = $1 AND event.closed_at IS NULL
             AND event.completed_at IS NULL AND event.return_at > clock_timestamp()
             AND job.photo_access <= $2 AND job.attempts < $4
             AND ((job.status = 'pending' AND job.next_attempt_at <= clock_timestamp())
               OR (job.status = 'running' AND job.offline_lease_until <= clock_timestamp()))
           ORDER BY job.offline_rank
           LIMIT 1 FOR UPDATE OF job SKIP LOCKED
         )
         UPDATE image_job AS job
         SET status = 'running', attempts = job.attempts + 1, started_at = clock_timestamp(), updated_at = now(),
             offline_lease_token = gen_random_uuid(),
             offline_lease_until = clock_timestamp() + ($3::bigint * interval '1 millisecond')
         FROM candidate WHERE job.id = candidate.id
         RETURNING job.id, job.offline_position, job.photo_access, job.offline_lease_token`,
        [eventId, access, leaseMs, maxAttempts],
      );
      const row = result.rows[0];
      return row === undefined
        ? null
        : {
            id: row.id,
            position: row.offline_position,
            requiredAccess: row.photo_access,
            token: row.offline_lease_token,
          };
    },

    failShot: async (
      claim: OfflineShotClaim,
      category: string,
      maxAttempts: number,
    ): Promise<void> => {
      await pool.query(
        `UPDATE image_job
         SET status = CASE WHEN attempts >= $4 THEN 'failed' ELSE 'pending' END,
             finished_at = CASE WHEN attempts >= $4 THEN now() ELSE finished_at END,
             next_attempt_at = now() + interval '30 seconds', error_category = $3, updated_at = now(),
             offline_lease_token = NULL, offline_lease_until = NULL
         WHERE id = $1 AND status = 'running' AND offline_lease_token = $2
           AND offline_lease_until > clock_timestamp()`,
        [claim.id, claim.token, category, maxAttempts],
      );
    },

    expireAlbums: async (): Promise<void> => {
      await withTransaction(pool, async (client) => {
        const { rows } = await client.query<{ id: string }>(
          `SELECT id FROM image_offline_event
           WHERE closed_at IS NULL AND publish_by <= clock_timestamp()
           FOR UPDATE SKIP LOCKED`,
        );
        for (const { id } of rows) await closeAlbum(client, id, null);
      });
    },

    nextAlbum: async (): Promise<string | null> => {
      const { rows } = await pool.query<{ id: string }>(
        `SELECT event.id FROM image_offline_event AS event
         WHERE event.completed_at IS NOT NULL AND event.closed_at IS NULL
           AND event.return_at <= clock_timestamp() AND event.publish_by > clock_timestamp()
           AND EXISTS (SELECT 1 FROM image_job WHERE offline_event_id = event.id AND status = 'rendered')
         ORDER BY event.return_at LIMIT 1`,
      );
      return rows[0]?.id ?? null;
    },

    prepareAlbum: async (
      client: PostgresPoolClient,
      id: string,
      access: PhotoAccess,
    ): Promise<ReadyAlbum | null> => {
      const {
        rows: [event],
      } = await client.query<{ publish_by: Date; photo_access: number }>(
        `SELECT publish_by, photo_access FROM image_offline_event
         WHERE id = $1 AND completed_at IS NOT NULL AND closed_at IS NULL
           AND return_at <= clock_timestamp() AND publish_by > clock_timestamp()
         FOR UPDATE`,
        [id],
      );
      if (event === undefined) return null;
      const allowed = Math.min(access, event.photo_access);
      if (allowed === 0) {
        await closeAlbum(client, id, null);
        return null;
      }
      const { rows } = await client.query<{ id: string; photo_access: number }>(
        `SELECT id, photo_access FROM image_job
         WHERE offline_event_id = $1 AND status = 'rendered' AND photo_access <= $2
         ORDER BY offline_rank`,
        [id, allowed],
      );
      if (rows.length === 0) return null;

      // Recipe ranks are randomized per event. Reserve the best-ranked shot
      // in each ready category before drawing how many extras to include.
      const categories = new Set<number>();
      const required: string[] = [];
      const extras: string[] = [];
      for (const shot of rows) {
        if (categories.has(shot.photo_access)) {
          extras.push(shot.id);
        } else {
          categories.add(shot.photo_access);
          required.push(shot.id);
        }
      }
      const extraCount = randomInt(extras.length + 1);
      return { id, publishBy: event.publish_by, jobIds: required.concat(extras.slice(0, extraCount)) };
    },

    cancelAlbum: (client: PostgresPoolClient, id: string) =>
      closeAlbum(client, id, null),

    publishAlbum: async (
      client: PostgresPoolClient,
      album: ReadyAlbum,
      messageId: string,
    ): Promise<void> => {
      for (const jobId of album.jobIds)
        await images.linkMessage(client, jobId, messageId);
      await closeAlbum(client, album.id, messageId);
    },
  };
}

export type OfflineImageStore = ReturnType<typeof createOfflineImageStore>;
