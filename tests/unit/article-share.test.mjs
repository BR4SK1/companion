// Unit tests for the article domain's database-free share and retrieval
// logic: the per-turn article-memory share question (typed optional `none`
// option, own-key-safe criteria), the share answer extraction (no silent
// fallback), the context chunk rendering (inclusion language, never a share
// claim), the retrieval limit normalization, and the source-aware observation
// policy branch (distinct independent reactions as article evidence, never
// turn counts). No database, no network.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  ARTICLE_SHARE_NONE_CHOICE,
  ARTICLE_SHARE_QUESTION_ID,
  buildArticleShareContextForPrompt,
  buildArticleShareQuestion,
  selectArticleShare,
} from "../../apps/worker/src/articles/share.ts";
import {
  ArticleMemoriesValidationError,
  normalizeArticleMemoriesLimit,
} from "../../apps/worker/src/articles/retrieval.ts";
import {
  distinctReactionCount,
  evaluateObservationCandidate,
} from "../../apps/worker/src/memory/policy.ts";

const CANARY = "CanaryToken42";

function candidate(overrides = {}) {
  return {
    reactionId: "11111111-1111-4111-8111-111111111111",
    itemId: "22222222-2222-4222-8222-222222222222",
    url: "https://example.com/article",
    title: "A tea story",
    feedId: "feed-a",
    reaction: "I found the tasting notes compelling.",
    factKey: "article:11111111-1111-4111-8111-111111111111",
    publishedAt: "2026-04-02T08:00:00.000Z",
    generatedAt: "2026-11-01T10:00:00.000Z",
    ...overrides,
  };
}

function choiceAnswer(choice) {
  return {
    model: "decision-model",
    answers: {
      [ARTICLE_SHARE_QUESTION_ID]: { type: "choice", choice },
    },
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

// --- Share question ---------------------------------------------------------

describe("article share question", () => {
  it("offers none plus one option per candidate, with own-key safety", () => {
    const offered = [
      candidate(),
      candidate({ reactionId: "constructor", title: "Tricky title" }),
      candidate({ reactionId: "__proto__", title: "Trickier" }),
    ];
    const { questionId, question } = buildArticleShareQuestion(offered);
    assert.equal(questionId, ARTICLE_SHARE_QUESTION_ID);
    assert.equal(question.type, "choice");
    const keys = Object.keys(question.criteria);
    assert.ok(keys.includes(ARTICLE_SHARE_NONE_CHOICE));
    assert.ok(keys.includes("constructor"));
    assert.ok(keys.includes("__proto__"));
    // The none option is described as including nothing.
    assert.match(question.criteria[ARTICLE_SHARE_NONE_CHOICE], /no article memory/i);
    // Candidate descriptions carry the article provenance.
    assert.match(question.criteria["11111111-1111-4111-8111-111111111111"], /A tea story/);
    assert.match(question.criteria["11111111-1111-4111-8111-111111111111"], /feed-a/);
  });

  it("refuses to build a question with no candidates", () => {
    assert.throws(() => buildArticleShareQuestion([]), /no candidates/);
  });
});

// --- Share selection --------------------------------------------------------

describe("article share selection", () => {
  const offered = [candidate()];

  it("extracts none as the no-inclusion outcome", () => {
    const selection = selectArticleShare(choiceAnswer(ARTICLE_SHARE_NONE_CHOICE), offered);
    assert.deepEqual(selection, { kind: "none" });
  });

  it("extracts a chosen candidate", () => {
    const selection = selectArticleShare(choiceAnswer(offered[0].reactionId), offered);
    assert.equal(selection.kind, "selected");
    assert.equal(selection.candidate.reactionId, offered[0].reactionId);
  });

  it("rejects a missing, mistyped, or unoffered answer without fallback", () => {
    assert.throws(
      () => selectArticleShare({ model: "m", answers: {}, usage: {} }, offered),
      /no answer for the article-share question/,
    );
    assert.throws(
      () =>
        selectArticleShare(
          {
            model: "m",
            answers: { [ARTICLE_SHARE_QUESTION_ID]: { type: "noul", probability: 0.5 } },
            usage: {},
          },
          offered,
        ),
      /expected a choice answer/,
    );
    assert.throws(
      () => selectArticleShare(choiceAnswer("not-offered"), offered),
      /not an offered option/,
    );
  });
});

// --- Context chunk ----------------------------------------------------------

describe("article share context chunk", () => {
  it("describes provenance and the noted reaction, never a share claim", () => {
    const chunk = buildArticleShareContextForPrompt(candidate(), new Date("2026-11-02T10:00:00Z"));
    assert.match(chunk, /background context/);
    assert.match(chunk, /A tea story/);
    assert.match(chunk, /https:\/\/example\.com\/article/);
    assert.match(chunk, /Reaction you noted at the time:/);
    // Inclusion language only: the chunk must not assert that anything was
    // said to the owner.
    assert.doesNotMatch(chunk, /you (already )?(told|said|mentioned|shared)/i);
    assert.ok(!chunk.includes(CANARY));
  });

  it("escapes xml-sensitive characters from article metadata", () => {
    const chunk = buildArticleShareContextForPrompt(
      candidate({ title: "Tea & <steep> tips", url: "https://example.com/a?x=1&y=2" }),
      new Date("2026-11-02T10:00:00Z"),
    );
    assert.ok(chunk.includes("Tea &amp; &lt;steep&gt; tips"));
    assert.ok(chunk.includes("a?x=1&amp;y=2"));
  });

  it("bounds a very long reaction in the chunk", () => {
    const long = candidate({ reaction: "x".repeat(2000) });
    const chunk = buildArticleShareContextForPrompt(long, new Date("2026-11-02T10:00:00Z"));
    const reactionLine = chunk
      .split("\n")
      .find((line) => line.includes("Reaction you noted at the time:"));
    assert.ok(reactionLine !== undefined);
    assert.ok(reactionLine.length < 700);
  });
});

// --- Retrieval limit --------------------------------------------------------

describe("article memories limit", () => {
  it("defaults when omitted and passes integer limits through", () => {
    assert.equal(normalizeArticleMemoriesLimit(), 20);
    assert.equal(normalizeArticleMemoriesLimit(1), 1);
    assert.equal(normalizeArticleMemoriesLimit(5), 5);
    assert.equal(normalizeArticleMemoriesLimit(100), 100);
  });

  it("rejects out-of-range and non-integer limits", () => {
    for (const bad of [0, -1, 101, 1.5, Number.NaN]) {
      assert.throws(() => normalizeArticleMemoriesLimit(bad), ArticleMemoriesValidationError);
    }
  });
});

// --- Source-aware policy ----------------------------------------------------

function fact(key, overrides = {}) {
  return {
    id: `id-${key}`,
    factKey: key,
    turnId: null,
    turnKey: overrides.turnKey ?? null,
    articleReactionId: overrides.articleReactionId ?? `reaction-${key}`,
    subject: overrides.subject ?? "assistant",
    kind: "preference",
    claim: `claim ${key}`,
    condition: null,
    consequence: null,
    topics: [],
    observedAt: overrides.observedAt ?? new Date("2026-06-15T15:00:00Z"),
    explicitness: "explicit",
    evidenceBasis: "observed_behavior",
    extractionVersion: "v",
    ingestVersion: "v",
    ...overrides,
  };
}

describe("source-aware observation policy", () => {
  it("counts distinct independent reactions as article evidence breadth", () => {
    const factsById = new Map([
      ["a1", fact("a1", { articleReactionId: "r1" })],
      ["a2", fact("a2", { articleReactionId: "r2" })],
    ]);
    const decision = evaluateObservationCandidate(
      { subject: "assistant", kind: "preference", claim: "Enjoys tea writing", topics: ["tea"], sourceFactIds: ["a1", "a2"] },
      factsById,
    );
    assert.equal(decision.eligible, true);
    assert.equal(distinctReactionCount([factsById.get("a1"), factsById.get("a2")]), 2);
  });

  it("rejects a single independent source for article evidence", () => {
    const factsById = new Map([["a1", fact("a1")]]);
    const decision = evaluateObservationCandidate(
      { subject: "assistant", kind: "preference", claim: "Enjoys tea writing", topics: ["tea"], sourceFactIds: ["a1"] },
      factsById,
    );
    assert.equal(decision.eligible, false);
    assert.equal(decision.reason, "insufficient_independent_sources");
  });

  it("supports the preference kind only for article evidence", () => {
    const factsById = new Map([
      ["a1", fact("a1", { articleReactionId: "r1" })],
      ["a2", fact("a2", { articleReactionId: "r2" })],
    ]);
    const decision = evaluateObservationCandidate(
      { subject: "assistant", kind: "habit", claim: "Reads every morning", topics: ["reading"], sourceFactIds: ["a1", "a2"] },
      factsById,
    );
    assert.equal(decision.eligible, false);
    assert.equal(decision.reason, "unsupported_kind_for_source");
  });

  it("treats mixed turn/article support as a provenance violation", () => {
    const factsById = new Map([
      ["a1", fact("a1", { articleReactionId: "r1" })],
      ["t1", fact("t1", { turnKey: "turn-1", articleReactionId: null })],
    ]);
    assert.throws(
      () =>
        evaluateObservationCandidate(
          { subject: "assistant", kind: "preference", claim: "Mixed", topics: [], sourceFactIds: ["a1", "t1"] },
          factsById,
        ),
      /mixed-source/,
    );
  });

  it("keeps turn-sourced behavior unchanged", () => {
    const factsById = new Map([
      ["t1", fact("t1", { turnKey: "turn-1", articleReactionId: null })],
      ["t2", fact("t2", { turnKey: "turn-2", articleReactionId: null })],
    ]);
    const habit = evaluateObservationCandidate(
      { subject: "user", kind: "habit", claim: "Drinks tea every morning", topics: ["tea"], sourceFactIds: ["t1", "t2"] },
      factsById,
    );
    assert.equal(habit.eligible, true);

    const singleTurn = evaluateObservationCandidate(
      {
        subject: "user",
        kind: "preference",
        claim: "Likes tea",
        topics: ["tea"],
        sourceFactIds: ["t1"],
      },
      new Map([["t1", fact("t1", { turnKey: "turn-1", articleReactionId: null, evidenceBasis: "direct_statement" })]]),
    );
    assert.equal(singleTurn.eligible, true);
  });
});
