/**
 * Memory-domain schema migrations.
 *
 * The schema is native relational PostgreSQL only: typed columns, foreign
 * keys, check constraints, and child tables for ordered references. There is
 * no JSONB payload, no document facade, no EAV, and no serialized objects.
 *
 * Three tables are personal behavior configuration and are deliberately NOT
 * seeded by migrations (like `response_pattern`, their contents are runtime
 * configuration provisioned per deployment, never repository content):
 *
 * - `memory_subject` — who a memory can be about (including which side of a
 *   source turn a subject speaks for, its source-rendering label, and its
 *   per-subject evidence-attribution rule for the v1 profile sheet).
 * - `memory_prompt` — the persona-bearing system prompt text for each memory
 *   LLM task, keyed by kind and prompt version.
 * - `memory_behavior` — the behavioral-day boundary (timezone and local
 *   start hour) used by evidence counting, period keys, and cadence.
 */

import type { Migration } from "@companion/postgres";

const MEMORY_WORK = `
CREATE TABLE memory_subject (
  id text PRIMARY KEY,
  role text NOT NULL CHECK (role IN ('user', 'assistant', 'relationship')),
  profile_enabled boolean NOT NULL DEFAULT false,
  source_label text NOT NULL,
  -- Per-subject evidence-attribution rule for the v1 profile sheet: how
  -- statements may be attributed to this subject. Personal configuration,
  -- provisioned privately; the configuration loader fails closed when it is
  -- missing or empty.
  profile_evidence_rule text NOT NULL,
  position integer NOT NULL CHECK (position >= 0)
);

-- Personal behavior configuration: the behavioral-day boundary. Provisioned
-- privately per deployment as a single row; the memory configuration loader
-- fails closed when it is missing, and an unprovisioned deployment runs the
-- memory domain as a safe no-op instead of failing the worker.
CREATE TABLE memory_behavior (
  id text PRIMARY KEY CHECK (id = 'behavior'),
  timezone text NOT NULL,
  day_start_hour integer NOT NULL CHECK (day_start_hour >= 0 AND day_start_hour <= 23),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE memory_prompt (
  kind text NOT NULL CHECK (kind IN (
    'fact_extraction', 'observation_consolidation', 'temporal_summary',
    'profile_summary', 'observation_profile')),
  version text NOT NULL,
  system_prompt text NOT NULL,
  PRIMARY KEY (kind, version)
);

-- Production facts: durable, source-linked memory evidence.
CREATE TABLE memory_fact (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fact_key text NOT NULL UNIQUE,
  turn_id uuid NOT NULL REFERENCES conversation_turn (id),
  subject_id text NOT NULL REFERENCES memory_subject (id),
  kind text NOT NULL CHECK (kind IN (
    'fact', 'preference', 'habit', 'conditional_pattern',
    'observed_interaction', 'boundary')),
  claim text NOT NULL,
  condition text,
  consequence text,
  topics text[] NOT NULL DEFAULT '{}',
  observed_at timestamptz NOT NULL,
  explicitness text NOT NULL CHECK (explicitness IN ('explicit', 'supported', 'inferred')),
  evidence_basis text NOT NULL CHECK (evidence_basis IN (
    'direct_statement', 'observed_behavior', 'observed_interaction', 'inferred')),
  extraction_version text NOT NULL,
  ingest_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX memory_fact_turn_idx ON memory_fact (turn_id);
CREATE INDEX memory_fact_observed_idx ON memory_fact (observed_at);
CREATE INDEX memory_fact_search_idx ON memory_fact USING gin (
  to_tsvector('english',
    claim || ' ' || coalesce(condition, '') || ' ' || coalesce(consequence, '')));

CREATE TABLE memory_fact_source_message (
  fact_id uuid NOT NULL REFERENCES memory_fact (id) ON DELETE CASCADE,
  position integer NOT NULL CHECK (position >= 0),
  message_id uuid NOT NULL REFERENCES conversation_message (id),
  PRIMARY KEY (fact_id, position)
);

-- Per-turn fact extraction cache. One row per source turn per generation
-- signature; items are child rows. The cache is keyed by content fingerprint,
-- so a changed turn or a changed extraction configuration is a new key.
CREATE TABLE memory_turn_extraction (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  turn_id uuid NOT NULL REFERENCES conversation_turn (id),
  key_version integer NOT NULL,
  cache_key text NOT NULL UNIQUE,
  source_fingerprint text NOT NULL,
  generation_signature text NOT NULL,
  extraction_version text NOT NULL,
  item_count integer NOT NULL CHECK (item_count >= 0),
  empty boolean NOT NULL,
  payload_hash text NOT NULL,
  producer text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE memory_turn_extraction_item (
  extraction_id uuid NOT NULL REFERENCES memory_turn_extraction (id) ON DELETE CASCADE,
  position integer NOT NULL CHECK (position >= 0),
  subject_id text NOT NULL REFERENCES memory_subject (id),
  kind text NOT NULL CHECK (kind IN (
    'fact', 'preference', 'habit', 'conditional_pattern',
    'observed_interaction', 'boundary')),
  claim text NOT NULL,
  condition text,
  consequence text,
  topics text[] NOT NULL DEFAULT '{}',
  explicitness text NOT NULL CHECK (explicitness IN ('explicit', 'supported', 'inferred')),
  evidence_basis text NOT NULL CHECK (evidence_basis IN (
    'direct_statement', 'observed_behavior', 'observed_interaction', 'inferred')),
  PRIMARY KEY (extraction_id, position)
);

-- Consolidation runs: the bounded selection of source turns a run saw.
CREATE TABLE memory_run (
  run_id text PRIMARY KEY,
  status text NOT NULL CHECK (status IN ('planned', 'facts-ready', 'observations-ready', 'failed')),
  facts_status text NOT NULL CHECK (facts_status IN ('pending', 'complete', 'failed')),
  observations_status text NOT NULL CHECK (observations_status IN ('pending', 'complete', 'failed', 'skipped')),
  max_turns integer NOT NULL CHECK (max_turns >= 1),
  source_fingerprint text NOT NULL,
  fact_set_id text NOT NULL,
  observation_set_id text NOT NULL,
  fact_generation_signature text NOT NULL,
  observation_generation_signature text NOT NULL,
  fact_count integer,
  observation_count integer,
  observation_candidate_count integer,
  observation_accepted_count integer,
  observation_omitted_count integer,
  fact_llm_calls integer,
  observation_llm_calls integer,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE TABLE memory_run_turn (
  run_id text NOT NULL REFERENCES memory_run (run_id) ON DELETE CASCADE,
  position integer NOT NULL CHECK (position >= 0),
  turn_id uuid NOT NULL REFERENCES conversation_turn (id),
  PRIMARY KEY (run_id, position)
);

-- Observation artifacts produced by one consolidation run. Omitted
-- (policy-rejected) candidates are stored separately so every row here is an
-- accepted candidate that promotion may consider.
CREATE TABLE memory_observation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id text NOT NULL REFERENCES memory_run (run_id),
  observation_set_id text NOT NULL,
  observation_key text NOT NULL,
  subject_id text NOT NULL REFERENCES memory_subject (id),
  kind text NOT NULL CHECK (kind IN (
    'fact', 'preference', 'habit', 'conditional_pattern', 'boundary')),
  claim text NOT NULL,
  condition text,
  consequence text,
  topics text[] NOT NULL DEFAULT '{}',
  support_count integer NOT NULL CHECK (support_count >= 1),
  distinct_turn_count integer NOT NULL CHECK (distinct_turn_count >= 1),
  distinct_day_count integer NOT NULL CHECK (distinct_day_count >= 1),
  contradiction_count integer NOT NULL CHECK (contradiction_count >= 0),
  first_observed_at timestamptz NOT NULL,
  last_observed_at timestamptz NOT NULL,
  evidence_strength text NOT NULL CHECK (evidence_strength IN ('tentative', 'supported', 'strong')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'superseded', 'retracted')),
  consolidation_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, observation_key)
);

CREATE INDEX memory_observation_set_idx ON memory_observation (observation_set_id);

CREATE TABLE memory_observation_evidence (
  observation_id uuid NOT NULL REFERENCES memory_observation (id) ON DELETE CASCADE,
  fact_id uuid NOT NULL REFERENCES memory_fact (id),
  role text NOT NULL CHECK (role IN ('support', 'contradiction')),
  position integer NOT NULL CHECK (position >= 0),
  PRIMARY KEY (observation_id, fact_id, role)
);

CREATE TABLE memory_observation_omission (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  omission_id text NOT NULL UNIQUE,
  run_id text NOT NULL REFERENCES memory_run (run_id),
  observation_set_id text NOT NULL,
  observation_key text NOT NULL,
  subject_id text NOT NULL REFERENCES memory_subject (id),
  kind text NOT NULL CHECK (kind IN (
    'fact', 'preference', 'habit', 'conditional_pattern', 'boundary')),
  claim text NOT NULL,
  condition text,
  consequence text,
  topics text[] NOT NULL DEFAULT '{}',
  support_count integer NOT NULL CHECK (support_count >= 1),
  distinct_turn_count integer NOT NULL CHECK (distinct_turn_count >= 1),
  distinct_day_count integer NOT NULL CHECK (distinct_day_count >= 1),
  contradiction_count integer NOT NULL CHECK (contradiction_count >= 0),
  first_observed_at timestamptz NOT NULL,
  last_observed_at timestamptz NOT NULL,
  reason text NOT NULL CHECK (reason IN (
    'insufficient_distinct_turns', 'one_turn_without_direct_statement',
    'event_specific_temporal_anchor')),
  policy_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX memory_observation_omission_run_idx ON memory_observation_omission (run_id);

CREATE TABLE memory_observation_omission_evidence (
  omission_id uuid NOT NULL REFERENCES memory_observation_omission (id) ON DELETE CASCADE,
  fact_id uuid NOT NULL REFERENCES memory_fact (id),
  role text NOT NULL CHECK (role IN ('support', 'contradiction')),
  position integer NOT NULL CHECK (position >= 0),
  PRIMARY KEY (omission_id, fact_id, role)
);

-- Canonical observations: the current projection per observation identity.
CREATE TABLE memory_canonical_observation (
  canonical_observation_id text PRIMARY KEY,
  canonical_identity_key text NOT NULL UNIQUE,
  identity_version integer NOT NULL,
  observation_key text NOT NULL,
  subject_id text NOT NULL REFERENCES memory_subject (id),
  kind text NOT NULL CHECK (kind IN (
    'fact', 'preference', 'habit', 'conditional_pattern', 'boundary')),
  claim text NOT NULL,
  condition text,
  consequence text,
  topics text[] NOT NULL DEFAULT '{}',
  support_count integer NOT NULL CHECK (support_count >= 1),
  distinct_turn_count integer NOT NULL CHECK (distinct_turn_count >= 1),
  distinct_day_count integer NOT NULL CHECK (distinct_day_count >= 1),
  contradiction_count integer NOT NULL CHECK (contradiction_count >= 0),
  first_observed_at timestamptz NOT NULL,
  last_observed_at timestamptz NOT NULL,
  source_fact_keys text[] NOT NULL,
  contradiction_fact_keys text[] NOT NULL DEFAULT '{}',
  evidence_strength text NOT NULL CHECK (evidence_strength IN ('tentative', 'supported', 'strong')),
  status text NOT NULL CHECK (status IN ('active', 'superseded', 'retracted')),
  consolidation_version text NOT NULL,
  content_hash text NOT NULL,
  revision integer NOT NULL CHECK (revision >= 1),
  promotion_id text NOT NULL,
  promotion_sequence integer NOT NULL,
  -- Fencing token bumped by every mutation (promotion apply, retraction): a
  -- conditional writer CASes on the value it read, so a concurrent retraction
  -- can never be overwritten back to active by an in-flight promotion.
  mutation_seq bigint NOT NULL DEFAULT 0,
  latest_artifact_id text NOT NULL,
  latest_run_id text NOT NULL,
  latest_observation_set_id text NOT NULL,
  latest_fact_set_id text NOT NULL,
  latest_artifact_created_at timestamptz NOT NULL,
  latest_artifact_updated_at timestamptz NOT NULL,
  retraction_kind text CHECK (retraction_kind IN ('policy', 'manual')),
  retraction_reason_codes text[] NOT NULL DEFAULT '{}',
  retraction_policy_version text,
  retraction_operation_key text,
  retracted_at timestamptz,
  last_operation_key text,
  canonical_created_at timestamptz NOT NULL,
  canonical_updated_at timestamptz NOT NULL
);

CREATE INDEX memory_canonical_active_idx ON memory_canonical_observation (status)
  WHERE status = 'active';
CREATE INDEX memory_canonical_search_idx ON memory_canonical_observation USING gin (
  to_tsvector('english',
    claim || ' ' || coalesce(condition, '') || ' ' || coalesce(consequence, '')))
  WHERE status = 'active';

-- Append-only canonical history: every applied action, with the full snapshot
-- it produced. Snapshots carry fact keys as audit copies; facts are immutable
-- once written, so the copies stay valid without a mutable join.
CREATE TABLE memory_observation_history (
  history_event_id text PRIMARY KEY,
  promotion_id text NOT NULL,
  promotion_sequence integer NOT NULL,
  action text NOT NULL CHECK (action IN (
    'created', 'revised', 'unchanged', 'reactivated', 'policy_retracted', 'manual_retracted')),
  operation_key text,
  change_kind text NOT NULL CHECK (change_kind IN ('content', 'evidence', 'status')),
  revision integer NOT NULL CHECK (revision >= 1),
  canonical_observation_id text NOT NULL,
  canonical_identity_key text NOT NULL,
  content_hash text NOT NULL,
  observation_key text NOT NULL,
  subject_id text NOT NULL REFERENCES memory_subject (id),
  kind text NOT NULL,
  claim text NOT NULL,
  condition text,
  consequence text,
  topics text[] NOT NULL DEFAULT '{}',
  support_count integer NOT NULL,
  distinct_turn_count integer NOT NULL,
  distinct_day_count integer NOT NULL,
  contradiction_count integer NOT NULL,
  first_observed_at timestamptz NOT NULL,
  last_observed_at timestamptz NOT NULL,
  source_fact_keys text[] NOT NULL,
  contradiction_fact_keys text[] NOT NULL DEFAULT '{}',
  evidence_strength text NOT NULL,
  status text NOT NULL,
  consolidation_version text NOT NULL,
  source_artifact_id text NOT NULL,
  source_run_id text NOT NULL,
  source_observation_set_id text NOT NULL,
  source_fact_set_id text NOT NULL,
  source_artifact_created_at timestamptz NOT NULL,
  source_artifact_updated_at timestamptz NOT NULL,
  retraction_kind text CHECK (retraction_kind IN ('policy', 'manual')),
  retraction_reason_codes text[] NOT NULL DEFAULT '{}',
  retraction_policy_version text,
  retraction_operation_key text,
  retracted_at timestamptz,
  recorded_at timestamptz NOT NULL
);

CREATE INDEX memory_observation_history_identity_idx
  ON memory_observation_history (canonical_identity_key, recorded_at);
CREATE INDEX memory_observation_history_promotion_idx
  ON memory_observation_history (promotion_id);

-- Promotions: staged plans, applied atomically, verified after apply.
CREATE SEQUENCE memory_promotion_sequence;

CREATE TABLE memory_promotion (
  promotion_id text PRIMARY KEY,
  run_id text NOT NULL REFERENCES memory_run (run_id),
  observation_set_id text NOT NULL,
  fact_set_id text NOT NULL,
  canonicalization_version text NOT NULL,
  evidence_policy_version text NOT NULL,
  source_plan_hash text NOT NULL,
  confirmation_token text NOT NULL,
  item_count integer NOT NULL CHECK (item_count >= 0),
  promotion_sequence integer NOT NULL,
  allow_reactivation boolean NOT NULL DEFAULT false,
  status text NOT NULL CHECK (status IN ('staged', 'applying', 'completed', 'failed')),
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE TABLE memory_promotion_item (
  promotion_id text NOT NULL REFERENCES memory_promotion (promotion_id),
  promotion_item_id text NOT NULL UNIQUE,
  -- Apply outcome: applied normally, skipped because the canonical identity
  -- was retracted between planning and applying (never reactivated), or
  -- superseded because a later promotion already advanced the identity
  -- (this promotion's item was never applied; no history event of its own).
  outcome text NOT NULL DEFAULT 'applied' CHECK (outcome IN ('applied', 'skipped_inactive', 'superseded')),
  canonical_observation_id text NOT NULL,
  canonical_identity_key text NOT NULL,
  content_hash text NOT NULL,
  observation_key text NOT NULL,
  subject_id text NOT NULL REFERENCES memory_subject (id),
  kind text NOT NULL,
  claim text NOT NULL,
  condition text,
  consequence text,
  topics text[] NOT NULL DEFAULT '{}',
  support_count integer NOT NULL,
  distinct_turn_count integer NOT NULL,
  distinct_day_count integer NOT NULL,
  contradiction_count integer NOT NULL,
  first_observed_at timestamptz NOT NULL,
  last_observed_at timestamptz NOT NULL,
  source_fact_keys text[] NOT NULL,
  contradiction_fact_keys text[] NOT NULL DEFAULT '{}',
  evidence_strength text NOT NULL,
  status text NOT NULL,
  consolidation_version text NOT NULL,
  source_artifact_id text NOT NULL,
  source_run_id text NOT NULL,
  source_observation_set_id text NOT NULL,
  source_fact_set_id text NOT NULL,
  source_artifact_created_at timestamptz NOT NULL,
  source_artifact_updated_at timestamptz NOT NULL,
  PRIMARY KEY (promotion_id, canonical_identity_key)
);

-- Temporal memory: behavioral-day-bounded summaries.
CREATE TABLE memory_temporal_summary (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('morning', 'afternoon', 'night', 'day', 'week', 'month')),
  period_key text NOT NULL,
  timezone text NOT NULL,
  start_at timestamptz NOT NULL,
  end_at timestamptz NOT NULL,
  content text NOT NULL,
  message_count integer NOT NULL CHECK (message_count >= 0),
  fingerprint text NOT NULL,
  selection_version text,
  selected_pair_ids text[] NOT NULL DEFAULT '{}',
  segment_pair_counts integer[] NOT NULL DEFAULT '{}',
  with_turn_log integer,
  child_summary_keys text[] NOT NULL DEFAULT '{}',
  model text NOT NULL,
  prompt_version text NOT NULL,
  -- The content hash of the exact prompt text used for generation, stored so
  -- the prompt-context validity check can reject a summary generated under
  -- different prompt content (a DB edit of the same-version prompt row).
  prompt_content_hash text NOT NULL,
  generated_at timestamptz NOT NULL,
  input_tokens integer NOT NULL DEFAULT 0,
  output_tokens integer NOT NULL DEFAULT 0,
  call_count integer NOT NULL DEFAULT 0,
  final_output_tokens integer NOT NULL DEFAULT 0,
  attempt_count integer NOT NULL DEFAULT 0,
  structured_output_fallback boolean NOT NULL DEFAULT false,
  status text NOT NULL CHECK (status IN ('complete', 'failed')),
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, period_key)
);

CREATE INDEX memory_temporal_summary_period_idx
  ON memory_temporal_summary (kind, period_key);

CREATE TABLE memory_temporal_summary_message (
  summary_id uuid NOT NULL REFERENCES memory_temporal_summary (id) ON DELETE CASCADE,
  position integer NOT NULL CHECK (position >= 0),
  message_id uuid NOT NULL REFERENCES conversation_message (id),
  PRIMARY KEY (summary_id, position)
);

-- Profile summaries (v1): subject sheets distilled from temporal day summaries.
CREATE TABLE memory_profile_summary (
  subject_id text PRIMARY KEY REFERENCES memory_subject (id),
  content text NOT NULL,
  source_summary_keys text[] NOT NULL DEFAULT '{}',
  source_fingerprint text NOT NULL,
  model text NOT NULL,
  prompt_version text NOT NULL,
  status text NOT NULL CHECK (status IN ('complete', 'failed')),
  error text,
  generated_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Observation profiles (v2): subject sheets distilled from canonical
-- observations, regenerated only when the observation set fingerprint moves.
CREATE TABLE memory_observation_profile (
  subject_id text PRIMARY KEY REFERENCES memory_subject (id),
  fingerprint text NOT NULL,
  prompt_version text NOT NULL,
  -- The content hash of the exact prompt text used for generation, stored so
  -- the serve gate can reject a document generated under different prompt
  -- content (a DB edit of the same-version prompt row) without recomputing
  -- the observation fingerprint.
  prompt_content_hash text NOT NULL,
  content text NOT NULL,
  source_count integer NOT NULL CHECK (source_count >= 0),
  model text,
  generated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE memory_observation_profile_claim (
  subject_id text NOT NULL REFERENCES memory_observation_profile (subject_id) ON DELETE CASCADE,
  position integer NOT NULL CHECK (position >= 0),
  observation_id text NOT NULL REFERENCES memory_canonical_observation (canonical_observation_id),
  claim_text text NOT NULL,
  PRIMARY KEY (subject_id, position)
);

-- The FULL relational input set a profile was generated from (every active
-- canonical observation rendered into the prompt, not only the ones the
-- model happened to claim). Serve-time suppression checks these rows: the
-- profile is only served while every source is still active with an
-- unchanged revision and content hash, so a concurrent retraction or
-- revision of ANY input observation suppresses the stale prose.
CREATE TABLE memory_observation_profile_source (
  subject_id text NOT NULL REFERENCES memory_observation_profile (subject_id) ON DELETE CASCADE,
  position integer NOT NULL CHECK (position >= 0),
  observation_id text NOT NULL REFERENCES memory_canonical_observation (canonical_observation_id),
  content_hash text NOT NULL,
  revision integer NOT NULL,
  PRIMARY KEY (subject_id, position)
);
CREATE INDEX memory_observation_profile_source_obs_idx
  ON memory_observation_profile_source (observation_id);

-- Consolidation/ingest state for the single-owner thread. initialized_at
-- records that the new-turn-only cursor was established: from then on a null
-- watermark means "everything completed so far is new", never "backfill
-- history".
CREATE TABLE memory_ingest_state (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  initialized_at timestamptz,
  watermark_turn_id uuid REFERENCES conversation_turn (id),
  watermark_end_at timestamptz,
  last_ingest_at timestamptz,
  new_facts_since_consolidation integer NOT NULL DEFAULT 0,
  last_consolidated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Memory operation trace: metadata-only records for memory LLM operations,
-- correlated to turns, runs, and promotions. Deliberately no source, prompt,
-- or response content columns: memory prompts and outputs derive from private
-- conversation content, and the trace must not duplicate it.
CREATE TABLE memory_operation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN (
    'fact_extraction', 'observation_consolidation', 'promotion', 'retraction',
    'temporal_summary', 'profile_summary', 'observation_profile', 'recall')),
  turn_id uuid REFERENCES conversation_turn (id),
  run_id text,
  promotion_id text,
  outcome text NOT NULL CHECK (outcome IN ('ok', 'failed')),
  detail text,
  model text,
  prompt_version text,
  input_tokens integer,
  output_tokens integer,
  llm_calls integer,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);

CREATE INDEX memory_operation_kind_idx ON memory_operation (kind, started_at);
`;

export const memoryMigrations: readonly Migration[] = [
  {
    id: "0003_memory_work",
    sql: MEMORY_WORK,
  },
];
