import type { Migration } from "@companion/postgres";

/** Generic, disabled-by-default fixture demonstrating the exact executable path. */
export const EXAMPLE_PROMPT_MODULE_FUNCTION =
  '(context: PromptModuleContext): string => "Example: I am ready to continue the conversation."';

const PROMPT_MODULE_SCHEMA = `
CREATE TABLE prompt_module (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  module_key text NOT NULL UNIQUE
    CHECK (module_key ~ '^[a-z][a-z0-9_-]{0,63}$'),
  decision_description text NOT NULL
    CHECK (length(btrim(decision_description)) > 0 AND length(decision_description) <= 4000),
  function_definition text NOT NULL
    CHECK (length(btrim(function_definition)) > 0 AND length(function_definition) <= 131072),
  fallback_content text
    CHECK (fallback_content IS NULL OR
      (length(btrim(fallback_content)) > 0 AND length(fallback_content) <= 16000)),
  enabled boolean NOT NULL DEFAULT false,
  position integer NOT NULL DEFAULT 0,
  timeout_ms integer NOT NULL DEFAULT 5000
    CHECK (timeout_ms BETWEEN 1 AND 30000),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX prompt_module_enabled_order_idx
  ON prompt_module (enabled, position, id);

CREATE TABLE trace_attempt_prompt_module (
  attempt_id uuid NOT NULL REFERENCES trace_attempt (id),
  module_id uuid NOT NULL,
  module_key text NOT NULL,
  position integer NOT NULL,
  decision_description text NOT NULL,
  function_hash text NOT NULL CHECK (function_hash ~ '^[0-9a-f]{64}$'),
  fallback_available boolean NOT NULL,
  decision_state text NOT NULL DEFAULT 'not_requested'
    CHECK (decision_state IN ('not_requested', 'requested', 'responded', 'failed', 'invalid')),
  decision_model text,
  response_model text,
  response_provider text,
  decision_choice text,
  selected boolean,
  decision_confidence double precision,
  decision_ms integer CHECK (decision_ms IS NULL OR decision_ms >= 0),
  execution_state text NOT NULL DEFAULT 'not_selected'
    CHECK (execution_state IN ('not_selected', 'pending', 'succeeded', 'failed', 'timed_out', 'invalid_result')),
  execution_ms integer CHECK (execution_ms IS NULL OR execution_ms >= 0),
  failure_kind text CHECK (failure_kind IS NULL OR failure_kind IN (
    'decision_transport', 'decision_invalid', 'decision_unusable',
    'execution_error', 'execution_timeout', 'execution_invalid_result')),
  fallback_used boolean NOT NULL DEFAULT false,
  included boolean NOT NULL DEFAULT false,
  requested_at timestamptz,
  decided_at timestamptz,
  executed_at timestamptz,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (attempt_id, module_id),
  CHECK (selected IS NULL OR decision_state = 'responded'),
  CHECK (NOT fallback_used OR (selected IS TRUE AND included)),
  CHECK (NOT included OR selected IS TRUE)
);
CREATE INDEX trace_attempt_prompt_module_order_idx
  ON trace_attempt_prompt_module (attempt_id, position, module_key);

CREATE TABLE trace_attempt_prompt_module_probability (
  attempt_id uuid NOT NULL,
  module_id uuid NOT NULL,
  option_id text NOT NULL,
  value double precision NOT NULL,
  PRIMARY KEY (attempt_id, module_id, option_id),
  FOREIGN KEY (attempt_id, module_id)
    REFERENCES trace_attempt_prompt_module (attempt_id, module_id)
);

INSERT INTO prompt_module
  (module_key, decision_description, function_definition, enabled, position, timeout_ms)
VALUES
  (
    'generic_example',
    'Use this generic example module when a brief supplementary status thought is appropriate.',
    '${EXAMPLE_PROMPT_MODULE_FUNCTION}',
    false,
    0,
    5000
  );

ALTER TABLE trace_attempt_chat_message
  DROP CONSTRAINT trace_attempt_chat_message_chunk_check;
ALTER TABLE trace_attempt_chat_message
  ADD CONSTRAINT trace_attempt_chat_message_chunk_check
  CHECK (chunk IN (
    'identity', 'profiles', 'temporal', 'recall', 'article', 'relationship',
    'routine', 'guidance', 'prompt_module', 'conversation'
  ));
`;

const PROMPT_MODULE_CHAT_ATTRIBUTION = `
ALTER TABLE trace_attempt_prompt_module
  ADD COLUMN execution_ordinal integer CHECK (execution_ordinal IS NULL OR execution_ordinal >= 0),
  ADD COLUMN output_ready boolean NOT NULL DEFAULT false,
  ADD COLUMN fallback_selected boolean NOT NULL DEFAULT false;

-- Migration 0018 used included/fallback_used for pre-chat readiness. Preserve
-- that fact separately, then establish actual inclusion only from an exact
-- prompt_module message in the persisted chat request below.
UPDATE trace_attempt_prompt_module
SET output_ready = included,
    fallback_selected = fallback_used,
    included = false,
    fallback_used = false;

WITH ranked AS (
  SELECT attempt_id, module_id,
         row_number() OVER (PARTITION BY attempt_id ORDER BY position, module_id) - 1 AS ordinal
  FROM trace_attempt_prompt_module
  WHERE execution_state IN ('succeeded', 'failed', 'timed_out', 'invalid_result')
)
UPDATE trace_attempt_prompt_module AS module
SET execution_ordinal = ranked.ordinal
FROM ranked
WHERE ranked.attempt_id = module.attempt_id
  AND ranked.module_id = module.module_id;

ALTER TABLE trace_attempt_chat
  ADD CONSTRAINT trace_attempt_chat_attempt_id_id_key UNIQUE (attempt_id, id);

CREATE TABLE trace_attempt_prompt_module_chat_message (
  attempt_id uuid NOT NULL,
  module_id uuid NOT NULL,
  chat_id uuid NOT NULL,
  message_position integer NOT NULL CHECK (message_position >= 0),
  PRIMARY KEY (attempt_id, module_id),
  UNIQUE (chat_id, message_position),
  FOREIGN KEY (attempt_id, module_id)
    REFERENCES trace_attempt_prompt_module (attempt_id, module_id),
  FOREIGN KEY (attempt_id, chat_id)
    REFERENCES trace_attempt_chat (attempt_id, id),
  FOREIGN KEY (chat_id, message_position)
    REFERENCES trace_attempt_chat_message (chat_id, position)
    ON DELETE CASCADE
    DEFERRABLE INITIALLY DEFERRED
);

-- Backfill only when every prepared module maps one-to-one to the exact
-- historical prompt_module chunks. Unmatched/partial attempts remain omitted.
WITH ranked_modules AS (
  SELECT attempt_id, module_id,
         row_number() OVER (PARTITION BY attempt_id ORDER BY position, module_id) - 1 AS ordinal
  FROM trace_attempt_prompt_module
  WHERE output_ready
), ranked_messages AS (
  SELECT chat.attempt_id, message.chat_id, message.position,
         row_number() OVER (PARTITION BY chat.attempt_id ORDER BY message.position) - 1 AS ordinal
  FROM trace_attempt_chat_message AS message
  JOIN trace_attempt_chat AS chat ON chat.id = message.chat_id
  WHERE message.chunk = 'prompt_module'
), module_counts AS (
  SELECT attempt_id, count(*) AS amount, count(DISTINCT position) AS distinct_positions
  FROM ranked_modules
  JOIN trace_attempt_prompt_module USING (attempt_id, module_id)
  GROUP BY attempt_id
), message_counts AS (
  SELECT attempt_id, count(*) AS amount FROM ranked_messages GROUP BY attempt_id
), complete_attempts AS (
  SELECT module_counts.attempt_id
  FROM module_counts
  JOIN message_counts USING (attempt_id)
  WHERE module_counts.amount > 0
    AND module_counts.amount = module_counts.distinct_positions
    AND module_counts.amount = message_counts.amount
)
INSERT INTO trace_attempt_prompt_module_chat_message
  (attempt_id, module_id, chat_id, message_position)
SELECT modules.attempt_id, modules.module_id, messages.chat_id, messages.position
FROM ranked_modules AS modules
JOIN ranked_messages AS messages
  ON messages.attempt_id = modules.attempt_id AND messages.ordinal = modules.ordinal
JOIN complete_attempts AS complete
  ON complete.attempt_id = modules.attempt_id;

CREATE OR REPLACE FUNCTION clear_prompt_module_inclusion_after_chat_message_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE trace_attempt_prompt_module
  SET included = false, fallback_used = false, recorded_at = now()
  WHERE attempt_id = OLD.attempt_id AND module_id = OLD.module_id;
  RETURN OLD;
END;
$$;

CREATE TRIGGER trace_attempt_prompt_module_chat_message_deleted
AFTER DELETE ON trace_attempt_prompt_module_chat_message
FOR EACH ROW
EXECUTE FUNCTION clear_prompt_module_inclusion_after_chat_message_delete();

UPDATE trace_attempt_prompt_module AS module
SET included = true,
    fallback_used = module.fallback_selected
FROM trace_attempt_prompt_module_chat_message AS association
WHERE association.attempt_id = module.attempt_id
  AND association.module_id = module.module_id;

ALTER TABLE trace_attempt_prompt_module
  ADD CONSTRAINT trace_attempt_prompt_module_output_shape CHECK (
    (execution_ordinal IS NULL OR selected IS TRUE)
    AND (NOT output_ready OR selected IS TRUE)
    AND (NOT fallback_selected OR output_ready)
    AND (NOT fallback_used OR (fallback_selected AND included))
    AND (NOT included OR (output_ready AND selected IS TRUE))
  );
`;

export const promptModuleMigrations: readonly Migration[] = [
  { id: "0018_generic_prompt_modules", sql: PROMPT_MODULE_SCHEMA },
  { id: "0019_prompt_module_chat_attribution", sql: PROMPT_MODULE_CHAT_ATTRIBUTION },
];
