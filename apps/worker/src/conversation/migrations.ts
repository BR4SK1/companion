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

export const conversationMigrations: readonly Migration[] = [
  {
    id: "0001_conversation_work",
    sql: CREATE_CONVERSATION_WORK,
  },
  {
    id: "0002_conversation_tracing",
    sql: CREATE_CONVERSATION_TRACING,
  },
];
