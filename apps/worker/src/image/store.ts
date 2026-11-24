/**
 * Durable image-job persistence. One job per published turn (unique
 * `turn_id`); rendered bytes are stored before the thread message that
 * carries them is published, so a crash between rendering and publication
 * loses neither. Publication linking runs inside the conversation domain's
 * assistant-message transaction (see `linkMessage`).
 */

import { withTransaction, type PostgresPool, type PostgresPoolClient } from "@companion/postgres";

import type {
  ImageJob,
  ImagePlanSummary,
  MessageImageRef,
  PriorPose,
  RenderedImage,
} from "./types.ts";

interface JobRow {
  id: string;
  turn_id: string;
  status: string;
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
  error_category: string | null;
  message_id: string | null;
  created_at: Date;
}

const JOB_COLUMNS =
  "id, turn_id, status, attempts, pattern_id, user_text, companion_response, " +
  "local_date_time, prompt_id, plan_location, plan_time_period, " +
  "plan_pose_category, plan_pose_variant_id, plan_expression, " +
  "plan_hand_gesture, plan_camera_angle, plan_intimacy, " +
  "plan_clothing_summary, error_category, message_id, created_at";

function mapJob(row: JobRow): ImageJob {
  return {
    id: row.id,
    turnId: row.turn_id,
    status: row.status as ImageJob["status"],
    attempts: row.attempts,
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
      readonly images: readonly RenderedImage[];
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
  readonly releaseRendered: (jobId: string) => Promise<void>;
  readonly loadPriorPose: () => Promise<PriorPose | null>;
  readonly getImage: (
    id: string,
  ) => Promise<{ readonly mimeType: string; readonly data: Buffer } | null>;
  readonly getImagesForMessages: (
    messageIds: readonly string[],
  ) => Promise<ReadonlyMap<string, readonly MessageImageRef[]>>;
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
         WHERE status = 'running'`,
      );
      return result.rowCount ?? 0;
    },

    claimNextDue: async () =>
      withTransaction(pool, async (client) => {
        const result = await client.query<JobRow>(
          `SELECT ${JOB_COLUMNS} FROM image_job
           WHERE status = 'pending' AND next_attempt_at <= now()
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
        await client.query(
          `UPDATE image_job
           SET status = 'rendered', prompt_id = $2,
               plan_location = $3, plan_time_period = $4,
               plan_pose_category = $5, plan_pose_variant_id = $6,
               plan_expression = $7, plan_hand_gesture = $8,
               plan_camera_angle = $9, plan_intimacy = $10,
               plan_clothing_summary = $11,
               error_category = NULL, updated_at = now()
           WHERE id = $1 AND status = 'running'`,
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
          ],
        );
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
         WHERE status = 'rendered'
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
         ORDER BY finished_at DESC NULLS LAST, created_at DESC
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
        `SELECT mime_type, data FROM image_asset WHERE id = $1`,
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
         ORDER BY a.created_at ASC`,
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
  };
}
