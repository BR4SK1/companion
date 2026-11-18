// Unit tests for the engagement domain's pure logic
// (apps/worker/src/engagement): band classification at the three configured
// cutoffs, the no-immediate-engagement assessment rule (a first message
// after a lull retains the lull assessment; a subsequent immediate message
// becomes engaged), the effective-state semantics (the deeper of the
// last-activity band and the last message's own assessment — inactivity
// measured from the LAST user message, a single return message never
// resetting the state to engaged), and locally configurable cutoffs with
// monotonicity validation.
//
// Pure functions only: no database, no timers, no network. All band values
// here are local test fixtures, never deployment policy.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  classifySilence,
  assessMessage,
  stateAt,
  deeperEngagementState,
  selectSessionHistory,
  isInCurrentSession,
  latestGoneMessageId,
  hasGoneAssessment,
  firstSessionBatchLength,
  selectFirstSessionBatch,
} from "../../apps/worker/src/engagement/runtime.ts";
import { validateEngagementBands } from "../../apps/worker/src/engagement/bands.ts";
import { EngagementBandsError } from "../../apps/worker/src/engagement/bands.ts";

const MINUTE = 60_000;
// Three cutoffs delimiting four bands: engaged < lull < idle < gone.
const BANDS = {
  lullMs: 3 * MINUTE,
  idleMs: 7 * MINUTE,
  goneMs: 30 * MINUTE,
};

describe("engagement band classification", () => {
  it("classifies the half-open bands at every cutoff boundary", () => {
    assert.equal(classifySilence(0, BANDS), "engaged");
    assert.equal(classifySilence(3 * MINUTE - 1, BANDS), "engaged");
    assert.equal(classifySilence(3 * MINUTE, BANDS), "lull");
    assert.equal(classifySilence(7 * MINUTE - 1, BANDS), "lull");
    assert.equal(classifySilence(7 * MINUTE, BANDS), "idle");
    assert.equal(classifySilence(30 * MINUTE - 1, BANDS), "idle");
    assert.equal(classifySilence(30 * MINUTE, BANDS), "gone");
    assert.equal(classifySilence(10 * 24 * 60 * MINUTE, BANDS), "gone");
  });

  it("uses the configured cutoffs, not hardcoded ones", () => {
    const custom = { lullMs: 10, idleMs: 20, goneMs: 30 };
    assert.equal(classifySilence(9, custom), "engaged");
    assert.equal(classifySilence(10, custom), "lull");
    assert.equal(classifySilence(19, custom), "lull");
    assert.equal(classifySilence(20, custom), "idle");
    assert.equal(classifySilence(29, custom), "idle");
    assert.equal(classifySilence(30, custom), "gone");
  });
});

describe("engagement assessment (no immediate engagement)", () => {
  it("assesses the first user message of a thread as engaged", () => {
    const assessment = assessMessage({
      messageEffectiveAt: new Date(1_000_000),
      previousUserMessageAt: null,
      previousAssessmentState: null,
      bands: BANDS,
    });
    assert.equal(assessment.state, "engaged");
    assert.equal(assessment.previousState, null);
    assert.equal(assessment.silenceMs, null);
    assert.equal(assessment.retainedLull, false);
  });

  it("retains the lull assessment on the first message after a lull", () => {
    const previousAt = new Date(0);
    // Five minutes of silence: inside the lull band.
    const assessment = assessMessage({
      messageEffectiveAt: new Date(5 * MINUTE),
      previousUserMessageAt: previousAt,
      previousAssessmentState: "engaged",
      bands: BANDS,
    });
    // Crucially NOT engaged: the effective engagement is not overwritten by
    // the first return message.
    assert.equal(assessment.state, "lull");
    assert.equal(assessment.previousState, "engaged");
    assert.equal(assessment.silenceMs, 5 * MINUTE);
    assert.equal(assessment.retainedLull, true);
  });

  it("assesses a subsequent immediate message as engaged", () => {
    const assessment = assessMessage({
      messageEffectiveAt: new Date(5 * MINUTE + 30_000),
      previousUserMessageAt: new Date(5 * MINUTE),
      previousAssessmentState: "lull",
      bands: BANDS,
    });
    assert.equal(assessment.state, "engaged");
    assert.equal(assessment.previousState, "lull");
    assert.equal(assessment.silenceMs, 30_000);
    assert.equal(assessment.retainedLull, false);
  });

  it("keeps an active exchange engaged message over message", () => {
    const assessment = assessMessage({
      messageEffectiveAt: new Date(10_000),
      previousUserMessageAt: new Date(0),
      previousAssessmentState: "engaged",
      bands: BANDS,
    });
    assert.equal(assessment.state, "engaged");
    assert.equal(assessment.retainedLull, false);
  });

  it("records deeper bands (idle, gone) on messages arriving after long silence", () => {
    const idle = assessMessage({
      messageEffectiveAt: new Date(10 * MINUTE),
      previousUserMessageAt: new Date(0),
      previousAssessmentState: "engaged",
      bands: BANDS,
    });
    assert.equal(idle.state, "idle");
    assert.equal(idle.retainedLull, false);

    const gone = assessMessage({
      messageEffectiveAt: new Date(2 * 24 * 60 * MINUTE),
      previousUserMessageAt: new Date(0),
      previousAssessmentState: "engaged",
      bands: BANDS,
    });
    assert.equal(gone.state, "gone");
  });

  it("clamps a negative gap to zero silence", () => {
    const assessment = assessMessage({
      messageEffectiveAt: new Date(0),
      previousUserMessageAt: new Date(60_000),
      previousAssessmentState: "engaged",
      bands: BANDS,
    });
    assert.equal(assessment.state, "engaged");
    assert.equal(assessment.silenceMs, 0);
  });
});

describe("effective engagement state (last-activity clock with assessment floor)", () => {
  it("advances the state during silence from the last user message", () => {
    const lastAt = new Date(0);
    const engaged = { lastUserMessageAt: lastAt, lastAssessmentState: "engaged", bands: BANDS };
    assert.equal(stateAt({ ...engaged, observedAt: new Date(2 * MINUTE) }), "engaged");
    assert.equal(stateAt({ ...engaged, observedAt: new Date(3 * MINUTE) }), "lull");
    assert.equal(stateAt({ ...engaged, observedAt: new Date(7 * MINUTE) }), "idle");
    assert.equal(stateAt({ ...engaged, observedAt: new Date(30 * MINUTE) }), "gone");
  });

  it("keeps the first return message at its lull assessment immediately", () => {
    // m1 at minute 0 (engaged), first return at minute 5 assessed lull:
    // the effective state is lull the moment the message lands, NOT engaged.
    const state = stateAt({
      lastUserMessageAt: new Date(5 * MINUTE),
      lastAssessmentState: "lull",
      observedAt: new Date(5 * MINUTE),
      bands: BANDS,
    });
    assert.equal(state, "lull");
  });

  it("measures subsequent inactivity from the last message, retaining the floor", () => {
    // The review timeline: m1 at minute 0, first return m2 at minute 5
    // (lull assessment). At minute 7 — 2 minutes since the last activity —
    // the state remains lull rather than jumping to idle; the activity band
    // alone (2 minutes = engaged) would suggest a shallower state, and the
    // assessment floor holds it at lull.
    const state = stateAt({
      lastUserMessageAt: new Date(5 * MINUTE),
      lastAssessmentState: "lull",
      observedAt: new Date(7 * MINUTE),
      bands: BANDS,
    });
    assert.equal(state, "lull");
  });

  it("transitions onward from the floor as silence grows past the next cutoff", () => {
    // Same thread, observed at minute 12 (7 minutes since m2): the activity
    // band reaches idle and overtakes the lull floor.
    const state = stateAt({
      lastUserMessageAt: new Date(5 * MINUTE),
      lastAssessmentState: "lull",
      observedAt: new Date(12 * MINUTE),
      bands: BANDS,
    });
    assert.equal(state, "idle");
    // And at minute 35 (30 minutes since m2): gone.
    assert.equal(
      stateAt({
        lastUserMessageAt: new Date(5 * MINUTE),
        lastAssessmentState: "lull",
        observedAt: new Date(35 * MINUTE),
        bands: BANDS,
      }),
      "gone",
    );
  });

  it("never overwrites the state to engaged on a single deep return", () => {
    // A message arriving after two days assesses gone; the effective state
    // stays gone right after it lands (the activity band is engaged, the
    // assessment floor is gone) until the next message proves engagement.
    assert.equal(
      stateAt({
        lastUserMessageAt: new Date(2 * 24 * 60 * MINUTE),
        lastAssessmentState: "gone",
        observedAt: new Date(2 * 24 * 60 * MINUTE),
        bands: BANDS,
      }),
      "gone",
    );
    assert.equal(
      stateAt({
        lastUserMessageAt: new Date(2 * 24 * 60 * MINUTE),
        lastAssessmentState: "gone",
        observedAt: new Date(2 * 24 * 60 * MINUTE + 4 * MINUTE),
        bands: BANDS,
      }),
      "gone",
    );
  });

  it("lifts the state only through a message assessed inside the engaged band", () => {
    // The immediate follow-up to the deep return assesses engaged, which
    // lifts the state: max(activity=engaged, assessment=engaged).
    assert.equal(
      stateAt({
        lastUserMessageAt: new Date(2 * 24 * 60 * MINUTE + 30_000),
        lastAssessmentState: "engaged",
        observedAt: new Date(2 * 24 * 60 * MINUTE + 30_000),
        bands: BANDS,
      }),
      "engaged",
    );
  });

  it("uses the activity band alone when no assessment is recorded (pre-engagement history)", () => {
    const state = stateAt({
      lastUserMessageAt: new Date(0),
      lastAssessmentState: null,
      observedAt: new Date(8 * MINUTE),
      bands: BANDS,
    });
    assert.equal(state, "idle");
  });

  it("returns null with no last user message (no user activity yet)", () => {
    assert.equal(
      stateAt({
        lastUserMessageAt: null,
        lastAssessmentState: null,
        observedAt: new Date(0),
        bands: BANDS,
      }),
      null,
    );
  });
});

describe("deeper-state selection", () => {
  it("picks the state further along the silence timeline", () => {
    assert.equal(deeperEngagementState("engaged", "lull"), "lull");
    assert.equal(deeperEngagementState("lull", "engaged"), "lull");
    assert.equal(deeperEngagementState("idle", "engaged"), "idle");
    assert.equal(deeperEngagementState("engaged", "gone"), "gone");
    assert.equal(deeperEngagementState("gone", "idle"), "gone");
    assert.equal(deeperEngagementState("engaged", "engaged"), "engaged");
  });
});

describe("engagement band configuration", () => {
  it("accepts locally provisioned cutoffs", () => {
    validateEngagementBands({ lullMs: 60_000, idleMs: 300_000, goneMs: 900_000 });
  });

  it("rejects non-monotone cutoffs as a configuration error", () => {
    assert.throws(
      () => validateEngagementBands({ lullMs: 10, idleMs: 10, goneMs: 30 }),
      EngagementBandsError,
    );
    assert.throws(
      () => validateEngagementBands({ lullMs: 20, idleMs: 10, goneMs: 30 }),
      EngagementBandsError,
    );
    assert.throws(
      () => validateEngagementBands({ lullMs: 10, idleMs: 30, goneMs: 20 }),
      EngagementBandsError,
    );
    assert.throws(
      () => validateEngagementBands({ lullMs: 0, idleMs: 20, goneMs: 30 }),
      EngagementBandsError,
    );
    assert.throws(
      () => validateEngagementBands({ lullMs: Number.NaN, idleMs: 20, goneMs: 30 }),
      EngagementBandsError,
    );
  });
});
describe("session history scoping (recorded gone starts a new conversation)", () => {
  const history = [
    { id: "old-user-1" },
    { id: "old-assistant-1" },
    { id: "gone-user" },
    { id: "new-assistant-1" },
    { id: "followup-user" },
    { id: "new-assistant-2" },
  ];
  const states = new Map([
    ["old-user-1", "engaged"],
    ["gone-user", "gone"],
    ["followup-user", "engaged"],
  ]);

  it("slices history from the recorded gone return message, inclusive", () => {
    assert.deepEqual(
      selectSessionHistory(history, states).map((m) => m.id),
      ["gone-user", "new-assistant-1", "followup-user", "new-assistant-2"],
    );
  });

  it("does not repeatedly reset on follow-up turns in the new conversation", () => {
    // The return message's recorded gone is the only boundary: a later
    // turn whose history already starts at the return message keeps the
    // new conversation's own prior messages instead of emptying again.
    const newHistory = selectSessionHistory(history, states);
    assert.deepEqual(
      selectSessionHistory(newHistory, states).map((m) => m.id),
      newHistory.map((m) => m.id),
    );
  });

  it("empties prior history when any grouped current-turn message is gone", () => {
    assert.deepEqual(selectSessionHistory(history, states, ["gone-user"]), []);
    // Any, not last-only: a mixed grouped turn with an earlier gone and
    // an unassessed last message must not leak earlier conversation.
    assert.deepEqual(
      selectSessionHistory(history, states, ["gone-user", "unassessed"]),
      [],
    );
  });

  it("keeps history unchanged with no gone, missing, or non-gone states", () => {
    assert.deepEqual(selectSessionHistory(history, new Map()), history);
    assert.deepEqual(
      selectSessionHistory(history, new Map([["old-user-1", "idle"], ["followup-user", "lull"]])),
      history,
    );
    // Pre-existing/unprovisioned: absence is never gone.
    assert.equal(latestGoneMessageId(history.map((m) => m.id), new Map()), null);
    assert.equal(hasGoneAssessment(["unknown"], new Map()), false);
  });

  it("uses the latest gone when several returns exist", () => {
    const multi = new Map(states);
    multi.set("followup-user", "gone");
    assert.equal(
      latestGoneMessageId(history.map((m) => m.id), multi),
      "followup-user",
    );
    assert.deepEqual(
      selectSessionHistory(history, multi).map((m) => m.id),
      ["followup-user", "new-assistant-2"],
    );
  });

  it("distinguishes the boundary from the post-return effective floor", () => {
    // stateAt floors at gone after the return, but session scoping must
    // key on the recorded return message only: a message assessed
    // engaged after the return is inside the new session, not a boundary.
    const afterReturn = new Map(states);
    afterReturn.set("followup-user", "engaged");
    assert.equal(
      isInCurrentSession("followup-user", history.map((m) => m.id), afterReturn),
      true,
    );
    assert.equal(
      isInCurrentSession("old-user-1", history.map((m) => m.id), afterReturn),
      false,
    );
    assert.equal(
      isInCurrentSession("gone-user", history.map((m) => m.id), afterReturn),
      true,
    );
    // A gone in the current turn puts every prior message outside.
    assert.equal(
      isInCurrentSession("new-assistant-2", history.map((m) => m.id), afterReturn, ["gone-user"]),
      false,
    );
  });
});

describe("claim batch selection (first contiguous session)", () => {
  const pending = [
    { id: "pre-1" },
    { id: "pre-2" },
    { id: "gone-return" },
    { id: "follow-1" },
    { id: "follow-2" },
    { id: "gone-return-2" },
    { id: "follow-3" },
  ];
  const states = new Map([
    ["pre-1", "engaged"],
    ["gone-return", "gone"],
    ["follow-1", "engaged"],
    ["follow-2", "engaged"],
    ["gone-return-2", "gone"],
  ]);

  it("stops the first claim before the return, leaving the return for the next claim", () => {
    assert.equal(firstSessionBatchLength(pending.map((m) => m.id), states), 2);
    assert.deepEqual(
      selectFirstSessionBatch(pending, states).map((m) => m.id),
      ["pre-1", "pre-2"],
    );
    // Next claim on the remainder starts at the gone head and runs to
    // the following gone; the last claim takes the tail.
    const rest = pending.slice(2);
    assert.deepEqual(
      selectFirstSessionBatch(rest, states).map((m) => m.id),
      ["gone-return", "follow-1", "follow-2"],
    );
    assert.deepEqual(
      selectFirstSessionBatch(rest.slice(3), states).map((m) => m.id),
      ["gone-return-2", "follow-3"],
    );
  });

  it("claims the whole backlog with no gone, missing, or non-gone states", () => {
    assert.equal(firstSessionBatchLength(pending.map((m) => m.id), new Map()), pending.length);
    assert.equal(
      firstSessionBatchLength(
        pending.map((m) => m.id),
        new Map([["pre-1", "idle"], ["gone-return", "lull"]]),
      ),
      pending.length,
    );
    assert.equal(firstSessionBatchLength([], states), 0);
  });

  it("includes a gone at the head and ends at the next gone", () => {
    const headGone = [{ id: "gone-return" }, { id: "follow-1" }, { id: "gone-return-2" }, { id: "follow-3" }];
    assert.deepEqual(
      selectFirstSessionBatch(headGone, states).map((m) => m.id),
      ["gone-return", "follow-1"],
    );
  });
});
