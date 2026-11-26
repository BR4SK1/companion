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

const PROMPT_MODULE_ACTIVATION_MODES = `
ALTER TABLE prompt_module
  ADD COLUMN activation_mode text NOT NULL DEFAULT 'model_gated'
    CHECK (activation_mode IN ('model_gated', 'every_turn')),
  ADD COLUMN output_kind text NOT NULL DEFAULT 'thoughts'
    CHECK (output_kind IN ('thoughts', 'authoritative_context'));

ALTER TABLE trace_attempt_prompt_module
  ADD COLUMN activation_mode text NOT NULL DEFAULT 'model_gated'
    CHECK (activation_mode IN ('model_gated', 'every_turn')),
  ADD COLUMN output_kind text NOT NULL DEFAULT 'thoughts'
    CHECK (output_kind IN ('thoughts', 'authoritative_context'));

-- Replace the original decision-state and selected/state compatibility checks
-- without relying on PostgreSQL's generated constraint names.
DO $$
DECLARE constraint_row record;
BEGIN
  FOR constraint_row IN
    SELECT conname, pg_get_constraintdef(oid) AS definition
    FROM pg_constraint
    WHERE conrelid = 'trace_attempt_prompt_module'::regclass AND contype = 'c'
  LOOP
    IF constraint_row.definition LIKE '%decision_state%' AND
       (constraint_row.definition LIKE '%not_requested%' OR constraint_row.definition LIKE '%selected IS NULL%') THEN
      EXECUTE format('ALTER TABLE trace_attempt_prompt_module DROP CONSTRAINT %I', constraint_row.conname);
    END IF;
  END LOOP;
END;
$$;

ALTER TABLE trace_attempt_prompt_module
  ADD CONSTRAINT trace_attempt_prompt_module_decision_state_check
    CHECK (decision_state IN ('not_requested', 'requested', 'responded', 'failed', 'invalid', 'not_required')),
  ADD CONSTRAINT trace_attempt_prompt_module_selection_state_check
    CHECK (selected IS NULL OR
      (decision_state = 'responded' AND activation_mode = 'model_gated') OR
      (decision_state = 'not_required' AND activation_mode = 'every_turn')),
  DROP CONSTRAINT trace_attempt_prompt_module_output_shape,
  ADD CONSTRAINT trace_attempt_prompt_module_output_shape CHECK (
    (execution_ordinal IS NULL OR selected IS TRUE)
    AND (NOT output_ready OR selected IS TRUE)
    AND (NOT fallback_selected OR output_ready)
    AND (NOT fallback_used OR (fallback_selected AND included))
    AND (NOT included OR (output_ready AND selected IS TRUE))
    AND (decision_state <> 'not_required' OR activation_mode = 'every_turn')
  );
`;

const PROMPT_MODULE_HTTP_POST = `
ALTER TABLE prompt_module
  ADD COLUMN execution_mode text NOT NULL DEFAULT 'function'
    CHECK (execution_mode IN ('function', 'http_post')),
  ADD COLUMN http_endpoint_setting text
    CHECK (http_endpoint_setting IS NULL OR http_endpoint_setting ~ '^[A-Za-z][A-Za-z0-9_.-]{0,63}$'),
  ADD COLUMN http_scope_setting text
    CHECK (http_scope_setting IS NULL OR http_scope_setting ~ '^[A-Za-z][A-Za-z0-9_.-]{0,63}$'),
  ADD COLUMN http_scope_field text
    CHECK (http_scope_field IS NULL OR http_scope_field ~ '^[A-Za-z][A-Za-z0-9_]{0,63}$'),
  ADD COLUMN http_turn_id_field text
    CHECK (http_turn_id_field IS NULL OR http_turn_id_field ~ '^[A-Za-z][A-Za-z0-9_]{0,63}$'),
  ADD COLUMN http_local_datetime_field text
    CHECK (http_local_datetime_field IS NULL OR http_local_datetime_field ~ '^[A-Za-z][A-Za-z0-9_]{0,63}$'),
  ADD COLUMN http_previous_assistant_field text
    CHECK (http_previous_assistant_field IS NULL OR http_previous_assistant_field ~ '^[A-Za-z][A-Za-z0-9_]{0,63}$'),
  ADD COLUMN http_user_message_field text
    CHECK (http_user_message_field IS NULL OR http_user_message_field ~ '^[A-Za-z][A-Za-z0-9_]{0,63}$'),
  ADD COLUMN http_prior_conversation_field text
    CHECK (http_prior_conversation_field IS NULL OR http_prior_conversation_field ~ '^[A-Za-z][A-Za-z0-9_]{0,63}$'),
  ADD COLUMN http_response_text_field text
    CHECK (http_response_text_field IS NULL OR http_response_text_field ~ '^[A-Za-z][A-Za-z0-9_]{0,63}$'),
  ADD COLUMN http_field_max_bytes integer
    CHECK (http_field_max_bytes IS NULL OR http_field_max_bytes BETWEEN 1 AND 262144),
  ADD COLUMN http_prior_message_limit integer
    CHECK (http_prior_message_limit IS NULL OR http_prior_message_limit BETWEEN 0 AND 200),
  ADD COLUMN http_request_max_bytes integer
    CHECK (http_request_max_bytes IS NULL OR http_request_max_bytes BETWEEN 128 AND 1048576),
  ADD COLUMN http_response_max_bytes integer
    CHECK (http_response_max_bytes IS NULL OR http_response_max_bytes BETWEEN 1 AND 1048576);

ALTER TABLE trace_attempt_prompt_module
  ADD COLUMN execution_mode text NOT NULL DEFAULT 'function'
    CHECK (execution_mode IN ('function', 'http_post'));

ALTER TABLE prompt_module ALTER COLUMN function_definition DROP NOT NULL;

DO $$
DECLARE constraint_row record;
BEGIN
  FOR constraint_row IN
    SELECT conname, pg_get_constraintdef(oid) AS definition
    FROM pg_constraint
    WHERE conrelid = 'prompt_module'::regclass AND contype = 'c'
  LOOP
    IF constraint_row.definition LIKE '%function_definition%' THEN
      EXECUTE format('ALTER TABLE prompt_module DROP CONSTRAINT %I', constraint_row.conname);
    END IF;
  END LOOP;
END;
$$;

ALTER TABLE prompt_module
  ADD CONSTRAINT prompt_module_execution_config_shape CHECK (
    (
      execution_mode = 'function'
      AND function_definition IS NOT NULL
      AND length(btrim(function_definition)) > 0
      AND length(function_definition) <= 131072
      AND http_endpoint_setting IS NULL
      AND http_scope_setting IS NULL
      AND http_scope_field IS NULL
      AND http_turn_id_field IS NULL
      AND http_local_datetime_field IS NULL
      AND http_previous_assistant_field IS NULL
      AND http_user_message_field IS NULL
      AND http_prior_conversation_field IS NULL
      AND http_response_text_field IS NULL
      AND http_field_max_bytes IS NULL
      AND http_prior_message_limit IS NULL
      AND http_request_max_bytes IS NULL
      AND http_response_max_bytes IS NULL
    ) OR (
      execution_mode = 'http_post'
      AND function_definition IS NULL
      AND http_endpoint_setting IS NOT NULL
      AND (
        (http_scope_setting IS NULL AND http_scope_field IS NULL) OR
        (http_scope_setting IS NOT NULL AND http_scope_field IS NOT NULL
          AND http_scope_setting <> http_endpoint_setting)
      )
      AND http_response_text_field IS NOT NULL
      AND http_field_max_bytes IS NOT NULL
      AND http_prior_message_limit IS NOT NULL
      AND http_request_max_bytes IS NOT NULL
      AND http_response_max_bytes IS NOT NULL
      AND (http_scope_field IS NULL OR http_turn_id_field IS NULL OR http_scope_field <> http_turn_id_field)
      AND (http_scope_field IS NULL OR http_local_datetime_field IS NULL OR http_scope_field <> http_local_datetime_field)
      AND (http_scope_field IS NULL OR http_previous_assistant_field IS NULL OR http_scope_field <> http_previous_assistant_field)
      AND (http_scope_field IS NULL OR http_user_message_field IS NULL OR http_scope_field <> http_user_message_field)
      AND (http_scope_field IS NULL OR http_prior_conversation_field IS NULL OR http_scope_field <> http_prior_conversation_field)
      AND (http_turn_id_field IS NULL OR http_local_datetime_field IS NULL OR http_turn_id_field <> http_local_datetime_field)
      AND (http_turn_id_field IS NULL OR http_previous_assistant_field IS NULL OR http_turn_id_field <> http_previous_assistant_field)
      AND (http_turn_id_field IS NULL OR http_user_message_field IS NULL OR http_turn_id_field <> http_user_message_field)
      AND (http_turn_id_field IS NULL OR http_prior_conversation_field IS NULL OR http_turn_id_field <> http_prior_conversation_field)
      AND (http_local_datetime_field IS NULL OR http_previous_assistant_field IS NULL OR http_local_datetime_field <> http_previous_assistant_field)
      AND (http_local_datetime_field IS NULL OR http_user_message_field IS NULL OR http_local_datetime_field <> http_user_message_field)
      AND (http_local_datetime_field IS NULL OR http_prior_conversation_field IS NULL OR http_local_datetime_field <> http_prior_conversation_field)
      AND (http_previous_assistant_field IS NULL OR http_user_message_field IS NULL OR http_previous_assistant_field <> http_user_message_field)
      AND (http_previous_assistant_field IS NULL OR http_prior_conversation_field IS NULL OR http_previous_assistant_field <> http_prior_conversation_field)
      AND (http_user_message_field IS NULL OR http_prior_conversation_field IS NULL OR http_user_message_field <> http_prior_conversation_field)
    )
  );
`;

const PROMPT_MODULE_ENGAGEMENT_AND_HOLD = `
ALTER TABLE prompt_module
  ADD COLUMN http_engagement_state_field text
    CHECK (http_engagement_state_field IS NULL OR http_engagement_state_field ~ '^[A-Za-z][A-Za-z0-9_]{0,63}$'),
  ADD COLUMN http_unavailable_until_field text
    CHECK (http_unavailable_until_field IS NULL OR http_unavailable_until_field ~ '^[A-Za-z][A-Za-z0-9_]{0,63}$');

ALTER TABLE prompt_module
  DROP CONSTRAINT prompt_module_execution_config_shape;

ALTER TABLE prompt_module
  ADD CONSTRAINT prompt_module_execution_config_shape CHECK (
    (
      execution_mode = 'function'
      AND function_definition IS NOT NULL
      AND length(btrim(function_definition)) > 0
      AND length(function_definition) <= 131072
      AND http_endpoint_setting IS NULL
      AND http_scope_setting IS NULL
      AND http_scope_field IS NULL
      AND http_turn_id_field IS NULL
      AND http_local_datetime_field IS NULL
      AND http_engagement_state_field IS NULL
      AND http_previous_assistant_field IS NULL
      AND http_user_message_field IS NULL
      AND http_prior_conversation_field IS NULL
      AND http_response_text_field IS NULL
      AND http_unavailable_until_field IS NULL
      AND http_field_max_bytes IS NULL
      AND http_prior_message_limit IS NULL
      AND http_request_max_bytes IS NULL
      AND http_response_max_bytes IS NULL
    ) OR (
      execution_mode = 'http_post'
      AND function_definition IS NULL
      AND http_endpoint_setting IS NOT NULL
      AND (
        (http_scope_setting IS NULL AND http_scope_field IS NULL) OR
        (http_scope_setting IS NOT NULL AND http_scope_field IS NOT NULL
          AND http_scope_setting <> http_endpoint_setting)
      )
      AND http_response_text_field IS NOT NULL
      AND (http_unavailable_until_field IS NULL OR http_unavailable_until_field <> http_response_text_field)
      AND http_field_max_bytes IS NOT NULL
      AND http_prior_message_limit IS NOT NULL
      AND http_request_max_bytes IS NOT NULL
      AND http_response_max_bytes IS NOT NULL
      AND (http_scope_field IS NULL OR http_turn_id_field IS NULL OR http_scope_field <> http_turn_id_field)
      AND (http_scope_field IS NULL OR http_local_datetime_field IS NULL OR http_scope_field <> http_local_datetime_field)
      AND (http_scope_field IS NULL OR http_engagement_state_field IS NULL OR http_scope_field <> http_engagement_state_field)
      AND (http_scope_field IS NULL OR http_previous_assistant_field IS NULL OR http_scope_field <> http_previous_assistant_field)
      AND (http_scope_field IS NULL OR http_user_message_field IS NULL OR http_scope_field <> http_user_message_field)
      AND (http_scope_field IS NULL OR http_prior_conversation_field IS NULL OR http_scope_field <> http_prior_conversation_field)
      AND (http_turn_id_field IS NULL OR http_local_datetime_field IS NULL OR http_turn_id_field <> http_local_datetime_field)
      AND (http_turn_id_field IS NULL OR http_engagement_state_field IS NULL OR http_turn_id_field <> http_engagement_state_field)
      AND (http_turn_id_field IS NULL OR http_previous_assistant_field IS NULL OR http_turn_id_field <> http_previous_assistant_field)
      AND (http_turn_id_field IS NULL OR http_user_message_field IS NULL OR http_turn_id_field <> http_user_message_field)
      AND (http_turn_id_field IS NULL OR http_prior_conversation_field IS NULL OR http_turn_id_field <> http_prior_conversation_field)
      AND (http_local_datetime_field IS NULL OR http_engagement_state_field IS NULL OR http_local_datetime_field <> http_engagement_state_field)
      AND (http_local_datetime_field IS NULL OR http_previous_assistant_field IS NULL OR http_local_datetime_field <> http_previous_assistant_field)
      AND (http_local_datetime_field IS NULL OR http_user_message_field IS NULL OR http_local_datetime_field <> http_user_message_field)
      AND (http_local_datetime_field IS NULL OR http_prior_conversation_field IS NULL OR http_local_datetime_field <> http_prior_conversation_field)
      AND (http_engagement_state_field IS NULL OR http_previous_assistant_field IS NULL OR http_engagement_state_field <> http_previous_assistant_field)
      AND (http_engagement_state_field IS NULL OR http_user_message_field IS NULL OR http_engagement_state_field <> http_user_message_field)
      AND (http_engagement_state_field IS NULL OR http_prior_conversation_field IS NULL OR http_engagement_state_field <> http_prior_conversation_field)
      AND (http_previous_assistant_field IS NULL OR http_user_message_field IS NULL OR http_previous_assistant_field <> http_user_message_field)
      AND (http_previous_assistant_field IS NULL OR http_prior_conversation_field IS NULL OR http_previous_assistant_field <> http_prior_conversation_field)
      AND (http_user_message_field IS NULL OR http_prior_conversation_field IS NULL OR http_user_message_field <> http_prior_conversation_field)
    )
  );
`;

const PROMPT_MODULE_ROUTINE_METADATA = `
ALTER TABLE prompt_module
  ADD COLUMN http_published_routine_message_key_field text
    CHECK (http_published_routine_message_key_field ~ '^[A-Za-z][A-Za-z0-9_]{0,63}$'),
  ADD COLUMN http_availability_revision_field text
    CHECK (http_availability_revision_field ~ '^[A-Za-z][A-Za-z0-9_]{0,63}$'),
  ADD CONSTRAINT prompt_module_published_routine_message_key_field_check CHECK (
    http_published_routine_message_key_field IS NULL OR (
      execution_mode = 'http_post'
      AND NOT (http_published_routine_message_key_field = ANY (array_remove(ARRAY[
        http_scope_field, http_turn_id_field, http_local_datetime_field, http_engagement_state_field,
        http_previous_assistant_field, http_user_message_field, http_prior_conversation_field
      ], NULL)))
    )
  ),
  ADD CONSTRAINT prompt_module_availability_revision_field_check CHECK (
    http_availability_revision_field IS NULL OR (
      execution_mode = 'http_post'
      AND http_unavailable_until_field IS NOT NULL
      AND http_availability_revision_field <> http_unavailable_until_field
      AND http_availability_revision_field <> http_response_text_field
    )
  );
`;

const PROMPT_MODULE_PATTERN_ID = `
ALTER TABLE prompt_module
  ADD COLUMN http_pattern_id_field text
    CHECK (http_pattern_id_field ~ '^[A-Za-z][A-Za-z0-9_]{0,63}$'),
  ADD CONSTRAINT prompt_module_pattern_id_field_check CHECK (
    http_pattern_id_field IS NULL OR (
      execution_mode = 'http_post'
      AND NOT (http_pattern_id_field = ANY (array_remove(ARRAY[
        http_scope_field, http_turn_id_field, http_local_datetime_field, http_engagement_state_field,
        http_published_routine_message_key_field, http_previous_assistant_field,
        http_user_message_field, http_prior_conversation_field
      ], NULL)))
    )
  );
`;

const PROMPT_MODULE_FAMILIARITY_TIER = `
ALTER TABLE prompt_module
  ADD COLUMN http_familiarity_tier_field text
    CHECK (http_familiarity_tier_field ~ '^[A-Za-z][A-Za-z0-9_]{0,63}$'),
  ADD CONSTRAINT prompt_module_familiarity_tier_field_check CHECK (
    http_familiarity_tier_field IS NULL OR (
      execution_mode = 'http_post'
      AND NOT (http_familiarity_tier_field = ANY (array_remove(ARRAY[
        http_scope_field, http_turn_id_field, http_local_datetime_field, http_engagement_state_field,
        http_published_routine_message_key_field, http_pattern_id_field,
        http_previous_assistant_field, http_user_message_field, http_prior_conversation_field
      ], NULL)))
    )
  );
`;

export const promptModuleMigrations: readonly Migration[] = [
  { id: "0018_generic_prompt_modules", sql: PROMPT_MODULE_SCHEMA },
  { id: "0019_prompt_module_chat_attribution", sql: PROMPT_MODULE_CHAT_ATTRIBUTION },
  { id: "0022_prompt_module_activation_modes", sql: PROMPT_MODULE_ACTIVATION_MODES },
  { id: "0023_prompt_module_http_post", sql: PROMPT_MODULE_HTTP_POST },
  { id: "0027_prompt_module_engagement_and_hold", sql: PROMPT_MODULE_ENGAGEMENT_AND_HOLD },
  { id: "0029_prompt_module_routine_metadata", sql: PROMPT_MODULE_ROUTINE_METADATA },
  { id: "0031_prompt_module_pattern_id", sql: PROMPT_MODULE_PATTERN_ID },
  { id: "0036_prompt_module_familiarity_tier", sql: PROMPT_MODULE_FAMILIARITY_TIER },
];
