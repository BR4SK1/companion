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

export const conversationMigrations: readonly Migration[] = [
  {
    id: "0001_conversation_work",
    sql: CREATE_CONVERSATION_WORK,
  },
];
