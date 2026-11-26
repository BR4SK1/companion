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

const ADD_IMAGE_SCENE_DESCRIPTION_AND_CHAT_CHUNK = `
ALTER TABLE image_job
  ADD COLUMN scene_description text;

ALTER TABLE trace_attempt_chat_message
  DROP CONSTRAINT trace_attempt_chat_message_chunk_check;
ALTER TABLE trace_attempt_chat_message
  ADD CONSTRAINT trace_attempt_chat_message_chunk_check
  CHECK (chunk IN (
    'identity', 'profiles', 'temporal', 'time', 'recall', 'article',
    'relationship', 'routine', 'guidance', 'prompt_module', 'image',
    'conversation'
  ));
`;

const ADD_OFFLINE_PHOTOS = `
CREATE TABLE image_offline_event (
  id text PRIMARY KEY,
  started_at timestamptz NOT NULL,
  return_at timestamptz NOT NULL,
  publish_by timestamptz NOT NULL,
  completed_at timestamptz,
  photo_access smallint NOT NULL CHECK (photo_access IN (0, 1, 3)),
  closed_at timestamptz,
  message_id uuid REFERENCES conversation_message (id),
  CHECK (started_at < return_at AND return_at < publish_by),
  CHECK (completed_at IS NULL OR completed_at >= return_at),
  CHECK (message_id IS NULL OR closed_at IS NOT NULL)
);

ALTER TABLE image_job
  ALTER COLUMN turn_id DROP NOT NULL,
  ADD COLUMN photo_access smallint CHECK (photo_access IN (1, 3)),
  ADD COLUMN offline_event_id text REFERENCES image_offline_event (id),
  ADD COLUMN offline_position smallint CHECK (offline_position BETWEEN 0 AND 5),
  ADD COLUMN offline_rank smallint CHECK (offline_rank BETWEEN 0 AND 5),
  ADD COLUMN offline_lease_token uuid,
  ADD COLUMN offline_lease_until timestamptz,
  ADD CONSTRAINT image_job_source CHECK (
    (turn_id IS NOT NULL AND offline_event_id IS NULL AND offline_position IS NULL AND offline_rank IS NULL)
    OR (turn_id IS NULL AND offline_event_id IS NOT NULL AND offline_position IS NOT NULL AND offline_rank IS NOT NULL AND photo_access IS NOT NULL)
  ),
  ADD CONSTRAINT image_job_offline_position UNIQUE (offline_event_id, offline_position);

CREATE INDEX image_offline_event_open_idx ON image_offline_event (publish_by)
  WHERE closed_at IS NULL;
`;

export const imageMigrations: readonly Migration[] = [
  { id: "0032_image_generation", sql: CREATE_IMAGE_GENERATION },
  {
    id: "0033_image_scene_description",
    sql: ADD_IMAGE_SCENE_DESCRIPTION_AND_CHAT_CHUNK,
  },
  { id: "0034_image_offline_photos", sql: ADD_OFFLINE_PHOTOS },
  {
    id: "0035_offline_photo_access",
    sql: `
ALTER TABLE image_offline_event DROP CONSTRAINT image_offline_event_photo_access_check,
  ADD CHECK (photo_access IN (0, 1, 2, 3));
ALTER TABLE image_job DROP CONSTRAINT image_job_photo_access_check,
  ADD CHECK (photo_access IN (1, 2, 3));
`,
  },
];
