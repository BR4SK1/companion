/**
 * Domain-owned schema migrations for the conversation-work domain.
 *
 * The schema is relational PostgreSQL only (no document-compatibility
 * layer). Migrations are supplied to the shared migration runner
 * (`@companion/postgres`) in order and applied idempotently.
 *
 * No response-pattern rows are seeded here: selection descriptions and
 * response guidance are runtime configuration content, not code or
 * repository content.
 */

import type { Migration } from "@companion/postgres";

const CREATE_CONVERSATION_WORK = `
CREATE TABLE conversation_turn (
  id uuid PRIMARY KEY,
  status text NOT NULL DEFAULT 'in_flight'
    CHECK (status IN ('in_flight', 'completed', 'failed')),
  attempt integer NOT NULL DEFAULT 1 CHECK (attempt >= 1),
  lease_owner text,
  lease_expires_at timestamptz,
  selected_pattern_id text,
  decision jsonb,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT conversation_turn_lease_present
    CHECK (status <> 'in_flight'
           OR (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL))
);

CREATE TABLE conversation_message (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq bigint GENERATED ALWAYS AS IDENTITY,
  role text NOT NULL CHECK (role IN ('user', 'assistant')),
  content text NOT NULL,
  client_key text UNIQUE,
  turn_id uuid REFERENCES conversation_turn (id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX conversation_message_seq_idx ON conversation_message (seq);

-- Claim-time grouping reads the unassigned trailing user-message run.
CREATE INDEX conversation_message_pending_user_idx
  ON conversation_message (seq)
  WHERE turn_id IS NULL AND role = 'user';

-- At most one persisted assistant reply per turn (publication idempotency).
CREATE UNIQUE INDEX conversation_turn_reply_idx
  ON conversation_message (turn_id)
  WHERE role = 'assistant';

CREATE INDEX conversation_turn_in_flight_idx
  ON conversation_turn (created_at)
  WHERE status = 'in_flight';

CREATE TABLE response_pattern (
  id text PRIMARY KEY,
  enabled boolean NOT NULL DEFAULT true,
  selection_description text NOT NULL,
  response_guidance text NOT NULL,
  position integer NOT NULL CHECK (position >= 0)
);
`;

/**
 * Turn/attempt tracing: relational records for the processing history of
 * conversation turns. Every attempt (initial claim or reclaim) gets one row;
 * the decision and chat boundaries of that attempt are recorded as child
 * records of it. The structure is deliberately feature-specific — no generic
 * JSONB payload, no document facade, no EAV:
 *
 * - `trace_attempt` — one row per attempt of a turn, created inside the claim
 *   transaction (so the attempt row exists exactly when the turn is leased),
 *   with its terminal outcome written by the same transaction that publishes
 *   the reply or records the failure. A fenced-out attempt (whose lease was
 *   lost to a reclaiming worker) records `outcome = 'fenced'` on its own row
 *   without touching the turn's state.
 * - `trace_attempt_context` — the exact ordered context (prior-turn history
 *   plus this turn's grouped messages) the attempt saw, by message id. The
 *   messages themselves are immutable in `conversation_message`; the snapshot
 *   records which ones were used and in what order.
 * - `trace_attempt_pattern` — the mutable response-pattern configuration as it
 *   stood when the snapshot was taken, with each row's full content.
 * - `trace_attempt_decision` — the decision boundary for the attempt's single
 *   question, written in two fenced steps like the chat boundary: the exact
 *   validated request before the provider call (state `requested`), and the
 *   available outcome after the call (state `responded` with the native
 *   response, `failed` with the actual transport error when the provider gave
 *   no usable response, or `invalid` with the validation error when a body
 *   arrived but failed the Decisions contract). The offered criteria (the
 *   pattern snapshot is the criteria), the instructions as sent, and the
 *   returned choice, optional confidence, response model/provider/id, and
 *   usage are recorded as returned. Optional native values (confidence,
 *   provider, id, usage cost) are nullable columns: absence and empty stay
 *   distinct from any fabricated value. `error_body` holds the truncated
 *   response body only when the transport retained one (HTTP-status errors);
 *   it is never fabricated. The invalid state's offending untyped value is not
 *   persisted — arbitrary provider data has no relational home.
 * - `trace_attempt_decision_probability` — the optional per-option probability
 *   distribution the provider returned, one row per option. The decision
 *   row's `probabilities_present` marker keeps absence and presence distinct:
 *   `false` means the provider returned no distribution at all (zero child
 *   rows), `true` with zero child rows means it returned an explicitly empty
 *   distribution, and `true` with rows means a non-empty distribution. Native
 *   absent and empty values are preserved as returned; neither is invented.
 * - `trace_attempt_chat` — the chat request/response boundary for the attempt:
 *   request model, optional temperature/max_tokens, and the returned response
 *   model, optional id, all choices, and usage. The chat boundary is written
 *   in two fenced steps: the exact request before the provider call (state
 *   `requested`), and the available outcome after the call (state `responded`
 *   with the native response, `failed` with the actual transport error when
 *   the provider gave no usable response, or `invalid` with the validation
 *   error when a body arrived but failed the chat contract). A `responded`
 *   record carries the application usability verdict separately from the
 *   transport outcome: `application_rejection` names the reason the
 *   application rejected an arrived response (e.g. no choices) — the response
 *   itself is still recorded in full. Absent raw data stays absent; nothing
 *   is invented.
 * - `trace_attempt_chat_message` — the exact ordered messages sent, with the
 *   guidance system message's source left null and every other message linked
 *   to its conversation_message row.
 *
 * The decision boundary is likewise recorded before selection: the full
 * native response (choice, optional confidence/probabilities, model, usage)
 * is persisted before `selectResponsePattern` runs, and the selection itself
 * (`selected` with the chosen pattern id, or `rejected` with the reason) is
 * recorded separately — so a rejected selection still leaves every response
 * detail behind. `choice` is nullable because a missing or non-choice answer
 * is a fact about the response, not a fabrication to paper over.
 *
 * The legacy `conversation_turn.decision` JSONB column is preserved untouched
 * for existing data and is no longer written by new work; new decision
 * diagnostics live in the trace tables above. The report (read-only CLI)
 * presents both, clearly marked.
 */
const CREATE_CONVERSATION_TRACING = `
CREATE TABLE trace_attempt (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  turn_id uuid NOT NULL REFERENCES conversation_turn (id),
  attempt integer NOT NULL CHECK (attempt >= 1),
  lease_owner text NOT NULL,
  claimed_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  outcome text,
  snapshot_recorded_at timestamptz,
  CONSTRAINT trace_attempt_outcome_shape CHECK (
    (finished_at IS NULL AND outcome IS NULL)
    OR (finished_at IS NOT NULL AND outcome IN ('published', 'failed', 'fenced', 'superseded'))
  ),
  UNIQUE (turn_id, attempt)
);

CREATE INDEX trace_attempt_turn_idx ON trace_attempt (turn_id, attempt);

CREATE TABLE trace_attempt_context (
  attempt_id uuid NOT NULL REFERENCES trace_attempt (id),
  position integer NOT NULL CHECK (position >= 0),
  message_id uuid NOT NULL REFERENCES conversation_message (id),
  PRIMARY KEY (attempt_id, position)
);

CREATE TABLE trace_attempt_pattern (
  attempt_id uuid NOT NULL REFERENCES trace_attempt (id),
  position integer NOT NULL CHECK (position >= 0),
  pattern_id text NOT NULL,
  selection_description text NOT NULL,
  response_guidance text NOT NULL,
  PRIMARY KEY (attempt_id, position)
);

CREATE TABLE trace_attempt_decision (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  attempt_id uuid NOT NULL UNIQUE REFERENCES trace_attempt (id),
  state text NOT NULL CHECK (state IN ('requested', 'responded', 'failed', 'invalid')),
  question_id text NOT NULL,
  question_type text NOT NULL,
  request_model text NOT NULL,
  instructions text NOT NULL,
  choice text,
  confidence numeric,
  probabilities_present boolean NOT NULL DEFAULT false,
  selection text CHECK (selection IN ('selected', 'rejected')),
  rejection_reason text,
  response_model text,
  response_provider text,
  response_id text,
  usage_input_tokens integer,
  usage_output_tokens integer,
  usage_cost numeric,
  error_kind text,
  error_message text,
  error_body text,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT trace_attempt_decision_state_shape CHECK (
    (state = 'requested'
      AND choice IS NULL AND confidence IS NULL AND probabilities_present = false
      AND selection IS NULL AND rejection_reason IS NULL
      AND response_model IS NULL AND response_provider IS NULL AND response_id IS NULL
      AND usage_input_tokens IS NULL AND usage_output_tokens IS NULL AND usage_cost IS NULL
      AND error_kind IS NULL AND error_message IS NULL AND error_body IS NULL)
    OR (state = 'responded'
      AND response_model IS NOT NULL
      AND error_kind IS NULL AND error_message IS NULL AND error_body IS NULL)
    OR (state = 'failed'
      AND choice IS NULL AND confidence IS NULL AND probabilities_present = false
      AND selection IS NULL AND rejection_reason IS NULL
      AND response_model IS NULL AND response_provider IS NULL AND response_id IS NULL
      AND usage_input_tokens IS NULL AND usage_output_tokens IS NULL AND usage_cost IS NULL
      AND error_kind IS NOT NULL AND error_message IS NOT NULL)
    OR (state = 'invalid'
      AND choice IS NULL AND confidence IS NULL AND probabilities_present = false
      AND selection IS NULL AND rejection_reason IS NULL
      AND response_model IS NULL AND response_provider IS NULL AND response_id IS NULL
      AND usage_input_tokens IS NULL AND usage_output_tokens IS NULL AND usage_cost IS NULL
      AND error_kind IS NOT NULL AND error_message IS NOT NULL AND error_body IS NULL)
  ),
  CONSTRAINT trace_attempt_decision_selection_shape CHECK (
    (selection IS NULL AND rejection_reason IS NULL)
    OR (selection = 'selected' AND rejection_reason IS NULL)
    OR (selection = 'rejected' AND rejection_reason IS NOT NULL)
  )
);

CREATE TABLE trace_attempt_decision_probability (
  decision_id uuid NOT NULL REFERENCES trace_attempt_decision (id),
  option_id text NOT NULL,
  value numeric NOT NULL,
  PRIMARY KEY (decision_id, option_id)
);

CREATE TABLE trace_attempt_chat (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  attempt_id uuid NOT NULL UNIQUE REFERENCES trace_attempt (id),
  state text NOT NULL CHECK (state IN ('requested', 'responded', 'failed', 'invalid')),
  request_model text NOT NULL,
  temperature numeric,
  max_tokens integer,
  response_id text,
  response_model text,
  reply_content text,
  application_rejection text,
  error_kind text,
  error_message text,
  error_body text,
  usage_prompt_tokens integer,
  usage_completion_tokens integer,
  usage_total_tokens integer,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT trace_attempt_chat_state_shape CHECK (
    (state = 'requested'
      AND response_id IS NULL AND response_model IS NULL AND reply_content IS NULL
      AND application_rejection IS NULL
      AND error_kind IS NULL AND error_message IS NULL AND error_body IS NULL
      AND usage_prompt_tokens IS NULL AND usage_completion_tokens IS NULL
      AND usage_total_tokens IS NULL)
    OR (state = 'responded'
      AND response_model IS NOT NULL
      AND error_kind IS NULL AND error_message IS NULL AND error_body IS NULL
      AND ((application_rejection IS NULL AND reply_content IS NOT NULL)
        OR (application_rejection IS NOT NULL AND reply_content IS NULL)))
    OR (state = 'failed'
      AND response_id IS NULL AND response_model IS NULL AND reply_content IS NULL
      AND application_rejection IS NULL
      AND error_kind IS NOT NULL AND error_message IS NOT NULL
      AND usage_prompt_tokens IS NULL AND usage_completion_tokens IS NULL
      AND usage_total_tokens IS NULL)
    OR (state = 'invalid'
      AND response_id IS NULL AND response_model IS NULL AND reply_content IS NULL
      AND application_rejection IS NULL
      AND error_kind IS NOT NULL AND error_message IS NOT NULL AND error_body IS NULL
      AND usage_prompt_tokens IS NULL AND usage_completion_tokens IS NULL
      AND usage_total_tokens IS NULL)
  )
);

CREATE TABLE trace_attempt_chat_message (
  chat_id uuid NOT NULL REFERENCES trace_attempt_chat (id),
  position integer NOT NULL CHECK (position >= 0),
  role text NOT NULL CHECK (role IN ('system', 'user', 'assistant')),
  content text NOT NULL,
  source_message_id uuid REFERENCES conversation_message (id),
  PRIMARY KEY (chat_id, position)
);

CREATE TABLE trace_attempt_chat_choice (
  chat_id uuid NOT NULL REFERENCES trace_attempt_chat (id),
  position integer NOT NULL CHECK (position >= 0),
  finish_reason text,
  content text NOT NULL,
  PRIMARY KEY (chat_id, position)
);
`;

/**
 * Chat identity: the owner-authored identity/persona text sent as the
 * leading system message of every chat request. It is runtime configuration
 * exactly like `response_pattern`: provisioned per deployment (one singleton
 * row, authored by the owner through SQL), never seeded by migrations, and
 * never code or repository content. The schema is generic structural shape —
 * no personal text lives here, only the table the owner authors.
 *
 * `revision` is a plain counter the owner bumps on each edit; every chat
 * boundary trace records the revision it used, so a trace identifies which
 * version of the identity was in effect without duplicating its content.
 *
 * The tracing additions stay metadata-only:
 * - `trace_attempt_chat.identity_revision` — which identity revision the
 *   request carried (null for rows recorded before this migration).
 * - `trace_attempt_chat_message.chunk` — which assembly chunk each recorded
 *   message belongs to (identity/profiles/temporal/recall/guidance or a
 *   conversation message; null for rows recorded before this migration).
 * Neither duplicates prompt content: the exact rendered text was already
 * recorded in `trace_attempt_chat_message` by design; these columns classify
 * it.
 */
const CREATE_CHAT_IDENTITY = `
CREATE TABLE chat_identity (
  id text PRIMARY KEY,
  content text NOT NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chat_identity_content_nonempty CHECK (length(btrim(content)) > 0)
);

ALTER TABLE trace_attempt_chat ADD COLUMN identity_revision integer;

ALTER TABLE trace_attempt_chat_message ADD COLUMN chunk text
  CHECK (chunk IN ('identity', 'profiles', 'temporal', 'recall', 'guidance', 'conversation'));
`;

/**
 * Original message timing: dual provenance for user messages. The raw
 * client-reported send time (nullable — absence is legitimate) is preserved
 * alongside the server receive time (the existing `created_at`), and one
 * effective time is derived at ingest and persisted so every later reader
 * sees the same decision:
 *
 * - `client_sent_at` — the client-reported send time as received, kept even
 *   when it was not trusted (a parseable but rejected value stays visible
 *   for provenance; only an unparseable value cannot be stored as a
 *   timestamp and is recorded through `client_time_status` instead).
 * - `effective_at` — the trusted working time: the client time when it was
 *   valid and consistent with the acceptance/order bound, otherwise the
 *   server receive time, always identical to `server_received_at` on
 *   fallbacks (never clamped or synthesized).
 * - `time_source` / `client_time_status` — which clock the effective time
 *   came from and why (`absent`, `valid`, `future_skew`, `out_of_order`,
 *   `invalid`), preserved independently.
 * - `server_received_at` — the server clock reading at ingest, recorded
 *   honestly; on every fallback it is identical to `effective_at`.
 *
 * Legacy rows are backfilled from their own recorded history with nothing
 * invented: `server_received_at` = `created_at` (the row's server insert
 * instant — same clock, same statement), `effective_at` = `created_at`,
 * `time_source` = 'server', `client_time_status` = 'absent' (no client time
 * was recorded before this migration, and none is invented);
 * `client_sent_at` stays nullable because absence is a real state. The
 * provenance columns become NOT NULL after the backfill.
 *
 * The partial index on user rows supports the ingest path's
 * acceptance/order bound lookup (the maximum effective time over user
 * rows — the monotonically tracked client-candidate validation bound and
 * the engagement last-activity clock), which runs inside the serialized
 * ingest transaction.
 */
const ADD_MESSAGE_TIMING = `
ALTER TABLE conversation_message ADD COLUMN client_sent_at timestamptz;
ALTER TABLE conversation_message ADD COLUMN effective_at timestamptz;
ALTER TABLE conversation_message ADD COLUMN server_received_at timestamptz;
ALTER TABLE conversation_message ADD COLUMN time_source text
  CHECK (time_source IN ('client', 'server'));
ALTER TABLE conversation_message ADD COLUMN client_time_status text
  CHECK (client_time_status IN ('absent', 'valid', 'future_skew', 'out_of_order', 'invalid'));

UPDATE conversation_message
SET server_received_at = created_at,
    effective_at = created_at,
    time_source = 'server',
    client_time_status = 'absent'
WHERE effective_at IS NULL OR server_received_at IS NULL;

ALTER TABLE conversation_message ALTER COLUMN effective_at SET NOT NULL;
ALTER TABLE conversation_message ALTER COLUMN server_received_at SET NOT NULL;
ALTER TABLE conversation_message ALTER COLUMN time_source SET NOT NULL;
ALTER TABLE conversation_message ALTER COLUMN client_time_status SET NOT NULL;

CREATE INDEX conversation_message_user_seq_idx
  ON conversation_message (seq) WHERE role = 'user';
`;

const ADD_CONVERSATION_THREAD_ORDER = `
-- A turn's first user seq can predate a standalone announcement even when the
-- turn is claimed later. Persist one shared event order for turn claims and
-- standalone assistant publications so context does not treat queued input as
-- conversationally earlier than an intervening notice.
CREATE SEQUENCE conversation_thread_order_seq AS bigint;
ALTER TABLE conversation_turn ADD COLUMN thread_order bigint;
ALTER TABLE conversation_message ADD COLUMN thread_order bigint;
-- Preserve the established first-user-seq ordering of existing turns. For
-- legacy standalone assistants, no publication ordinal was persisted, so place
-- each one after the turn with the greatest first-user seq below its message
-- seq (or before all turns when none precedes it), matching the prior context
-- projection deterministically. Timestamp ordering is only a final tie-breaker
-- for empty turns that have no user message and therefore no context position.
CREATE TEMP TABLE conversation_thread_order_backfill ON COMMIT DROP AS
WITH turn_keys AS (
  SELECT t.id, t.created_at,
         min(m.seq) FILTER (WHERE m.role = 'user') AS first_user_seq
  FROM conversation_turn AS t
  LEFT JOIN conversation_message AS m ON m.turn_id = t.id
  GROUP BY t.id
), events AS (
  SELECT t.id AS turn_id, NULL::uuid AS message_id,
         t.first_user_seq AS slot_seq, 0 AS event_kind,
         t.first_user_seq AS tie_seq, t.created_at AS tie_time,
         0 AS empty_turn
  FROM turn_keys AS t
  WHERE t.first_user_seq IS NOT NULL
  UNION ALL
  SELECT NULL::uuid AS turn_id, m.id AS message_id,
         COALESCE((
           SELECT max(previous.first_user_seq)
           FROM turn_keys AS previous
           WHERE previous.first_user_seq < m.seq
         ), 0) AS slot_seq,
         1 AS event_kind, m.seq AS tie_seq, m.created_at AS tie_time,
         0 AS empty_turn
  FROM conversation_message AS m
  WHERE m.turn_id IS NULL AND m.role = 'assistant'
  UNION ALL
  SELECT t.id AS turn_id, NULL::uuid AS message_id,
         NULL::bigint AS slot_seq, 0 AS event_kind, NULL::bigint AS tie_seq,
         t.created_at AS tie_time, 1 AS empty_turn
  FROM turn_keys AS t
  WHERE t.first_user_seq IS NULL
)
SELECT turn_id, message_id,
       row_number() OVER (
         ORDER BY empty_turn, slot_seq NULLS LAST, event_kind,
                  tie_seq NULLS LAST, tie_time, turn_id, message_id
       ) AS thread_order
FROM events;
UPDATE conversation_turn AS t
SET thread_order = backfill.thread_order
FROM conversation_thread_order_backfill AS backfill
WHERE backfill.turn_id = t.id;
UPDATE conversation_message AS m
SET thread_order = backfill.thread_order
FROM conversation_thread_order_backfill AS backfill
WHERE backfill.message_id = m.id;
ALTER TABLE conversation_turn ALTER COLUMN thread_order SET DEFAULT nextval('conversation_thread_order_seq');
ALTER TABLE conversation_turn ALTER COLUMN thread_order SET NOT NULL;
SELECT setval(
  'conversation_thread_order_seq',
  COALESCE((SELECT max(thread_order) FROM (
    SELECT thread_order FROM conversation_turn
    UNION ALL
    SELECT thread_order FROM conversation_message WHERE thread_order IS NOT NULL
  ) AS orders), 1),
  EXISTS (SELECT 1 FROM conversation_turn)
    OR EXISTS (SELECT 1 FROM conversation_message WHERE thread_order IS NOT NULL)
);
CREATE UNIQUE INDEX conversation_turn_thread_order_idx ON conversation_turn (thread_order);
CREATE UNIQUE INDEX conversation_message_standalone_thread_order_idx
  ON conversation_message (thread_order)
  WHERE thread_order IS NOT NULL;
`;

export const conversationMigrations: readonly Migration[] = [
  {
    id: "0001_conversation_work",
    sql: CREATE_CONVERSATION_WORK,
  },
  {
    id: "0002_conversation_tracing",
    sql: CREATE_CONVERSATION_TRACING,
  },
  {
    id: "0004_chat_identity",
    sql: CREATE_CHAT_IDENTITY,
  },
  {
    id: "0005_message_timing",
    sql: ADD_MESSAGE_TIMING,
  },
  {
    id: "0006_conversation_thread_order",
    sql: ADD_CONVERSATION_THREAD_ORDER,
  },
];
