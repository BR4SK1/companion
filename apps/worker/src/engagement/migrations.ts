/**
 * Engagement-domain schema migrations.
 *
 * The schema is native relational PostgreSQL only: typed columns, foreign
 * keys, and check constraints. There is no JSONB payload, no document
 * facade, no EAV, and no serialized objects.
 *
 * One table is deployment configuration and is deliberately NOT seeded by
 * migrations (like `memory_behavior`, its content is runtime configuration
 * provisioned per deployment, never repository content):
 *
 * - `engagement_bands` — the locally configured band cutoffs (`lullMs` /
 *   `idleMs` / `goneMs`, in milliseconds): THREE strictly increasing
 *   cutoffs delimiting the FOUR half-open bands (`engaged`/`lull`/`idle`/
 *   `gone`). Unprovisioned deployments run the engagement domain as a safe
 *   no-op instead of failing the worker.
 *
 * Per-message assessments are recorded in `engagement_message_assessment`,
 * one row per NEW user message, keyed by message id. Each row records the
 * assessed state, the previous assessment state, the silence duration, and
 * the band cutoffs the assessment used — so any later reader (including a
 * grouped turn reading its last user message's assessment) gets the same
 * recorded values on retries and lease reclaims, without recomputation and
 * without drift when band configuration later changes. A row also carries
 * the provenance of the effective time the assessment was derived from.
 */

import type { Migration } from "@companion/postgres";

const ENGAGEMENT_WORK = `
CREATE TABLE engagement_bands (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  lull_ms bigint NOT NULL CHECK (lull_ms > 0),
  idle_ms bigint NOT NULL CHECK (idle_ms > lull_ms),
  gone_ms bigint NOT NULL CHECK (gone_ms > idle_ms),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE engagement_message_assessment (
  message_id uuid PRIMARY KEY REFERENCES conversation_message (id),
  state text NOT NULL CHECK (state IN ('engaged', 'lull', 'idle', 'gone')),
  previous_state text CHECK (previous_state IN ('engaged', 'lull', 'idle', 'gone')),
  silence_ms bigint CHECK (silence_ms >= 0),
  retained_lull boolean NOT NULL DEFAULT false,
  message_effective_at timestamptz NOT NULL,
  lull_ms bigint NOT NULL,
  idle_ms bigint NOT NULL,
  gone_ms bigint NOT NULL,
  assessed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX engagement_message_assessment_state_idx
  ON engagement_message_assessment (state, assessed_at);
`;

export const engagementMigrations: readonly Migration[] = [
  {
    id: "0006_engagement_assessment",
    sql: ENGAGEMENT_WORK,
  },
];
