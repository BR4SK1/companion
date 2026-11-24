import type { Migration } from "@companion/postgres";

/**
 * Image generation: durable post-turn media jobs and their rendered assets.
 * Relational and feature-owned — plan fields are typed columns, never a
 * generic JSONB payload; raw image bytes live only in `image_asset.data`.
 * Error recording is a fixed category, never provider or service text.
 */
const CREATE_IMAGE_GENERATION = `
CREATE TABLE image_job (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  turn_id uuid NOT NULL UNIQUE REFERENCES conversation_turn (id),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'rendered', 'succeeded', 'skipped', 'failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  pattern_id text,
  user_text text NOT NULL,
  companion_response text NOT NULL,
  local_date_time text NOT NULL,
  prompt_id text,
  plan_location text,
  plan_time_period text,
  plan_pose_category text,
  plan_pose_variant_id text,
  plan_expression text,
  plan_hand_gesture text,
  plan_camera_angle text,
  plan_intimacy text,
  plan_clothing_summary text,
  error_category text,
  skip_reason text,
  message_id uuid REFERENCES conversation_message (id),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX image_job_due_idx ON image_job (created_at)
  WHERE status IN ('pending', 'rendered');

CREATE TABLE image_asset (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES image_job (id),
  message_id uuid REFERENCES conversation_message (id),
  filename text NOT NULL,
  mime_type text NOT NULL CHECK (mime_type IN ('image/webp', 'image/png', 'image/jpeg')),
  width integer NOT NULL CHECK (width > 0),
  height integer NOT NULL CHECK (height > 0),
  size_bytes integer NOT NULL CHECK (size_bytes > 0),
  data bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX image_asset_message_idx ON image_asset (message_id)
  WHERE message_id IS NOT NULL;
CREATE INDEX image_asset_job_idx ON image_asset (job_id);
`;

export const imageMigrations: readonly Migration[] = [
  { id: "0032_image_generation", sql: CREATE_IMAGE_GENERATION },
];
