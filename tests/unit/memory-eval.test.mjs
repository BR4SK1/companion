// Unit tests for the recall evaluation harness's pure logic: corpus
// validation and ranking metrics (recall@k, precision@k, MRR). Deterministic
// — no database, no network. The DB-backed evaluation run itself lives in
// the integration suites (run only after non-production deployment).

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  validateEvalCorpus,
  scoreEvalQueries,
  countTemporalViolations,
  EvalCorpusError,
  EVAL_SUBJECT_ID,
  EVAL_ID_PREFIX,
} from "../../apps/worker/src/memory/eval.ts";
import evalCorpusJson from "../../apps/worker/src/memory/eval-corpus.json" with { type: "json" };

const corpus = validateEvalCorpus(evalCorpusJson);

describe("recall evaluation corpus", () => {
  it("the bundled corpus is valid, generic, and prefixed for isolation", () => {
    assert.ok(corpus.observations.length >= 5);
    assert.ok(corpus.queries.length >= 5);
    for (const observation of corpus.observations) {
      assert.ok(observation.id.startsWith(EVAL_ID_PREFIX));
      assert.equal(
        Date.parse(observation.observedAt),
        Date.parse(new Date(observation.observedAt).toISOString()),
        "point-in-time seeds use exact ISO moments (first seen == last seen)",
      );
    }
    assert.equal(EVAL_SUBJECT_ID, "memory-eval-subject");
  });

  it("every expected id names a corpus observation", () => {
    const ids = new Set(corpus.observations.map((observation) => observation.id));
    for (const query of corpus.queries) {
      for (const expected of query.expect) {
        assert.ok(ids.has(expected), `${query.query} expects unknown id ${expected}`);
      }
    }
  });

  it("rejects malformed corpora", () => {
    assert.throws(() => validateEvalCorpus(null), EvalCorpusError);
    assert.throws(() => validateEvalCorpus({ version: 2 }), EvalCorpusError);
    assert.throws(
      () => validateEvalCorpus({ version: 1, description: "d", observations: [], queries: [{ query: "q", expect: ["x"] }] }),
      EvalCorpusError,
    );
    assert.throws(
      () =>
        validateEvalCorpus({
          version: 1,
          description: "d",
          observations: [{ id: "not-prefixed", kind: "fact", claim: "c", observedAt: "2026-01-01T00:00:00Z", evidenceStrength: "strong", supportCount: 1, distinctTurnCount: 1, distinctDayCount: 1 }],
          queries: [{ query: "q", expect: ["not-prefixed"] }],
        }),
        EvalCorpusError,
    );
    assert.throws(
      () =>
        validateEvalCorpus({
          version: 1,
          description: "d",
          observations: [
            { id: "eval-a", kind: "fact", claim: "c", observedAt: "2026-01-01T00:00:00Z", evidenceStrength: "strong", supportCount: 1, distinctTurnCount: 1, distinctDayCount: 1 },
            { id: "eval-a", kind: "fact", claim: "c", observedAt: "2026-01-01T00:00:00Z", evidenceStrength: "strong", supportCount: 1, distinctTurnCount: 1, distinctDayCount: 1 },
          ],
          queries: [{ query: "q", expect: ["eval-a"] }],
        }),
        EvalCorpusError,
    );
    assert.throws(
      () =>
        validateEvalCorpus({
          version: 1,
          description: "d",
          observations: [
            { id: "eval-a", kind: "fact", claim: "c", observedAt: "2026-01-01T00:00:00Z", evidenceStrength: "strong", supportCount: 1, distinctTurnCount: 1, distinctDayCount: 1 },
          ],
          queries: [{ query: "q", expect: ["eval-unknown"] }],
        }),
        EvalCorpusError,
    );
  });
});

describe("recall evaluation scoring", () => {
  // A tiny explicit corpus makes the averaging semantics exact: metrics are
  // means over every corpus query, with absent responses scoring zero.
  const mini = validateEvalCorpus({
    version: 1,
    description: "tiny scoring fixture",
    observations: [
      { id: "eval-a", kind: "fact", claim: "alpha claim", observedAt: "2026-01-01T00:00:00Z", evidenceStrength: "strong", supportCount: 1, distinctTurnCount: 1, distinctDayCount: 1 },
      { id: "eval-b", kind: "fact", claim: "beta claim", observedAt: "2026-01-02T00:00:00Z", evidenceStrength: "strong", supportCount: 1, distinctTurnCount: 1, distinctDayCount: 1 },
    ],
    queries: [
      { query: "one", expect: ["eval-a"] },
      { query: "two", expect: ["eval-a", "eval-b"] },
    ],
  });
  const perfect = [
    { query: "one", got: ["eval-a"] },
    { query: "two", got: ["eval-a", "eval-b"] },
  ];

  it("a perfect run scores 1.0 on every metric", () => {
    const scores = scoreEvalQueries(mini, perfect);
    assert.equal(scores.recall, 1);
    assert.equal(scores.precision, 1);
    assert.equal(scores.mrr, 1);
  });

  it("a partial hit lowers recall exactly", () => {
    const scores = scoreEvalQueries(mini, [
      perfect[0],
      { query: "two", got: ["eval-a"] }, // one of two expected rows
    ]);
    assert.equal(scores.recall, (1 + 0.5) / 2);
    assert.equal(scores.precision, (1 + 1) / 2); // the only returned row is a hit
    assert.equal(scores.mrr, (1 + 1) / 2); // and it ranks first
  });

  it("rank below first lowers reciprocal rank and precision without touching recall", () => {
    const scores = scoreEvalQueries(mini, [
      { query: "one", got: ["eval-distractor", "eval-a"] },
      perfect[1],
    ]);
    assert.equal(scores.recall, 1);
    assert.equal(scores.precision, (0.5 + 1) / 2);
    assert.equal(scores.mrr, (0.5 + 1) / 2);
  });

  it("a query with no returned rows scores zero, not NaN", () => {
    const scores = scoreEvalQueries(mini, [
      { query: "one", got: [] },
      perfect[1],
    ]);
    assert.equal(scores.recall, (0 + 1) / 2);
    assert.equal(scores.precision, (0 + 1) / 2);
    assert.equal(scores.mrr, (0 + 1) / 2);
  });

  it("an absent response scores zero for that query", () => {
    const scores = scoreEvalQueries(mini, [perfect[1]]);
    assert.equal(scores.recall, (0 + 1) / 2);
    assert.ok(Number.isFinite(scores.mrr));
  });

  it("counts only eval-prefixed rows outside the served window as violations", () => {
    const violations = countTemporalViolations([
      {
        rows: [
          { id: "eval-in-window", observedAt: "2026-03-08T15:00:00Z" },
          { id: "eval-outside", observedAt: "2026-05-01T15:00:00Z" },
          { id: "not-eval-outside", observedAt: "2026-05-01T15:00:00Z" },
        ],
        window: { start: "2026-03-01T05:00:00Z", end: "2026-03-20T04:00:00Z" },
      },
      { rows: [{ id: "eval-keyword", observedAt: "2026-05-01T15:00:00Z" }] }, // no window: not checked
    ]);
    assert.equal(violations, 1);
  });
});
