/**
 * Relationship/familiarity domain schema. All policy, relationship labels,
 * tier prompts, and question content are runtime database configuration and
 * are intentionally not seeded here. Answer recording itself is exactly one
 * updatable row per (question, participant).
 */

import type { Migration } from "@companion/postgres";

const RELATIONSHIP_SCHEMA = `
CREATE TABLE relationship_settings (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  relationship_type text NOT NULL CHECK (length(btrim(relationship_type)) > 0),
  timezone text NOT NULL CHECK (length(btrim(timezone)) > 0),
  day_start_hour smallint NOT NULL CHECK (day_start_hour BETWEEN 0 AND 23),
  tier_movement_enabled boolean NOT NULL,
  tier_up_min_days integer CHECK (tier_up_min_days > 0),
  tier_up_min_active_streak integer CHECK (tier_up_min_active_streak > 0),
  tier_down_missed_streak integer CHECK (tier_down_missed_streak > 0),
  answer_extraction_prompt text NOT NULL CHECK (length(btrim(answer_extraction_prompt)) > 0),
  clarification_guidance text NOT NULL CHECK (length(btrim(clarification_guidance)) > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    NOT tier_movement_enabled OR
    (tier_up_min_days IS NOT NULL AND
     tier_up_min_active_streak IS NOT NULL AND
     tier_down_missed_streak IS NOT NULL)
  )
);

CREATE TABLE relationship_tier (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tier_key text NOT NULL UNIQUE CHECK (length(btrim(tier_key)) > 0),
  position integer NOT NULL UNIQUE CHECK (position >= 0),
  minimum_familiarity numeric(6,5) NOT NULL
    CHECK (minimum_familiarity >= 0 AND minimum_familiarity <= 1),
  label text NOT NULL CHECK (length(btrim(label)) > 0),
  prompt text NOT NULL CHECK (length(btrim(prompt)) > 0),
  behavioral_guidance text NOT NULL CHECK (length(btrim(behavioral_guidance)) > 0)
);

CREATE TABLE relationship_question_type (
  type_key text PRIMARY KEY CHECK (length(btrim(type_key)) > 0),
  interpretation_guidance text NOT NULL CHECK (length(btrim(interpretation_guidance)) > 0)
);

CREATE TABLE relationship_question (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  question_key text NOT NULL UNIQUE CHECK (length(btrim(question_key)) > 0),
  type_key text NOT NULL REFERENCES relationship_question_type (type_key),
  tier_id uuid NOT NULL REFERENCES relationship_tier (id),
  question_text text NOT NULL CHECK (length(btrim(question_text)) > 0),
  enabled boolean NOT NULL DEFAULT true,
  position integer NOT NULL DEFAULT 0
);
CREATE INDEX relationship_question_enabled_idx
  ON relationship_question (enabled, tier_id, position);

CREATE TABLE relationship_answer (
  question_id uuid NOT NULL REFERENCES relationship_question (id),
  participant text NOT NULL CHECK (participant IN ('user', 'assistant')),
  current_answer text NOT NULL CHECK (length(btrim(current_answer)) > 0),
  clarification_needed boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (question_id, participant)
);
`;

export const relationshipMigrations: readonly Migration[] = [
  { id: "0010_relationship_familiarity", sql: RELATIONSHIP_SCHEMA },
  {
    id: "0011_relationship_chat_chunk",
    sql: `
      ALTER TABLE trace_attempt_chat_message
        DROP CONSTRAINT trace_attempt_chat_message_chunk_check;
      ALTER TABLE trace_attempt_chat_message
        ADD CONSTRAINT trace_attempt_chat_message_chunk_check
        CHECK (chunk IN ('identity', 'profiles', 'temporal', 'recall', 'article', 'relationship', 'guidance', 'conversation'));
    `,
  },
];
