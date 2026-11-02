// Unit tests for the canonical policy review decision logic (no database):
// the same policy that gates promotion, applied in reverse over a promoted
// observation's current evidence — eligible observations stay, evidence that
 // no longer satisfies the policy becomes a policy-retract candidate with
// reason codes, incomplete provenance requires manual review, and explicitly
// reviewed single-turn observations are protected.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  resolveEvidence,
  reviewDecision,
  reviewOperationKey,
  MEMORY_REVIEW_VERSION,
} from "../../apps/worker/src/memory/review.ts";

const NY4 = { timezone: "America/New_York", dayStartHour: 4 };

function makeObservation(overrides = {}) {
  const now = new Date("2026-06-16T12:00:00Z");
  return {
    canonicalObservationId: "obs-1",
    canonicalIdentityKey: "identity-1",
    identityVersion: 1,
    observationKey: "key-1",
    subject: "user",
    kind: "preference",
    claim: "Likes morning tea",
    topics: ["tea"],
    supportCount: 2,
    distinctTurnCount: 2,
    distinctDayCount: 1,
    contradictionCount: 0,
    firstObservedAt: now,
    lastObservedAt: now,
    sourceFactIds: ["fact-1", "fact-2"],
    contradictionFactIds: [],
    evidenceStrength: "supported",
    status: "active",
    consolidationVersion: "v1",
    contentHash: "hash",
    revision: 1,
    promotionId: "promo-1",
    promotionSequence: 1,
    latestSource: {
      artifactId: "artifact-1",
      runId: "run-1",
      observationSetId: "set-1",
      factSetId: "factset-1",
      sourceArtifactCreatedAt: now,
      sourceArtifactUpdatedAt: now,
    },
    canonicalCreatedAt: now,
    canonicalUpdatedAt: now,
    ...overrides,
  };
}

function fact(key, turnId, observedAt) {
  return { factKey: key, turnId, observedAt: new Date(observedAt) };
}

// Two clearly distinct behavioral days (4am America/New_York boundary).
const DAY_ONE = "2026-06-15T14:00:00Z";
const DAY_TWO = "2026-06-17T14:00:00Z";

function evidenceFor(observation, facts) {
  const byKey = new Map(facts.map((f) => [f.factKey, f]));
  return resolveEvidence(observation, byKey);
}

describe("canonical review decisions", () => {
  it("marks non-active observations already_inactive with their retraction operation key", () => {
    const observation = makeObservation({
      status: "retracted",
      retraction: {
        kind: "manual",
        reasonCodes: ["operator_correction"],
        operationKey: "manual-op-key",
        at: new Date(),
      },
    });
    const item = reviewDecision(observation, evidenceFor(observation, []), new Set(), NY4);
    assert.equal(item.decision, "already_inactive");
    assert.equal(item.operationKey, "manual-op-key");
    assert.deepEqual(item.reasonCodes, []);
  });

  it("derives a stable review operation key from the revision", () => {
    const observation = makeObservation();
    assert.equal(
      reviewOperationKey(observation),
      `${MEMORY_REVIEW_VERSION}:obs-1:revision-1`,
    );
    // An existing retraction's operation key is reused, not re-derived.
    const retracted = makeObservation({
      retraction: {
        kind: "policy",
        reasonCodes: ["single_turn_evidence"],
        operationKey: "prior-op",
        at: new Date(),
      },
    });
    assert.equal(reviewOperationKey(retracted), "prior-op");
  });

  it("requires manual review when referenced facts no longer resolve", () => {
    const observation = makeObservation();
    const item = reviewDecision(
      observation,
      evidenceFor(observation, [fact("fact-1", "turn-1", DAY_ONE)]),
      new Set(),
      NY4,
    );
    assert.equal(item.decision, "needs_manual_review");
    assert.deepEqual(item.reasonCodes, []);
  });

  it("keeps multi-turn evidence eligible", () => {
    const observation = makeObservation();
    const item = reviewDecision(
      observation,
      evidenceFor(observation, [
        fact("fact-1", "turn-1", DAY_ONE),
        fact("fact-2", "turn-2", DAY_TWO),
      ]),
      new Set(),
      NY4,
    );
    assert.equal(item.decision, "eligible");
    assert.deepEqual(item.reasonCodes, []);
    assert.equal(item.distinctTurnCount, 2);
    assert.equal(item.distinctDayCount, 2);
  });

  it("policy-retracts single-turn evidence", () => {
    const observation = makeObservation({ sourceFactIds: ["fact-1"] });
    const item = reviewDecision(
      observation,
      evidenceFor(observation, [fact("fact-1", "turn-1", DAY_ONE)]),
      new Set(),
      NY4,
    );
    assert.equal(item.decision, "policy_retract");
    assert.deepEqual(item.reasonCodes, ["single_turn_evidence"]);
    // The item carries the reviewed snapshot for the apply-time fence: an
    // observation revised after the plan was built is skipped, never
    // retracted on stale evidence.
    assert.equal(item.reviewedRevision, observation.revision);
    assert.equal(item.reviewedContentHash, observation.contentHash);
  });

  it("policy-retracts event-specific temporal anchors", () => {
    const observation = makeObservation({ claim: "Visited the museum yesterday" });
    const item = reviewDecision(
      observation,
      evidenceFor(observation, [
        fact("fact-1", "turn-1", DAY_ONE),
        fact("fact-2", "turn-2", DAY_TWO),
      ]),
      new Set(),
      NY4,
    );
    assert.equal(item.decision, "policy_retract");
    assert.deepEqual(item.reasonCodes, ["event_specific_temporal_anchor"]);
  });

  it("policy-retracts habits without recurrence across behavioral days", () => {
    const observation = makeObservation({ kind: "habit" });
    const item = reviewDecision(
      observation,
      evidenceFor(observation, [
        fact("fact-1", "turn-1", DAY_ONE),
        fact("fact-2", "turn-2", DAY_ONE),
      ]),
      new Set(),
      NY4,
    );
    assert.equal(item.decision, "policy_retract");
    assert.deepEqual(item.reasonCodes, ["insufficient_recurrence_evidence"]);
  });

  it("protects an explicitly reviewed single-turn observation", () => {
    const observation = makeObservation({ sourceFactIds: ["fact-1"] });
    const reviewed = reviewDecision(
      observation,
      evidenceFor(observation, [fact("fact-1", "turn-1", DAY_ONE)]),
      new Set(["obs-1"]),
      NY4,
    );
    assert.equal(reviewed.decision, "eligible_by_reviewed_exception");
    assert.deepEqual(reviewed.reasonCodes, ["single_turn_evidence"]);
    // The exception covers only the single-turn reason: any additional
    // reason still retracts.
    const anchored = makeObservation({
      sourceFactIds: ["fact-1"],
      claim: "Visited the museum yesterday",
    });
    const stillRetracted = reviewDecision(
      anchored,
      evidenceFor(anchored, [fact("fact-1", "turn-1", DAY_ONE)]),
      new Set(["obs-1"]),
      NY4,
    );
    assert.equal(stillRetracted.decision, "policy_retract");
  });

  it("counts contradiction facts for provenance completeness without support", () => {
    const observation = makeObservation({ contradictionFactIds: ["contra-1"] });
    // Both support facts resolve; the missing contradiction fact still makes
    // provenance incomplete.
    const item = reviewDecision(
      observation,
      evidenceFor(observation, [
        fact("fact-1", "turn-1", DAY_ONE),
        fact("fact-2", "turn-2", DAY_TWO),
      ]),
      new Set(),
      NY4,
    );
    assert.equal(item.decision, "needs_manual_review");
  });
});
