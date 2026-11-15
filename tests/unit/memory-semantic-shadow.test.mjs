import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";

import {
  createEmbeddingClient,
  EMBEDDING_CODE_REVISION,
  EMBEDDING_DIMENSIONS,
  EMBEDDING_INPUT_VERSION,
  EMBEDDING_MODEL,
  EMBEDDING_MODEL_REVISION,
  EmbeddingRequestError,
  embeddingContentHash,
  renderEmbeddingInput,
} from "../../apps/worker/src/memory/embeddings.ts";
import {
  baselineArmTraces,
  buildShadowArms,
  MAX_KEYWORD_CANDIDATES,
  MAX_SEMANTIC_ONLY_CANDIDATES,
  RANKING_STRATEGY_VERSION,
  selectKeywordCandidates,
} from "../../apps/worker/src/memory/semantic-shadow.ts";
import {
  getKeywordSimilarities,
  reconcileSemanticEmbeddingBatch,
  runSemanticShadowRecall,
} from "../../apps/worker/src/memory/semantic-store.ts";
import { createSemanticScheduler } from "../../apps/worker/src/memory/semantic-scheduler.ts";
import { processTurnWork } from "../../apps/worker/src/work/processor.ts";
import { recallCanonical, recallCanonicalDetailed } from "../../apps/worker/src/memory/recall.ts";
import { buildCanonicalMemoryContextForPrompt } from "../../apps/worker/src/memory/chat-context.ts";
import { memoryMigrations } from "../../apps/worker/src/memory/migrations.ts";

const unitVector = () => [1, ...Array(EMBEDDING_DIMENSIONS - 1).fill(0)];
const responseFor = (vectors, model = EMBEDDING_MODEL) => new Response(JSON.stringify({
  object: "list",
  model,
  data: vectors.map((embedding, index) => ({ object: "embedding", index, embedding })),
}), { status: 200, headers: { "content-type": "application/json" } });

function vectorAt(angle) {
  return [Math.cos(angle), Math.sin(angle), ...Array(EMBEDDING_DIMENSIONS - 2).fill(0)];
}

function candidate(id, type, baselineRank, extras = {}) {
  return {
    id,
    type,
    score: 1 / baselineRank,
    chars: 50,
    baselineRank,
    baselineIncluded: baselineRank <= 4,
    baselineResultRank: baselineRank <= 4 ? baselineRank : null,
    textScore: 1,
    ...extras,
  };
}

function transactionalPool(handler) {
  const calls = [];
  const query = async (sql, params = []) => {
    calls.push({ sql, params });
    if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK" || sql.includes("set_config")) {
      return { rows: [] };
    }
    return handler(sql, params);
  };
  return {
    calls,
    async query(sql, params) { return query(sql, params); },
    async connect() { return { query, release() {} }; },
  };
}

function recallCandidate(id = "fact-a") {
  return {
    item: {
      type: "fact", id, claim: "synthetic claim", condition: null, consequence: null,
      textScore: 1, observedAt: "2026-11-15T12:00:00.000Z",
    },
    score: 1,
    chars: 50,
    rank: 1,
    baselineIncluded: true,
    baselineResultRank: 1,
  };
}

describe("embedding service contract", () => {
  it("sends unprefixed query/document input and validates an ordered normalized 768-vector response", async () => {
    const requests = [];
    const client = createEmbeddingClient({
      baseUrl: "http://embedding.internal:5113/",
      fetchImpl: async (url, init) => {
        requests.push({ url, body: JSON.parse(init.body) });
        return responseFor([unitVector()]);
      },
    });

    const [queryVector] = await client.embed(["query text"], "query");
    const [documentVector] = await client.embed(["document text"], "document");
    assert.equal(queryVector.length, EMBEDDING_DIMENSIONS);
    assert.equal(documentVector.length, EMBEDDING_DIMENSIONS);
    assert.equal(requests[0].url, "http://embedding.internal:5113/v1/embeddings");
    assert.deepEqual(requests.map((request) => request.body), [
      { model: EMBEDDING_MODEL, input: ["query text"], input_type: "query" },
      { model: EMBEDDING_MODEL, input: ["document text"], input_type: "document" },
    ]);
    assert.equal(client.busy, false);
  });

  it("rejects malformed model, order, dimension, non-finite, and non-normalized vectors", async () => {
    const invalidBodies = [
      { model: "wrong", data: [{ index: 0, embedding: unitVector() }] },
      { model: EMBEDDING_MODEL, data: [{ index: 1, embedding: unitVector() }] },
      { model: EMBEDDING_MODEL, data: [{ index: 0, embedding: [1, 2] }] },
      { model: EMBEDDING_MODEL, data: [{ index: 0, embedding: [NaN, ...Array(767).fill(0)] }] },
      { model: EMBEDDING_MODEL, data: [{ index: 0, embedding: [2, ...Array(767).fill(0)] }] },
    ];
    for (const body of invalidBodies) {
      const client = createEmbeddingClient({
        baseUrl: "http://unused",
        fetchImpl: async () => new Response(JSON.stringify(body), { status: 200 }),
      });
      await assert.rejects(client.embed(["x"], "query"), (error) =>
        error instanceof EmbeddingRequestError && error.category === "embedding_invalid_response");
      assert.equal(client.busy, false);
    }
  });

  it("bounds batch/text requests and classifies timeout, HTTP 503, and transport errors", async () => {
    const client = createEmbeddingClient({
      baseUrl: "http://unused",
      fetchImpl: async () => responseFor([unitVector()]),
    });
    await assert.rejects(client.embed(Array(9).fill("x"), "document"), /embedding_invalid_response/);
    await assert.rejects(client.embed(["x".repeat(4097)], "document"), /embedding_invalid_response/);

    for (const [fetchImpl, category] of [
      [async () => { throw Object.assign(new Error("timeout"), { name: "TimeoutError" }); }, "embedding_timeout"],
      [async () => new Response("unavailable", { status: 503 }), "embedding_http_503"],
      [async () => { throw new Error("network details"); }, "embedding_transport"],
    ]) {
      const failing = createEmbeddingClient({ baseUrl: "http://unused", fetchImpl });
      await assert.rejects(failing.embed(["x"], "query"), (error) =>
        error instanceof EmbeddingRequestError && error.category === category);
    }
  });

  it("allows only one in-flight inference request", async () => {
    let finish;
    const client = createEmbeddingClient({
      baseUrl: "http://unused",
      fetchImpl: () => new Promise((resolve) => { finish = () => resolve(responseFor([unitVector()])); }),
    });
    const first = client.embed(["x"], "query");
    await assert.rejects(client.embed(["y"], "document"), /embedding_transport/);
    finish();
    await first;
    assert.equal(client.busy, false);
  });
});

describe("versioned embedding inputs and generation fence", () => {
  it("hashes the bounded claim/condition/consequence representation, not evidence metadata", () => {
    const a = renderEmbeddingInput({ claim: "likes tea", condition: "when tired", consequence: "feels calmer" });
    const b = renderEmbeddingInput({ claim: "likes tea", condition: "when tired", consequence: "feels calmer" });
    const changed = renderEmbeddingInput({ claim: "likes tea", condition: "when busy", consequence: "feels calmer" });
    assert.equal(a, "likes tea\nCondition: when tired\nConsequence: feels calmer");
    assert.equal(embeddingContentHash(a), embeddingContentHash(b));
    assert.notEqual(embeddingContentHash(a), embeddingContentHash(changed));
    assert.equal(renderEmbeddingInput({ claim: "x".repeat(5000) }).length, 4096);
    assert.equal(EMBEDDING_INPUT_VERSION, "claim-condition-consequence-v1");
    assert.equal(EMBEDDING_MODEL, "nomic-embed-text-v1.5");
    assert.equal(EMBEDDING_MODEL_REVISION, "e9b6763023c676ca8431644204f50c2b100d9aab");
    assert.equal(EMBEDDING_CODE_REVISION, "7710840340a098cfb869c4f65e87cf2b1b70caca");
  });

  it("reconciles a generation mismatch using one bounded document call and stores fenced metadata", async () => {
    const currentAt = new Date("2026-11-15T12:01:00Z");
    const text = renderEmbeddingInput({ claim: "prefers tea" });
    const contentHash = embeddingContentHash(text);
    const calls = [];
    const pool = {
      async query(sql, params) {
        calls.push({ sql, params });
        if (sql.includes("FROM (")) return { rows: [{
          source_kind: "fact", source_id: "fact-1", fact_id: "fact-uuid",
          claim: "prefers tea", condition: null, consequence: null,
          source_content_hash: contentHash, source_updated_at: currentAt,
          embedding_source_updated_at: currentAt, embedding: null,
          input_version: EMBEDDING_INPUT_VERSION, model: EMBEDDING_MODEL,
          model_revision: "old-model", model_code_revision: EMBEDDING_CODE_REVISION,
          attempt_count: 0, retry_after: null,
        }] };
        if (sql.includes("FROM memory_fact WHERE id")) return { rows: [{
          claim: "prefers tea", condition: null, consequence: null, source_updated_at: currentAt,
        }] };
        return { rows: [], rowCount: 1 };
      },
    };
    pool.connect = async () => ({ query: pool.query, release() {} });
    const client = {
      busy: false,
      async embed(texts, inputType) {
        assert.deepEqual(texts, [text]);
        assert.equal(inputType, "document");
        return [unitVector()];
      },
    };
    const result = await reconcileSemanticEmbeddingBatch({ pool, client });
    assert.deepEqual(result, { selected: 1, stored: 1, failed: 0 });
    const write = calls.find((call) => call.sql.includes("INSERT INTO memory_semantic_embedding"));
    assert.ok(write);
    assert.equal(write.params[1], contentHash);
    assert.equal(write.params[2], currentAt);
    assert.equal(write.params[4], EMBEDDING_MODEL);
    assert.equal(write.params[5], EMBEDDING_MODEL_REVISION);
    assert.equal(write.params[6], EMBEDDING_CODE_REVISION);
  });

  it("fences changed/deleted sources after selecting a stale source", async () => {
    const selectedAt = new Date("2026-11-15T12:00:00Z");
    const calls = [];
    const pool = {
      async query(sql, params) {
        calls.push({ sql, params });
        if (sql.includes("FROM (")) return { rows: [{
          source_kind: "observation", source_id: "obs-1", fact_id: null,
          claim: "old claim", condition: null, consequence: null,
          source_content_hash: null, source_updated_at: selectedAt,
          embedding_source_updated_at: null, embedding: null,
          input_version: null, model: null, model_revision: null,
          model_code_revision: null, attempt_count: 0, retry_after: null,
        }] };
        if (sql.includes("FROM memory_canonical_observation")) return { rows: [] };
        return { rows: [] };
      },
    };
    pool.connect = async () => ({ query: pool.query, release() {} });
    const client = { busy: false, async embed() { throw new Error("must not call"); } };
    assert.deepEqual(await reconcileSemanticEmbeddingBatch({ pool, client }), {
      selected: 1, stored: 0, failed: 0,
    });
    assert.equal(calls.some((call) => call.sql.includes("INSERT INTO memory_semantic_embedding")), false);
  });

  it("advances evidence-only source timestamps without another embedding call", async () => {
    const oldAt = new Date("2026-11-15T12:00:00Z");
    const currentAt = new Date("2026-11-15T12:02:00Z");
    const text = renderEmbeddingInput({ claim: "same claim" });
    const hash = embeddingContentHash(text);
    const calls = [];
    const pool = {
      async query(sql, params) {
        calls.push({ sql, params });
        if (sql.includes("FROM (")) return { rows: [{
          source_kind: "observation", source_id: "obs-1", fact_id: null,
          claim: "same claim", condition: null, consequence: null,
          source_content_hash: hash, source_updated_at: currentAt,
          embedding_source_updated_at: oldAt, embedding: "[vector]",
          input_version: EMBEDDING_INPUT_VERSION, model: EMBEDDING_MODEL,
          model_revision: EMBEDDING_MODEL_REVISION, model_code_revision: EMBEDDING_CODE_REVISION,
          attempt_count: 0, retry_after: null,
        }] };
        if (sql.includes("FROM memory_canonical_observation")) return { rows: [{
          claim: "same claim", condition: null, consequence: null, source_updated_at: currentAt,
        }] };
        return { rows: [], rowCount: 1 };
      },
    };
    pool.connect = async () => ({ query: pool.query, release() {} });
    const client = { busy: false, async embed() { throw new Error("evidence-only change must not re-embed"); } };
    assert.deepEqual(await reconcileSemanticEmbeddingBatch({ pool, client }), {
      selected: 1, stored: 0, failed: 0,
    });
    const timestampUpdate = calls.find((call) => call.sql.includes("SET source_updated_at"));
    assert.ok(timestampUpdate);
    assert.equal(timestampUpdate.params[1], currentAt);
  });
});

describe("keyword compatibility and relational evidence", () => {
  it("keeps ordinary recall and rendered context equal to the detailed keyword baseline", async () => {
    const referenceTime = new Date("2026-11-15T12:00:00Z");
    const factRows = [{
      fact_key: "fact-key-a", subject_id: "owner", subject_role: "user", kind: "preference",
      claim: "likes tea", turn_id: "turn-a", source_type: "conversation", article_reaction_id: null,
      condition: null, consequence: null, topics: ["tea"], observed_at: new Date("2026-11-14T12:00:00Z"),
      explicitness: "explicit", text_score: 0.8,
    }];
    const observationRows = [{
      canonical_observation_id: "observation-b", subject_id: "owner", subject_role: "user",
      article_sourced: false, kind: "habit", claim: "drinks tea in the morning",
      condition: null, consequence: null, topics: ["tea"], last_observed_at: new Date("2026-11-13T12:00:00Z"),
      evidence_strength: "strong", support_count: 3, distinct_day_count: 3, text_score: 0.3,
    }];
    const pool = { async query(sql) {
      return { rows: sql.includes("FROM memory_fact f") ? factRows : observationRows };
    } };
    const config = {
      canonicalCandidateLimit: 8,
      canonicalRecencyHalfLifeDays: 21,
      canonicalRecencyWeight: 0.5,
    };
    const input = { query: "tea", referenceTime, limit: 2, maxChars: 1000 };
    const detailed = await recallCanonicalDetailed(pool, config, input);
    const defaulted = await recallCanonicalDetailed(pool, config, {
      query: "tea",
      referenceTime,
    });
    const ordinary = await recallCanonical(pool, config, input);
    assert.deepEqual(ordinary.query, detailed.response.query);
    assert.deepEqual(ordinary.results, detailed.response.results);
    assert.equal(ordinary.results[0].id, "fact-key-a");
    assert.deepEqual(
      buildCanonicalMemoryContextForPrompt({ items: ordinary.results, now: referenceTime }),
      buildCanonicalMemoryContextForPrompt({ items: detailed.response.results, now: referenceTime }),
    );
    assert.equal(detailed.candidates.length, 2);
    assert.equal(defaulted.normalizedInput.limit, 8);
    assert.equal(defaulted.normalizedInput.maxChars, 12_000);
  });

  it("declares typed relational traces and vectors without installing extensions or storing text payloads", () => {
    const sql = memoryMigrations[1].sql;
    assert.match(sql, /memory_semantic_embedding[\s\S]*vector\(768\)/);
    assert.match(sql, /memory_semantic_shadow_attempt/);
    assert.match(sql, /memory_semantic_shadow_candidate/);
    assert.match(sql, /fact_key text REFERENCES memory_fact/);
    assert.match(sql, /canonical_observation_id text REFERENCES memory_canonical_observation/);
    assert.doesNotMatch(sql, /CREATE\s+EXTENSION/i);
    assert.doesNotMatch(sql, /JSONB|payload json/i);
  });
});

describe("bounded lexical-dominant comparison arms", () => {
  it("reranks keyword candidates and adds at most four semantic-only candidates", () => {
    const keywords = [
      candidate("fact:a", "fact", 1),
      candidate("fact:b", "fact", 2),
      candidate("obs:c", "observation", 3),
    ];
    const semanticOnly = Array.from({ length: 7 }, (_, index) =>
      candidate(`fact:s${index}`, "fact", Number.MAX_SAFE_INTEGER, { semanticOnly: true }));
    const semantic = new Map([
      ["fact:a", { rank: 2, similarity: 0.91 }],
      ["fact:b", { rank: 1, similarity: 0.92 }],
      ["obs:c", { rank: 3, similarity: 0.88 }],
      ...semanticOnly.slice(0, 4).map((item, index) => [item.id, { rank: index + 4, similarity: 0.8 - index / 100 }]),
    ]);
    const [rerank, hybrid] = buildShadowArms({
      keywordCandidates: keywords,
      semanticOnlyCandidates: semanticOnly,
      semantic,
      limit: 4,
      maxChars: 10_000,
    });
    assert.equal(rerank.traces.some((trace) => trace.origin === "semantic_only"), false);
    assert.equal(hybrid.traces.filter((trace) => trace.origin === "semantic_only").length, MAX_SEMANTIC_ONLY_CANDIDATES);
    assert.ok(rerank.ids.indexOf("fact:a") < rerank.ids.indexOf("fact:b"), "lexical rank wins the close fusion comparison");
    assert.ok(rerank.traces.every((trace) => trace.similarity === null || trace.similarity >= -1 && trace.similarity <= 1));
  });

  it("keeps observation-share and character/result budgets in both experimental arms", () => {
    const keywords = [
      candidate("fact:f1", "fact", 1),
      candidate("obs:o1", "observation", 2),
      candidate("obs:o2", "observation", 3),
      candidate("obs:o3", "observation", 4),
      candidate("fact:f2", "fact", 5),
    ];
    const semantic = new Map(keywords.map((row, index) => [row.id, { rank: index + 1, similarity: 0.9 - index / 100 }]));
    const [rerank, hybrid] = buildShadowArms({
      keywordCandidates: keywords,
      semanticOnlyCandidates: [],
      semantic,
      limit: 4,
      maxChars: 105,
    });
    for (const arm of [rerank, hybrid]) {
      assert.ok(arm.ids.length <= 4);
      const includedObservations = arm.traces.filter((trace) => trace.budgetIncluded && trace.type === "observation");
      assert.ok(includedObservations.length <= 2);
      assert.ok(arm.traces.filter((trace) => trace.budgetIncluded).length <= 2, "only two 50-char items fit the budget");
    }
  });

  it("admits a strong semantic-only match into C beside a full lexical candidate pool", () => {
    const keywords = Array.from({ length: MAX_KEYWORD_CANDIDATES }, (_, index) =>
      candidate(`fact:k${String(index + 1)}`, "fact", index + 1));
    const semanticOnly = [candidate("fact:strong-match", "fact", Number.MAX_SAFE_INTEGER, { semanticOnly: true })];
    const semantic = new Map([
      ...keywords.map((item, index) => [item.id, { rank: index + 2, similarity: 0.8 - index / 1000 }]),
      [semanticOnly[0].id, { rank: 1, similarity: 0.99 }],
    ]);
    const [rerank, hybrid] = buildShadowArms({
      keywordCandidates: keywords,
      semanticOnlyCandidates: semanticOnly,
      semantic,
      limit: 8,
      maxChars: 10_000,
    });
    assert.equal(RANKING_STRATEGY_VERSION, "lexical-2x-semantic-1-rrf-k2-v2");
    assert.equal(rerank.ids.includes(semanticOnly[0].id), false);
    assert.equal(hybrid.ids.includes(semanticOnly[0].id), true);
  });

  it("keeps every actual baseline-selected item even when its rank is beyond the 64-item window", () => {
    const baseline = Array.from({ length: 80 }, (_, index) => candidate(
      `fact:${String(index + 1)}`,
      "fact",
      index + 1,
      { baselineIncluded: index === 69, baselineResultRank: index === 69 ? 1 : null },
    ));
    const selected = selectKeywordCandidates(baseline, 8);
    assert.equal(selected.length, 65);
    assert.equal(selected.some((item) => item.id === "fact:70"), true);
    assert.equal(baselineArmTraces(baseline).find((trace) => trace.id === "fact:70").resultRank, 1);
  });

  it("uses a neutral lexical-rank contribution when a keyword vector is missing", () => {
    const keywords = [
      candidate("fact:a", "fact", 1),
      candidate("fact:missing", "fact", 2),
      candidate("fact:c", "fact", 3),
    ];
    const semantic = new Map([
      ["fact:a", { rank: 1, similarity: 0.9 }],
      ["fact:c", { rank: 2, similarity: 0.8 }],
    ]);
    const [rerank] = buildShadowArms({
      keywordCandidates: keywords,
      semanticOnlyCandidates: [],
      semantic,
      limit: 3,
      maxChars: 10_000,
    });
    assert.ok(rerank.ids.indexOf("fact:missing") < rerank.ids.indexOf("fact:c"));
    const missing = rerank.traces.find((trace) => trace.id === "fact:missing");
    assert.equal(missing.semanticRank, null);
    assert.equal(missing.similarity, null);
  });
});

describe("semantic read fences and attempt persistence", () => {
  it("persists versioned baseline, rerank, and hybrid evidence after a successful comparison", async () => {
    const item = recallCandidate();
    const hash = embeddingContentHash(item.item.claim);
    const pool = transactionalPool((sql) => {
      if (sql.includes("WITH requested AS")) return { rows: [{
        source_kind: "fact",
        source_id: "fact-a",
        source_content_hash: hash,
        current_claim: "synthetic claim",
        current_condition: null,
        current_consequence: null,
        similarity: 1.00000006,
      }] };
      if (sql.includes("SELECT * FROM (")) return { rows: [] };
      if (sql.includes("INSERT INTO memory_semantic_shadow_attempt")) return { rows: [{ id: "attempt-id" }] };
      if (sql.includes("INSERT INTO memory_semantic_shadow_candidate")) return { rows: [] };
      return { rows: [] };
    });
    await runSemanticShadowRecall({
      pool,
      client: { busy: false, async embed() { return [unitVector()]; } },
      config: {},
      source: "api",
      recallOperationId: "operation-id",
      query: "private query canary",
      referenceTime: new Date("2026-11-15T12:00:00Z"),
      limit: 8,
      maxChars: 12_000,
      candidates: [item],
      baselineOrigin: "keyword",
      retrievalMode: "keyword",
      emptyQueryFallback: false,
    });
    const attempt = pool.calls.find((call) => call.sql.includes("INSERT INTO memory_semantic_shadow_attempt"));
    assert.equal(attempt.params[4], "ok");
    assert.equal(attempt.params[13], RANKING_STRATEGY_VERSION);
    assert.equal(attempt.params[17], 1);
    const candidateInsert = pool.calls.find((call) => call.sql.includes("INSERT INTO memory_semantic_shadow_candidate"));
    assert.ok(candidateInsert.params.includes("baseline"));
    assert.ok(candidateInsert.params.includes("semantic_rerank"));
    assert.ok(candidateInsert.params.includes("hybrid"));
    assert.ok(candidateInsert.params.includes(1), "valid rounded cosine is clamped to the supported range");
    assert.equal(candidateInsert.params.includes("private query canary"), false);
  });

  it("excludes lexical fact and observation ids from their own typed semantic pools", async () => {
    const fact = recallCandidate("shared-id");
    const observation = {
      ...recallCandidate("shared-id"),
      item: { ...recallCandidate("shared-id").item, type: "observation" },
    };
    const pool = transactionalPool((sql) => {
      if (sql.includes("INSERT INTO memory_semantic_shadow_attempt")) return { rows: [{ id: "attempt-id" }] };
      return { rows: [] };
    });
    await runSemanticShadowRecall({
      pool,
      client: { busy: false, async embed() { return [unitVector()]; } },
      config: {},
      source: "api",
      query: "synthetic query",
      referenceTime: new Date("2026-11-15T12:00:00Z"),
      limit: 8,
      maxChars: 12_000,
      candidates: [fact, observation],
      baselineOrigin: "keyword",
      retrievalMode: "keyword",
      emptyQueryFallback: false,
    });
    const similarities = pool.calls.find((call) => call.sql.includes("WITH requested AS"));
    assert.deepEqual(similarities.params[0], ["fact", "observation"]);
    assert.deepEqual(similarities.params[1], ["shared-id", "shared-id"]);
    const semanticOnly = pool.calls.find((call) => call.sql.includes("SELECT * FROM ("));
    assert.deepEqual(semanticOnly.params[1], ["shared-id"]);
    assert.deepEqual(semanticOnly.params[2], ["shared-id"]);
    assert.match(semanticOnly.sql, /f\.fact_key <> ALL\(\$2::text\[\]\)/);
    assert.match(semanticOnly.sql, /o\.canonical_observation_id <> ALL\(\$3::text\[\]\)/);
  });

  it("rejects a candidate whose source changed after baseline recall", async () => {
    const staleSource = recallCandidate("fact-a");
    staleSource.item.claim = "synthetic claim";
    const pool = transactionalPool((sql) => {
      if (sql.includes("WITH requested AS")) {
        return { rows: [{
          source_kind: "fact",
          source_id: "fact-a",
          source_content_hash: embeddingContentHash(renderEmbeddingInput({ claim: "synthetic claim" })),
          current_claim: "mutated current claim",
          current_condition: null,
          current_consequence: null,
          similarity: 0.999,
        }] };
      }
      return { rows: [] };
    });
    const scores = await getKeywordSimilarities({
      pool,
      candidates: [staleSource],
      vector: unitVector(),
    });
    assert.equal(scores.size, 0);
    const query = pool.calls.find((call) => call.sql.includes("WITH requested AS"));
    assert.match(query.sql, /e\.source_updated_at = f\.updated_at/);
    assert.match(query.sql, /e\.source_updated_at = o\.canonical_updated_at/);
    assert.match(query.sql, /e\.model_code_revision = \$8/);
    assert.match(query.sql, /unnest\(\$1::text\[\], \$2::text\[\], \$3::text\[\]\)/);
  });

  it("persists the complete baseline and safe attempt metadata after embedding failure", async () => {
    const pool = transactionalPool((sql) => {
      if (sql.includes("INSERT INTO memory_semantic_shadow_attempt")) return { rows: [{ id: "attempt-id" }] };
      if (sql.includes("INSERT INTO memory_semantic_shadow_candidate")) return { rows: [] };
      return { rows: [] };
    });
    const startedQuery = "private query canary";
    await runSemanticShadowRecall({
      pool,
      client: { busy: false, async embed() { throw new EmbeddingRequestError("embedding_timeout"); } },
      config: {},
      source: "chat",
      turnId: "turn-id",
      turnAttempt: 3,
      recallOperationId: "recall-operation-id",
      query: startedQuery,
      referenceTime: new Date("2026-11-15T12:00:00Z"),
      limit: 8,
      maxChars: 12_000,
      candidates: [recallCandidate()],
      baselineOrigin: "keyword",
      retrievalMode: "keyword",
      emptyQueryFallback: false,
    });
    const attempt = pool.calls.find((call) => call.sql.includes("INSERT INTO memory_semantic_shadow_attempt"));
    assert.equal(attempt.params[0], "turn-id");
    assert.equal(attempt.params[1], 3);
    assert.equal(attempt.params[2], "recall-operation-id");
    assert.equal(attempt.params[4], "failed");
    assert.equal(attempt.params[5], "embedding_timeout");
    assert.equal(attempt.params[6], null);
    assert.equal(attempt.params[7], "keyword");
    assert.equal(attempt.params[11], createHash("sha256").update(startedQuery).digest("hex"));
    assert.equal(attempt.params.includes(startedQuery), false);
    const candidateInsert = pool.calls.find((call) => call.sql.includes("INSERT INTO memory_semantic_shadow_candidate"));
    assert.ok(candidateInsert);
    assert.ok(candidateInsert.params.includes("fact-a"));
    assert.match(candidateInsert.sql, /WHERE \(row_values\.source_kind = 'fact'/);
    assert.match(candidateInsert.sql, /o\.canonical_observation_id = row_values\.canonical_observation_id/);
  });

  it("logs sanitized persistence failures without replacing the baseline response path", async () => {
    const logs = [];
    const pool = transactionalPool((sql) => {
      if (sql.includes("INSERT INTO memory_semantic_shadow_attempt")) return { rows: [{ id: "attempt-id" }] };
      if (sql.includes("INSERT INTO memory_semantic_shadow_candidate")) {
        throw Object.assign(new Error("private text in database error"), { code: "23503" });
      }
      if (sql.includes("SELECT EXISTS")) return { rows: [{ present: true }] };
      return { rows: [] };
    });
    await runSemanticShadowRecall({
      pool,
      client: { busy: false, async embed() { throw new EmbeddingRequestError("embedding_transport"); } },
      config: {},
      source: "api",
      query: "synthetic query",
      referenceTime: new Date("2026-11-15T12:00:00Z"),
      limit: 8,
      maxChars: 12_000,
      candidates: [recallCandidate()],
      baselineOrigin: "keyword",
      retrievalMode: "keyword",
      emptyQueryFallback: false,
      log: (message) => logs.push(message),
    });
    assert.equal(logs.length, 1);
    assert.match(logs[0], /db_23503/);
    assert.doesNotMatch(logs[0], /private text/);
    assert.ok(pool.calls.some((call) => call.sql.includes("INSERT INTO memory_semantic_shadow_attempt")));
  });

  it("omits one concurrently deleted source without discarding surviving candidate traces", async () => {
    const pool = transactionalPool((sql, params) => {
      if (sql.includes("INSERT INTO memory_semantic_shadow_attempt")) return { rows: [{ id: "attempt-id" }] };
      if (sql.includes("INSERT INTO memory_semantic_shadow_candidate")) {
        if (params.includes("fact-deleted")) {
          throw Object.assign(new Error("concurrent delete"), { code: "23503" });
        }
        return { rows: [] };
      }
      if (sql.includes("SELECT EXISTS")) return { rows: [{ present: params[0] !== "fact-deleted" }] };
      return { rows: [] };
    });
    const logs = [];
    await runSemanticShadowRecall({
      pool,
      client: { busy: false, async embed() { throw new EmbeddingRequestError("embedding_timeout"); } },
      config: {},
      source: "api",
      query: "synthetic query",
      referenceTime: new Date("2026-11-15T12:00:00Z"),
      limit: 8,
      maxChars: 12_000,
      candidates: [recallCandidate("fact-deleted"), recallCandidate("fact-live")],
      baselineOrigin: "keyword",
      retrievalMode: "keyword",
      emptyQueryFallback: false,
      log: (message) => logs.push(message),
    });
    assert.equal(pool.calls.filter((call) => call.sql.includes("INSERT INTO memory_semantic_shadow_attempt")).length, 1);
    assert.ok(pool.calls.some((call) => call.sql.includes("INSERT INTO memory_semantic_shadow_candidate") && call.params.includes("fact-live")));
    assert.ok(logs.some((message) => message.includes("omitted candidates whose source rows were deleted")));
  });

  it("records pure timeline comparison as skipped with baseline evidence", async () => {
    const pool = transactionalPool((sql) => {
      if (sql.includes("INSERT INTO memory_semantic_shadow_attempt")) return { rows: [{ id: "attempt-id" }] };
      return { rows: [] };
    });
    let inferenceCalled = false;
    await runSemanticShadowRecall({
      pool,
      client: { busy: false, async embed() { inferenceCalled = true; return [unitVector()]; } },
      config: {},
      source: "api",
      query: "yesterday",
      referenceTime: new Date("2026-11-15T12:00:00Z"),
      limit: 8,
      maxChars: 12_000,
      candidates: [recallCandidate()],
      baselineOrigin: "recency",
      retrievalMode: "timeline",
      emptyQueryFallback: true,
      timeRange: { start: "2026-11-14T00:00:00Z", end: "2026-11-15T00:00:00Z" },
    });
    const attempt = pool.calls.find((call) => call.sql.includes("INSERT INTO memory_semantic_shadow_attempt"));
    assert.equal(inferenceCalled, false);
    assert.equal(attempt.params[4], "skipped");
    assert.equal(attempt.params[5], null);
    assert.equal(attempt.params[6], "non_comparable_baseline");
    assert.equal(attempt.params[7], "timeline");
    assert.ok(pool.calls.some((call) => call.sql.includes("INSERT INTO memory_semantic_shadow_candidate")));
  });
});

describe("semantic runtime isolation", () => {
  it("coalesces work and drains its one in-flight task on shutdown", async () => {
    const logs = [];
    let finish;
    let reconciles = 0;
    let comparisons = 0;
    const scheduler = createSemanticScheduler({
      reconcile: async () => { reconciles += 1; },
      compare: async () => {
        comparisons += 1;
        await new Promise((resolve) => { finish = resolve; });
      },
      log: (message) => logs.push(message),
      errorCategory: () => "internal_error",
    });
    scheduler.enqueueShadow({});
    await Promise.resolve();
    scheduler.enqueueReconciliation();
    scheduler.enqueueShadow({});
    assert.equal(comparisons, 1);
    assert.equal(reconciles, 0);
    assert.equal(logs.length, 1);
    let closed = false;
    const closing = scheduler.close().then(() => { closed = true; });
    await Promise.resolve();
    assert.equal(closed, false);
    finish();
    await closing;
    scheduler.enqueueReconciliation();
    assert.equal(reconciles, 0);
  });

  it("keeps processor response assembly on baseline context while shadow work hangs or fails", async () => {
    const query = "synthetic user question";
    const request = {
      source: "chat",
      turnId: "turn-id",
      turnAttempt: 1,
      query,
      referenceTime: new Date("2026-11-15T12:00:00Z"),
      limit: 8,
      maxChars: 12_000,
      candidates: [recallCandidate()],
      baselineOrigin: "keyword",
      retrievalMode: "keyword",
      emptyQueryFallback: false,
    };
    const work = {
      turn: {
        id: "turn-id", status: "in_flight", attempt: 1, leaseOwner: "lease",
        leaseExpiresAt: new Date().toISOString(), selectedPatternId: null,
        decision: null, error: null, createdAt: new Date().toISOString(), completedAt: null,
      },
      messages: [{
        id: "message-id", seq: 1, role: "user", content: query,
        createdAt: new Date().toISOString(), turnId: "turn-id",
      }],
    };
    async function executeWithShadow(compare) {
      const logs = [];
      const scheduler = createSemanticScheduler({
        reconcile: async () => {},
        compare,
        log: (message) => logs.push(message),
        errorCategory: () => "internal_error",
      });
      let chatRequest;
      const outcome = await processTurnWork(work, {
        decisionModel: "decision-model",
        chatModel: "chat-model",
        callDecisions: async () => { throw new Error("decision should not run with no patterns"); },
        callChat: async (body) => {
          chatRequest = body;
          return {
            id: "chat-id", model: "chat-model",
            choices: [{ message: { role: "assistant", content: "reply" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          };
        },
        loadPatterns: async () => [],
        loadContext: async () => [],
        loadIdentity: async () => ({ content: "IDENTITY", revision: 1 }),
        loadMemoryContext: async () => {
          scheduler.enqueueShadow(request);
          return { memoryContext: "BASELINE_CONTEXT_ONLY" };
        },
      });
      await Promise.resolve();
      assert.equal(outcome.reply, "reply");
      assert.ok(chatRequest.messages.some((message) => message.content.includes("BASELINE_CONTEXT_ONLY")));
      assert.equal(chatRequest.messages.some((message) => message.content.includes("SEMANTIC")), false);
      return { logs, scheduler, outcome, chatRequest };
    }
    let release;
    const hanging = await executeWithShadow(async () => new Promise((resolve) => { release = resolve; }));
    assert.deepEqual(hanging.logs, []);
    release();
    await hanging.scheduler.close();
    const failed = await executeWithShadow(async () => { throw new Error("private output"); });
    await failed.scheduler.close();
    assert.deepEqual(failed.logs, ["[MEMORY] semantic shadow comparison failed: internal_error"]);
  });
});
