/**
 * Canonical policy review: re-derive each canonical observation's decision
 * from its current evidence and policy, and (with an explicit confirmation
 * token) policy-retract the observations the policy no longer supports.
 *
 * The decision logic is the same policy that gates promotion (temporal
 * anchors, single-turn evidence, habit/conditional-pattern recurrence
 * breadth), applied in reverse — a promoted observation whose evidence no
 * longer satisfies the policy is a `policy_retract` candidate. Applying a plan is always an
 * explicit, token-confirmed act: no scheduler runs this automatically.
 *
 * Evidence is resolved from the durable fact rows the observation's snapshot
 * names (fact keys are immutable once written, so the snapshot's references
 * stay addressable). An observation whose referenced facts no longer resolve
 * has incomplete provenance and requires manual review rather than an
 * automatic retraction.
 */

import type { PostgresPool } from "@companion/postgres";

import {
  CANONICAL_EVIDENCE_POLICY_VERSION,
  buildRetractionHistoryEvent,
  confirmationToken,
  currentStateDigest,
} from "./canonical.ts";
import { canonicalHash } from "./hashing.ts";
import { findEventSpecificTemporalAnchors } from "./policy.ts";
import {
  applyRetractionUpdate,
  getAllCanonicalObservations,
  getCanonicalObservationsByIds,
  getHistoryEvent,
} from "./promotion.ts";
import { behavioralDay, type BehaviorTime } from "./time.ts";
import type {
  CanonicalObservation,
  RetractionReason,
} from "./types.ts";
import { historyEventIdForOperation } from "./canonical.ts";

export const MEMORY_REVIEW_VERSION = "memory-observations-review-v1";

export type CanonicalReviewDecision =
  | "eligible"
  | "policy_retract"
  | "eligible_by_reviewed_exception"
  | "needs_manual_review"
  | "already_inactive";

export interface CanonicalReviewItem {
  readonly canonicalObservationId: string;
  readonly canonicalIdentityKey: string;
  readonly decision: CanonicalReviewDecision;
  readonly reasonCodes: readonly RetractionReason[];
  readonly distinctTurnCount?: number;
  readonly distinctDayCount?: number;
  readonly operationKey: string;
  /** The reviewed snapshot's revision and content hash: the apply fences
   *  against them, so a row a concurrent promotion revised after this plan
   *  was built is skipped as stale instead of retracted on stale evidence. */
  readonly reviewedRevision: number;
  readonly reviewedContentHash: string;
}

export interface CanonicalReviewSummary {
  readonly selected: number;
  readonly policyRetract: number;
  readonly eligible: number;
  readonly eligibleByReviewedException: number;
  readonly needsManualReview: number;
  readonly alreadyInactive: number;
}

export interface CanonicalReviewPlan {
  readonly reviewId: string;
  readonly canonicalObservationIds: readonly string[];
  readonly policyVersion: string;
  readonly currentStateDigest: string;
  readonly sourcePlanHash: string;
  readonly confirmationToken: string;
  readonly summary: CanonicalReviewSummary;
  readonly items: readonly CanonicalReviewItem[];
}

export interface CanonicalReviewResult {
  readonly reviewId: string;
  readonly status: "completed" | "already-completed" | "no-op";
  readonly policyRetracted: number;
  readonly historyEvents: number;
  /** Items skipped because the canonical observation changed after the plan
   *  was built (snapshot fence): never retracted on stale evidence; the next
   *  review re-plans against the current state. */
  readonly staleSkipped: number;
}

/** One resolved evidence fact, addressed by the snapshot's fact key. */
export interface ReviewFact {
  readonly factKey: string;
  readonly turnId: string;
  readonly observedAt: Date;
}

export interface ResolvedEvidence {
  readonly supportFacts: readonly ReviewFact[];
  readonly contradictionFacts: readonly ReviewFact[];
  readonly complete: boolean;
}

/**
 * Resolve an observation's evidence from the fact table. The snapshot's fact
 * keys are immutable, so a missing row means the referenced fact no longer
 * exists at all — incomplete provenance, not a weaker observation.
 */
export function resolveEvidence(
  observation: CanonicalObservation,
  factsByFactKey: ReadonlyMap<string, ReviewFact>,
): ResolvedEvidence {
  const supportFacts: ReviewFact[] = [];
  const contradictionFacts: ReviewFact[] = [];
  let complete = true;
  for (const factKey of observation.sourceFactIds) {
    const fact = factsByFactKey.get(factKey);
    if (fact === undefined) {
      complete = false;
      continue;
    }
    supportFacts.push(fact);
  }
  for (const factKey of observation.contradictionFactIds) {
    const fact = factsByFactKey.get(factKey);
    if (fact === undefined) {
      complete = false;
      continue;
    }
    contradictionFacts.push(fact);
  }
  return { supportFacts, contradictionFacts, complete };
}

/** The retraction operation key a review would use for this observation. */
export function reviewOperationKey(observation: CanonicalObservation): string {
  return (
    observation.retraction?.operationKey ??
    `${MEMORY_REVIEW_VERSION}:${observation.canonicalObservationId}:revision-${observation.revision}`
  );
}

export function reviewDecision(
  observation: CanonicalObservation,
  evidence: ResolvedEvidence,
  reviewedCanonicalIds: ReadonlySet<string>,
  behavior: BehaviorTime,
): CanonicalReviewItem {
  const operationKey = reviewOperationKey(observation);
  if (observation.status !== "active") {
    return {
      canonicalObservationId: observation.canonicalObservationId,
      canonicalIdentityKey: observation.canonicalIdentityKey,
      decision: "already_inactive",
      reasonCodes: [],
      operationKey,
      reviewedRevision: observation.revision,
      reviewedContentHash: observation.contentHash,
    };
  }
  if (!evidence.complete) {
    return {
      canonicalObservationId: observation.canonicalObservationId,
      canonicalIdentityKey: observation.canonicalIdentityKey,
      decision: "needs_manual_review",
      reasonCodes: [],
      operationKey,
      reviewedRevision: observation.revision,
      reviewedContentHash: observation.contentHash,
    };
  }
  const distinctTurnCount = new Set(evidence.supportFacts.map((fact) => fact.turnId)).size;
  const distinctDayCount = new Set(
    evidence.supportFacts.map((fact) => behavioralDay(fact.observedAt, behavior)),
  ).size;
  const temporalAnchor = findEventSpecificTemporalAnchors({
    claim: observation.claim,
    ...(observation.condition !== undefined && observation.condition !== ""
      ? { condition: observation.condition }
      : {}),
    ...(observation.consequence !== undefined && observation.consequence !== ""
      ? { consequence: observation.consequence }
      : {}),
  });
  const reasonCodes: RetractionReason[] = [];
  if (temporalAnchor !== undefined) reasonCodes.push("event_specific_temporal_anchor");
  if (distinctTurnCount < 2) reasonCodes.push("single_turn_evidence");
  if (
    (observation.kind === "habit" || observation.kind === "conditional_pattern") &&
    distinctDayCount < 2
  ) {
    reasonCodes.push("insufficient_recurrence_evidence");
  }
  if (reasonCodes.length === 0) {
    return {
      canonicalObservationId: observation.canonicalObservationId,
      canonicalIdentityKey: observation.canonicalIdentityKey,
      decision: "eligible",
      reasonCodes,
      distinctTurnCount,
      distinctDayCount,
      operationKey,
      reviewedRevision: observation.revision,
      reviewedContentHash: observation.contentHash,
    };
  }
  if (
    reviewedCanonicalIds.has(observation.canonicalObservationId) &&
    reasonCodes.length === 1 &&
    reasonCodes[0] === "single_turn_evidence"
  ) {
    return {
      canonicalObservationId: observation.canonicalObservationId,
      canonicalIdentityKey: observation.canonicalIdentityKey,
      decision: "eligible_by_reviewed_exception",
      reasonCodes,
      distinctTurnCount,
      distinctDayCount,
      operationKey,
      reviewedRevision: observation.revision,
      reviewedContentHash: observation.contentHash,
    };
  }
  return {
    canonicalObservationId: observation.canonicalObservationId,
    canonicalIdentityKey: observation.canonicalIdentityKey,
    decision: "policy_retract",
    reasonCodes,
    distinctTurnCount,
    distinctDayCount,
    operationKey,
    reviewedRevision: observation.revision,
    reviewedContentHash: observation.contentHash,
  };
}

export interface CanonicalReviewPlanInput {
  readonly canonicalObservationIds?: readonly string[];
  readonly allActive?: boolean;
  /** The behavioral-day boundary (provisioned configuration). */
  readonly behavior: BehaviorTime;
  /**
   * Reviewed single-turn exceptions: the operator may protect specific
   * single-turn observations from policy retraction by explicitly listing
   * them with a reviewer and note. This is a retraction-review exception
   * (it keeps an existing observation eligible); promotion itself has no
   * manual path in this port.
   */
  readonly allowSingleTurnReviewed?: boolean;
  readonly reviewedCanonicalIds?: readonly string[];
  readonly reviewedBy?: string;
  readonly reviewNote?: string;
}

async function loadEvidenceFacts(
  pool: PostgresPool,
  observations: readonly CanonicalObservation[],
): Promise<Map<string, ReviewFact>> {
  const factKeys = [
    ...new Set(
      observations.flatMap((observation) => [
        ...observation.sourceFactIds,
        ...observation.contradictionFactIds,
      ]),
    ),
  ];
  const factsByKey = new Map<string, ReviewFact>();
  if (factKeys.length === 0) return factsByKey;
  const result = await pool.query<{
    fact_key: string;
    turn_id: string;
    observed_at: Date;
  }>(
    `SELECT fact_key, turn_id, observed_at FROM memory_fact
     WHERE fact_key = ANY($1::text[])`,
    [factKeys],
  );
  for (const row of result.rows) {
    factsByKey.set(row.fact_key, {
      factKey: row.fact_key,
      turnId: row.turn_id,
      observedAt: row.observed_at,
    });
  }
  return factsByKey;
}

export async function buildCanonicalReviewPlan(
  pool: PostgresPool,
  input: CanonicalReviewPlanInput,
): Promise<CanonicalReviewPlan> {
  if (input.allActive !== true && (input.canonicalObservationIds ?? []).length === 0) {
    throw new Error("Canonical review requires canonical IDs or --all-active");
  }
  const requestedIds = [...new Set(input.canonicalObservationIds ?? [])].sort();
  const current = input.allActive === true
    ? await getAllCanonicalObservations(pool)
    : await getCanonicalObservationsByIds(pool, requestedIds);
  if (input.allActive !== true && current.length !== requestedIds.length) {
    throw new Error("A canonical observation ID was not found");
  }
  if (current.length === 0) throw new Error("Canonical review selected no observations");
  const reviewedCanonicalIds = [...new Set(input.reviewedCanonicalIds ?? [])].sort();
  if (reviewedCanonicalIds.length > 0 && input.allowSingleTurnReviewed !== true) {
    throw new Error("Reviewed canonical IDs require allowSingleTurnReviewed");
  }
  if (input.allowSingleTurnReviewed === true && reviewedCanonicalIds.length === 0) {
    throw new Error("allowSingleTurnReviewed requires explicit canonical IDs");
  }
  if (
    input.allowSingleTurnReviewed === true &&
    (input.reviewedBy === undefined || input.reviewNote === undefined)
  ) {
    throw new Error("Reviewed single-turn exceptions require reviewedBy and reviewNote");
  }
  const reviewedSet = new Set(reviewedCanonicalIds);
  if (
    reviewedCanonicalIds.some(
      (id) => !current.some((observation) => observation.canonicalObservationId === id),
    )
  ) {
    throw new Error("A reviewed canonical ID is outside the selected review scope");
  }
  const factsByKey = await loadEvidenceFacts(pool, current);
  const reviewId = canonicalHash("memory-observation-review-v1", {
    reviewVersion: MEMORY_REVIEW_VERSION,
    selection: input.allActive === true ? "all-active" : requestedIds,
    reviewedCanonicalIds,
  });
  const items = current.map((observation) =>
    reviewDecision(observation, resolveEvidence(observation, factsByKey), reviewedSet, input.behavior),
  );
  const sourcePlanHashValue = canonicalHash(
    "memory-observation-review-plan-v1",
    items
      .map((item) => ({
        canonicalObservationId: item.canonicalObservationId,
        decision: item.decision,
        reasonCodes: item.reasonCodes,
        distinctTurnCount: item.distinctTurnCount ?? null,
        distinctDayCount: item.distinctDayCount ?? null,
        operationKey: item.operationKey,
      }))
      .sort((left, right) => left.canonicalObservationId.localeCompare(right.canonicalObservationId)),
  );
  const stateDigestValue = currentStateDigest(current);
  const databaseResult = await pool.query<{ db: string }>(`SELECT current_database() AS db`);
  const databaseName = databaseResult.rows[0]?.db ?? "";
  const summary: CanonicalReviewSummary = {
    selected: items.length,
    policyRetract: items.filter((item) => item.decision === "policy_retract").length,
    eligible: items.filter((item) => item.decision === "eligible").length,
    eligibleByReviewedException: items.filter(
      (item) => item.decision === "eligible_by_reviewed_exception",
    ).length,
    needsManualReview: items.filter((item) => item.decision === "needs_manual_review").length,
    alreadyInactive: items.filter((item) => item.decision === "already_inactive").length,
  };
  return {
    reviewId,
    canonicalObservationIds: current
      .map((observation) => observation.canonicalObservationId)
      .sort(),
    policyVersion: CANONICAL_EVIDENCE_POLICY_VERSION,
    currentStateDigest: stateDigestValue,
    sourcePlanHash: sourcePlanHashValue,
    confirmationToken: confirmationToken({
      databaseName,
      promotionId: reviewId,
      sourcePlanHash: sourcePlanHashValue,
      currentStateDigest: stateDigestValue,
      allowReactivation: false,
      evidencePolicyVersion: CANONICAL_EVIDENCE_POLICY_VERSION,
      reviewedArtifactIds: reviewedCanonicalIds,
      reviewedBy: input.reviewedBy,
      reviewNote: input.reviewNote,
    }),
    summary,
    items,
  };
}

export interface CanonicalReviewApplyInput {
  readonly plan: CanonicalReviewPlan;
  readonly confirmationToken: string;
}

/**
 * Apply a review plan: policy-retract every `policy_retract` item. The
 * confirmation token must match the plan as built; a token mismatch is
 * accepted only when every policy action has already been applied
 * (idempotent re-apply), verified against the recorded history events.
 */
export async function reviewCanonicalObservations(
  pool: PostgresPool,
  input: CanonicalReviewApplyInput,
): Promise<CanonicalReviewResult> {
  const plan = input.plan;
  const actions = plan.items.filter((item) => item.decision === "policy_retract");
  if (input.confirmationToken !== plan.confirmationToken) {
    const alreadyInactive = plan.items.filter((item) => item.decision === "already_inactive");
    const allPolicyActionsAlreadyApplied =
      actions.length === 0 &&
      alreadyInactive.length > 0 &&
      alreadyInactive.every((item) => item.operationKey.startsWith(`${MEMORY_REVIEW_VERSION}:`));
    if (!allPolicyActionsAlreadyApplied) {
      throw new Error("Canonical review confirmation token does not match the current plan");
    }
    let historyEvents = 0;
    for (const item of alreadyInactive) {
      const event = await getHistoryEvent(pool, historyEventIdForOperation(item.operationKey));
      if (event !== null) historyEvents += 1;
    }
    return {
      reviewId: plan.reviewId,
      status: "already-completed",
      policyRetracted: 0,
      historyEvents,
      staleSkipped: 0,
    };
  }
  if (plan.summary.needsManualReview > 0) {
    throw new Error("Canonical review has incomplete provenance; manual review is required");
  }
  if (actions.length === 0) {
    return {
      reviewId: plan.reviewId,
      status: "no-op",
      policyRetracted: 0,
      historyEvents: 0,
      staleSkipped: 0,
    };
  }
  let policyRetracted = 0;
  let historyEvents = 0;
  let staleSkipped = 0;
  for (const item of actions) {
    const current = (
      await getCanonicalObservationsByIds(pool, [item.canonicalObservationId])
    )[0];
    if (current === undefined) {
      throw new Error(`Canonical observation ${item.canonicalObservationId} disappeared during review`);
    }
    if (current.status !== "active") {
      if (
        current.lastOperationKey === item.operationKey ||
        current.retraction?.operationKey === item.operationKey
      ) {
        continue;
      }
      if (current.retraction?.kind === "manual") {
        throw new Error(
          `Canonical observation ${item.canonicalObservationId} has a manual retraction`,
        );
      }
      continue;
    }
    const result = await applyRetractionUpdate(pool, current, {
      action: "policy_retracted",
      reasonCodes: item.reasonCodes,
      policyVersion: plan.policyVersion,
      operationKey: item.operationKey,
      recordedAt: new Date(),
      // Snapshot fence: only the reviewed revision/content may be retracted.
      // A concurrent promotion revision between plan and apply leaves the
      // (now different) observation active for the next review to re-plan.
      expectedRevision: item.reviewedRevision,
      expectedContentHash: item.reviewedContentHash,
    });
    if (result.stale === true) {
      staleSkipped += 1;
      continue;
    }
    historyEvents += 1;
    if (result.status === "completed") policyRetracted += 1;
  }
  return {
    reviewId: plan.reviewId,
    status: "completed",
    policyRetracted,
    historyEvents,
    staleSkipped,
  };
}

export const __internal = {
  buildRetractionHistoryEvent,
  resolveEvidence,
  reviewDecision,
};
