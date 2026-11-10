import type { Migration } from "@companion/postgres";

/** Schema only: all schedule and interaction content is private runtime data. */
const ROUTINE_SCHEMA = `
CREATE TABLE routine_settings (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  timezone text NOT NULL CHECK (length(btrim(timezone)) > 0),
  departure_context text CHECK (
    departure_context IS NULL OR length(btrim(departure_context)) > 0
  ),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE routine_transition (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transition_key text NOT NULL UNIQUE CHECK (length(btrim(transition_key)) > 0),
  weekday smallint NOT NULL CHECK (weekday BETWEEN 1 AND 7),
  local_minute smallint NOT NULL CHECK (local_minute BETWEEN 0 AND 1439),
  location text CHECK (location IS NULL OR length(btrim(location)) > 0),
  activity text CHECK (activity IS NULL OR length(btrim(activity)) > 0),
  available boolean NOT NULL,
  interaction_context text CHECK (
    interaction_context IS NULL OR length(btrim(interaction_context)) > 0
  ),
  enabled boolean NOT NULL DEFAULT true,
  UNIQUE (weekday, local_minute)
);
CREATE INDEX routine_transition_enabled_order_idx
  ON routine_transition (weekday, local_minute, transition_key)
  WHERE enabled = true;

-- Append-only record of transitions actually applied by the reconciler.
CREATE TABLE routine_applied_transition (
  transition_id uuid NOT NULL,
  transition_key text NOT NULL,
  local_date date NOT NULL,
  scheduled_at timestamptz NOT NULL,
  applied_at timestamptz NOT NULL,
  location text,
  activity text,
  available boolean NOT NULL,
  interaction_context text,
  PRIMARY KEY (transition_id, local_date)
);
CREATE INDEX routine_applied_transition_order_idx
  ON routine_applied_transition (scheduled_at DESC, transition_key DESC);

-- The materialized applied state is separate from the schedule's state at now.
CREATE TABLE routine_applied_state (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  transition_id uuid NOT NULL,
  transition_key text NOT NULL,
  local_date date NOT NULL,
  scheduled_at timestamptz NOT NULL,
  applied_at timestamptz NOT NULL,
  location text,
  activity text,
  available boolean NOT NULL,
  interaction_context text
);
`;

const CREATE_ROUTINE_ANNOUNCEMENT = `
-- Durable one-per-unavailable-period notice outbox. The assistant message and
-- this event's published state are committed in the same conversation-owned
-- transaction; old pending events are cancelled when their schedule is obsolete.
CREATE TABLE routine_announcement (
  transition_id uuid NOT NULL,
  transition_key text NOT NULL,
  local_date date NOT NULL,
  scheduled_at timestamptz NOT NULL,
  timezone text NOT NULL,
  departure_context text,
  location text,
  activity text,
  resumes_at timestamptz,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'published', 'cancelled')),
  message_id uuid UNIQUE REFERENCES conversation_message (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  cancelled_at timestamptz,
  PRIMARY KEY (transition_id, local_date),
  CHECK (
    (status = 'published' AND message_id IS NOT NULL AND published_at IS NOT NULL)
    OR
    (status <> 'published' AND message_id IS NULL AND published_at IS NULL)
  )
);
CREATE INDEX routine_announcement_pending_idx
  ON routine_announcement (scheduled_at, transition_key)
  WHERE status = 'pending';
CREATE INDEX routine_announcement_published_idx
  ON routine_announcement (published_at DESC)
  WHERE status = 'published';
`;

const UPGRADE_ROUTINE_ANNOUNCEMENT_PERIOD_ID = `
-- A transition occurrence is not an absence-period identity: edits can end and
-- re-enter an unavailable period on the same transition/date. Give each
-- observed period its own durable identity while preserving existing rows.
ALTER TABLE routine_announcement ADD COLUMN id uuid;
UPDATE routine_announcement SET id = gen_random_uuid() WHERE id IS NULL;
ALTER TABLE routine_announcement ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE routine_announcement ALTER COLUMN id SET NOT NULL;
ALTER TABLE routine_announcement DROP CONSTRAINT routine_announcement_pkey;
ALTER TABLE routine_announcement ADD CONSTRAINT routine_announcement_pkey PRIMARY KEY (id);
ALTER TABLE routine_announcement ADD COLUMN ended_at timestamptz;
ALTER TABLE routine_announcement DROP CONSTRAINT IF EXISTS routine_announcement_status_check;
ALTER TABLE routine_announcement DROP CONSTRAINT IF EXISTS routine_announcement_check;
ALTER TABLE routine_announcement DROP CONSTRAINT IF EXISTS routine_announcement_state_shape_check;
ALTER TABLE routine_announcement
  ADD CONSTRAINT routine_announcement_status_check
    CHECK (status IN ('pending', 'published', 'cancelled', 'ended')),
  ADD CONSTRAINT routine_announcement_state_shape_check CHECK (
    (status IN ('published', 'ended') AND message_id IS NOT NULL AND published_at IS NOT NULL)
    OR
    (status IN ('pending', 'cancelled') AND message_id IS NULL AND published_at IS NULL)
  ),
  ADD CONSTRAINT routine_announcement_ended_at_check
    CHECK ((status = 'ended') = (ended_at IS NOT NULL));
WITH ranked_pending AS (
  SELECT id, row_number() OVER (ORDER BY created_at DESC, scheduled_at DESC) AS position
  FROM routine_announcement
  WHERE status = 'pending'
)
UPDATE routine_announcement AS announcement
SET status = 'cancelled', cancelled_at = clock_timestamp(), updated_at = clock_timestamp()
FROM ranked_pending
WHERE announcement.id = ranked_pending.id AND ranked_pending.position > 1;
CREATE UNIQUE INDEX routine_announcement_single_pending_idx
  ON routine_announcement ((1))
  WHERE status = 'pending';
DROP INDEX IF EXISTS routine_announcement_pending_idx;
CREATE INDEX routine_announcement_pending_idx
  ON routine_announcement (created_at, transition_key)
  WHERE status = 'pending';
`;

const ADD_ROUTINE_CHAT_CHUNK = `
  ALTER TABLE trace_attempt_chat_message
    DROP CONSTRAINT trace_attempt_chat_message_chunk_check;
  ALTER TABLE trace_attempt_chat_message
    ADD CONSTRAINT trace_attempt_chat_message_chunk_check
    CHECK (chunk IN ('identity', 'profiles', 'temporal', 'recall', 'article', 'relationship', 'routine', 'guidance', 'conversation'));
`;

export const routineMigrations: readonly Migration[] = [
  { id: "0012_routine_schedule", sql: ROUTINE_SCHEMA },
  { id: "0013_routine_chat_chunk", sql: ADD_ROUTINE_CHAT_CHUNK },
  { id: "0014_routine_announcement", sql: CREATE_ROUTINE_ANNOUNCEMENT },
  { id: "0015_routine_announcement_period_id", sql: UPGRADE_ROUTINE_ANNOUNCEMENT_PERIOD_ID },
];
