// Unit tests for the memory observation policy: event-specific temporal
// anchors, eligibility reasons, and evidence-strength counting across
// behavioral days. Deterministic — no database, no network.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  evaluateObservationCandidate,
  evidenceStrength,
  findEventSpecificTemporalAnchors,
  OBSERVATION_POLICY_VERSION,
} from "../../apps/worker/src/memory/policy.ts";

const NY4 = { timezone: "America/New_York", dayStartHour: 4 };

/** Minimal durable-fact stub keyed by fact key. */
function fact(key, overrides = {}) {
  return {
    id: `id-${key}`,
    factKey: key,
    turnId: `turn-${key}`,
    turnKey: overrides.turnKey ?? key,
    subject: "user",
    kind: "fact",
    claim: `claim ${key}`,
    condition: null,
    consequence: null,
    topics: [],
    observedAt: overrides.observedAt ?? new Date("2026-06-15T15:00:00Z"),
    explicitness: "explicit",
    evidenceBasis: overrides.evidenceBasis ?? "direct_statement",
    extractionVersion: "v",
    ingestVersion: "v",
    ...overrides,
  };
}

function item(overrides = {}) {
  return {
    subject: "user",
    kind: "fact",
    claim: "Drinks coffee every morning",
    topics: ["coffee"],
    sourceFactIds: ["f1"],
    ...overrides,
  };
}

describe("observation policy", () => {
  it("has a stable policy version", () => {
    assert.equal(OBSERVATION_POLICY_VERSION, "memory-observation-policy-v1");
  });

  it("detects event-specific temporal anchors and names the fields", () => {
    const report = findEventSpecificTemporalAnchors({
      claim: "Has a dentist appointment tomorrow",
      condition: undefined,
      consequence: undefined,
    });
    assert.ok(report);
    assert.deepEqual(report.fields, ["claim"]);
    assert.ok(
      report.categories.includes("deictic_time") ||
        report.categories.includes("one_off_schedule_event"),
    );
  });

  it("detects anchors in condition and consequence fields", () => {
    const report = findEventSpecificTemporalAnchors({
      claim: "Prefers tea over coffee",
      condition: "when traveling on 2026-07-04",
      consequence: undefined,
    });
    assert.ok(report);
    assert.deepEqual(report.fields, ["condition"]);
    assert.ok(report.categories.includes("specific_date_or_time"));
  });

  it("does not flag durable statements without temporal anchors", () => {
    assert.equal(
      findEventSpecificTemporalAnchors({
        claim: "Prefers tea over coffee",
      }),
      undefined,
    );
  });

  it("rejects anchored candidates as omissions", () => {
    const decision = evaluateObservationCandidate(
      item({ claim: "Goes to the gym this week" }),
      new Map(),
    );
    assert.equal(decision.eligible, false);
    assert.equal(decision.reason, "event_specific_temporal_anchor");
    assert.ok(decision.temporalAnchor);
  });

  it("requires two distinct turns for habits and conditional patterns", () => {
    const factsById = new Map([
      ["f1", fact("f1", { turnKey: "t1" })],
      ["f2", fact("f2", { turnKey: "t1" })],
    ]);
    const oneTurn = evaluateObservationCandidate(
      item({ kind: "habit", sourceFactIds: ["f1", "f2"] }),
      factsById,
    );
    assert.equal(oneTurn.eligible, false);
    assert.equal(oneTurn.reason, "insufficient_distinct_turns");

    const twoTurns = evaluateObservationCandidate(
      item({ kind: "habit", sourceFactIds: ["f1", "f2"] }),
      new Map([
        ["f1", fact("f1", { turnKey: "t1" })],
        ["f2", fact("f2", { turnKey: "t2" })],
      ]),
    );
    assert.equal(twoTurns.eligible, true);
  });

  it("allows a single-turn preference only when every fact is a direct statement", () => {
    const singleTurn = item({ kind: "preference", sourceFactIds: ["f1"] });
    const direct = evaluateObservationCandidate(singleTurn, new Map([
      ["f1", fact("f1", { evidenceBasis: "direct_statement" })],
    ]));
    assert.equal(direct.eligible, true);

    const inferred = evaluateObservationCandidate(singleTurn, new Map([
      ["f1", fact("f1", { evidenceBasis: "observed_behavior" })],
    ]));
    assert.equal(inferred.eligible, false);
    assert.equal(inferred.reason, "one_turn_without_direct_statement");

    // The same rule applies to boundaries.
    const boundary = evaluateObservationCandidate(
      item({ kind: "boundary", sourceFactIds: ["f1"] }),
      new Map([["f1", fact("f1", { evidenceBasis: "inferred" })]]),
    );
    assert.equal(boundary.eligible, false);
  });

  it("ignores missing facts when counting support", () => {
    const decision = evaluateObservationCandidate(
      item({ sourceFactIds: ["missing"] }),
      new Map(),
    );
    // No support facts: no turn-count rule triggers for plain facts.
    assert.equal(decision.eligible, true);
  });
});

describe("evidence strength", () => {
  it("makes contradictory evidence tentative regardless of breadth", () => {
    const facts = [
      fact("f1", { turnKey: "t1", observedAt: new Date("2026-06-14T15:00:00Z") }),
      fact("f2", { turnKey: "t2", observedAt: new Date("2026-06-15T15:00:00Z") }),
      fact("f3", { turnKey: "t3", observedAt: new Date("2026-06-16T15:00:00Z") }),
    ];
    assert.equal(
      evidenceStrength(
        item({
          sourceFactIds: ["f1", "f2", "f3"],
          contradictionFactIds: ["c1"],
        }),
        facts,
        NY4,
      ),
      "tentative",
    );
  });

  it("needs three facts across two behavioral days for strong habits", () => {
    const across = [
      fact("f1", { turnKey: "t1", observedAt: new Date("2026-06-14T15:00:00Z") }),
      fact("f2", { turnKey: "t2", observedAt: new Date("2026-06-15T15:00:00Z") }),
      fact("f3", { turnKey: "t3", observedAt: new Date("2026-06-15T16:00:00Z") }),
    ];
    assert.equal(
      evidenceStrength(item({ kind: "habit", sourceFactIds: ["f1", "f2", "f3"] }), across, NY4),
      "strong",
    );

    // Same breadth, only two facts: supported.
    assert.equal(
      evidenceStrength(
        item({ kind: "habit", sourceFactIds: ["f1", "f2"] }),
        across.slice(0, 2),
        NY4,
      ),
      "supported",
    );

    // One fact: tentative.
    assert.equal(
      evidenceStrength(
        item({ kind: "habit", sourceFactIds: ["f1"] }),
        across.slice(0, 1),
        NY4,
      ),
      "tentative",
    );

    // Three facts, one behavioral day: supported, not strong.
    const sameDay = [
      fact("f1", { turnKey: "t1", observedAt: new Date("2026-06-15T14:00:00Z") }),
      fact("f2", { turnKey: "t2", observedAt: new Date("2026-06-15T15:00:00Z") }),
      fact("f3", { turnKey: "t3", observedAt: new Date("2026-06-15T16:00:00Z") }),
    ];
    assert.equal(
      evidenceStrength(item({ kind: "habit", sourceFactIds: ["f1", "f2", "f3"] }), sameDay, NY4),
      "supported",
    );
  });

  it("applies the same breadth rule to other kinds with a supported floor", () => {
    const across = [
      fact("f1", { turnKey: "t1", observedAt: new Date("2026-06-14T15:00:00Z") }),
      fact("f2", { turnKey: "t2", observedAt: new Date("2026-06-15T15:00:00Z") }),
      fact("f3", { turnKey: "t3", observedAt: new Date("2026-06-15T16:00:00Z") }),
    ];
    assert.equal(
      evidenceStrength(item({ kind: "preference", sourceFactIds: ["f1", "f2", "f3"] }), across, NY4),
      "strong",
    );
    // Two facts, two days: supported (the floor for non-habit kinds).
    assert.equal(
      evidenceStrength(
        item({ kind: "fact", sourceFactIds: ["f1", "f2"] }),
        across.slice(0, 2),
        NY4,
      ),
      "supported",
    );
  });

  it("counts behavioral days, not calendar days, across the 4am boundary", () => {
    // 2026-06-15T07:00Z is 3am EDT on Jun 15 -> behavioral day Jun 14.
    // 2026-06-15T09:00Z is 5am EDT on Jun 15 -> behavioral day Jun 15.
    const boundaryFacts = [
      fact("f1", { observedAt: new Date("2026-06-15T07:00:00Z") }),
      fact("f2", { observedAt: new Date("2026-06-15T09:00:00Z") }),
      fact("f3", { observedAt: new Date("2026-06-15T10:00:00Z") }),
    ];
    assert.equal(
      evidenceStrength(item({ kind: "habit", sourceFactIds: ["f1", "f2", "f3"] }), boundaryFacts, NY4),
      "strong",
    );
  });
});
