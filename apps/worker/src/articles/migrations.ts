/**
 * Article-ingestion domain schema migrations.
 *
 * The article domain is a worker-owned responsibility: RSS/Atom feeds are
 * configured in relational PostgreSQL (personal deployment configuration,
 * never code or repository content), excerpts are fetched with bounded
 * networking, reactions are generated and reviewed with the provisioned
 * persona prompt, and an accepted reaction becomes a real memory fact
 * attributed to the assistant subject, linked back to its article source.
 *
 * Configuration tables (like `memory_subject`/`memory_prompt`/`memory_behavior`)
 * are deliberately NOT seeded by migrations: their contents are provisioned
 * per deployment. An unprovisioned deployment runs ingestion as a safe
 * no-op that logs `ingestion not configured` and never fetches, calls the
 * provider, or writes state.
 *
 * Memory-model extension: a memory fact may now be sourced from an accepted
 * article reaction instead of a conversation turn. Exactly one source is
 * required. Conversation-sourced facts keep their existing columns and
 * behavior unchanged; article-sourced facts carry a nullable turn id and a
 * reference to the reaction that produced them.
 */

import type { Migration } from "@companion/postgres";

const ARTICLE_WORK = `
CREATE TABLE article_feed (
  id text PRIMARY KEY,
  url text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  position integer NOT NULL CHECK (position >= 0)
);

CREATE INDEX article_feed_enabled_idx ON article_feed (enabled, position);

-- Single-row ingestion policy (provisioned per deployment): limits, model,
-- and the enable switch. Missing row = unprovisioned; enabled=false = disabled.
CREATE TABLE article_behavior (
  id text PRIMARY KEY CHECK (id = 'behavior'),
  enabled boolean NOT NULL DEFAULT true,
  model text NOT NULL,
  max_generations_per_run integer NOT NULL CHECK (max_generations_per_run >= 1),
  max_reaction_attempts integer NOT NULL CHECK (max_reaction_attempts >= 1),
  max_article_age_days integer NOT NULL CHECK (max_article_age_days >= 1),
  max_reaction_chars integer NOT NULL CHECK (max_reaction_chars >= 100),
  max_excerpt_chars integer NOT NULL CHECK (max_excerpt_chars >= 200),
  decision_max_candidates integer NOT NULL CHECK (decision_max_candidates >= 1),
  share_cooldown_minutes integer NOT NULL CHECK (share_cooldown_minutes >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Persona-bearing prompts for the two article LLM tasks. Provisioned
-- privately per deployment, like the memory prompts; the loader fails closed.
CREATE TABLE article_prompt (
  kind text NOT NULL CHECK (kind IN ('reaction_generation', 'reaction_review')),
  version text NOT NULL,
  system_prompt text NOT NULL,
  PRIMARY KEY (kind, version)
);

-- Fetched feed items: durable provenance for what was seen, keyed by URL so
-- a re-fetch never duplicates an item. Excerpt text is the bounded excerpt
-- the reaction was generated from (never the full page).
CREATE TABLE article_item (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  feed_id text NOT NULL REFERENCES article_feed (id),
  url text NOT NULL UNIQUE,
  title text NOT NULL,
  excerpt text NOT NULL,
  published_at timestamptz,
  fetched_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX article_item_fetched_idx ON article_item (fetched_at DESC);

-- One reaction per item. State machine: generating (lease-held attempt) ->
-- accepted | rejected | failed. Accepted reactions carry the generated text;
-- rejected/failed ones keep the durable retry count for bounded retries.
CREATE TABLE article_reaction (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id uuid NOT NULL UNIQUE REFERENCES article_item (id),
  state text NOT NULL CHECK (state IN ('generating', 'accepted', 'rejected', 'failed')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  reaction text,
  -- Lease fencing for replicas: a generating row is owned until this instant.
  lease_expires_at timestamptz,
  last_error text,
  model text,
  generation_prompt_version text,
  generated_at timestamptz,
  review_prompt_version text,
  reviewed_at timestamptz,
  -- The memory fact key created from an accepted reaction (provenance
  -- back-reference; memory_fact.article_reaction_id is the forward link).
  fact_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT article_reaction_accepted_shape CHECK (
    (state = 'accepted') = (reaction IS NOT NULL AND fact_key IS NOT NULL)
  )
);

CREATE INDEX article_reaction_state_idx ON article_reaction (state);

-- Inclusion tracking: one row per prompt-inclusion event. This records
-- PROMPT INCLUSION, not a claim that the memory was actually shared; the
-- share cooldown is computed from the newest inclusion.
CREATE TABLE article_share (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reaction_id uuid NOT NULL REFERENCES article_reaction (id),
  turn_id uuid REFERENCES conversation_turn (id),
  included_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX article_share_reaction_idx ON article_share (reaction_id, included_at DESC);

-- Memory-model extension: an accepted article reaction is a real assistant-
-- attributed memory fact. Exactly one source (conversation turn or article
-- reaction) is present, and the source_type column matches the link.
ALTER TABLE memory_fact ALTER COLUMN turn_id DROP NOT NULL;
ALTER TABLE memory_fact ADD COLUMN article_reaction_id uuid REFERENCES article_reaction (id);
ALTER TABLE memory_fact ADD COLUMN source_type text NOT NULL DEFAULT 'conversation';
ALTER TABLE memory_fact ADD CONSTRAINT memory_fact_source_exclusive
  CHECK (
    (turn_id IS NULL) <> (article_reaction_id IS NULL)
  );
ALTER TABLE memory_fact ADD CONSTRAINT memory_fact_source_type_check
  CHECK (
    (source_type = 'conversation' AND turn_id IS NOT NULL AND article_reaction_id IS NULL) OR
    (source_type = 'article' AND turn_id IS NULL AND article_reaction_id IS NOT NULL)
  );
CREATE INDEX memory_fact_article_idx ON memory_fact (article_reaction_id)
  WHERE article_reaction_id IS NOT NULL;
`;

/**
 * Article share + evidence migration (0008).
 *
 * Applied AFTER 0007 (which stays byte-identical: applied migration ids are
 * recorded and skipped, so editing an applied migration would strand its new
 * SQL — this migration carries every later schema change instead):
 *
 * - `trace_attempt_decision` holds one row per (attempt, question): the
 *   per-turn article-memory share question is a second decision on the same
 *   attempt, so the attempt-wide uniqueness is relaxed to the pair.
 * - Trace kinds `article_ingestion` and `article_memory_share` join the
 *   `memory_operation` kind CHECK, and the chat trace's chunk CHECK gains
 *   the `article` synthetic-system-chunk classification. Both widen
 *   constraints on pre-existing tables, so they live here with the share
 *   feature's other trace-shape changes rather than in the additive 0007.
 * - `article_share` gains a partial unique index on (reaction_id, turn_id) so
 *   a retried turn's inclusion write is idempotent.
 * - `article_prompt` gains the article interest-consolidation prompt kind.
 * - Turn-breadth checks relax to `>= 0` so an article-sourced observation can
 *   honestly record zero turn evidence (its evidence breadth is counted in
 *   distinct reactions at validation time, never stored as turn count).
 * - Omission reasons gain the article-policy values the source-aware evidence
 *   path reports (snapshots are never evidence-mixed: a revision replaces a
 *   canonical identity's evidence wholesale, so no new promotion outcome is
 *   needed).
 *
 * Rollback limitation (honest statement): the migration runner is
 * forward-only, and this migration is NOT old-binary compatible. Once 0008
 * is applied, running the previous binary against the migrated database
 * tolerates the recorded-but-unrecognized migration id
 * (`unrecognized recorded migrations (left untouched)`), and its writes to
 * every table changed here except `trace_attempt_decision` still satisfy the
 * schema (the constraint changes for those tables only widen what was
 * already accepted, and the article tables are new). But the previous
 * binary's per-question decision writes use `ON CONFLICT (attempt_id)`,
 * which fails (`42P10`) on the migrated schema because the attempt-wide
 * unique constraint no longer exists — a previous binary cannot record
 * conversation decisions on a 0008-migrated database, so a mixed-version
 * deployment that serves conversation turns is not supported. Additionally,
 * the previous binary's decision-selection update filters only by
 * `attempt_id` and `selection IS NULL`, so it would cross-stamp the second
 * (article-share) decision row once both decisions exist for an attempt.
 * Do not hand-edit a live database to undo a migration; there is no
 * downgrade path, and a future destructive migration would need its own
 * explicit, separately-reviewed compatibility decision.
 */
const ARTICLE_SHARE_AND_EVIDENCE = `
ALTER TABLE trace_attempt_decision DROP CONSTRAINT trace_attempt_decision_attempt_id_key;
ALTER TABLE trace_attempt_decision ADD CONSTRAINT trace_attempt_decision_attempt_question_key
  UNIQUE (attempt_id, question_id);

-- Trace kind extension: article ingestion attempts and prompt-inclusion
-- records use the shared metadata-only memory_operation trace.
ALTER TABLE memory_operation DROP CONSTRAINT memory_operation_kind_check;
ALTER TABLE memory_operation ADD CONSTRAINT memory_operation_kind_check
  CHECK (kind IN (
    'fact_extraction', 'observation_consolidation', 'promotion', 'retraction',
    'temporal_summary', 'profile_summary', 'observation_profile', 'recall',
    'article_ingestion', 'article_memory_share'));

-- Chat trace chunk classification: the article-memory chunk is its own
-- synthetic system chunk, distinct from the lexical recall chunk.
ALTER TABLE trace_attempt_chat_message DROP CONSTRAINT trace_attempt_chat_message_chunk_check;
ALTER TABLE trace_attempt_chat_message ADD CONSTRAINT trace_attempt_chat_message_chunk_check
  CHECK (chunk IN ('identity', 'profiles', 'temporal', 'recall', 'article', 'guidance', 'conversation'));

CREATE UNIQUE INDEX article_share_turn_reaction_idx
  ON article_share (reaction_id, turn_id)
  WHERE turn_id IS NOT NULL;

ALTER TABLE article_prompt DROP CONSTRAINT article_prompt_kind_check;
ALTER TABLE article_prompt ADD CONSTRAINT article_prompt_kind_check
  CHECK (kind IN ('reaction_generation', 'reaction_review', 'article_interest_consolidation'));

ALTER TABLE memory_observation DROP CONSTRAINT memory_observation_distinct_turn_count_check;
ALTER TABLE memory_observation ADD CONSTRAINT memory_observation_distinct_turn_count_check
  CHECK (distinct_turn_count >= 0);

ALTER TABLE memory_observation_omission DROP CONSTRAINT memory_observation_omission_distinct_turn_count_check;
ALTER TABLE memory_observation_omission ADD CONSTRAINT memory_observation_omission_distinct_turn_count_check
  CHECK (distinct_turn_count >= 0);

ALTER TABLE memory_canonical_observation DROP CONSTRAINT memory_canonical_observation_distinct_turn_count_check;
ALTER TABLE memory_canonical_observation ADD CONSTRAINT memory_canonical_observation_distinct_turn_count_check
  CHECK (distinct_turn_count >= 0);

ALTER TABLE memory_observation_omission DROP CONSTRAINT memory_observation_omission_reason_check;
ALTER TABLE memory_observation_omission ADD CONSTRAINT memory_observation_omission_reason_check
  CHECK (reason IN (
    'insufficient_distinct_turns', 'one_turn_without_direct_statement',
    'event_specific_temporal_anchor', 'insufficient_independent_sources',
    'unsupported_kind_for_source'));

-- Article interest-consolidation runs are turn-free: their bounded selection
-- is article reactions, so the run's max_turns bound is zero.
ALTER TABLE memory_run DROP CONSTRAINT memory_run_max_turns_check;
ALTER TABLE memory_run ADD CONSTRAINT memory_run_max_turns_check
  CHECK (max_turns >= 0);

ALTER TABLE memory_promotion_item DROP CONSTRAINT memory_promotion_item_outcome_check;
ALTER TABLE memory_promotion_item ADD CONSTRAINT memory_promotion_item_outcome_check
  CHECK (outcome IN ('applied', 'skipped_inactive', 'superseded'));
`;

/**
 * Article interest-consolidation claim migration (0009).
 *
 * The turn-free consolidation phase is a single-flight job over one owner's
 * data, but the ingestion runner may run on several replicas. This claim is
 * the durable coordination point:
 *
 * - One row (`id = 'consolidation'`): claiming it serializes the phase, so
 *   concurrent workers never duplicate provider calls or artifacts.
 * - The claim carries a lease (`lease_expires_at`): a worker that dies while
 *   holding the claim does not wedge the phase — the next attempt takes the
 *   expired lease over (crash recovery), mirroring the reaction lease model.
 * - Artifact writes are fenced by the exact lease they were claimed under,
 *   so a stalled worker whose lease was taken over cannot write evidence
 *   after another worker already did.
 */
const ARTICLE_OBSERVATION_CLAIM = `
CREATE TABLE article_observation_claim (
  id text PRIMARY KEY CHECK (id = 'consolidation'),
  owner text NOT NULL,
  lease_expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
`;

export const articleMigrations: readonly Migration[] = [
  {
    id: "0007_article_work",
    sql: ARTICLE_WORK,
  },
  {
    id: "0008_article_share_and_evidence",
    sql: ARTICLE_SHARE_AND_EVIDENCE,
  },
  {
    id: "0009_article_observation_claim",
    sql: ARTICLE_OBSERVATION_CLAIM,
  },
];
