/**
 * Canonical promotion and retraction.
 *
 * Promotion applies a completed consolidation run's policy-eligible
 * observation artifacts to the canonical projection: latest snapshot plus
 * append-only history, with sequence-guarded concurrent updates and a
 * post-apply verification. The path is automatic-only and carries the source
 * pipeline's guardrails and nothing else:
 *
 * - policy-rejected artifacts stay blocked (existing plan machinery);
 * - contradiction-bearing (tentative) artifacts are skipped and reported;
 * - single-turn artifacts stay blocked;
 * - inactive canonical identities are never reactivated;
 * - the plan's own confirmation token gates the apply, so the apply is
 *   rejected when canonical state changed between plan and apply;
 * - promotion is idempotent by promotionId, so a retried run is a no-op.
 *
 * Manual promotion does not exist in this port (removed by owner decision):
 * there is no reviewed-exception or reactivation input on this path, and no
 * operator tool writes canonical observations outside it. Correction happens
 * through manual retraction with reason codes and the canonical policy
 * review (`review.ts`).
 */

import { withTransaction, type PostgresPool } from "@companion/postgres";

import { behavioralDay, type BehaviorTime } from "./time.ts";

/** Anything that can execute a query: the pool or one transaction client. */
type SqlExecutor = PostgresPool | import("@companion/postgres").PostgresPoolClient;
import {
  buildCurrentObservation,
  buildHistoryEvent,
  buildRetractionHistoryEvent,
  CANONICALIZATION_VERSION,
  CANONICAL_EVIDENCE_POLICY_VERSION,
  canonicalIdentityKey,
  canonicalObservationId,
  confirmationToken,
  currentStateDigest,
  historyEventId,
  historyEventIdForOperation,
  planHash,
  promotionIdForRun,
  promotionItemId,
  snapshotFromArtifact,
  stableStringify,
} from "./canonical.ts";
import {
  evaluateObservationCandidate,
  evidenceStrength as evidenceStrengthOf,
} from "./policy.ts";
import { getFactsByKeys } from "./facts.ts";
import { getMemoryRun } from "./consolidation.ts";
import type {
  CanonicalHistoryEvent,
  CanonicalObservation,
  CanonicalSnapshot,
  CanonicalSource,
  MemoryFact,
  ObservationArtifact,
  PromotionItem,
  PromotionPlan,
  PromotionResult,
  PromotionVerification,
  RetractionReason,
} from "./types.ts";

const MAX_PROMOTION_ITEMS = 10_000;
const MAX_SOURCE_FACT_IDS = 256;
const MAX_CONTRADICTION_FACT_IDS = 128;
const MAX_TOPICS = 32;
const MAX_CLAIM_CHARS = 2_048;
const MAX_RELATION_CHARS = 1_024;

type CanonicalEvidenceRejectionReason =
  | "single_turn_evidence"
  | "insufficient_recurrence_evidence"
  | "event_specific_temporal_anchor"
  | "source_policy_rejected";

interface CanonicalEvidenceDecision {
  eligible: boolean;
  reason?: CanonicalEvidenceRejectionReason;
  distinctTurnCount: number;
  distinctDayCount: number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface ArtifactForPromotion {
  readonly id: string;
  readonly runId: string;
  readonly observationSetId: string;
  readonly observationKey: string;
  readonly subject: string;
  readonly kind: string;
  readonly claim: string;
  readonly condition: string | null;
  readonly consequence: string | null;
  readonly topics: readonly string[];
  readonly supportCount: number;
  readonly distinctTurnCount: number;
  readonly distinctDayCount: number;
  readonly contradictionCount: number;
  readonly firstObservedAt: Date;
  readonly lastObservedAt: Date;
  readonly sourceFactIds: readonly string[];
  readonly contradictionFactIds: readonly string[];
  readonly evidenceStrength: string;
  readonly status: string;
  readonly consolidationVersion: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

interface ArtifactRow {
  id: string;
  run_id: string;
  observation_set_id: string;
  observation_key: string;
  subject_id: string;
  kind: string;
  claim: string;
  condition: string | null;
  consequence: string | null;
  topics: string[];
  support_count: number;
  distinct_turn_count: number;
  distinct_day_count: number;
  contradiction_count: number;
  first_observed_at: Date;
  last_observed_at: Date;
  evidence_strength: string;
  status: string;
  consolidation_version: string;
  created_at: Date;
  updated_at: Date;
}

interface EvidenceRow {
  observation_id: string;
  fact_key: string;
  role: string;
  position: number;
}

/**
 * Load a run's observation artifacts for promotion: camelCase rows plus the
 * evidence fact keys resolved through the evidence child tables. Source and
 * contradiction evidence stay ordered by their recorded positions.
 */
export async function getRunArtifacts(
  pool: PostgresPool,
  runId: string,
): Promise<ArtifactForPromotion[]> {
  const rows = await pool.query<ArtifactRow>(
    `SELECT id, run_id, observation_set_id, observation_key, subject_id, kind, claim,
            condition, consequence, topics, support_count, distinct_turn_count,
            distinct_day_count, contradiction_count, first_observed_at, last_observed_at,
            evidence_strength, status, consolidation_version, created_at, updated_at
     FROM memory_observation WHERE run_id = $1
     ORDER BY created_at, id`,
    [runId],
  );
  if (rows.rows.length === 0) return [];
  const evidence = await pool.query<EvidenceRow>(
    `SELECT e.observation_id::text AS observation_id, f.fact_key, e.role, e.position
     FROM memory_observation_evidence e
     JOIN memory_fact f ON f.id = e.fact_id
     WHERE e.observation_id IN (SELECT id FROM memory_observation WHERE run_id = $1)
     ORDER BY e.role, e.position`,
    [runId],
  );
  const supportByArtifact = new Map<string, string[]>();
  const contradictionByArtifact = new Map<string, string[]>();
  for (const row of evidence.rows) {
    const target = row.role === "support"
      ? supportByArtifact
      : contradictionByArtifact;
    const list = target.get(row.observation_id) ?? [];
    list.push(row.fact_key);
    target.set(row.observation_id, list);
  }
  return rows.rows.map((row) => ({
    id: row.id,
    runId: row.run_id,
    observationSetId: row.observation_set_id,
    observationKey: row.observation_key,
    subject: row.subject_id,
    kind: row.kind,
    claim: row.claim,
    condition: row.condition,
    consequence: row.consequence,
    topics: row.topics,
    supportCount: row.support_count,
    distinctTurnCount: row.distinct_turn_count,
    distinctDayCount: row.distinct_day_count,
    contradictionCount: row.contradiction_count,
    firstObservedAt: row.first_observed_at,
    lastObservedAt: row.last_observed_at,
    sourceFactIds: supportByArtifact.get(row.id) ?? [],
    contradictionFactIds: contradictionByArtifact.get(row.id) ?? [],
    evidenceStrength: row.evidence_strength,
    status: row.status,
    consolidationVersion: row.consolidation_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

function assertArtifactForPromotion(
  artifact: ArtifactForPromotion,
  run: { runId: string; observationSetId: string; factSetId: string },
  factsById: ReadonlyMap<string, MemoryFact>,
  behavior: BehaviorTime,
): CanonicalEvidenceDecision {
  const label = artifact.id;
  if (artifact.status !== "active") throw new Error(`${label} is not an active artifact`);
  if (artifact.runId !== run.runId) throw new Error(`${label} belongs to another run`);
  if (artifact.observationSetId !== run.observationSetId) {
    throw new Error(`${label} has the wrong observation set`);
  }
  if (!artifact.observationKey) throw new Error(`${label} is missing an observation key`);
  if (!artifact.claim || artifact.claim.length > MAX_CLAIM_CHARS) {
    throw new Error(`${label} has an invalid claim`);
  }
  if (artifact.condition !== null && artifact.condition.length > MAX_RELATION_CHARS) {
    throw new Error(`${label} has an invalid condition`);
  }
  if (artifact.consequence !== null && artifact.consequence.length > MAX_RELATION_CHARS) {
    throw new Error(`${label} has an invalid consequence`);
  }
  if (!Array.isArray(artifact.topics) || artifact.topics.length > MAX_TOPICS) {
    throw new Error(`${label} has invalid topics`);
  }
  if (
    !Array.isArray(artifact.sourceFactIds) || artifact.sourceFactIds.length === 0 ||
    artifact.sourceFactIds.length > MAX_SOURCE_FACT_IDS
  ) {
    throw new Error(`${label} has invalid source facts`);
  }
  if (
    !Array.isArray(artifact.contradictionFactIds) ||
    artifact.contradictionFactIds.length > MAX_CONTRADICTION_FACT_IDS
  ) {
    throw new Error(`${label} has invalid contradiction facts`);
  }
  if (new Set(artifact.sourceFactIds).size !== artifact.sourceFactIds.length) {
    throw new Error(`${label} has duplicate source facts`);
  }
  if (new Set(artifact.contradictionFactIds).size !== artifact.contradictionFactIds.length) {
    throw new Error(`${label} has duplicate contradiction facts`);
  }
  if (artifact.sourceFactIds.some((id) => artifact.contradictionFactIds.includes(id))) {
    throw new Error(`${label} reuses a fact as support and contradiction`);
  }
  if (artifact.supportCount !== artifact.sourceFactIds.length) {
    throw new Error(`${label} has an invalid support count`);
  }
  if (artifact.contradictionCount !== artifact.contradictionFactIds.length) {
    throw new Error(`${label} has an invalid contradiction count`);
  }
  if (
    !validDate(artifact.firstObservedAt) || !validDate(artifact.lastObservedAt) ||
    artifact.firstObservedAt > artifact.lastObservedAt
  ) {
    throw new Error(`${label} has an invalid observation date range`);
  }

  const supportFacts: MemoryFact[] = [];
  const contradictionFacts: MemoryFact[] = [];
  for (const id of artifact.sourceFactIds) {
    const fact = factsById.get(id);
    if (fact === undefined) {
      throw new Error(`${label} references an unknown fact`);
    }
    supportFacts.push(fact);
  }
  for (const id of artifact.contradictionFactIds) {
    const fact = factsById.get(id);
    if (fact === undefined) {
      throw new Error(`${label} references an unknown fact`);
    }
    contradictionFacts.push(fact);
  }
  const allFacts = [...supportFacts, ...contradictionFacts];
  const expectedFirst = Math.min(...allFacts.map((fact) => fact.observedAt.getTime()));
  const expectedLast = Math.max(...allFacts.map((fact) => fact.observedAt.getTime()));
  if (
    artifact.firstObservedAt.getTime() !== expectedFirst ||
    artifact.lastObservedAt.getTime() !== expectedLast
  ) {
    throw new Error(`${label} has an invalid evidence date range`);
  }
  const distinctTurns = new Set(supportFacts.map((fact) => fact.turnKey));
  const distinctDays = new Set(
    supportFacts.map((fact) => behavioralDay(fact.observedAt, behavior)),
  );
  if (
    artifact.distinctTurnCount !== distinctTurns.size ||
    artifact.distinctDayCount !== distinctDays.size
  ) {
    throw new Error(`${label} has invalid evidence breadth`);
  }

  const item = {
    subject: artifact.subject,
    kind: artifact.kind as CanonicalSnapshot["kind"],
    claim: artifact.claim,
    topics: artifact.topics,
    ...(artifact.condition !== null ? { condition: artifact.condition } : {}),
    ...(artifact.consequence !== null ? { consequence: artifact.consequence } : {}),
    sourceFactIds: artifact.sourceFactIds,
    contradictionFactIds: artifact.contradictionFactIds,
  } as const;
  const policy = evaluateObservationCandidate(item, factsById);
  const expectedStrength = evidenceStrengthOf(item, supportFacts as MemoryFact[], behavior);
  if (artifact.evidenceStrength !== expectedStrength) {
    throw new Error(`${label} has an invalid evidence strength`);
  }
  if (!validDate(artifact.createdAt) || !validDate(artifact.updatedAt)) {
    throw new Error(`${label} has invalid artifact dates`);
  }
  if (!policy.eligible) {
    return {
      eligible: false,
      reason: policy.reason === "event_specific_temporal_anchor"
        ? "event_specific_temporal_anchor"
        : policy.reason === "insufficient_distinct_turns"
          ? "insufficient_recurrence_evidence"
          : "source_policy_rejected",
      distinctTurnCount: distinctTurns.size,
      distinctDayCount: distinctDays.size,
    };
  }
  if (distinctTurns.size < 2) {
    return {
      eligible: false,
      reason: "single_turn_evidence",
      distinctTurnCount: distinctTurns.size,
      distinctDayCount: distinctDays.size,
    };
  }
  if ((artifact.kind === "habit" || artifact.kind === "conditional_pattern") && distinctDays.size < 2) {
    return {
      eligible: false,
      reason: "insufficient_recurrence_evidence",
      distinctTurnCount: distinctTurns.size,
      distinctDayCount: distinctDays.size,
    };
  }
  return {
    eligible: true,
    distinctTurnCount: distinctTurns.size,
    distinctDayCount: distinctDays.size,
  };
}

function validDate(value: Date): boolean {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function buildPromotionItem(
  artifact: ArtifactForPromotion,
  promotionId: string,
  factSetId: string,
): PromotionItem {
  const identityKey = canonicalIdentityKey(artifact.observationKey);
  const snapshot = snapshotFromArtifact(artifact);
  return {
    outcome: "applied",
    promotionId,
    promotionItemId: promotionItemId(promotionId, identityKey),
    canonicalObservationId: canonicalObservationId(identityKey),
    canonicalIdentityKey: identityKey,
    contentHash: snapshot.contentHash,
    observation: snapshot,
    source: {
      artifactId: artifact.id,
      runId: artifact.runId,
      observationSetId: artifact.observationSetId,
      factSetId,
      sourceArtifactCreatedAt: artifact.createdAt,
      sourceArtifactUpdatedAt: artifact.updatedAt,
    },
  };
}

type CanonicalPromotionCountKey = "creates" | "revisions" | "unchanged";

function actionFor(
  item: PromotionItem,
  existing: CanonicalObservation | undefined,
): CanonicalPromotionCountKey {
  if (existing === undefined) return "creates";
  // Inactive canonical identities are excluded from the plan entirely before
  // items are built (the automatic path never reactivates), so an existing
  // row here is always active.
  if (existing.contentHash !== item.contentHash) return "revisions";
  return "unchanged";
}

// ---------------------------------------------------------------------------
// Canonical / promotion store queries
// ---------------------------------------------------------------------------

interface CanonicalRow {
  canonical_observation_id: string;
  canonical_identity_key: string;
  identity_version: number;
  observation_key: string;
  subject_id: string;
  kind: string;
  claim: string;
  condition: string | null;
  consequence: string | null;
  topics: string[];
  support_count: number;
  distinct_turn_count: number;
  distinct_day_count: number;
  contradiction_count: number;
  first_observed_at: Date;
  last_observed_at: Date;
  source_fact_keys: string[];
  contradiction_fact_keys: string[];
  evidence_strength: string;
  status: string;
  consolidation_version: string;
  content_hash: string;
  revision: number;
  promotion_id: string;
  promotion_sequence: number;
  mutation_seq: string;
  latest_artifact_id: string;
  latest_run_id: string;
  latest_observation_set_id: string;
  latest_fact_set_id: string;
  latest_artifact_created_at: Date;
  latest_artifact_updated_at: Date;
  retraction_kind: string | null;
  retraction_reason_codes: string[] | null;
  retraction_policy_version: string | null;
  retraction_operation_key: string | null;
  retracted_at: Date | null;
  last_operation_key: string | null;
  canonical_created_at: Date;
  canonical_updated_at: Date;
}

const CANONICAL_COLUMNS = `canonical_observation_id, canonical_identity_key, identity_version,
  observation_key, subject_id, kind, claim, condition, consequence, topics,
  support_count, distinct_turn_count, distinct_day_count, contradiction_count,
  first_observed_at, last_observed_at, source_fact_keys, contradiction_fact_keys,
  evidence_strength, status, consolidation_version, content_hash, revision,
  promotion_id, promotion_sequence, mutation_seq, latest_artifact_id, latest_run_id,
  latest_observation_set_id, latest_fact_set_id, latest_artifact_created_at,
  latest_artifact_updated_at, retraction_kind, retraction_reason_codes,
  retraction_policy_version, retraction_operation_key, retracted_at,
  last_operation_key, canonical_created_at, canonical_updated_at`;

function mapCanonical(row: CanonicalRow): CanonicalObservation {
  const snapshot: CanonicalSnapshot = {
    canonicalObservationId: row.canonical_observation_id,
    canonicalIdentityKey: row.canonical_identity_key,
    identityVersion: row.identity_version,
    observationKey: row.observation_key,
    subject: row.subject_id,
    kind: row.kind as CanonicalSnapshot["kind"],
    claim: row.claim,
    topics: row.topics,
    ...(row.condition !== null ? { condition: row.condition } : {}),
    ...(row.consequence !== null ? { consequence: row.consequence } : {}),
    supportCount: row.support_count,
    distinctTurnCount: row.distinct_turn_count,
    distinctDayCount: row.distinct_day_count,
    contradictionCount: row.contradiction_count,
    firstObservedAt: row.first_observed_at,
    lastObservedAt: row.last_observed_at,
    sourceFactIds: row.source_fact_keys,
    contradictionFactIds: row.contradiction_fact_keys,
    evidenceStrength: row.evidence_strength as CanonicalSnapshot["evidenceStrength"],
    status: row.status as CanonicalSnapshot["status"],
    consolidationVersion: row.consolidation_version,
    contentHash: row.content_hash,
  };
  return {
    ...snapshot,
    revision: row.revision,
    promotionId: row.promotion_id,
    promotionSequence: row.promotion_sequence,
    mutationSeq: Number(row.mutation_seq),
    latestSource: {
      artifactId: row.latest_artifact_id,
      runId: row.latest_run_id,
      observationSetId: row.latest_observation_set_id,
      factSetId: row.latest_fact_set_id,
      sourceArtifactCreatedAt: row.latest_artifact_created_at,
      sourceArtifactUpdatedAt: row.latest_artifact_updated_at,
    },
    ...(row.retraction_kind !== null
      ? {
          retraction: {
            kind: row.retraction_kind as "policy" | "manual",
            reasonCodes: (row.retraction_reason_codes ?? []) as RetractionReason[],
            ...(row.retraction_policy_version !== null
              ? { policyVersion: row.retraction_policy_version }
              : {}),
            operationKey: row.retraction_operation_key ?? "",
            at: row.retracted_at ?? row.canonical_updated_at,
          },
        }
      : {}),
    ...(row.last_operation_key !== null ? { lastOperationKey: row.last_operation_key } : {}),
    canonicalCreatedAt: row.canonical_created_at,
    canonicalUpdatedAt: row.canonical_updated_at,
  };
}

async function getCanonicalObservationsByIdentities(
  pool: PostgresPool,
  identityKeys: readonly string[],
): Promise<CanonicalObservation[]> {
  if (identityKeys.length === 0) return [];
  const result = await pool.query<CanonicalRow>(
    `SELECT ${CANONICAL_COLUMNS} FROM memory_canonical_observation
     WHERE canonical_identity_key = ANY($1::text[])`,
    [identityKeys],
  );
  return result.rows.map(mapCanonical);
}

export async function getCanonicalObservationsByIds(
  pool: PostgresPool,
  ids: readonly string[],
): Promise<CanonicalObservation[]> {
  if (ids.length === 0) return [];
  const result = await pool.query<CanonicalRow>(
    `SELECT ${CANONICAL_COLUMNS} FROM memory_canonical_observation
     WHERE canonical_observation_id = ANY($1::text[])`,
    [ids],
  );
  return result.rows.map(mapCanonical);
}

export async function getAllCanonicalObservations(
  pool: PostgresPool,
): Promise<CanonicalObservation[]> {
  const result = await pool.query<CanonicalRow>(
    `SELECT ${CANONICAL_COLUMNS} FROM memory_canonical_observation`,
  );
  return result.rows.map(mapCanonical);
}

interface PromotionItemRow {
  promotion_id: string;
  promotion_item_id: string;
  canonical_observation_id: string;
  canonical_identity_key: string;
  content_hash: string;
  observation_key: string;
  subject_id: string;
  kind: string;
  claim: string;
  condition: string | null;
  consequence: string | null;
  topics: string[];
  support_count: number;
  distinct_turn_count: number;
  distinct_day_count: number;
  contradiction_count: number;
  first_observed_at: Date;
  last_observed_at: Date;
  source_fact_keys: string[];
  contradiction_fact_keys: string[];
  evidence_strength: string;
  status: string;
  consolidation_version: string;
  source_artifact_id: string;
  source_run_id: string;
  source_observation_set_id: string;
  source_fact_set_id: string;
  source_artifact_created_at: Date;
  source_artifact_updated_at: Date;
  outcome: string;
}

function mapPromotionItem(row: PromotionItemRow): PromotionItem {
  const snapshot: CanonicalSnapshot = {
    canonicalObservationId: row.canonical_observation_id,
    canonicalIdentityKey: row.canonical_identity_key,
    identityVersion: 1,
    observationKey: row.observation_key,
    subject: row.subject_id,
    kind: row.kind as CanonicalSnapshot["kind"],
    claim: row.claim,
    topics: row.topics,
    ...(row.condition !== null ? { condition: row.condition } : {}),
    ...(row.consequence !== null ? { consequence: row.consequence } : {}),
    supportCount: row.support_count,
    distinctTurnCount: row.distinct_turn_count,
    distinctDayCount: row.distinct_day_count,
    contradictionCount: row.contradiction_count,
    firstObservedAt: row.first_observed_at,
    lastObservedAt: row.last_observed_at,
    sourceFactIds: row.source_fact_keys,
    contradictionFactIds: row.contradiction_fact_keys,
    evidenceStrength: row.evidence_strength as CanonicalSnapshot["evidenceStrength"],
    status: row.status as CanonicalSnapshot["status"],
    consolidationVersion: row.consolidation_version,
    contentHash: row.content_hash,
  };
  return {
    promotionId: row.promotion_id,
    promotionItemId: row.promotion_item_id,
    canonicalObservationId: row.canonical_observation_id,
    canonicalIdentityKey: row.canonical_identity_key,
    contentHash: row.content_hash,
    observation: snapshot,
    source: {
      artifactId: row.source_artifact_id,
      runId: row.source_run_id,
      observationSetId: row.source_observation_set_id,
      factSetId: row.source_fact_set_id,
      sourceArtifactCreatedAt: row.source_artifact_created_at,
      sourceArtifactUpdatedAt: row.source_artifact_updated_at,
    },
    outcome: row.outcome === "skipped_inactive"
      ? "skipped_inactive"
      : row.outcome === "superseded"
      ? "superseded"
      : "applied",
  };

}

const PROMOTION_ITEM_COLUMNS = `promotion_id, promotion_item_id, canonical_observation_id,
  canonical_identity_key, content_hash, observation_key, subject_id, kind, claim,
  condition, consequence, topics, support_count, distinct_turn_count,
  distinct_day_count, contradiction_count, first_observed_at, last_observed_at,
  source_fact_keys, contradiction_fact_keys, evidence_strength, status,
  consolidation_version, source_artifact_id, source_run_id,
  source_observation_set_id, source_fact_set_id, source_artifact_created_at,
  source_artifact_updated_at, outcome`;

async function getPromotionItems(
  executor: SqlExecutor,
  promotionId: string,
): Promise<PromotionItem[]> {
  const result = await executor.query<PromotionItemRow>(
    `SELECT ${PROMOTION_ITEM_COLUMNS} FROM memory_promotion_item
     WHERE promotion_id = $1 ORDER BY canonical_identity_key`,
    [promotionId],
  );
  return result.rows.map(mapPromotionItem);
}

async function getPromotion(
  pool: PostgresPool,
  promotionId: string,
): Promise<{
  promotion_id: string;
  source_plan_hash: string;
  confirmation_token: string;
  item_count: number;
  promotion_sequence: number | null;
  allow_reactivation: boolean;
  status: string;
} | null> {
  const result = await pool.query<{
    promotion_id: string;
    source_plan_hash: string;
    confirmation_token: string;
    item_count: number;
    promotion_sequence: number | null;
    allow_reactivation: boolean;
    status: string;
  }>(
    `SELECT promotion_id, source_plan_hash, confirmation_token, item_count,
            promotion_sequence, allow_reactivation, status
     FROM memory_promotion WHERE promotion_id = $1`,
    [promotionId],
  );
  return result.rows[0] ?? null;
}

async function getPromotionForUpdate(
  executor: SqlExecutor,
  promotionId: string,
): Promise<{
  promotion_id: string;
  source_plan_hash: string;
  confirmation_token: string;
  item_count: number;
  promotion_sequence: number | null;
  allow_reactivation: boolean;
  status: string;
} | null> {
  const result = await executor.query<{
    promotion_id: string;
    source_plan_hash: string;
    confirmation_token: string;
    item_count: number;
    promotion_sequence: number | null;
    allow_reactivation: boolean;
    status: string;
  }>(
    `SELECT promotion_id, source_plan_hash, confirmation_token, item_count,
            promotion_sequence, allow_reactivation, status
     FROM memory_promotion WHERE promotion_id = $1 FOR UPDATE`,
    [promotionId],
  );
  return result.rows[0] ?? null;
}

async function updatePromotion(
  pool: PostgresPool,
  promotionId: string,
  fields: { status?: string; completedAt?: Date; error?: string },
): Promise<void> {
  const sets: string[] = [`updated_at = now()`];
  const values: unknown[] = [];
  let index = 1;
  if (fields.status !== undefined) {
    sets.push(`status = $${index++}`);
    values.push(fields.status);
  }
  if (fields.completedAt !== undefined) {
    sets.push(`completed_at = $${index++}`);
    values.push(fields.completedAt);
  }
  if (fields.error !== undefined) {
    sets.push(`error = $${index++}`);
    values.push(fields.error);
  }
  values.push(promotionId);
  await pool.query(
    `UPDATE memory_promotion SET ${sets.join(", ")} WHERE promotion_id = $${index}`,
    values,
  );
}

async function upsertPromotionItems(
  executor: SqlExecutor,
  items: readonly PromotionItem[],
): Promise<void> {
  for (const item of items) {
    await executor.query(
      `INSERT INTO memory_promotion_item
         (promotion_id, promotion_item_id, canonical_observation_id,
          canonical_identity_key, content_hash, observation_key, subject_id, kind,
          claim, condition, consequence, topics, support_count, distinct_turn_count,
          distinct_day_count, contradiction_count, first_observed_at, last_observed_at,
          source_fact_keys, contradiction_fact_keys, evidence_strength, status,
          consolidation_version, source_artifact_id, source_run_id,
          source_observation_set_id, source_fact_set_id,
          source_artifact_created_at, source_artifact_updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29)
       ON CONFLICT (promotion_id, canonical_identity_key) DO UPDATE SET
         content_hash = EXCLUDED.content_hash,
         outcome = 'applied'`,
      [
        item.promotionId,
        item.promotionItemId,
        item.canonicalObservationId,
        item.canonicalIdentityKey,
        item.contentHash,
        item.observation.observationKey,
        item.observation.subject,
        item.observation.kind,
        item.observation.claim,
        item.observation.condition ?? null,
        item.observation.consequence ?? null,
        item.observation.topics,
        item.observation.supportCount,
        item.observation.distinctTurnCount,
        item.observation.distinctDayCount,
        item.observation.contradictionCount,
        item.observation.firstObservedAt,
        item.observation.lastObservedAt,
        item.observation.sourceFactIds,
        item.observation.contradictionFactIds,
        item.observation.evidenceStrength,
        item.observation.status,
        item.observation.consolidationVersion,
        item.source.artifactId,
        item.source.runId,
        item.source.observationSetId,
        item.source.factSetId,
        item.source.sourceArtifactCreatedAt,
        item.source.sourceArtifactUpdatedAt,
      ],
    );
  }
}

export async function getHistoryEvent(
  executor: SqlExecutor,
  historyEventIdValue: string,
): Promise<CanonicalHistoryEvent | null> {
  const result = await executor.query<{ payload: Record<string, unknown> }>(
    `SELECT to_jsonb(h) AS payload
     FROM memory_observation_history h WHERE history_event_id = $1`,
    [historyEventIdValue],
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  return rebuildHistoryEvent(row.payload);
}

/**
 * Rebuild a history event from its flat relational columns. The nested
 * snapshot/source/retraction views of the event are derived views over the
 * row; rebuilding them deterministically is what makes history verification
 * an exact string comparison.
 */
function rebuildHistoryEvent(payload: Record<string, unknown>): CanonicalHistoryEvent {
  const snapshot: CanonicalSnapshot = {
    canonicalObservationId: String(payload.canonical_observation_id),
    canonicalIdentityKey: String(payload.canonical_identity_key),
    identityVersion: 1,
    observationKey: String(payload.observation_key),
    subject: String(payload.subject_id),
    kind: String(payload.kind) as CanonicalSnapshot["kind"],
    claim: String(payload.claim),
    ...(payload.condition !== null && payload.condition !== undefined
      ? { condition: String(payload.condition) }
      : {}),
    ...(payload.consequence !== null && payload.consequence !== undefined
      ? { consequence: String(payload.consequence) }
      : {}),
    topics: payload.topics as string[],
    supportCount: Number(payload.support_count),
    distinctTurnCount: Number(payload.distinct_turn_count),
    distinctDayCount: Number(payload.distinct_day_count),
    contradictionCount: Number(payload.contradiction_count),
    firstObservedAt: new Date(String(payload.first_observed_at)),
    lastObservedAt: new Date(String(payload.last_observed_at)),
    sourceFactIds: payload.source_fact_keys as string[],
    contradictionFactIds: (payload.contradiction_fact_keys ?? []) as string[],
    evidenceStrength: String(payload.evidence_strength) as CanonicalSnapshot["evidenceStrength"],
    status: String(payload.status) as CanonicalSnapshot["status"],
    consolidationVersion: String(payload.consolidation_version),
    contentHash: String(payload.content_hash),
  };
  const source: CanonicalSource = {
    artifactId: String(payload.source_artifact_id),
    runId: String(payload.source_run_id),
    observationSetId: String(payload.source_observation_set_id),
    factSetId: String(payload.source_fact_set_id),
    sourceArtifactCreatedAt: new Date(String(payload.source_artifact_created_at)),
    sourceArtifactUpdatedAt: new Date(String(payload.source_artifact_updated_at)),
  };
  const hasRetraction =
    payload.retraction_kind !== null && payload.retraction_kind !== undefined;
  return {
    historyEventId: String(payload.history_event_id),
    promotionId: String(payload.promotion_id),
    promotionSequence: Number(payload.promotion_sequence),
    action: String(payload.action) as CanonicalHistoryEvent["action"],
    ...(payload.operation_key !== null && payload.operation_key !== undefined
      ? { operationKey: String(payload.operation_key) }
      : {}),
    changeKind: String(payload.change_kind) as CanonicalHistoryEvent["changeKind"],
    revision: Number(payload.revision),
    canonicalObservationId: String(payload.canonical_observation_id),
    canonicalIdentityKey: String(payload.canonical_identity_key),
    contentHash: String(payload.content_hash),
    observation: snapshot,
    source,
    ...(hasRetraction
      ? {
          retraction: {
            kind: String(payload.retraction_kind) as "policy" | "manual",
            reasonCodes: (payload.retraction_reason_codes ?? []) as RetractionReason[],
            ...(payload.retraction_policy_version !== null &&
              payload.retraction_policy_version !== undefined
              ? { policyVersion: String(payload.retraction_policy_version) }
              : {}),
            operationKey: String(payload.retraction_operation_key),
            at: new Date(String(payload.retracted_at)),
          },
        }
      : {}),
    recordedAt: new Date(String(payload.recorded_at)),
  };
}

async function insertHistoryEvent(
  executor: SqlExecutor,
  event: CanonicalHistoryEvent,
): Promise<void> {
  await executor.query(
    `INSERT INTO memory_observation_history
       (history_event_id, promotion_id, promotion_sequence, action, operation_key,
        change_kind, revision, canonical_observation_id, canonical_identity_key,
        content_hash, observation_key, subject_id, kind, claim, condition,
        consequence, topics, support_count, distinct_turn_count, distinct_day_count,
        contradiction_count, first_observed_at, last_observed_at, source_fact_keys,
        contradiction_fact_keys, evidence_strength, status, consolidation_version,
        source_artifact_id, source_run_id, source_observation_set_id,
        source_fact_set_id, source_artifact_created_at, source_artifact_updated_at,
        retraction_kind, retraction_reason_codes, retraction_policy_version,
        retraction_operation_key, retracted_at, recorded_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,$38,$39,$40)
     ON CONFLICT (history_event_id) DO NOTHING`,
    [
      event.historyEventId,
      event.promotionId,
      event.promotionSequence,
      event.action,
      event.operationKey ?? null,
      event.changeKind,
      event.revision,
      event.canonicalObservationId,
      event.canonicalIdentityKey,
      event.contentHash,
      event.observation.observationKey,
      event.observation.subject,
      event.observation.kind,
      event.observation.claim,
      event.observation.condition ?? null,
      event.observation.consequence ?? null,
      event.observation.topics,
      event.observation.supportCount,
      event.observation.distinctTurnCount,
      event.observation.distinctDayCount,
      event.observation.contradictionCount,
      event.observation.firstObservedAt,
      event.observation.lastObservedAt,
      event.observation.sourceFactIds,
      event.observation.contradictionFactIds,
      event.observation.evidenceStrength,
      event.observation.status,
      event.observation.consolidationVersion,
      event.source.artifactId,
      event.source.runId,
      event.source.observationSetId,
      event.source.factSetId,
      event.source.sourceArtifactCreatedAt,
      event.source.sourceArtifactUpdatedAt,
      event.retraction?.kind ?? null,
      event.retraction?.reasonCodes ?? [],
      event.retraction?.policyVersion ?? null,
      event.retraction?.operationKey ?? null,
      event.retraction?.at ?? null,
      event.recordedAt,
    ],
  );
}

async function getHistoryByPromotion(
  pool: PostgresPool,
  promotionId: string,
): Promise<CanonicalHistoryEvent[]> {
  const result = await pool.query<{ payload: Record<string, unknown> }>(
    `SELECT to_jsonb(h) AS payload
     FROM memory_observation_history h WHERE promotion_id = $1`,
    [promotionId],
  );
  return result.rows.map((row) => rebuildHistoryEvent(row.payload));
}

// ---------------------------------------------------------------------------
// Promotion plan and apply
// ---------------------------------------------------------------------------

export interface PromotionPlanInput {
  readonly runId: string;
  readonly skipTentative: boolean;
  /** The behavioral-day boundary (provisioned configuration) used for
   *  behavioral-day evidence counting. */
  readonly behavior: BehaviorTime;
}

export async function buildPromotionPlan(
  pool: PostgresPool,
  input: PromotionPlanInput,
): Promise<PromotionPlan> {
  const run = await getMemoryRun(pool, input.runId);
  if (run === null) throw new Error(`Run ${input.runId} was not found`);
  if (
    run.status !== "observations-ready" ||
    run.facts_status !== "complete" ||
    run.observations_status !== "complete"
  ) {
    throw new Error(`Run ${input.runId} is not complete`);
  }
  const artifacts = await getRunArtifacts(pool, input.runId);
  if (run.observation_count === null || run.observation_count !== artifacts.length) {
    throw new Error(`Run ${input.runId} observation count does not match stored artifacts`);
  }
  if (artifacts.length > MAX_PROMOTION_ITEMS) {
    throw new Error(`Promotion exceeds ${MAX_PROMOTION_ITEMS} artifacts`);
  }
  const factKeys = [
    ...new Set(artifacts.flatMap((artifact) => [
      ...artifact.sourceFactIds,
      ...artifact.contradictionFactIds,
    ])),
  ];
  const facts = await getFactsByKeys(pool, factKeys);
  const factsById = new Map(facts.map((fact) => [fact.factKey, fact]));
  const activeArtifacts = artifacts.filter((artifact) => artifact.status === "active");

  const eligibleArtifacts: ArtifactForPromotion[] = [];
  const blockedArtifactIds: string[] = [];
  const blockedByReason: Record<string, number> = {};
  for (const artifact of activeArtifacts) {
    const id = artifact.id;
    const decision = assertArtifactForPromotion(
      artifact,
      {
        runId: run.run_id,
        observationSetId: run.observation_set_id,
        factSetId: run.fact_set_id,
      },
      factsById,
      input.behavior,
    );
    if (input.skipTentative && artifact.contradictionCount > 0) {
      blockedArtifactIds.push(id);
      blockedByReason.tentative_contradiction_evidence =
        (blockedByReason.tentative_contradiction_evidence ?? 0) + 1;
      continue;
    }
    if (decision.eligible) {
      eligibleArtifacts.push(artifact);
      continue;
    }
    blockedArtifactIds.push(id);
    blockedByReason[decision.reason ?? "policy_rejected"] =
      (blockedByReason[decision.reason ?? "policy_rejected"] ?? 0) + 1;
  }

  const promotionId = promotionIdForRun(run.run_id, run.observation_set_id);
  // Plan-time exclusion: an eligible artifact whose current canonical identity
  // is inactive (retracted) is skipped, not planned. The automatic path never
  // reactivates, and one inactive identity must not reject the whole run or
  // block its unrelated observations. (Apply-time skip logic still defends
  // the plan/apply window, where state can change after planning.)
  const eligibleIdentityKeys = eligibleArtifacts.map((artifact) =>
    canonicalIdentityKey(artifact.observationKey));
  const current = await getCanonicalObservationsByIdentities(pool, eligibleIdentityKeys);
  const currentByIdentity = new Map(
    current.map((observation) => [observation.canonicalIdentityKey, observation]),
  );
  const promotableArtifacts = eligibleArtifacts.filter((artifact) => {
    const existing = currentByIdentity.get(canonicalIdentityKey(artifact.observationKey));
    return existing === undefined || existing.status === "active";
  });
  const items = promotableArtifacts.map((artifact) =>
    buildPromotionItem(artifact, promotionId, run.fact_set_id));
  const identityKeys = items.map((item) => item.canonicalIdentityKey);
  if (new Set(identityKeys).size !== identityKeys.length) {
    throw new Error("Promotion contains duplicate canonical identities");
  }
  const summary = {
    creates: 0,
    revisions: 0,
    unchanged: 0,
    inactiveCanonicalSkipped: eligibleArtifacts.length - promotableArtifacts.length,
    inactiveArtifactsSkipped: artifacts.length - activeArtifacts.length,
    policyBlocked: blockedArtifactIds.length,
    blockedByReason,
  };
  for (const item of items) {
    summary[actionFor(item, currentByIdentity.get(item.canonicalIdentityKey))] += 1;
  }
  const sourcePlanHashValue = planHash(items);
  const stateDigestValue = currentStateDigest(
    current.filter((observation) =>
      identityKeys.includes(observation.canonicalIdentityKey)
    ),
  );
  const databaseResult = await pool.query<{ db: string }>(`SELECT current_database() AS db`);
  const databaseName = databaseResult.rows[0]?.db ?? "";
  return {
    promotionId,
    runId: run.run_id,
    observationSetId: run.observation_set_id,
    factSetId: run.fact_set_id,
    canonicalizationVersion: CANONICALIZATION_VERSION,
    sourcePlanHash: sourcePlanHashValue,
    currentStateDigest: stateDigestValue,
    confirmationToken: confirmationToken({
      databaseName,
      promotionId,
      sourcePlanHash: sourcePlanHashValue,
      currentStateDigest: stateDigestValue,
      allowReactivation: false,
      evidencePolicyVersion: CANONICAL_EVIDENCE_POLICY_VERSION,
      blockedArtifactIds,
      reviewedArtifactIds: [],
    }),
    itemCount: items.length,
    blockedArtifactIds,
    evidencePolicyVersion: CANONICAL_EVIDENCE_POLICY_VERSION,
    summary,
    items,
  };
}

async function ensurePromotionManifest(
  pool: PostgresPool,
  plan: PromotionPlan,
): Promise<{ promotionSequence: number; status: string; sourcePlanHash: string }> {
  // Atomic staging: the manifest row and its COMPLETE item set commit
  // together or not at all, under a row lock that serializes concurrent
  // stagings of the same promotion. A crash can therefore leave either no
  // manifest at all (the next attempt plans and stages fresh) or a complete
  // staged manifest (resumable from its staged items) — never a manifest
  // whose stored items disagree with its declared item count. That
  // disagreement is unrecoverable by design elsewhere: the resumable path
  // rejects it (the staged set is the immutable recovery basis) and would
  // reject every retry forever, making re-staging unreachable.
  return withTransaction(pool, async (client) => {
    let existing = await getPromotionForUpdate(client, plan.promotionId);
    if (existing === null) {
      const sequenceResult = await client.query<{ seq: number }>(
        `SELECT nextval('memory_promotion_sequence')::int AS seq`,
      );
      const sequence = sequenceResult.rows[0]!.seq;
      await client.query(
        `INSERT INTO memory_promotion
           (promotion_id, run_id, observation_set_id, fact_set_id,
            canonicalization_version, evidence_policy_version, source_plan_hash,
            confirmation_token, item_count, promotion_sequence, allow_reactivation, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'staged')
         ON CONFLICT (promotion_id) DO NOTHING`,
        [
          plan.promotionId,
          plan.runId,
          plan.observationSetId,
          plan.factSetId,
          CANONICALIZATION_VERSION,
          CANONICAL_EVIDENCE_POLICY_VERSION,
          plan.sourcePlanHash,
          plan.confirmationToken,
          plan.itemCount,
          sequence,
          false,
        ],
      );
      existing = await getPromotionForUpdate(client, plan.promotionId);
      if (existing === null) {
        throw new Error("Promotion manifest disappeared after a duplicate-key race");
      }
    }
    if (existing.status === "failed" || existing.status === "staged") {
      // A failed attempt may be re-staged with a freshly planned token: the
      // failure is recorded, and the retry carries the new plan hash/token
      // while keeping the original promotion sequence. A promotion still in
      // 'staged' may be re-staged the same way: nothing has been applied yet
      // (apply moves the manifest to 'applying' first), so replacing the
      // staged item set is safe — and necessary when the fresh plan is smaller
      // (e.g. an identity turned inactive after the first staging), because
      // the item upsert never deletes rows that left the plan.
      await client.query(
        `DELETE FROM memory_promotion_item WHERE promotion_id = $1`,
        [plan.promotionId],
      );
      await client.query(
        `UPDATE memory_promotion
         SET source_plan_hash = $2, confirmation_token = $3, item_count = $4,
             error = NULL, updated_at = now()
         WHERE promotion_id = $1`,
        [plan.promotionId, plan.sourcePlanHash, plan.confirmationToken, plan.itemCount],
      );
      existing = await getPromotionForUpdate(client, plan.promotionId);
      if (existing === null) {
        throw new Error("Promotion manifest disappeared during re-staging");
      }
    }
    if (
      existing.source_plan_hash !== plan.sourcePlanHash ||
      existing.confirmation_token !== plan.confirmationToken ||
      existing.item_count !== plan.itemCount ||
      existing.allow_reactivation !== false
    ) {
      throw new Error("Existing promotion manifest does not match the current confirmation plan");
    }
    if (existing.promotion_sequence === null) {
      const sequenceResult = await client.query<{ seq: number }>(
        `SELECT nextval('memory_promotion_sequence')::int AS seq`,
      );
      const sequence = sequenceResult.rows[0]!.seq;
      await client.query(
        `UPDATE memory_promotion SET promotion_sequence = $2, status = 'staged',
           updated_at = now() WHERE promotion_id = $1`,
        [plan.promotionId, sequence],
      );
      existing = await getPromotionForUpdate(client, plan.promotionId);
      if (existing === null || existing.promotion_sequence === null) {
        throw new Error("Promotion manifest has no sequence");
      }
    }
    // Stage the complete item set inside this same transaction: the manifest
    // and its items are one unit (see the atomicity comment above).
    await upsertPromotionItems(client, plan.items);
    const staged = await getPromotionItems(client, plan.promotionId);
    if (staged.length !== plan.itemCount || planHash(staged) !== plan.sourcePlanHash) {
      throw new Error("Staged promotion items failed plan verification");
    }
    return {
      promotionSequence: existing.promotion_sequence,
      status: existing.status,
      sourcePlanHash: existing.source_plan_hash,
    };
  });
}

/** Two history events are the same event when everything but recordedAt
 *  matches: recordedAt is the wall-clock instant of the first write, and a
 *  replayed apply recomputes it. Content fields must match exactly. */
function historyEventMatches(
  stored: CanonicalHistoryEvent,
  event: CanonicalHistoryEvent,
): boolean {
  const { recordedAt: _storedAt, ...storedRest } = stored;
  const { recordedAt: _eventAt, ...eventRest } = event;
  return stableStringify(storedRest) === stableStringify(eventRest);
}

export async function ensureHistoryEvent(
  executor: SqlExecutor,
  event: CanonicalHistoryEvent,
): Promise<void> {
  const existing = await getHistoryEvent(executor, event.historyEventId);
  if (existing !== null) {
    if (!historyEventMatches(existing, event)) {
      throw new Error(`History event ${event.historyEventId} conflicts with the staged event`);
    }
    return;
  }
  await insertHistoryEvent(executor, event);
  const stored = await getHistoryEvent(executor, event.historyEventId);
  if (stored === null || !historyEventMatches(stored, event)) {
    throw new Error(`History event ${event.historyEventId} failed verification`);
  }
}

async function readCurrentForIdentity(
  executor: SqlExecutor,
  identityKey: string,
): Promise<CanonicalObservation | undefined> {
  const result = await executor.query<CanonicalRow>(
    `SELECT ${CANONICAL_COLUMNS} FROM memory_canonical_observation
     WHERE canonical_identity_key = $1 FOR UPDATE`,
    [identityKey],
  );
  const row = result.rows[0];
  return row === undefined ? undefined : mapCanonical(row);
}

/** Row-locked read by canonical observation id (retraction atomicity). */
async function readCurrentForId(
  executor: SqlExecutor,
  canonicalObservationId: string,
): Promise<CanonicalObservation | undefined> {
  const result = await executor.query<CanonicalRow>(
    `SELECT ${CANONICAL_COLUMNS} FROM memory_canonical_observation
     WHERE canonical_observation_id = $1 FOR UPDATE`,
    [canonicalObservationId],
  );
  const row = result.rows[0];
  return row === undefined ? undefined : mapCanonical(row);
}

async function updatePromotionItemOutcome(
  executor: SqlExecutor,
  promotionId: string,
  identityKey: string,
  outcome: "applied" | "skipped_inactive" | "superseded",
): Promise<void> {
  await executor.query(
    `UPDATE memory_promotion_item SET outcome = $3
     WHERE promotion_id = $1 AND canonical_identity_key = $2`,
    [promotionId, identityKey, outcome],
  );
}

/**
 * Apply one staged item inside the caller's transaction, never reactivating:
 * the row was read `FOR UPDATE` in the same transaction, so a concurrent
 * retraction is serialized before the write; the mutation fence CAS below is
 * defense in depth for any non-locking writer. When the current row is not
 * active (a retraction won between plan and apply), the item is skipped —
 * the promotion never writes an active status over a retraction.
 */
/** Thrown when an apply discovers the canonical identity is no longer
 *  active: the caller's transaction rolls back (including any staged
 *  history event) and the item is recorded as skipped. */
class SkipInactiveError extends Error {
  constructor(identityKey: string) {
    super(`Canonical observation ${identityKey} is no longer active; skipping`);
    this.name = "SkipInactiveError";
  }
}

async function applyCurrentObservation(
  executor: SqlExecutor,
  item: PromotionItem,
  sequence: number,
  revision: number,
  promotionId: string,
  now: Date,
): Promise<"applied"> {
  const current = await readCurrentForIdentity(executor, item.canonicalIdentityKey);
  if (current !== undefined) {
    if (current.promotionSequence > sequence) return "applied";
    if (current.status !== "active") throw new SkipInactiveError(item.canonicalIdentityKey);
    if (current.promotionId === promotionId && current.promotionSequence === sequence) {
      return "applied";
    }
  }
  const next = buildCurrentObservation(
    item.observation,
    item.source,
    promotionId,
    sequence,
    revision,
    now,
  );
  if (current !== undefined) {
    const updated = await executor.query(
      `UPDATE memory_canonical_observation
       SET status = $3, content_hash = $4, revision = $5,
           promotion_id = $6, promotion_sequence = $7,
           mutation_seq = memory_canonical_observation.mutation_seq + 1,
           latest_artifact_id = $8, latest_run_id = $9,
           latest_observation_set_id = $10, latest_fact_set_id = $11,
           latest_artifact_created_at = $12, latest_artifact_updated_at = $13,
           claim = $14, condition = $15, consequence = $16, topics = $17,
           support_count = $18, distinct_turn_count = $19, distinct_day_count = $20,
           contradiction_count = $21, first_observed_at = $22, last_observed_at = $23,
           source_fact_keys = $24, contradiction_fact_keys = $25,
           evidence_strength = $26, consolidation_version = $27,
           canonical_updated_at = $28
       WHERE canonical_identity_key = $1 AND promotion_sequence < $2
         AND mutation_seq = $29
       RETURNING canonical_observation_id`,
      [
        item.canonicalIdentityKey,
        sequence,
        next.status,
        next.contentHash,
        revision,
        promotionId,
        sequence,
        next.latestSource.artifactId,
        next.latestSource.runId,
        next.latestSource.observationSetId,
        next.latestSource.factSetId,
        next.latestSource.sourceArtifactCreatedAt,
        next.latestSource.sourceArtifactUpdatedAt,
        next.claim,
        next.condition ?? null,
        next.consequence ?? null,
        next.topics,
        next.supportCount,
        next.distinctTurnCount,
        next.distinctDayCount,
        next.contradictionCount,
        next.firstObservedAt,
        next.lastObservedAt,
        next.sourceFactIds,
        next.contradictionFactIds,
        next.evidenceStrength,
        next.consolidationVersion,
        now,
        current.mutationSeq,
      ],
    );
    if (updated.rows.length > 0) return "applied";
    // The fence moved under us despite the row lock: re-read and re-decide
    // (a retraction may have committed between our stages).
    const raced = await readCurrentForIdentity(executor, item.canonicalIdentityKey);
    if (raced !== undefined && raced.status !== "active") {
      throw new SkipInactiveError(item.canonicalIdentityKey);
    }
    throw new Error(
      `Could not apply canonical observation ${item.canonicalIdentityKey}: concurrent mutation`,
    );
  }
  const inserted = await executor.query(
    `INSERT INTO memory_canonical_observation
       (canonical_observation_id, canonical_identity_key, identity_version,
        observation_key, subject_id, kind, claim, condition, consequence, topics,
        support_count, distinct_turn_count, distinct_day_count, contradiction_count,
        first_observed_at, last_observed_at, source_fact_keys,
        contradiction_fact_keys, evidence_strength, status, consolidation_version,
        content_hash, revision, promotion_id, promotion_sequence,
        latest_artifact_id, latest_run_id, latest_observation_set_id,
        latest_fact_set_id, latest_artifact_created_at, latest_artifact_updated_at,
        canonical_created_at, canonical_updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33)
     ON CONFLICT (canonical_identity_key) DO NOTHING
     RETURNING canonical_observation_id`,
    [
      next.canonicalObservationId,
      next.canonicalIdentityKey,
      next.identityVersion,
      next.observationKey,
      next.subject,
      next.kind,
      next.claim,
      next.condition ?? null,
      next.consequence ?? null,
      next.topics,
      next.supportCount,
      next.distinctTurnCount,
      next.distinctDayCount,
      next.contradictionCount,
      next.firstObservedAt,
      next.lastObservedAt,
      next.sourceFactIds,
      next.contradictionFactIds,
      next.evidenceStrength,
      next.status,
      next.consolidationVersion,
      next.contentHash,
      revision,
      promotionId,
      sequence,
      next.latestSource.artifactId,
      next.latestSource.runId,
      next.latestSource.observationSetId,
      next.latestSource.factSetId,
      next.latestSource.sourceArtifactCreatedAt,
      next.latestSource.sourceArtifactUpdatedAt,
      now,
      now,
    ],
  );
  if (inserted.rows.length > 0) return "applied";
  // Lost an insert race: re-read and re-decide under the same rules.
  const raced = await readCurrentForIdentity(executor, item.canonicalIdentityKey);
  if (raced !== undefined && raced.status !== "active") {
    throw new SkipInactiveError(item.canonicalIdentityKey);
  }
  if (raced !== undefined && raced.promotionSequence >= sequence) return "applied";
  throw new Error(
    `Could not apply canonical observation ${item.canonicalIdentityKey}: concurrent insert`,
  );
}

/**
 * Apply staged items, one transaction per item: the history event and the
 * canonical write commit or roll back together, an item's failure never
 * blocks unrelated eligible items, and a concurrent retraction makes the
 * item skip instead of reactivating. Idempotent under replay: staged items
 * are the authority, history events are keyed per (promotion, identity), and
 * the recordedAt of the first write is preserved.
 */
async function applyStagedPromotionItems(
  pool: PostgresPool,
  items: readonly PromotionItem[],
  promotionSequence: number,
  promotionId: string,
): Promise<{
  created: number;
  revised: number;
  unchanged: number;
  skippedInactive: number;
  superseded: number;
}> {
  let created = 0;
  let revised = 0;
  let unchanged = 0;
  let skippedInactive = 0;
  let superseded = 0;
  for (const item of items) {
    let outcome: { action: string; applied: "applied" | "superseded" };
    try {
      outcome = await withTransaction(pool, async (client) => {
        const current = await readCurrentForIdentity(client, item.canonicalIdentityKey);
        // Settled-by-this-promotion check FIRST, before the inactive skip:
        // an earlier attempt of THIS promotion already applied the item and
        // its history event committed in the same transaction as the
        // document write. Even if the document was retracted afterwards
        // (crash before the manifest completed), the item stays 'applied' —
        // a resume must never restore a retraction. No new history event is
        // written: deriving one now would not match the first write.
        if (current !== undefined) {
          const priorEvent = await getHistoryEvent(
            client,
            historyEventId(promotionId, item.canonicalIdentityKey),
          );
          if (
            priorEvent !== null &&
            current.promotionSequence >= promotionSequence
          ) {
            await updatePromotionItemOutcome(
              client,
              promotionId,
              item.canonicalIdentityKey,
              "applied",
            );
            return { action: "unchanged", applied: "applied" as const };
          }
        }
        // Skip decision under the row lock, BEFORE any history write: a
        // retracted identity is never reactivated and produces no promotion
        // history event (the retraction carries its own).
        if (current !== undefined && current.status !== "active") {
          await updatePromotionItemOutcome(
            client,
            promotionId,
            item.canonicalIdentityKey,
            "skipped_inactive",
          );
          throw new SkipInactiveError(item.canonicalIdentityKey);
        }
        if (
          current !== undefined &&
          current.promotionSequence > promotionSequence
        ) {
          // Superseded: a later promotion already advanced this identity and
          // this promotion's item was never applied (no event of ours above).
          // Record the outcome and touch nothing else — no history event, no
          // write to the later promotion's document, never a restore.
          await updatePromotionItemOutcome(
            client,
            promotionId,
            item.canonicalIdentityKey,
            "superseded",
          );
          return { action: "superseded", applied: "superseded" as const };
        }
        const contentChanged =
          current !== undefined && current.contentHash !== item.contentHash;
        const revision = current !== undefined
          ? current.revision + (contentChanged ? 1 : 0)
          : 1;
        const action = current === undefined
          ? "created"
          : contentChanged
            ? "revised"
            : "unchanged";
        const event = buildHistoryEvent({
          item,
          action,
          revision,
          promotionSequence,
          recordedAt: new Date(),
        });
        await ensureHistoryEvent(client, event);
        const applied = await applyCurrentObservation(
          client,
          item,
          promotionSequence,
          revision,
          promotionId,
          new Date(),
        );
        await updatePromotionItemOutcome(client, promotionId, item.canonicalIdentityKey, applied);
        return { action, applied };
      });
    } catch (error) {
      if (error instanceof SkipInactiveError) {
        // The transaction rolled back (no history event leaked); record the
        // outcome on its own so a replay treats the item as settled.
        await withTransaction(pool, async (client) => {
          await updatePromotionItemOutcome(
            client,
            promotionId,
            item.canonicalIdentityKey,
            "skipped_inactive",
          );
        });
        skippedInactive += 1;
        continue;
      }
      throw error;
    }
    if (outcome.action === "created") created += 1;
    else if (outcome.action === "revised") revised += 1;
    else if (outcome.action === "superseded") superseded += 1;
    else unchanged += 1;
  }
  return { created, revised, unchanged, skippedInactive, superseded };
}

async function verifyPromotionInternal(
  pool: PostgresPool,
  promotion: { promotionId: string; itemCount: number; sourcePlanHash: string; promotionSequence: number; status: string },
): Promise<PromotionVerification> {
  // Outcomes are read fresh: the caller's pre-apply snapshot predates the
  // apply, so its per-item outcomes (and the history events they imply) are
  // stale by definition.
  const stagedItems = await getPromotionItems(pool, promotion.promotionId);
  const storedHistory = await getHistoryByPromotion(pool, promotion.promotionId);
  const expectedHistoryIds = new Set(
    stagedItems
      .filter((item) => item.outcome === "applied")
      .map((item) => historyEventId(promotion.promotionId, item.canonicalIdentityKey)),
  );
  const promotionHistory = storedHistory.filter((event) =>
    expectedHistoryIds.has(event.historyEventId));
  const identities = stagedItems.map((item) => item.canonicalIdentityKey);
  const current = await getCanonicalObservationsByIdentities(pool, identities);
  // Per-item checks use ALL stored history events for this promotion (an
  // outcome-filtered set would hide an event recorded for an item whose
  // staged outcome is not 'applied').
  const historyIds = new Set(storedHistory.map((event) => event.historyEventId));
  let missingHistoryEvents = 0;
  let currentDocumentsBehindSequence = 0;
  let skippedNotInactive = 0;
  let supersededInvalid = 0;
  for (const item of stagedItems) {
    const document = current.find(
      (candidate) => candidate.canonicalIdentityKey === item.canonicalIdentityKey,
    );
    if (item.outcome === "skipped_inactive") {
      // A concurrently retracted identity: it must still be inactive and must
      // not carry this promotion's sequence (we never reactivated it).
      if (
        document === undefined ||
        document.status === "active" ||
        (document.promotionId === promotion.promotionId &&
          document.promotionSequence >= promotion.promotionSequence)
      ) {
        skippedNotInactive += 1;
      }
      continue;
    }
    if (item.outcome === "superseded") {
      // A later promotion advanced this identity before this promotion could
      // apply its item: the document must be strictly ahead of this
      // promotion's sequence, and this promotion must have written no
      // history event for it (the item was never applied here). The later
      // promotion's content stands; a retraction of it is never restored.
      if (
        document === undefined ||
        document.promotionSequence <= promotion.promotionSequence ||
        historyIds.has(historyEventId(promotion.promotionId, item.canonicalIdentityKey))
      ) {
        supersededInvalid += 1;
      }
      continue;
    }
    // Applied items are status-agnostic: a document retracted AFTER this
    // promotion applied it still verifies (the retraction carries its own
    // history and is never restored), as long as this promotion's history
    // event exists and the document reached at least this sequence.
    if (!historyIds.has(historyEventId(promotion.promotionId, item.canonicalIdentityKey))) {
      missingHistoryEvents += 1;
    }
    if (
      document === undefined ||
      document.promotionSequence < promotion.promotionSequence
    ) {
      currentDocumentsBehindSequence += 1;
    }
  }
  const stagedPlanHash =
    stagedItems.length === promotion.itemCount ? planHash(stagedItems) : "";
  const appliedCount = stagedItems.filter((item) => item.outcome === "applied").length;
  return {
    promotionId: promotion.promotionId,
    manifestStatus: promotion.status,
    itemCount: promotion.itemCount,
    stagedItemCount: stagedItems.length,
    historyEventCount: promotionHistory.length,
    currentIdentityCount: current.length,
    missingHistoryEvents,
    currentDocumentsBehindSequence,
    skippedNotInactive,
    supersededInvalid,
    planHashMatches: stagedPlanHash === promotion.sourcePlanHash,
    valid:
      stagedItems.length === promotion.itemCount &&
      promotionHistory.length === appliedCount &&
      missingHistoryEvents === 0 &&
      currentDocumentsBehindSequence === 0 &&
      skippedNotInactive === 0 &&
      supersededInvalid === 0 &&
      stagedPlanHash === promotion.sourcePlanHash,
  };
}

/** Backoff window for promotion reconcile retries: a run whose latest
 *  promotion attempt failed recently is skipped by the sweep so repeated
 *  failures cannot starve older pending runs behind the bounded batch. */
export const PROMOTION_RECONCILE_BACKOFF_MS = 5 * 60 * 1000;

/**
 * Runs with observations ready and no successful promotion operation, bounded
 * — excluding runs whose latest failed promotion operation is within
 * `backoffMs`, and ordered FAIRLY for retry selection.
 *
 * Fairness: the order key is each run's latest failed promotion attempt
 * (never-attempted runs order by their completion time), oldest first. With
 * the previous oldest-run-first ordering, a batch of repeatedly failing old
 * runs monopolized the bounded batch forever whenever the retry backoff was
 * shorter than the reconcile cadence — every sweep re-selected the same
 * oldest runs and pending runs behind them were starved. Ordering by
 * least-recent-attempt rotates the batch instead: each failure moves that run
 * behind every run that has not just been tried, so every pending run is
 * eventually selected regardless of backoff and cadence lengths.
 */
export async function selectPendingPromotionRunIds(
  pool: PostgresPool,
  backoffMs: number,
  limit: number,
): Promise<string[]> {
  const result = await pool.query<{ run_id: string }>(
    `SELECT r.run_id
     FROM memory_run r
     WHERE r.status = 'observations-ready'
       AND NOT EXISTS (
         SELECT 1 FROM memory_operation o
         WHERE o.kind = 'promotion' AND o.run_id = r.run_id AND o.outcome = 'ok')
       AND NOT EXISTS (
         SELECT 1 FROM memory_operation o
         WHERE o.kind = 'promotion' AND o.run_id = r.run_id AND o.outcome = 'failed'
           AND COALESCE(o.finished_at, o.started_at) > now() - make_interval(secs => $1))
     ORDER BY COALESCE((
       SELECT MAX(COALESCE(o.finished_at, o.started_at))
       FROM memory_operation o
       WHERE o.kind = 'promotion' AND o.run_id = r.run_id AND o.outcome = 'failed'
     ), r.completed_at) ASC
     LIMIT $2`,
    [backoffMs / 1000, limit],
  );
  return result.rows.map((row) => row.run_id);
}

/**
 * The promotion manifest for a run, looked up by the manifest's `run_id`
 * (a run has at most one manifest: the promotion id is derived
 * deterministically from the run and its immutable observation-set id).
 */
export async function getPromotionForRun(
  pool: PostgresPool,
  runId: string,
): Promise<{
  promotion_id: string;
  source_plan_hash: string;
  confirmation_token: string;
  item_count: number;
  promotion_sequence: number | null;
  allow_reactivation: boolean;
  status: string;
} | null> {
  const result = await pool.query<{
    promotion_id: string;
    source_plan_hash: string;
    confirmation_token: string;
    item_count: number;
    promotion_sequence: number | null;
    allow_reactivation: boolean;
    status: string;
  }>(
    `SELECT promotion_id, source_plan_hash, confirmation_token, item_count,
            promotion_sequence, allow_reactivation, status
     FROM memory_promotion WHERE run_id = $1`,
    [runId],
  );
  return result.rows[0] ?? null;
}

/**
 * Manifest-first recovery: resolve a run's EXISTING promotion manifest from
 * its immutable stored state — never by re-planning.
 *
 * - `staged`/`applying`: apply the staged items (their plan hash was verified
 *   when the manifest was staged; staging/apply state is crash-resumable
 *   because every item apply is idempotent under its row lock).
 * - `completed`: verify the ORIGINAL staged manifest (stored item count, plan
 *   hash, and history events) — never a fresh plan, which concurrent state
 *   changes (later promotions, retractions) would make disagree and which
 *   could wrongly reject finished work.
 * - `failed` or no manifest: returns null; the caller plans fresh (a failed
 *   attempt is re-staged with a newly planned token by design).
 *
 * This is the recovery path reconciliation must use: re-planning an existing
 * manifest can mis-mark recovery as "nothing eligible" (the fresh plan
 * excludes identities that changed during the crash window) and would
 * replace — instead of finish — the already-staged work.
 */
export async function resumePromotionForRun(
  pool: PostgresPool,
  input: { runId: string },
): Promise<PromotionResult | null> {
  const existing = await getPromotionForRun(pool, input.runId);
  if (existing === null || existing.status === "failed") return null;
  const stagedItems = await getPromotionItems(pool, existing.promotion_id);
  if (
    stagedItems.length !== existing.item_count ||
    planHash(stagedItems) !== existing.source_plan_hash
  ) {
    throw new Error("Stored promotion manifest does not match its staged items");
  }
  if (existing.status === "completed") {
    const verification = await verifyPromotionInternal(pool, {
      promotionId: existing.promotion_id,
      itemCount: existing.item_count,
      sourcePlanHash: existing.source_plan_hash,
      promotionSequence: existing.promotion_sequence ?? 0,
      status: "completed",
    });
    if (!verification.valid) {
      throw new Error("Completed promotion failed verification of its original staged history");
    }
    const applied = stagedItems.filter((item) => item.outcome === "applied").length;
    return {
      promotionId: existing.promotion_id,
      status: "already-completed",
      promotionSequence: existing.promotion_sequence ?? 0,
      itemCount: existing.item_count,
      created: 0,
      revised: 0,
      unchanged: applied,
      reactivated: 0,
      skippedInactive: stagedItems.length - applied,
      superseded: 0,
      historyEvents: verification.historyEventCount,
    };
  }
  // staged | applying: resume from the immutable staged items.
  if (existing.status === "staged") {
    // Mark applying before the first apply so a crash during the resume is
    // the ordinary applying-resume case (never a half-applied 'staged').
    await updatePromotion(pool, existing.promotion_id, { status: "applying" });
  }
  if (existing.promotion_sequence === null) {
    throw new Error("Promotion manifest has no sequence");
  }
  const counts = await applyStagedPromotionItems(
    pool,
    stagedItems,
    existing.promotion_sequence,
    existing.promotion_id,
  );
  const verification = await verifyPromotionInternal(pool, {
    promotionId: existing.promotion_id,
    itemCount: existing.item_count,
    sourcePlanHash: existing.source_plan_hash,
    promotionSequence: existing.promotion_sequence,
    status: "applying",
  });
  if (!verification.valid) {
    await updatePromotion(pool, existing.promotion_id, {
      status: "failed",
      error: "post-apply verification failed on resume",
    });
    throw new Error("Canonical promotion failed post-apply verification on resume");
  }
  await updatePromotion(pool, existing.promotion_id, {
    status: "completed",
    completedAt: new Date(),
  });
  return {
    promotionId: existing.promotion_id,
    status: "completed",
    promotionSequence: existing.promotion_sequence,
    itemCount: existing.item_count,
    created: counts.created,
    revised: counts.revised,
    unchanged: counts.unchanged,
    reactivated: 0,
    skippedInactive: counts.skippedInactive,
    superseded: counts.superseded,
    historyEvents: verification.historyEventCount,
  };
}

export async function promoteRun(
  pool: PostgresPool,
  input: {
    runId: string;
    confirmationToken: string;
    skipTentative: boolean;
    /** The behavioral-day boundary (provisioned configuration). */
    behavior: BehaviorTime;
  },
): Promise<PromotionResult> {
  // Manifest-first: an existing staged/applying/completed manifest is
  // recovered from its immutable stored state without planning (see
  // resumePromotionForRun). Only a run without a live manifest — or with a
  // failed one, which is re-staged with a fresh token by design — reaches
  // the planning path below.
  const recovered = await resumePromotionForRun(pool, { runId: input.runId });
  if (recovered !== null) return recovered;

  const plan = await buildPromotionPlan(pool, input);
  if (input.confirmationToken !== plan.confirmationToken) {
    throw new Error(
      "Confirmation token does not match the current source/current-state plan; run the plan again",
    );
  }
  if (plan.itemCount === 0) {
    throw new Error("Promotion has no eligible canonical observations");
  }
  // Reactivation safety is structural now: the planner excludes inactive
  // canonical identities, so no staged item can reactivate one. The apply
  // path still skips an item whose identity turned inactive after planning.
  // The manifest and its complete item set were staged atomically (see
  // ensurePromotionManifest); the post-commit re-verification below is a
  // cheap independent check that the committed state matches the plan.
  const manifest = await ensurePromotionManifest(pool, plan);
  const staged = await getPromotionItems(pool, plan.promotionId);
  if (staged.length !== plan.itemCount || planHash(staged) !== plan.sourcePlanHash) {
    throw new Error("Staged promotion items failed plan verification");
  }
  await updatePromotion(pool, plan.promotionId, { status: "applying" });

  const counts = await applyStagedPromotionItems(
    pool,
    staged,
    manifest.promotionSequence,
    plan.promotionId,
  );
  const verification = await verifyPromotionInternal(
    pool,
    {
      promotionId: plan.promotionId,
      itemCount: plan.itemCount,
      sourcePlanHash: plan.sourcePlanHash,
      promotionSequence: manifest.promotionSequence,
      status: "applying",
    },
  );
  if (!verification.valid) {
    await updatePromotion(pool, plan.promotionId, {
      status: "failed",
      error: "post-apply verification failed",
    });
    throw new Error("Canonical promotion failed post-apply verification");
  }
  await updatePromotion(pool, plan.promotionId, {
    status: "completed",
    completedAt: new Date(),
  });
  return {
    promotionId: plan.promotionId,
    status: "completed",
    promotionSequence: manifest.promotionSequence,
    itemCount: plan.itemCount,
    created: counts.created,
    revised: counts.revised,
    unchanged: counts.unchanged,
    reactivated: 0,
    skippedInactive: counts.skippedInactive,
    superseded: counts.superseded,
    historyEvents: verification.historyEventCount,
  };
}

export async function verifyPromotion(
  pool: PostgresPool,
  promotionId: string,
): Promise<PromotionVerification> {
  const promotion = await getPromotion(pool, promotionId);
  if (promotion === null) throw new Error(`Promotion ${promotionId} was not found`);
  return verifyPromotionInternal(
    pool,
    {
      promotionId,
      itemCount: promotion.item_count,
      sourcePlanHash: promotion.source_plan_hash,
      promotionSequence: promotion.promotion_sequence ?? 0,
      status: promotion.status,
    },
  );
}

// ---------------------------------------------------------------------------
// Manual retraction (correction)
// ---------------------------------------------------------------------------

export interface RetractionInput {
  readonly canonicalObservationId: string;
  readonly reasonCodes: readonly RetractionReason[];
  /** Recorded on the history event's operation key for audit. */
  readonly operationKey: string;
  readonly policyVersion?: string;
}

export interface RetractionResult {
  readonly status: "completed" | "no-op";
  readonly historyEventId: string;
  /** True when a snapshot fence skipped the apply because the row changed
   *  after the plan was built (never retracted on a stale plan). */
  readonly stale?: boolean;
}

/**
 * Manually retract a canonical observation (operator correction, user or
 * privacy request). The retraction is a status change with an append-only
 * history event, guarded by the current revision so a concurrent promotion
 * cannot be silently overwritten.
 */
export async function retractCanonicalObservation(
  pool: PostgresPool,
  input: RetractionInput,
): Promise<RetractionResult> {
  const current = (
    await getCanonicalObservationsByIds(pool, [input.canonicalObservationId])
  )[0];
  if (current === undefined) {
    throw new Error(`Canonical observation ${input.canonicalObservationId} was not found`);
  }
  if (current.status !== "active") {
    if (current.retraction?.operationKey === input.operationKey) {
      return { status: "no-op", historyEventId: historyEventIdForOperationKey(input.operationKey) };
    }
    if (current.retraction?.kind === "manual") {
      throw new Error(
        `Canonical observation ${input.canonicalObservationId} already has a manual retraction`,
      );
    }
    throw new Error(
      `Canonical observation ${input.canonicalObservationId} is not active (status ${current.status})`,
    );
  }
  return applyRetractionUpdate(pool, current, {
    action: "manual_retracted",
    reasonCodes: input.reasonCodes,
    policyVersion: input.policyVersion,
    operationKey: input.operationKey,
    recordedAt: new Date(),
  });
}

export interface RetractionApplyInput {
  readonly action: "policy_retracted" | "manual_retracted";
  readonly reasonCodes: readonly RetractionReason[];
  readonly policyVersion?: string;
  readonly operationKey: string;
  readonly recordedAt: Date;
  /**
   * Snapshot fence (automated plans, e.g. the canonical policy review): when
   * provided, the retraction applies only to the row EXACTLY as reviewed —
   * same revision and content hash. A row that a concurrent promotion revised
   * after the plan was built is skipped as stale, never retracted on the
   * strength of decisions made about older content; the next review re-plans
   * against the current state. Manual retractions omit the fence: an operator
   * acts on the row as it stands now.
   */
  readonly expectedRevision?: number;
  readonly expectedContentHash?: string;
}

/**
 * Apply one retraction to a canonical observation ATOMICALLY: one
 * transaction re-reads the row under `FOR UPDATE`, re-decides the outcome
 * (apply / replay no-op / never-overwrite), appends the retraction history
 * event, and guarded-updates the current row (revision, status, and
 * mutation sequence checked inside the UPDATE). History and status commit
 * together, so a crash cannot leave one without the other, a replay cannot
 * double-write an event, and a competing retraction or promotion cannot
 * interleave between the decision and the write. Shared by the manual
 * retraction and the canonical policy review.
 */
export async function applyRetractionUpdate(
  pool: PostgresPool,
  current: CanonicalObservation,
  input: RetractionApplyInput,
): Promise<RetractionResult> {
  return withTransaction(pool, async (client) => {
    const locked = await readCurrentForId(client, current.canonicalObservationId);
    if (locked === undefined) {
      throw new Error(
        `Canonical observation ${current.canonicalObservationId} was not found`,
      );
    }
    if (locked.status !== "active") {
      // Replay of this same operation: the retraction already committed.
      if (
        locked.lastOperationKey === input.operationKey ||
        locked.retraction?.operationKey === input.operationKey
      ) {
        return {
          status: "no-op",
          historyEventId: historyEventIdForOperationKey(input.operationKey),
        };
      }
      // Policy retractions never overwrite any non-active state (including a
      // manual operator decision that landed after the caller's pre-check).
      if (input.action === "policy_retracted") {
        return {
          status: "no-op",
          historyEventId: historyEventIdForOperationKey(input.operationKey),
        };
      }
      if (locked.retraction?.kind === "manual") {
        throw new Error(
          `Canonical observation ${locked.canonicalObservationId} already has a manual retraction`,
        );
      }
      throw new Error(
        `Canonical observation ${locked.canonicalObservationId} is not active (status ${locked.status})`,
      );
    }
    // Snapshot fence for automated plans: the row must still be exactly the
    // reviewed snapshot. A concurrent promotion revision between plan and
    // apply means the review's evidence no longer describes this content —
    // skip as stale instead of retracting newly-updated state on a stale
    // plan (the next review re-plans against the current state).
    if (
      (input.expectedRevision !== undefined &&
        locked.revision !== input.expectedRevision) ||
      (input.expectedContentHash !== undefined &&
        locked.contentHash !== input.expectedContentHash)
    ) {
      return {
        status: "no-op",
        historyEventId: historyEventIdForOperationKey(input.operationKey),
        stale: true,
      };
    }
    // Snapshot and event come from the LOCKED row: the revision and mutation
    // sequence the event and CAS describe are the ones that will be updated.
    const event = buildRetractionHistoryEvent({
      current: locked,
      operationKey: input.operationKey,
      action: input.action,
      reasonCodes: input.reasonCodes,
      policyVersion: input.policyVersion,
      recordedAt: input.recordedAt,
    });
    await ensureHistoryEvent(client, event);
    const snapshot = event.observation;
    const updated = await client.query(
      `UPDATE memory_canonical_observation
       SET status = 'retracted', content_hash = $3, revision = revision + 1,
           retraction_kind = $4,
           retraction_reason_codes = $5,
           retraction_policy_version = $6,
           retraction_operation_key = $7,
           retracted_at = $8,
           last_operation_key = $7,
           mutation_seq = memory_canonical_observation.mutation_seq + 1,
           canonical_updated_at = $8
       WHERE canonical_identity_key = $1 AND revision = $2 AND status = 'active'
         AND mutation_seq = $9
       RETURNING canonical_observation_id`,
      [
        locked.canonicalIdentityKey,
        locked.revision,
        snapshot.contentHash,
        input.action === "policy_retracted" ? "policy" : "manual",
        input.reasonCodes,
        input.policyVersion ?? null,
        input.operationKey,
        input.recordedAt,
        locked.mutationSeq,
      ],
    );
    if (updated.rows.length === 0) {
      // Unreachable while the row lock is held; treat as a raced write.
      throw new Error(
        `Canonical observation ${locked.canonicalObservationId} changed during retraction`,
      );
    }
    return { status: "completed", historyEventId: event.historyEventId };
  });
}

function historyEventIdForOperationKey(operationKey: string): string {
  return historyEventIdForOperation(operationKey);
}

export const __internal = {
  assertArtifactForPromotion,
  actionFor,
  buildPromotionItem,
  validDate,
  errorMessage,
};

export type { ObservationArtifact, CanonicalEvidenceDecision };
