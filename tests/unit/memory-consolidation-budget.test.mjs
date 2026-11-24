// Unit tests for consolidation budget fitting and response-truncation error
// classification (no database, no network): ensures dense turn histories trim
// oldest turns cleanly to fit fact-count and character limits instead of
// wedging scheduled consolidation, while still failing visibly with typed
// categories when even a single turn exceeds the budget or an LLM response
// truncates.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  fitTurnsToConsolidationBudget,
  matchExistingCanonicalObservationKey,
  MAX_OBSERVATION_SOURCE_CHARS,
} from "../../apps/worker/src/memory/consolidation.ts";
import {
  assertCompleteResponse,
  isRetryableFactExtractionError,
  isSplittableFactExtractionError,
} from "../../apps/worker/src/memory/extraction.ts";
import {
  memoryErrorCategory,
  MemoryLlmTruncatedError,
  MemorySourceBudgetError,
} from "../../apps/worker/src/memory/errors.ts";
import {
  buildObservationConsolidationPrompt,
  renderFactInput,
} from "../../apps/worker/src/memory/prompts.ts";

function makeTurn(index) {
  const start = new Date(Date.UTC(2026, 10, 1, 12, index, 0));
  const end = new Date(start.getTime() + 5_000);
  const id = `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
  return {
    turnId: id,
    turnKey: id,
    startAt: start,
    endAt: end,
    userText: `user turn ${index}`,
    assistantText: `assistant turn ${index}`,
    sourceMessageIds: [`msg-u-${index}`, `msg-a-${index}`],
  };
}

function makeFact(turn, factIndex, claim = `Fact ${factIndex} from ${turn.turnKey}`) {
  return {
    id: `fact-id-${turn.turnKey}-${factIndex}`,
    factKey: `fk-${turn.turnKey.slice(-4)}-${factIndex}`,
    turnId: turn.turnId,
    turnKey: turn.turnKey,
    articleReactionId: null,
    subject: "user",
    kind: "preference",
    claim,
    topics: ["general"],
    condition: null,
    consequence: null,
    observedAt: turn.endAt,
    explicitness: "explicit",
    evidenceBasis: "direct",
    extractionVersion: "memory-facts-prompt-v7",
    ingestVersion: "v1",
  };
}

function renderedLengthOf(facts) {
  return renderFactInput(
    facts.map((fact) => ({
      id: fact.factKey,
      subject: fact.subject,
      kind: fact.kind,
      claim: fact.claim,
      topics: fact.topics,
      condition: fact.condition ?? undefined,
      consequence: fact.consequence ?? undefined,
      observedAt: fact.observedAt,
      turnId: fact.turnKey,
    })),
  ).length;
}

describe("fitTurnsToConsolidationBudget", () => {
  it("returns all turns and facts unchanged when within budget", () => {
    const turns = [makeTurn(1), makeTurn(2), makeTurn(3)];
    const facts = [makeFact(turns[0], 1), makeFact(turns[1], 1), makeFact(turns[2], 1)];

    const fitted = fitTurnsToConsolidationBudget(turns, facts, {
      maxFacts: 160,
      maxSourceChars: MAX_OBSERVATION_SOURCE_CHARS,
    });

    assert.deepEqual(fitted.turns, turns);
    assert.deepEqual(fitted.facts, facts);
    assert.equal(fitted.trimmedTurns, 0);
    assert.equal(fitted.trimmedFacts, 0);
    assert.equal(fitted.sourceChars, renderedLengthOf(facts));
  });

  it("returns all turns with zero facts when no turn-sourced facts exist", () => {
    const turns = [makeTurn(1), makeTurn(2)];
    const articleOnlyFact = { ...makeFact(turns[0], 1), turnId: null, turnKey: null };

    const fitted = fitTurnsToConsolidationBudget(turns, [articleOnlyFact], {
      maxFacts: 10,
      maxSourceChars: 10_000,
    });

    assert.deepEqual(fitted.turns, turns);
    assert.deepEqual(fitted.facts, []);
    assert.equal(fitted.sourceChars, 0);
    assert.equal(fitted.trimmedTurns, 0);
    assert.equal(fitted.trimmedFacts, 0);
  });

  it("drops oldest turns to stay within maxFacts while preserving oldest-first order", () => {
    // 4 turns with 50, 50, 50, 20 facts = 170 total (> 160 limit).
    const turns = [makeTurn(1), makeTurn(2), makeTurn(3), makeTurn(4)];
    const counts = [50, 50, 50, 20];
    const facts = turns.flatMap((turn, idx) =>
      Array.from({ length: counts[idx] }, (_, f) => makeFact(turn, f)),
    );

    const fitted = fitTurnsToConsolidationBudget(turns, facts, {
      maxFacts: 160,
      maxSourceChars: MAX_OBSERVATION_SOURCE_CHARS,
    });

    assert.deepEqual(
      fitted.turns.map((t) => t.turnKey),
      [turns[1].turnKey, turns[2].turnKey, turns[3].turnKey],
    );
    assert.equal(fitted.facts.length, 120);
    assert.equal(fitted.trimmedTurns, 1);
    assert.equal(fitted.trimmedFacts, 50);
    assert.equal(fitted.sourceChars, renderedLengthOf(fitted.facts));
  });

  it("drops oldest turns to stay within maxSourceChars with exact rendered length", () => {
    const turns = [makeTurn(1), makeTurn(2), makeTurn(3)];
    const f1 = makeFact(turns[0], 1, "Oldest " + "a".repeat(200));
    const f2 = makeFact(turns[1], 1, "Middle " + "b".repeat(200));
    const f3 = makeFact(turns[2], 1, "Newest " + "c".repeat(200));

    const twoNewestLen = renderedLengthOf([f2, f3]);
    const fitted = fitTurnsToConsolidationBudget(turns, [f1, f2, f3], {
      maxFacts: 100,
      maxSourceChars: twoNewestLen,
    });

    assert.deepEqual(
      fitted.turns.map((t) => t.turnKey),
      [turns[1].turnKey, turns[2].turnKey],
    );
    assert.deepEqual(fitted.facts, [f2, f3]);
    assert.equal(fitted.trimmedTurns, 1);
    assert.equal(fitted.trimmedFacts, 1);
    assert.equal(fitted.sourceChars, twoNewestLen);

    // One char tighter drops turn 2 as well, keeping only turn 3.
    const tighter = fitTurnsToConsolidationBudget(turns, [f1, f2, f3], {
      maxFacts: 100,
      maxSourceChars: twoNewestLen - 1,
    });
    assert.deepEqual(
      tighter.turns.map((t) => t.turnKey),
      [turns[2].turnKey],
    );
    assert.deepEqual(tighter.facts, [f3]);
    assert.equal(tighter.sourceChars, renderedLengthOf([f3]));
  });

  it("keeps trailing zero-fact turns alongside fitted newest turns", () => {
    const turns = [makeTurn(1), makeTurn(2), makeTurn(3)];
    const facts = [
      makeFact(turns[0], 1),
      makeFact(turns[0], 2),
      makeFact(turns[1], 1),
      makeFact(turns[1], 2),
    ];

    const fitted = fitTurnsToConsolidationBudget(turns, facts, {
      maxFacts: 2,
      maxSourceChars: MAX_OBSERVATION_SOURCE_CHARS,
    });

    assert.deepEqual(
      fitted.turns.map((t) => t.turnKey),
      [turns[1].turnKey, turns[2].turnKey],
    );
    assert.equal(fitted.facts.length, 2);
    assert.equal(fitted.trimmedTurns, 1);
    assert.equal(fitted.trimmedFacts, 2);
  });

  it("throws MemorySourceBudgetError when even the newest turn with facts exceeds budget", () => {
    const turns = [makeTurn(1), makeTurn(2), makeTurn(3)];
    const facts = [
      makeFact(turns[0], 1),
      makeFact(turns[1], 1),
      makeFact(turns[1], 2),
      makeFact(turns[1], 3),
      // turns[2] intentionally has 0 facts; turns[1] is the newest turn with facts
    ];

    assert.throws(
      () =>
        fitTurnsToConsolidationBudget(turns, facts, {
          maxFacts: 2,
          maxSourceChars: MAX_OBSERVATION_SOURCE_CHARS,
        }),
      (error) =>
        error instanceof MemorySourceBudgetError &&
        memoryErrorCategory(error) === "source_budget_exceeded",
    );

    assert.throws(
      () =>
        fitTurnsToConsolidationBudget([turns[0]], [makeFact(turns[0], 1)], {
          maxFacts: 10,
          maxSourceChars: 10,
        }),
      (error) =>
        error instanceof MemorySourceBudgetError &&
        memoryErrorCategory(error) === "source_budget_exceeded",
    );
  });
});

describe("assertCompleteResponse truncation classification", () => {
  it("throws MemoryLlmTruncatedError and preserves retry/split predicates", () => {
    assert.doesNotThrow(() => assertCompleteResponse("stop", "Memory task"));
    assert.doesNotThrow(() => assertCompleteResponse(null, "Memory task"));

    let caught = null;
    try {
      assertCompleteResponse("length", "Memory observation consolidation");
    } catch (error) {
      caught = error;
    }

    assert.ok(caught instanceof MemoryLlmTruncatedError);
    assert.equal(memoryErrorCategory(caught), "llm_output_truncated");
    assert.equal(isRetryableFactExtractionError(caught), true);
    assert.equal(isSplittableFactExtractionError(caught), true);
  });
});

describe("canonical observation identity reconciliation during consolidation", () => {
  const existing = [
    {
      observationKey: "obs-key-college",
      subject: "user",
      kind: "fact",
      claim: "User read Lord of the Rings during his one year of college and had a bad time after a breakup.",
      sourceFactIds: ["fk-1", "fk-2", "fk-3"],
      lastObservedAt: new Date("2026-11-23T20:00:00.000Z"),
    },
    {
      observationKey: "obs-key-couch",
      subject: "user",
      kind: "preference",
      claim: "User lives alone and likes the end of the couch lined up with the TV for watching movies.",
      sourceFactIds: ["fk-10", "fk-11"],
      lastObservedAt: new Date("2026-11-23T19:00:00.000Z"),
    },
  ];

  it("reuses an existing canonical observation key on near-duplicate rewording or >=50% fact overlap", () => {
    assert.equal(
      matchExistingCanonicalObservationKey(
        {
          subject: "user",
          kind: "fact",
          claim: "User went to college for one year, read Lord of the Rings, and had a bad time after a breakup.",
          sourceFactIds: ["fk-99"],
        },
        existing,
      ),
      "obs-key-college",
    );
    assert.equal(
      matchExistingCanonicalObservationKey(
        {
          subject: "user",
          kind: "preference",
          claim: "Completely rewritten summary about his favorite living room spot.",
          sourceFactIds: ["fk-10", "fk-12"],
        },
        existing,
      ),
      "obs-key-couch",
    );
  });

  it("never matches across subject or kind boundaries or unrelated observations", () => {
    assert.equal(
      matchExistingCanonicalObservationKey(
        {
          subject: "assistant",
          kind: "fact",
          claim: "User read Lord of the Rings during his one year of college and had a bad time after a breakup.",
          sourceFactIds: ["fk-1", "fk-2"],
        },
        existing,
      ),
      null,
    );
    assert.equal(
      matchExistingCanonicalObservationKey(
        {
          subject: "user",
          kind: "preference",
          claim: "User builds modular synthesizers in his spare time.",
          sourceFactIds: ["fk-50", "fk-51"],
        },
        existing,
      ),
      null,
    );
  });

  it("includes existing active observations in the consolidation prompt when supplied", () => {
    const prompt = buildObservationConsolidationPrompt(
      "SYSTEM",
      "FACT BLOCK",
      "- [user/fact] Existing claim",
    );
    assert.match(prompt.messages[0].content, /EXISTING ACTIVE OBSERVATIONS/);
    assert.match(prompt.messages[0].content, /Existing claim/);
    assert.match(prompt.messages[0].content, /single topic in 1–2 concise sentences/);
  });
});
