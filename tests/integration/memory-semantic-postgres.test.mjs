// Focused real-PostgreSQL coverage for semantic embedding persistence, exact
// source-version fences, and both unbounded and temporal candidate queries.
// The caller must provide a verified disposable database with pgvector enabled.

import { randomUUID } from "node:crypto";
import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  closePostgresPool,
  createPostgresPool,
} from "../../libraries/postgres/src/index.ts";
import { applyWorkerMigrations } from "../../apps/worker/src/migrations.ts";
import {
  EMBEDDING_DIMENSIONS,
  embeddingContentHash,
} from "../../apps/worker/src/memory/embeddings.ts";
import {
  getKeywordSimilarities,
  reconcileSemanticEmbeddingBatch,
  runSemanticShadowRecall,
} from "../../apps/worker/src/memory/semantic-store.ts";
import { retractCanonicalObservation } from "../../apps/worker/src/memory/promotion.ts";

const databaseUrl = process.env.WORKER_TEST_DATABASE_URL;
const hasDatabase = typeof databaseUrl === "string" && databaseUrl.length > 0;
const behavior = { canonicalRecencyHalfLifeDays: 21, canonicalRecencyWeight: 0.5 };
const unitVector = () => [1, ...Array(EMBEDDING_DIMENSIONS - 1).fill(0)];
const vector = unitVector();
const referenceTime = new Date("2026-11-15T12:00:00.000Z");
const fixtureTimestamp = "2026-11-15T12:00:00.123456Z";
const updatedSameMillisecond = "2026-11-15T12:00:00.123789Z";
const mutatedSameMillisecond = "2026-11-15T12:00:00.123987Z";
/** @type {import("pg").Pool} */
let pool;

describe("semantic memory PostgreSQL correctness", { skip: !hasDatabase }, () => {

  before(async () => {
    pool = createPostgresPool({ connectionString: databaseUrl, connectionTimeoutMillis: 5_000 });
    await applyWorkerMigrations(pool);
  });

  after(async () => {
    if (pool !== undefined) await closePostgresPool(pool);
  });

  beforeEach(async () => {
    await pool.query(`TRUNCATE
      memory_semantic_shadow_candidate,
      memory_semantic_shadow_attempt,
      memory_semantic_embedding,
      memory_observation_history,
      memory_canonical_observation,
      memory_fact,
      conversation_turn
      RESTART IDENTITY CASCADE`);
    await pool.query(`
      INSERT INTO memory_subject (id, role, profile_enabled, source_label, profile_evidence_rule, position)
      VALUES ('user', 'user', false, 'OWNER', 'Synthetic integration fixture.', 0),
             ('assistant', 'assistant', false, 'COMPANION', 'Synthetic integration fixture.', 1)
      ON CONFLICT (id) DO NOTHING`);
  });

  it("reconciles exact microsecond identities and runs empty/nonempty no-window and temporal arms", async () => {
    const fact = await seedFact("semantic-base", "synthetic baseline tea", fixtureTimestamp);
    const secondFact = await seedFact("semantic-only", "synthetic semantic match", fixtureTimestamp);
    const observationId = "semantic-observation";
    await seedObservation(observationId, fact.factKey, "synthetic observation", fixtureTimestamp);
    const embedding = fakeEmbeddingClient();
    const candidate = recallCandidate(fact.factKey, "synthetic baseline tea");

    // No vectors yet: a real SQL query over an empty semantic pool still persists
    // a successful comparison and both experimental arms.
    await runSemanticShadowRecall(shadowInput(candidate, { pool, client: embedding }));
    let latest = await latestAttempt(pool);
    assert.equal(latest.outcome, "ok");
    assert.equal(latest.semantic_only_candidate_count, 0);
    assert.deepEqual(await armsFor(pool, latest.id), ["baseline", "hybrid", "semantic_rerank"]);

    const reconciled = await reconcileSemanticEmbeddingBatch({ pool, client: embedding });
    assert.deepEqual(reconciled, { selected: 3, stored: 3, failed: 0 });
    assert.equal(embedding.documentCalls, 1);
    const exact = await pool.query(
      `SELECT f.updated_at = e.source_updated_at AS exact,
              to_char(f.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS source_text,
              to_char(e.source_updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS embedding_text
       FROM memory_fact f JOIN memory_semantic_embedding e ON e.fact_id = f.id
       WHERE f.fact_key = $1`,
      [fact.factKey],
    );
    assert.equal(exact.rows[0].exact, true);
    assert.equal(exact.rows[0].source_text, fixtureTimestamp);
    assert.equal(exact.rows[0].embedding_text, fixtureTimestamp);
    const exactObservation = await pool.query(
      `SELECT o.canonical_updated_at = e.source_updated_at AS exact
       FROM memory_canonical_observation o
       JOIN memory_semantic_embedding e USING (canonical_observation_id)
       WHERE o.canonical_observation_id = $1`,
      [observationId],
    );
    assert.equal(exactObservation.rows[0].exact, true);

    // Evidence-only timestamp movement within the same millisecond is retained
    // exactly without re-embedding the unchanged text.
    await pool.query("UPDATE memory_fact SET updated_at = $2::timestamptz WHERE fact_key = $1", [
      fact.factKey,
      updatedSameMillisecond,
    ]);
    const evidenceOnly = await reconcileSemanticEmbeddingBatch({ pool, client: embedding });
    assert.deepEqual(evidenceOnly, { selected: 1, stored: 0, failed: 0 });
    assert.equal(embedding.documentCalls, 1);
    const evidenceIdentity = await pool.query(
      `SELECT f.updated_at = e.source_updated_at AS exact,
              to_char(e.source_updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS embedding_text
       FROM memory_fact f JOIN memory_semantic_embedding e ON e.fact_id = f.id
       WHERE f.fact_key = $1`,
      [fact.factKey],
    );
    assert.equal(evidenceIdentity.rows[0].exact, true);
    assert.equal(evidenceIdentity.rows[0].embedding_text, updatedSameMillisecond);

    // A changed source at a different microsecond within the same millisecond
    // cannot use its old vector. After reconciliation the new generation is
    // stored against the exact current timestamp and content hash.
    const staleCandidate = recallCandidate(fact.factKey, "synthetic baseline tea");
    await pool.query(
      "UPDATE memory_fact SET claim = $2, updated_at = $3::timestamptz WHERE fact_key = $1",
      [fact.factKey, "synthetic changed tea", mutatedSameMillisecond],
    );
    const staleScores = await getKeywordSimilarities({ pool, candidates: [staleCandidate], vector });
    assert.equal(staleScores.size, 0);
    const changed = await reconcileSemanticEmbeddingBatch({ pool, client: embedding });
    assert.deepEqual(changed, { selected: 1, stored: 1, failed: 0 });
    assert.equal(embedding.documentCalls, 2);
    const changedIdentity = await pool.query(
      `SELECT f.updated_at = e.source_updated_at AS exact,
              e.source_content_hash = $2 AS current_hash,
              to_char(f.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS source_text
       FROM memory_fact f JOIN memory_semantic_embedding e ON e.fact_id = f.id
       WHERE f.fact_key = $1`,
      [fact.factKey, embeddingContentHash("synthetic changed tea")],
    );
    assert.equal(changedIdentity.rows[0].exact, true);
    assert.equal(changedIdentity.rows[0].current_hash, true);
    assert.equal(changedIdentity.rows[0].source_text, mutatedSameMillisecond);

    // Exercise both SQL parameter shapes against a nonempty pool. The first
    // path has no temporal bounds; the second binds both bounds explicitly.
    const currentCandidate = recallCandidate(fact.factKey, "synthetic changed tea");
    await runSemanticShadowRecall(shadowInput(currentCandidate, { pool, client: embedding }));
    latest = await latestAttempt(pool);
    assert.equal(latest.outcome, "ok");
    assert.ok(latest.semantic_only_candidate_count > 0);
    assert.deepEqual(await armsFor(pool, latest.id), ["baseline", "hybrid", "semantic_rerank"]);

    await runSemanticShadowRecall(shadowInput(currentCandidate, {
      pool,
      client: embedding,
      retrievalMode: "hybrid",
      baselineOrigin: "temporal_keyword",
      timeRange: { start: "2026-11-14T00:00:00.000Z", end: "2026-11-16T00:00:00.000Z" },
    }));
    latest = await latestAttempt(pool);
    assert.equal(latest.outcome, "ok");
    assert.equal(latest.retrieval_mode, "hybrid");
    assert.ok(latest.semantic_only_candidate_count > 0);
    assert.deepEqual(await armsFor(pool, latest.id), ["baseline", "hybrid", "semantic_rerank"]);

    // Retraction goes through the real operation and atomically removes the
    // observation vector. The subsequent hybrid arm cannot draw it into C.
    const retracted = await retractCanonicalObservation(pool, {
      canonicalObservationId: observationId,
      reasonCodes: ["operator_correction"],
      operationKey: "semantic-fixture-retraction",
    });
    assert.equal(retracted.status, "completed");
    const deletedVector = await pool.query(
      "SELECT count(*)::int AS count FROM memory_semantic_embedding WHERE canonical_observation_id = $1",
      [observationId],
    );
    assert.equal(deletedVector.rows[0].count, 0);
    await runSemanticShadowRecall(shadowInput(currentCandidate, {
      pool,
      client: embedding,
      retrievalMode: "hybrid",
      baselineOrigin: "temporal_keyword",
      timeRange: { start: "2026-11-14T00:00:00.000Z", end: "2026-11-16T00:00:00.000Z" },
    }));
    latest = await latestAttempt(pool);
    const retractedCandidate = await pool.query(
      `SELECT count(*)::int AS count FROM memory_semantic_shadow_candidate
       WHERE attempt_id = $1 AND arm IN ('semantic_rerank', 'hybrid')
         AND source_kind = 'observation' AND source_id = $2`,
      [latest.id, observationId],
    );
    assert.equal(retractedCandidate.rows[0].count, 0);
    assert.equal(secondFact.factKey, "semantic-only");
  });

  it("honors retry backoff after a document embedding failure", async () => {
    await seedFact("retry-source", "synthetic retry claim", fixtureTimestamp);
    const client = fakeEmbeddingClient({ failDocuments: true });
    const failed = await reconcileSemanticEmbeddingBatch({ pool, client });
    assert.deepEqual(failed, { selected: 1, stored: 0, failed: 1 });
    assert.equal(client.documentCalls, 1);

    const backedOff = await reconcileSemanticEmbeddingBatch({ pool, client });
    assert.deepEqual(backedOff, { selected: 0, stored: 0, failed: 0 });
    assert.equal(client.documentCalls, 1);
    const persisted = await pool.query(
      `SELECT attempt_count, retry_after > now() AS retry_is_future, embedding IS NULL AS no_vector
       FROM memory_semantic_embedding WHERE fact_id = (SELECT id FROM memory_fact WHERE fact_key = $1)`,
      ["retry-source"],
    );
    assert.equal(persisted.rows[0].attempt_count, 1);
    assert.equal(persisted.rows[0].retry_is_future, true);
    assert.equal(persisted.rows[0].no_vector, true);
  });
});

function fakeEmbeddingClient({ failDocuments = false } = {}) {
  const client = {
    busy: false,
    documentCalls: 0,
    async embed(texts, inputType) {
      assert.ok(texts.length >= 1 && texts.length <= 8);
      if (inputType === "document") {
        client.documentCalls += 1;
        if (failDocuments) throw new Error("synthetic embedding failure");
      }
      return texts.map(() => vector);
    },
  };
  return client;
}

function shadowInput(candidate, overrides) {
  return {
    client: fakeEmbeddingClient(),
    config: behavior,
    source: "api",
    query: "synthetic semantic query",
    referenceTime,
    limit: 8,
    maxChars: 12_000,
    candidates: [candidate],
    baselineOrigin: "keyword",
    retrievalMode: "keyword",
    emptyQueryFallback: false,
    ...overrides,
  };
}

function recallCandidate(id, claim) {
  const item = {
    type: "fact",
    id,
    subject: "user",
    subjectRole: "user",
    kind: "preference",
    claim,
    sourceType: "conversation",
    topics: ["synthetic"],
    observedAt: fixtureTimestamp,
    explicitness: "explicit",
    textScore: 1,
    recencyBoost: 0,
    evidenceBoost: 0,
    score: 1,
  };
  return {
    item,
    score: 1,
    chars: claim.length + 40,
    rank: 1,
    baselineIncluded: true,
    baselineResultRank: 1,
  };
}

async function seedFact(factKey, claim, updatedAt) {
  const turnId = randomUUID();
  await pool.query(
    `INSERT INTO conversation_turn (id, status, created_at, completed_at)
     VALUES ($1, 'completed', $2::timestamptz, $2::timestamptz)`,
    [turnId, updatedAt],
  );
  const result = await pool.query(
    `INSERT INTO memory_fact
       (fact_key, turn_id, subject_id, kind, claim, topics, observed_at, explicitness,
        evidence_basis, extraction_version, ingest_version, updated_at)
     VALUES ($1, $2, 'user', 'preference', $3, ARRAY['synthetic'], $4::timestamptz,
             'explicit', 'direct_statement', 'integration-test', 'integration-test', $4::timestamptz)
     RETURNING id`,
    [factKey, turnId, claim, updatedAt],
  );
  return { factKey, factId: result.rows[0].id, turnId };
}

async function seedObservation(id, factKey, claim, updatedAt) {
  const stamp = "$4::timestamptz";
  await pool.query(
    `INSERT INTO memory_canonical_observation (
       canonical_observation_id, canonical_identity_key, identity_version,
       observation_key, subject_id, kind, claim, support_count,
       distinct_turn_count, distinct_day_count, contradiction_count,
       first_observed_at, last_observed_at, source_fact_keys,
       evidence_strength, status, consolidation_version, content_hash,
       revision, promotion_id, promotion_sequence, latest_artifact_id,
       latest_run_id, latest_observation_set_id, latest_fact_set_id,
       latest_artifact_created_at, latest_artifact_updated_at,
       canonical_created_at, canonical_updated_at
     ) VALUES (
       $1, $2, 1, $3, 'user', 'preference', $5, 1, 1, 1, 0,
       ${stamp}, ${stamp}, ARRAY[$6::text], 'supported', 'active',
       'integration-test', 'integration-test', 1, 'integration-promotion', 1,
       'integration-artifact', 'integration-run', 'integration-observation-set',
       'integration-fact-set', ${stamp}, ${stamp}, ${stamp}, ${stamp}
     )`,
    [id, `user|preference|${id}`, `observation-${id}`, updatedAt, claim, factKey],
  );
}

async function latestAttempt(currentPool) {
  const result = await currentPool.query(
    `SELECT id, outcome, retrieval_mode, semantic_only_candidate_count
     FROM memory_semantic_shadow_attempt ORDER BY started_at DESC, id DESC LIMIT 1`,
  );
  return result.rows[0];
}

async function armsFor(currentPool, attemptId) {
  const result = await currentPool.query(
    `SELECT DISTINCT arm FROM memory_semantic_shadow_candidate
     WHERE attempt_id = $1 ORDER BY arm`,
    [attemptId],
  );
  return result.rows.map((row) => row.arm);
}
