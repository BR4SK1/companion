/**
 * Durable image-job persistence. One job per published turn (unique
 * `turn_id`); rendered bytes are stored before the thread message that
 * carries them is published, so a crash between rendering and publication
 * loses neither. Publication linking runs inside the conversation domain's
 * assistant-message transaction (see `linkMessage`).
 */

import { withTransaction, type PostgresPool, type PostgresPoolClient } from "@companion/postgres";

import { fallbackSceneDescription } from "./context.ts";
import type {
  ImageJob,
  ImagePlanSummary,
  MessageImageRef,
  PriorPose,
  RecentSentImage,
  RenderedImage,
} from "./types.ts";

interface JobRow {
  id: string;
  turn_id: string;
  status: string;
  photo_access: ImageJob["photoAccess"];
  attempts: number;
  pattern_id: string | null;
  user_text: string;
  companion_response: string;
  local_date_time: string;
  prompt_id: string | null;
  plan_location: string | null;
  plan_time_period: string | null;
  plan_pose_category: string | null;
  plan_pose_variant_id: string | null;
  plan_expression: string | null;
  plan_hand_gesture: string | null;
  plan_camera_angle: string | null;
  plan_intimacy: string | null;
  plan_clothing_summary: string | null;
  scene_description: string | null;
  error_category: string | null;
  message_id: string | null;
  created_at: Date;
}

const JOB_COLUMNS =
  "id, turn_id, status, attempts, photo_access, pattern_id, user_text, companion_response, " +
  "local_date_time, prompt_id, plan_location, plan_time_period, " +
  "plan_pose_category, plan_pose_variant_id, plan_expression, " +
  "plan_hand_gesture, plan_camera_angle, plan_intimacy, " +
  "plan_clothing_summary, scene_description, error_category, message_id, created_at";

function mapJob(row: JobRow): ImageJob {
  return {
    id: row.id,
    turnId: row.turn_id,
    status: row.status as ImageJob["status"],
    attempts: row.attempts,
    photoAccess: row.photo_access,
    patternId: row.pattern_id,
    userText: row.user_text,
    companionResponse: row.companion_response,
    localDateTime: row.local_date_time,
    promptId: row.prompt_id,
    plan: {
      location: row.plan_location,
      timePeriod: row.plan_time_period,
      poseCategory: row.plan_pose_category,
      poseVariantId: row.plan_pose_variant_id,
      expression: row.plan_expression,
      handGesture: row.plan_hand_gesture,
      cameraAngle: row.plan_camera_angle,
      intimacy: row.plan_intimacy,
      clothingSummary: row.plan_clothing_summary,
    },
    sceneDescription: row.scene_description,
    errorCategory: row.error_category,
    messageId: row.message_id,
    createdAt: row.created_at.toISOString(),
  };
}

export interface ImageStore {
  readonly enqueueTurn: (input: {
    readonly turnId: string;
    readonly patternId: string | null;
    readonly userText: string;
    readonly companionResponse: string;
    readonly localDateTime: string;
  }) => Promise<boolean>;
  /** Reset jobs left `running` by a crashed worker back to pending. */
  readonly resetStaleRunning: () => Promise<number>;
  readonly claimNextDue: () => Promise<ImageJob | null>;
  readonly markSkipped: (jobId: string, reason: string) => Promise<void>;
  readonly saveRendered: (
    jobId: string,
    input: {
      readonly promptId: string;
      readonly plan: ImagePlanSummary;
      readonly sceneDescription?: string | null;
      readonly images: readonly RenderedImage[];
      readonly offlineLease?: { readonly eventId: string; readonly token: string };
    },
  ) => Promise<void>;
  readonly failJob: (input: {
    readonly jobId: string;
    readonly category: string;
    readonly maxAttempts: number;
    readonly backoffMs: number;
  }) => Promise<void>;
  readonly nextRendered: () => Promise<ImageJob | null>;
  /** Link a rendered job to its published thread message, in the publisher's transaction. */
  readonly linkMessage: (
    client: PostgresPoolClient,
    jobId: string,
    messageId: string,
  ) => Promise<void>;
  /** Release a rendered job whose publication was refused (e.g. a turn is in flight). */
  readonly isRendered: (client: PostgresPoolClient, jobId: string) => Promise<boolean>;
  readonly releaseRendered: (jobId: string) => Promise<void>;
  readonly loadPriorPose: () => Promise<PriorPose | null>;
  readonly getImage: (
    id: string,
  ) => Promise<{ readonly mimeType: string; readonly data: Buffer } | null>;
  readonly getImagesForMessages: (
    messageIds: readonly string[],
  ) => Promise<ReadonlyMap<string, readonly MessageImageRef[]>>;
  /**
   * Recently published photos inside the current session window for a claimed
   * turn (oldest first, bounded by `limit`), so the chat prompt can report
   * what images were already sent without adding synthetic assistant turns.
   */
  readonly getRecentSentImagesForTurn: (input: {
    readonly turnId: string;
    readonly sinceMessageId: string;
    readonly lastHistoryMessageId: string;
    readonly limit: number;
  }) => Promise<readonly RecentSentImage[]>;
}

export function createImageStore(pool: PostgresPool): ImageStore {
  return {
    enqueueTurn: async (input) => {
      const result = await pool.query(
        `INSERT INTO image_job
           (turn_id, pattern_id, user_text, companion_response, local_date_time)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (turn_id) DO NOTHING`,
        [
          input.turnId,
          input.patternId,
          input.userText,
          input.companionResponse,
          input.localDateTime,
        ],
      );
      return (result.rowCount ?? 0) > 0;
    },

    resetStaleRunning: async () => {
      const result = await pool.query(
        `UPDATE image_job
         SET status = 'pending', next_attempt_at = now(), updated_at = now()
         WHERE status = 'running' AND turn_id IS NOT NULL`,
      );
      return result.rowCount ?? 0;
    },

    claimNextDue: async () =>
      withTransaction(pool, async (client) => {
        const result = await client.query<JobRow>(
          `SELECT ${JOB_COLUMNS} FROM image_job
           WHERE turn_id IS NOT NULL AND status = 'pending' AND next_attempt_at <= now()
           ORDER BY created_at ASC
           LIMIT 1
           FOR UPDATE SKIP LOCKED`,
        );
        const row = result.rows[0];
        if (row === undefined) return null;
        const updated = await client.query<JobRow>(
          `UPDATE image_job
           SET status = 'running', attempts = attempts + 1,
               started_at = now(), updated_at = now()
           WHERE id = $1
           RETURNING ${JOB_COLUMNS}`,
          [row.id],
        );
        return updated.rows[0] === undefined ? null : mapJob(updated.rows[0]);
      }),

    markSkipped: async (jobId, reason) => {
      await pool.query(
        `UPDATE image_job
         SET status = 'skipped', skip_reason = $2, finished_at = now(), updated_at = now()
         WHERE id = $1 AND status = 'running'`,
        [jobId, reason],
      );
    },

    saveRendered: async (jobId, input) => {
      await withTransaction(pool, async (client) => {
        if (input.offlineLease !== undefined) {
          const active = await client.query(
            `SELECT id FROM image_offline_event
             WHERE id = $1 AND closed_at IS NULL AND publish_by > clock_timestamp()
             FOR UPDATE`,
            [input.offlineLease.eventId],
          );
          if (active.rows.length === 0) return;
        }
        const updated = await client.query(
          `UPDATE image_job
           SET status = 'rendered', prompt_id = $2,
               plan_location = $3, plan_time_period = $4,
               plan_pose_category = $5, plan_pose_variant_id = $6,
               plan_expression = $7, plan_hand_gesture = $8,
               plan_camera_angle = $9, plan_intimacy = $10,
               plan_clothing_summary = $11, scene_description = $12,
               error_category = NULL, updated_at = now(),
               offline_lease_token = NULL, offline_lease_until = NULL
           WHERE id = $1 AND status = 'running'
             AND ((turn_id IS NOT NULL AND $13::uuid IS NULL)
               OR (offline_event_id = $14 AND offline_lease_token = $13
                 AND offline_lease_until > clock_timestamp()))`,
          [
            jobId,
            input.promptId,
            input.plan.location,
            input.plan.timePeriod,
            input.plan.poseCategory,
            input.plan.poseVariantId,
            input.plan.expression,
            input.plan.handGesture,
            input.plan.cameraAngle,
            input.plan.intimacy,
            input.plan.clothingSummary,
            input.sceneDescription ?? null,
            input.offlineLease?.token ?? null,
            input.offlineLease?.eventId ?? null,
          ],
        );
        if (updated.rowCount !== 1) return;
        for (const image of input.images) {
          await client.query(
            `INSERT INTO image_asset
               (job_id, filename, mime_type, width, height, size_bytes, data)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [
              jobId,
              image.filename,
              image.mimeType,
              image.width,
              image.height,
              image.data.byteLength,
              image.data,
            ],
          );
        }
      });
    },

    failJob: async ({ jobId, category, maxAttempts, backoffMs }) => {
      await pool.query(
        `UPDATE image_job
         SET status = CASE WHEN attempts >= $3 THEN 'failed' ELSE 'pending' END,
             finished_at = CASE WHEN attempts >= $3 THEN now() ELSE finished_at END,
             error_category = $2,
             next_attempt_at = now() + ($4::integer * interval '1 millisecond'),
             updated_at = now()
         WHERE id = $1 AND status = 'running'`,
        [jobId, category, maxAttempts, backoffMs],
      );
    },

    nextRendered: async () => {
      const result = await pool.query<JobRow>(
        `SELECT ${JOB_COLUMNS} FROM image_job
         WHERE status = 'rendered' AND turn_id IS NOT NULL
         ORDER BY created_at ASC
         LIMIT 1`,
      );
      const row = result.rows[0];
      return row === undefined ? null : mapJob(row);
    },

    linkMessage: async (client, jobId, messageId) => {
      await client.query(
        `UPDATE image_asset SET message_id = $2 WHERE job_id = $1`,
        [jobId, messageId],
      );
      await client.query(
        `UPDATE image_job
         SET status = 'succeeded', message_id = $2, finished_at = now(), updated_at = now()
         WHERE id = $1 AND status = 'rendered'`,
        [jobId, messageId],
      );
    },

    isRendered: async (client, jobId) => {
      const result = await client.query(
        `SELECT id FROM image_job WHERE id = $1 AND status = 'rendered' FOR UPDATE`,
        [jobId],
      );
      return result.rows.length === 1;
    },

    releaseRendered: async (jobId) => {
      await pool.query(
        `UPDATE image_job SET updated_at = now()
         WHERE id = $1 AND status = 'rendered'`,
        [jobId],
      );
    },

    loadPriorPose: async () => {
      const result = await pool.query<JobRow>(
        `SELECT ${JOB_COLUMNS} FROM image_job
         WHERE status = 'succeeded'
         ORDER BY finished_at DESC NULLS LAST, created_at DESC, offline_position DESC NULLS LAST
         LIMIT 1`,
      );
      const row = result.rows[0];
      if (row === undefined) return null;
      const pose: PriorPose = {
        ...(row.plan_pose_variant_id !== null
          ? { poseVariantId: row.plan_pose_variant_id }
          : {}),
        ...(row.plan_pose_category !== null
          ? { poseCategory: row.plan_pose_category }
          : {}),
        ...(row.plan_hand_gesture !== null
          ? { handGesture: row.plan_hand_gesture }
          : {}),
        ...(row.plan_camera_angle !== null
          ? { cameraAngle: row.plan_camera_angle }
          : {}),
        ...(row.plan_expression !== null
          ? { expression: row.plan_expression }
          : {}),
      };
      return Object.keys(pose).length > 0 ? pose : null;
    },

    getImage: async (id) => {
      const result = await pool.query<{ mime_type: string; data: Buffer }>(
        `SELECT mime_type, data FROM image_asset WHERE id = $1 AND message_id IS NOT NULL`,
        [id],
      );
      const row = result.rows[0];
      return row === undefined
        ? null
        : { mimeType: row.mime_type, data: row.data };
    },

    getImagesForMessages: async (messageIds) => {
      const map = new Map<string, MessageImageRef[]>();
      if (messageIds.length === 0) return map;
      const result = await pool.query<{
        id: string;
        message_id: string;
        mime_type: string;
        width: number;
        height: number;
        plan_clothing_summary: string | null;
        plan_location: string | null;
      }>(
        `SELECT a.id, a.message_id, a.mime_type, a.width, a.height,
                j.plan_clothing_summary, j.plan_location
         FROM image_asset AS a
         JOIN image_job AS j ON j.id = a.job_id
         WHERE a.message_id = ANY($1)
         ORDER BY j.offline_position ASC NULLS LAST, a.created_at ASC, a.id ASC`,
        [messageIds],
      );
      for (const row of result.rows) {
        const alt =
          row.plan_clothing_summary !== null && row.plan_clothing_summary.length > 0
            ? `Photo of the companion wearing ${row.plan_clothing_summary}`
            : row.plan_location !== null && row.plan_location.length > 0
              ? `Photo of the companion in the ${row.plan_location}`
              : "Photo of the companion";
        const entry: MessageImageRef = {
          id: row.id,
          mimeType: row.mime_type,
          width: row.width,
          height: row.height,
          alt,
        };
        const existing = map.get(row.message_id);
        if (existing === undefined) map.set(row.message_id, [entry]);
        else existing.push(entry);
      }
      return map;
    },

    getRecentSentImagesForTurn: async (input) => {
      if (input.limit < 1) return [];
      const result = await pool.query<{
        id: string;
        turn_id: string | null;
        message_id: string;
        scene_description: string | null;
        plan_location: string | null;
        plan_time_period: string | null;
        plan_pose_category: string | null;
        plan_pose_variant_id: string | null;
        plan_expression: string | null;
        plan_hand_gesture: string | null;
        plan_camera_angle: string | null;
        plan_intimacy: string | null;
        plan_clothing_summary: string | null;
        published_at: Date;
        thread_order: string;
        after_last_history: boolean;
      }>(
        `WITH bounds AS (
           SELECT
             (SELECT t.thread_order FROM conversation_turn AS t WHERE t.id = $1) AS current_order,
             (
               SELECT COALESCE(t.thread_order, m.thread_order)
               FROM conversation_message AS m
               LEFT JOIN conversation_turn AS t ON t.id = m.turn_id
               WHERE m.id = $2
             ) AS since_order,
             (
               SELECT COALESCE(t.thread_order, m.thread_order)
               FROM conversation_message AS m
               LEFT JOIN conversation_turn AS t ON t.id = m.turn_id
               WHERE m.id = $3
             ) AS last_history_order
         )
         SELECT j.id, j.turn_id, j.message_id, j.scene_description,
                j.plan_location, j.plan_time_period, j.plan_pose_category,
                j.plan_pose_variant_id, j.plan_expression, j.plan_hand_gesture,
                j.plan_camera_angle, j.plan_intimacy, j.plan_clothing_summary,
                m.created_at AS published_at,
                m.thread_order,
                (bounds.last_history_order IS NOT NULL AND m.thread_order > bounds.last_history_order)
                  AS after_last_history
         FROM image_job AS j
         JOIN conversation_message AS m ON m.id = j.message_id
         CROSS JOIN bounds
         WHERE j.status = 'succeeded'
           AND j.message_id IS NOT NULL
           AND bounds.current_order IS NOT NULL
           AND bounds.since_order IS NOT NULL
           AND m.thread_order >= bounds.since_order
           AND m.thread_order < bounds.current_order
         ORDER BY m.thread_order DESC, m.seq DESC, j.offline_position DESC NULLS LAST
         LIMIT $4`,
        [input.turnId, input.sinceMessageId, input.lastHistoryMessageId, input.limit],
      );
      const images: RecentSentImage[] = [];
      for (const row of [...result.rows].reverse()) {
        const stored = row.scene_description?.trim() ?? "";
        const description =
          stored.length > 0
            ? stored
            : fallbackSceneDescription({
                location: row.plan_location,
                timePeriod: row.plan_time_period,
                poseCategory: row.plan_pose_category,
                poseVariantId: row.plan_pose_variant_id,
                expression: row.plan_expression,
                handGesture: row.plan_hand_gesture,
                cameraAngle: row.plan_camera_angle,
                intimacy: row.plan_intimacy,
                clothingSummary: row.plan_clothing_summary,
              });
        if (description === null) continue;
        images.push({
          jobId: row.id,
          turnId: row.turn_id,
          messageId: row.message_id,
          publishedAt: row.published_at.toISOString(),
          threadOrder: Number(row.thread_order),
          afterLastHistory: row.after_last_history,
          sceneDescription: description,
        });
      }
      return images;
    },
  };
}
