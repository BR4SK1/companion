// Database-backed integration tests for the memory domain (apps/worker/src/
// memory): migrations, fail-closed configuration loading (including the
// provisioned behavioral-day boundary), the runtime's ingest gating, the
// new-turn-only ingest cursor (historical turns are never backfilled),
// watermark ingest with the per-turn extraction cache, consolidation with
// evidence child tables, automatic-only promotion with canonical state and
// history, canonical policy review with reviewed single-turn protection,
// manual retraction idempotency, canonical recall ranking, temporal summary
// generation and prompt-context validity, the separately gated and
// subject-aware v1 profile summaries, observation-profile fingerprint
// gating, and the chat request memory-context integration.
//
// These tests need a real PostgreSQL. They run ONLY against the
// non-production database provided via WORKER_TEST_DATABASE_URL and are
// skipped otherwise. All LLM calls are fake functions — no network, and no
// live model calls are made from tests. All test data is synthetic and
// generic.

import { describe, it, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";

import {
  closePostgresPool,
  createPostgresPool,
  runMigrations,
} from "../../libraries/postgres/src/index.ts";
import { conversationMigrations } from "../../apps/worker/src/conversation/migrations.ts";
import { createConversationStore } from "../../apps/worker/src/conversation/store.ts";
import { memoryMigrations } from "../../apps/worker/src/memory/migrations.ts";
import { loadMemoryConfig } from "../../apps/worker/src/memory/config.ts";
import { loadMemoryConfiguration } from "../../apps/worker/src/memory/subjects.ts";
import { ingestTurns } from "../../apps/worker/src/memory/ingest.ts";
import { runScheduledConsolidation } from "../../apps/worker/src/memory/consolidation.ts";
import {
  buildPromotionPlan,
  promoteRun,
  retractCanonicalObservation,
  verifyPromotion,
} from "../../apps/worker/src/memory/promotion.ts";
import {
  buildCanonicalReviewPlan,
  reviewCanonicalObservations,
} from "../../apps/worker/src/memory/review.ts";
import { recallCanonical } from "../../apps/worker/src/memory/recall.ts";
import { promptContentHash } from "../../apps/worker/src/memory/prompts.ts";
import { runReport } from "../../apps/worker/src/memory-cli.ts";
import {
  recordMemoryOperation,
  startMemoryRuntime,
} from "../../apps/worker/src/memory/runtime.ts";
import { generateTemporalSummary } from "../../apps/worker/src/memory/temporal/generator.ts";
import { getTemporalPeriod } from "../../apps/worker/src/memory/temporal/periods.ts";
import { getTemporalSummaryPromptContext } from "../../apps/worker/src/memory/temporal/store.ts";
import { generateProfileIfNeeded, getProfileDocument } from "../../apps/worker/src/memory/profiles-v2.ts";
import {
  renderProfileSection,
} from "../../apps/worker/src/memory/chat-context.ts";
import { buildChatRequest } from "../../apps/worker/src/work/chat.ts";
import { processTurnWork } from "../../apps/worker/src/work/processor.ts";
import { createApiServer } from "../../apps/worker/src/api/server.ts";
import { loadMemoryBehavior } from "../../apps/worker/src/memory/subjects.ts";
import {
  buildEvalSeeds,
  cleanupEvalCorpus,
  runRecallEval,
  seedEvalCorpus,
  validateEvalCorpus,
  EVAL_SUBJECT_ID,
} from "../../apps/worker/src/memory/eval.ts";
import { readFileSync } from "node:fs";

const DATABASE_URL = process.env.WORKER_TEST_DATABASE_URL;
const hasDatabase =
  typeof DATABASE_URL === "string" && DATABASE_URL.length > 0;

const MEMORY_TABLES = [
  "memory_subject", "memory_prompt", "memory_behavior", "memory_fact",
  "memory_fact_source_message", "memory_turn_extraction",
  "memory_turn_extraction_item", "memory_run", "memory_run_turn",
  "memory_observation", "memory_observation_evidence",
  "memory_observation_omission", "memory_observation_omission_evidence",
  "memory_canonical_observation", "memory_observation_history",
  "memory_promotion", "memory_promotion_item", "memory_temporal_summary",
  "memory_temporal_summary_message", "memory_profile_summary",
  "memory_observation_profile", "memory_observation_profile_claim",
  "memory_ingest_state", "memory_operation",
];

const SUBJECTS_SQL = `
  INSERT INTO memory_subject (id, role, profile_enabled, source_label, profile_evidence_rule, position)
  VALUES
    ('user', 'user', true, 'OWNER',
     'Attribute statements to the owner only when the owner explicitly said them; assistant suggestions are not owner evidence.', 0),
    ('assistant', 'assistant', true, 'COMPANION',
     'Literal assistant-authored statements are assistant evidence; roleplay and hypotheticals are not stable facts.', 1)
  ON CONFLICT (id) DO NOTHING`;

const BEHAVIOR_SQL = `
  INSERT INTO memory_behavior (id, timezone, day_start_hour)
  VALUES ('behavior', 'America/New_York', 4)
  ON CONFLICT (id) DO NOTHING`;

/** The provisioned boundary under test. */
const BEHAVIOR = { timezone: "America/New_York", dayStartHour: 4 };

const PROMPTS_SQL = `
  INSERT INTO memory_prompt (kind, version, system_prompt)
  VALUES
    ('fact_extraction', 'memory-facts-prompt-v7', 'Extract durable facts from the supplied turns. Test system prompt.'),
    ('observation_consolidation', 'memory-observations-prompt-v9', 'Consolidate observations from the supplied facts. Test system prompt.'),
    ('temporal_summary', 'temporal-v6', 'Write a diary-style memory summary. Test system prompt.'),
    ('profile_summary', 'profile-v1', 'Write a subject profile from day summaries. Test system prompt.'),
    ('observation_profile', 'v2-1', 'Write a subject profile from observations. Test system prompt.')
  ON CONFLICT (kind, version) DO NOTHING`;

const PROMPT_VERSIONS = {
  fact_extraction: "memory-facts-prompt-v7",
  observation_consolidation: "memory-observations-prompt-v9",
  temporal_summary: "temporal-v6",
  profile_summary: "profile-v1",
  observation_profile: "v2-1",
};

/** Extract every source-turn id the extractor was asked about. */
function extractTurnIds(userMessage) {
  return [...userMessage.matchAll(/SOURCE TURN ID: (\S+)/g)].map((match) => match[1]);
}

/** Extract every fact id the consolidator was asked about. */
function extractFactIds(userMessage) {
  return [...userMessage.matchAll(/^FACT ID: (\S+)$/gm)].map((match) => match[1]);
}

/**
 * A fake memory LLM caller. Routes on the request's user-message markers and
 * produces contract-valid JSON for each task; call counts are recorded per
 * task so fingerprint gating can be asserted.
 */
function makeFakeLlm() {
  const calls = { extraction: 0, consolidation: 0, temporal: 0, profileV1: 0, profileV2: 0 };
  const systemPrompts = [];
  const fn = async (input) => {
    systemPrompts.push(input.systemPrompt);
    const message = input.userMessage;
    const respond = (text) => ({
      text,
      model: "fake-memory-model",
      finishReason: "stop",
      inputTokens: 10,
      outputTokens: 10,
      attemptCount: 1,
      structuredOutputFallback: false,
    });
    if (/^EXTRACTED FACTS$/m.test(message)) {
      calls.consolidation += 1;
      const factIds = extractFactIds(message);
      const first = factIds.slice(0, 2);
      if (first.length === 0) {
        return respond(JSON.stringify({ observations: [] }));
      }
      return respond(JSON.stringify({
        observations: [{
          subject: "user",
          kind: "preference",
          claim: "Likes morning tea",
          topics: ["tea"],
          condition: "",
          consequence: "",
          sourceFactIds: first,
          contradictionFactIds: [],
        }],
      }));
    }
    if (message.includes("SOURCE TURN ID:")) {
      calls.extraction += 1;
      const turnIds = extractTurnIds(message);
      return respond(JSON.stringify({
        sources: turnIds.map((turnId) => ({
          sourceTurnId: turnId,
          facts: [{
            subject: "user",
            kind: "preference",
            claim: "Likes morning tea",
            topics: ["tea"],
            condition: "",
            consequence: "",
            explicitness: "explicit",
            evidenceBasis: "direct_statement",
          }],
        })),
      }));
    }
    if (message.includes("REVIEWED OBSERVATIONS")) {
      calls.profileV2 += 1;
      return respond(JSON.stringify({
        content: "The owner likes morning tea and keeps a steady schedule.",
        claims: [],
      }));
    }
    if (message.includes("SOURCE id=summary:day:")) {
      calls.profileV1 += 1;
      return respond(JSON.stringify({
        profile: "Settled, steady mornings.",
        claims: [],
      }));
    }
    if (message.includes("CONVERSATION EXCERPT") || message.includes("PRIOR MEMORY")) {
      calls.temporal += 1;
      return respond(JSON.stringify({
        eventsAndFeelings: "Quiet morning, I felt calm.",
        learnedFacts: "",
        discoveredPreferences: "",
      }));
    }
    throw new Error(`fake LLM has no route for message: ${message.slice(0, 120)}`);
  };
  fn.calls = calls;
  fn.systemPrompts = systemPrompts;
  return fn;
}

function memoryConfig(overrides = {}) {
  return loadMemoryConfig({
    WORKER_MEMORY_INGEST_ENABLED: "true",
    WORKER_MEMORY_AUTOPROMOTE_ENABLED: "true",
    WORKER_MEMORY_PROFILES_ENABLED: "true",
    WORKER_MEMORY_INGEST_SETTLE_MS: "0",
    WORKER_MEMORY_CONSOLIDATION_INTERVAL_MS: "1",
    ...overrides,
  });
}

describe("memory domain work (PostgreSQL)", { skip: !hasDatabase }, () => {
  /** @type {import("pg").Pool} */
  let pool;
  let store;

  before(async () => {
    pool = createPostgresPool({ connectionString: DATABASE_URL });
    store = createConversationStore(pool);
    await runMigrations(pool, [...conversationMigrations, ...memoryMigrations]);
  });

  after(async () => {
    if (pool !== undefined) {
      await closePostgresPool(pool);
    }
  });

  beforeEach(async () => {
    await pool.query(
      `TRUNCATE ${MEMORY_TABLES.join(", ")} RESTART IDENTITY CASCADE`,
    );
    await pool.query(`TRUNCATE conversation_message, conversation_turn RESTART IDENTITY CASCADE`);
    await pool.query(SUBJECTS_SQL);
    await pool.query(PROMPTS_SQL);
    await pool.query(BEHAVIOR_SQL);
  });


  it("applies the memory migration idempotently with the domain tables present", async () => {
    const second = await runMigrations(pool, memoryMigrations);
    assert.deepEqual(second.applied, []);
    assert.deepEqual(second.alreadyApplied, ["0003_memory_work"]);
    const tables = await pool.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name LIKE 'memory_%'
       ORDER BY table_name`,
    );
    const names = tables.rows.map((row) => row.table_name);
    for (const table of MEMORY_TABLES) {
      assert.ok(names.includes(table), `missing table ${table}`);
    }
  });

  it("loads configuration fail-closed", async () => {
    await pool.query(`DELETE FROM memory_prompt`);
    await assert.rejects(
      () => loadMemoryConfiguration(pool, PROMPT_VERSIONS),
      /no row for kind 'fact_extraction'/,
    );
    await pool.query(`DELETE FROM memory_subject`);
    await assert.rejects(
      () => loadMemoryConfiguration(pool, PROMPT_VERSIONS),
      /memory_subject has no rows/,
    );
    await pool.query(SUBJECTS_SQL);
    await pool.query(PROMPTS_SQL);
    // The behavioral-day boundary is personal configuration too: a missing
    // row fails closed.
    await pool.query(`DELETE FROM memory_behavior`);
    await assert.rejects(
      () => loadMemoryConfiguration(pool, PROMPT_VERSIONS),
      /memory_behavior has no row/,
    );
    await pool.query(BEHAVIOR_SQL);
    await pool.query(`UPDATE memory_behavior SET timezone = 'Not/AZone'`);
    await assert.rejects(
      () => loadMemoryConfiguration(pool, PROMPT_VERSIONS),
      /not a usable IANA timezone/,
    );
    await pool.query(`UPDATE memory_behavior SET timezone = 'America/New_York'`);
    const configuration = await loadMemoryConfiguration(pool, PROMPT_VERSIONS);
    assert.equal(configuration.userSubject.id, "user");
    assert.deepEqual(configuration.behavior, BEHAVIOR);
    assert.equal(configuration.assistantSubject.sourceLabel, "COMPANION");
    assert.equal(configuration.subjects.length, 2);
  });

  it("ingests completed turns into durable facts with a per-turn cache", async () => {
    await enableIngest(pool);
    const turnOne = await seedTurn(store, "I love morning tea with honey");
    await seedTurn(store, "Remind me that I prefer walking to the market");

    const callLlm = makeFakeLlm();
    const config = memoryConfig();
    const summary = await ingestTurns(
      {
        pool,
        config,
        subjects: ["user", "assistant"],
        systemPrompt: "Extract durable facts. Test system prompt.",
        userLabel: "OWNER",
        assistantLabel: "COMPANION",
        callLlm,
      },
      "reconciliation",
    );

    assert.equal(summary.selectedTurns, 2);
    assert.equal(summary.extractedTurns, 2);
    assert.equal(summary.factsInserted, 2);
    assert.equal(summary.cacheHits, 0);
    assert.equal(callLlm.calls.extraction, 1);
    assert.ok(summary.watermark !== null);

    const facts = await pool.query(
      `SELECT f.fact_key, f.subject_id, f.kind, f.claim, f.observed_at,
              m.message_id
       FROM memory_fact f
       JOIN memory_fact_source_message m ON m.fact_id = f.id AND m.position = 0
       ORDER BY f.fact_key`,
    );
    assert.equal(facts.rows.length, 2);
    assert.equal(facts.rows[0].subject_id, "user");
    assert.equal(facts.rows[0].kind, "preference");
    assert.ok(facts.rows[0].message_id !== null);

    // The extraction cache persisted one row per turn.
    const cache = await pool.query(`SELECT turn_id, item_count, empty FROM memory_turn_extraction`);
    assert.equal(cache.rows.length, 2);
    assert.ok(cache.rows.every((row) => row.item_count === 1));

    // A rerun is a pure cache hit: no LLM calls, no new facts, watermark held.
    const rerun = await ingestTurns(
      {
        pool,
        config,
        subjects: ["user", "assistant"],
        systemPrompt: "Extract durable facts. Test system prompt.",
        userLabel: "OWNER",
        assistantLabel: "COMPANION",
        callLlm,
      },
      "reconciliation",
    );
    assert.equal(rerun.selectedTurns, 0);
    assert.equal(rerun.factsInserted, 0);
    assert.equal(callLlm.calls.extraction, 1);
  });

  it("consolidates, promotes under guardrails, and verifies canonical state", async () => {
    await enableIngest(pool);
    await seedTurn(store, "I love morning tea with honey");
    await seedTurn(store, "I take my tea with honey every morning");
    await ingestTurns(await ingestDeps(pool, makeFakeLlm()), "reconciliation");

    const callLlm = makeFakeLlm();
    const config = memoryConfig();
    const run = await runScheduledConsolidation({
      pool,
      config,
      subjects: ["user", "assistant"],
      systemPrompt: "Consolidate observations. Test system prompt.",
      factExtractionPromptContentHash: promptContentHash("Extract durable facts. Test system prompt."),
      callLlm,
      behavior: BEHAVIOR,
    });
    assert.equal(run.observations, 1);
    assert.equal(run.omissions, 0);

    const artifacts = await pool.query(
      `SELECT o.observation_key, o.support_count, o.distinct_turn_count,
              o.evidence_strength, e.role, f.fact_key
       FROM memory_observation o
       JOIN memory_observation_evidence e ON e.observation_id = o.id
       JOIN memory_fact f ON f.id = e.fact_id
       WHERE o.run_id = $1`,
      [run.runId],
    );
    assert.equal(artifacts.rows.length, 2);
    assert.ok(artifacts.rows.every((row) => row.role === "support"));
    assert.equal(artifacts.rows[0].distinct_turn_count, 2);
    // Two support facts across two turns on one behavioral day: supported
    // (strong requires three facts across two or more behavioral days).
    assert.equal(artifacts.rows[0].evidence_strength, "supported");

    const plan = await buildPromotionPlan(pool, { runId: run.runId, skipTentative: true, behavior: BEHAVIOR });
    assert.equal(plan.itemCount, 1);
    assert.equal(plan.summary.creates, 1);
    assert.ok(plan.confirmationToken.length > 0);

    const result = await promoteRun(pool, {
      runId: run.runId,
      confirmationToken: plan.confirmationToken,
      skipTentative: true,
      behavior: BEHAVIOR,
    });
    assert.equal(result.status, "completed");
    assert.equal(result.created, 1);

    const canonical = await pool.query(
      `SELECT canonical_observation_id, canonical_identity_key, status, revision,
              promotion_id, promotion_sequence, source_fact_keys
       FROM memory_canonical_observation`,
    );
    assert.equal(canonical.rows.length, 1);
    assert.equal(canonical.rows[0].status, "active");
    assert.equal(canonical.rows[0].revision, 1);

    const history = await pool.query(
      `SELECT history_event_id, action, revision FROM memory_observation_history`,
    );
    assert.equal(history.rows.length, 1);
    assert.equal(history.rows[0].action, "created");

    const verification = await verifyPromotion(pool, result.promotionId);
    assert.equal(verification.valid, true);
    assert.equal(verification.missingHistoryEvents, 0);
    assert.equal(verification.currentDocumentsBehindSequence, 0);

    // Re-promoting the same run is an idempotent no-op.
    const again = await promoteRun(pool, {
      runId: run.runId,
      confirmationToken: plan.confirmationToken,
      skipTentative: true,
      behavior: BEHAVIOR,
    });
    assert.equal(again.status, "already-completed");
  });

  it("retracts manually with a revision guard and idempotent operation key", async () => {
    const { canonicalObservationId } = await seedCanonical(pool);
    const operationKey = "manual-test-op-1";

    const first = await retractCanonicalObservation(pool, {
      canonicalObservationId,
      reasonCodes: ["operator_correction"],
      operationKey,
    });
    assert.equal(first.status, "completed");

    const current = await pool.query(
      `SELECT status, retraction_kind, retraction_reason_codes, retracted_at
       FROM memory_canonical_observation WHERE canonical_observation_id = $1`,
      [canonicalObservationId],
    );
    assert.equal(current.rows[0].status, "retracted");
    assert.equal(current.rows[0].retraction_kind, "manual");
    assert.deepEqual(current.rows[0].retraction_reason_codes, ["operator_correction"]);

    const history = await pool.query(
      `SELECT action, operation_key FROM memory_observation_history ORDER BY recorded_at`,
    );
    assert.equal(history.rows.length, 2);
    assert.equal(history.rows[1].action, "manual_retracted");
    assert.equal(history.rows[1].operation_key, operationKey);

    // Same operation key: an idempotent no-op with no new history.
    const repeat = await retractCanonicalObservation(pool, {
      canonicalObservationId,
      reasonCodes: ["operator_correction"],
      operationKey,
    });
    assert.equal(repeat.status, "no-op");
    const historyAfter = await pool.query(
      `SELECT count(*)::int AS n FROM memory_observation_history`,
    );
    assert.equal(historyAfter.rows[0].n, 2);
  });

  it("policy-retracts through the canonical review with a confirmation token", async () => {
    // Promotion is automatic-only in this port (no manual or reviewed
    // promotion path exists), so the single-turn canonical row under review
    // is seeded directly against one real ingested fact — the state a
    // legacy row occupies.
    const canonicalId = await seedSingleTurnCanonical(pool);

    const plan = await buildCanonicalReviewPlan(pool, {
      canonicalObservationIds: [canonicalId],
      behavior: BEHAVIOR,
    });
    assert.equal(plan.summary.selected, 1);
    assert.equal(plan.summary.policyRetract, 1);
    const item = plan.items[0];
    assert.equal(item.decision, "policy_retract");
    assert.deepEqual([...item.reasonCodes], ["single_turn_evidence"]);
    assert.ok(item.operationKey.startsWith("memory-observations-review-v1:"));

    // A wrong token is rejected while the action is still pending.
    await assert.rejects(
      () =>
        reviewCanonicalObservations(pool, {
          plan,
          confirmationToken: "not-the-token",
        }),
      /confirmation token does not match/,
    );

    const result = await reviewCanonicalObservations(pool, {
      plan,
      confirmationToken: plan.confirmationToken,
    });
    assert.equal(result.status, "completed");
    assert.equal(result.policyRetracted, 1);
    assert.equal(result.historyEvents, 1);

    const retracted = await pool.query(
      `SELECT status, revision, retraction_kind, retraction_reason_codes,
              retraction_policy_version, retraction_operation_key
       FROM memory_canonical_observation WHERE canonical_observation_id = $1`,
      [canonicalId],
    );
    assert.equal(retracted.rows[0].status, "retracted");
    assert.equal(retracted.rows[0].revision, 2);
    assert.equal(retracted.rows[0].retraction_kind, "policy");
    assert.deepEqual(retracted.rows[0].retraction_reason_codes, ["single_turn_evidence"]);
    assert.equal(retracted.rows[0].retraction_policy_version, "canonical-evidence-v2");
    assert.equal(retracted.rows[0].retraction_operation_key, item.operationKey);

    const history = await pool.query(
      `SELECT action, retraction_kind, retraction_reason_codes, revision
       FROM memory_observation_history
       WHERE canonical_observation_id = $1
       ORDER BY recorded_at`,
      [canonicalId],
    );
    assert.equal(history.rows.length, 1);
    assert.equal(history.rows[0].action, "policy_retracted");
    assert.equal(history.rows[0].retraction_kind, "policy");
    assert.deepEqual(history.rows[0].retraction_reason_codes, ["single_turn_evidence"]);
    assert.equal(history.rows[0].revision, 2);

    // Re-applying the same applied plan is a per-item no-op.
    const repeat = await reviewCanonicalObservations(pool, {
      plan,
      confirmationToken: plan.confirmationToken,
    });
    assert.equal(repeat.status, "completed");
    assert.equal(repeat.policyRetracted, 0);

    // A fresh plan now sees the observation as already inactive; applying it
    // with the stale token is recognized as already-completed (verified
    // against the recorded history events).
    const freshPlan = await buildCanonicalReviewPlan(pool, {
      canonicalObservationIds: [canonicalId],
      behavior: BEHAVIOR,
    });
    assert.equal(freshPlan.items[0].decision, "already_inactive");
    const alreadyDone = await reviewCanonicalObservations(pool, {
      plan: freshPlan,
      confirmationToken: plan.confirmationToken,
    });
    assert.equal(alreadyDone.status, "already-completed");
    assert.equal(alreadyDone.historyEvents, 1);
  });

  it("protects an explicitly reviewed single-turn observation from policy retraction", async () => {
    // The reviewed exception is a retraction-review input only: it keeps a
    // named single-turn observation eligible instead of policy-retracting
    // it. It creates nothing — promotion itself has no manual path.
    const canonicalId = await seedSingleTurnCanonical(pool);
    const plan = await buildCanonicalReviewPlan(pool, {
      canonicalObservationIds: [canonicalId],
      behavior: BEHAVIOR,
      allowSingleTurnReviewed: true,
      reviewedCanonicalIds: [canonicalId],
      reviewedBy: "test-operator",
      reviewNote: "Reviewed single-turn exception for the review test",
    });
    assert.equal(plan.items[0].decision, "eligible_by_reviewed_exception");
    assert.equal(plan.summary.policyRetract, 0);
    assert.equal(plan.summary.eligibleByReviewedException, 1);
    const result = await reviewCanonicalObservations(pool, {
      plan,
      confirmationToken: plan.confirmationToken,
    });
    assert.equal(result.status, "no-op");
    assert.equal(result.policyRetracted, 0);
    const row = await pool.query(
      `SELECT status, revision FROM memory_canonical_observation
       WHERE canonical_observation_id = $1`,
      [canonicalId],
    );
    assert.equal(row.rows[0].status, "active");
    assert.equal(row.rows[0].revision, 1);
  });

  it("recalls facts and canonical observations with budget and share caps", async () => {
    const { factKeys, canonicalObservationId } = await seedCanonical(pool);
    const referenceTime = new Date("2026-06-16T12:00:00Z");

    const response = await recallCanonical(pool, memoryConfig(), {
      query: "morning tea",
      referenceTime,
      limit: 8,
      maxChars: 12_000,
    });
    assert.equal(response.query.emptyQueryFallback, false);
    const ids = response.results.map((item) => item.id);
    assert.ok(factKeys.some((key) => ids.includes(key)));
    assert.ok(ids.includes(canonicalObservationId));
    const factItem = response.results.find((item) => item.type === "fact");
    assert.ok(factItem !== undefined);
    assert.equal(factItem.subject, "user");
    assert.ok(factItem.score > 0);
    // Every candidate carries the same claim text and the same recency
    // (all observed after the reference time, which clamps to the freshest
    // age), so ranking is decided by the evidence boost alone: the
    // supported observation lifts above the explicit facts regardless of
    // the randomly generated row ids.
    const ranks = response.results.map((item) => item.id);
    const factRanks = factKeys
      .map((key) => ranks.indexOf(key))
      .filter((rank) => rank >= 0);
    assert.ok(factRanks.length >= 1);
    assert.ok(
      ranks.indexOf(canonicalObservationId) < Math.max(...factRanks),
      "supported observation should outrank explicit facts on identical text",
    );

    // The observation share cap: with limit 2, at most one observation.
    const capped = await recallCanonical(pool, memoryConfig(), {
      query: "morning tea",
      referenceTime,
      limit: 2,
      maxChars: 12_000,
    });
    const observationCount = capped.results.filter((item) => item.type === "observation").length;
    assert.ok(observationCount <= Math.ceil(2 * 0.5));

    // Character budget: a tiny budget truncates and reports the diagnostics.
    const tight = await recallCanonical(pool, memoryConfig(), {
      query: "morning tea",
      referenceTime,
      limit: 8,
      maxChars: 500,
    });
    assert.ok(tight.results.length <= 8);
    assert.equal(tight.diagnostics.maxChars, 500);

    // Empty query: recency fallback over both sources.
    const fallback = await recallCanonical(pool, memoryConfig(), {
      query: "'\"$",
      referenceTime,
      limit: 8,
      maxChars: 12_000,
    });
    assert.equal(fallback.query.emptyQueryFallback, true);
    assert.ok(fallback.results.length >= 2);
  });

  it("generates temporal summaries and validates the prompt context", async () => {
    const period = getTemporalPeriod("morning", new Date("2026-06-15T18:00:00Z"), BEHAVIOR);
    // Seed one completed turn inside the morning period.
    await seedTurnAt(pool, store, "Morning tea was lovely today", period.startAt);

    const callLlm = makeFakeLlm();
    const deps = {
      pool,
      config: memoryConfig(),
      behavior: BEHAVIOR,
      systemPrompt: "Write a diary-style memory summary. Test system prompt.",
      userLabel: "OWNER",
      assistantLabel: "COMPANION",
      callLlm,
    };
    const summary = await generateTemporalSummary(
      deps,
      period,
      new Date("2026-06-15T19:00:00Z"),
    );
    assert.ok(summary !== null);
    assert.equal(summary.messageCount, 2);
    assert.equal(callLlm.calls.temporal, 1);
    assert.ok(summary.content.startsWith("This morning, "));

    const stored = await pool.query(
      `SELECT s.kind, s.period_key, s.status, m.message_id
       FROM memory_temporal_summary s
       JOIN memory_temporal_summary_message m ON m.summary_id = s.id AND m.position = 0
       WHERE s.kind = $1 AND s.period_key = $2`,
      [period.kind, period.periodKey],
    );
    assert.equal(stored.rows.length, 1);
    assert.ok(stored.rows[0].message_id !== null);

    // Regeneration with unchanged source is a fingerprint no-op.
    const second = await generateTemporalSummary(
      deps,
      period,
      new Date("2026-06-15T19:00:00Z"),
    );
    assert.equal(callLlm.calls.temporal, 1);
    assert.equal(second.fingerprint, summary.fingerprint);

    // The prompt context serves the closed morning under its tag.
    const context = await getTemporalSummaryPromptContext(
      pool,
      [{ id: "user", profileEnabled: true }, { id: "assistant", profileEnabled: true }],
      new Date("2026-06-15T19:00:00Z"),
      BEHAVIOR,
    );
    assert.ok(context.recentText !== undefined);
    assert.ok(context.recentText.includes(`<this_morning date="2026-06-15">`));
    assert.ok(context.recentSummaries.some((item) => item.periodKey === period.periodKey));

    // A later reference time on the same day keeps serving it; an earlier
    // reference time does not (the period was not closed yet).
    const early = await getTemporalSummaryPromptContext(
      pool,
      [{ id: "user", profileEnabled: true }],
      new Date("2026-06-15T15:00:00Z"),
      BEHAVIOR,
    );
    assert.ok(
      early.recentText === undefined ||
        !early.recentText.includes("2026-06-15-morning"),
    );
  });

  it("generates observation profiles gated by the observation fingerprint", async () => {
    await seedCanonical(pool);
    const callLlm = makeFakeLlm();
    const deps = {
      pool,
      config: memoryConfig(),
      systemPrompt: "Write a subject profile from observations. Test system prompt.",
      callLlm,
    };

    const first = await generateProfileIfNeeded(deps, "user");
    assert.equal(first.regenerated, true);
    assert.equal(first.sourceCount, 1);
    assert.ok(first.content.includes("morning tea"));
    assert.equal(callLlm.calls.profileV2, 1);

    // Claims were backfilled from the full observation set (fallback path).
    const claims = await pool.query(
      `SELECT observation_id, claim_text FROM memory_observation_profile_claim
       WHERE subject_id = 'user'`,
    );
    assert.equal(claims.rows.length, 1);
    assert.equal(claims.rows[0].claim_text, "Likes morning tea");

    // Unchanged fingerprint: no LLM call, same content.
    const second = await generateProfileIfNeeded(deps, "user");
    assert.equal(second.regenerated, false);
    assert.equal(second.skippedReason, "unchanged");
    assert.equal(callLlm.calls.profileV2, 1);

    // Empty observation sets clear the sheet without calling the LLM. Claim
    // and source-dependency rows reference canonical observations, so they
    // go first.
    await pool.query(`DELETE FROM memory_observation_profile_claim`);
    await pool.query(`DELETE FROM memory_observation_profile_source`);
    await pool.query(`DELETE FROM memory_canonical_observation`);
    const third = await generateProfileIfNeeded(deps, "user");
    assert.equal(third.regenerated, true);
    assert.equal(third.skippedReason, "no-source");
    assert.equal(third.content, null);
    assert.equal(callLlm.calls.profileV2, 1);
    const cleared = await pool.query(
      `SELECT content, source_count FROM memory_observation_profile WHERE subject_id = 'user'`,
    );
    assert.equal(cleared.rows[0].content, "");
    assert.equal(cleared.rows[0].source_count, 0);
  });

  it("does not schedule, initialize, or extract when ingest is disabled", async () => {
    // Historical turns exist but memory ingest is off: the runtime must not
    // enqueue, execute, or initialize the cursor — no accidental backfill,
    // no provider calls.
    await seedTurn(store, "I love morning tea with honey");
    await seedTurn(store, "Remind me that I prefer walking to the market");
    const callLlm = makeFakeLlm();
    const runtime = startMemoryRuntime({
      pool,
      config: memoryConfig({ WORKER_MEMORY_INGEST_ENABLED: "false" }),
      configuration: await loadMemoryConfiguration(pool, PROMPT_VERSIONS),
      callLlm,
      log: () => {},
    });
    await runtime.close();
    assert.equal(callLlm.calls.extraction, 0);
    const state = await pool.query(`SELECT count(*)::int AS n FROM memory_ingest_state`);
    assert.equal(state.rows[0].n, 0);
    const facts = await pool.query(`SELECT count(*)::int AS n FROM memory_fact`);
    assert.equal(facts.rows[0].n, 0);
  });

  it("initializes the ingest cursor at the newest existing turn and processes only new turns", async () => {
    // Historical turns predate memory enablement: the first ingest pass
    // initializes the cursor at the newest existing completed turn and
    // extracts nothing (no historical backfill).
    await seedTurn(store, "I love morning tea with honey");
    await seedTurn(store, "Remind me that I prefer walking to the market");
    const runtimeConfig = memoryConfig({
      WORKER_MEMORY_AUTOPROMOTE_ENABLED: "false",
      WORKER_MEMORY_CONSOLIDATION_INTERVAL_MS: "3600000",
    });
    const configuration = await loadMemoryConfiguration(pool, PROMPT_VERSIONS);
    const historicalLlm = makeFakeLlm();
    const first = startMemoryRuntime({
      pool,
      config: runtimeConfig,
      configuration,
      callLlm: historicalLlm,
      log: () => {},
    });
    await first.close();
    assert.equal(historicalLlm.calls.extraction, 0);
    const state = await pool.query(
      `SELECT initialized_at, watermark_turn_id FROM memory_ingest_state`,
    );
    assert.equal(state.rows.length, 1);
    assert.ok(state.rows[0].initialized_at !== null);
    const newestTurn = await pool.query(
      `SELECT t.id, max(m.created_at) AS end_at
       FROM conversation_turn t JOIN conversation_message m ON m.turn_id = t.id
       WHERE t.status = 'completed'
       GROUP BY t.id ORDER BY end_at DESC LIMIT 1`,
    );
    assert.equal(state.rows[0].watermark_turn_id, newestTurn.rows[0].id);
    const facts = await pool.query(`SELECT count(*)::int AS n FROM memory_fact`);
    assert.equal(facts.rows[0].n, 0);

    // A turn published after enablement is new: it gets extracted.
    await seedTurn(store, "I take my tea with honey every morning");
    const enabledLlm = makeFakeLlm();
    const second = startMemoryRuntime({
      pool,
      config: runtimeConfig,
      configuration,
      callLlm: enabledLlm,
      log: () => {},
    });
    second.onTurnPublished("signal");
    await new Promise((resolve) => setTimeout(resolve, 50));
    await second.close();
    assert.equal(enabledLlm.calls.extraction, 1);
    const newTurn = await pool.query(
      `SELECT t.id FROM conversation_turn t
       JOIN conversation_message m ON m.turn_id = t.id
       WHERE m.role = 'user' AND m.content LIKE '%honey every morning%'`,
    );
    assert.equal(newTurn.rows.length, 1);
    const factsAfter = await pool.query(`SELECT turn_id FROM memory_fact`);
    assert.equal(factsAfter.rows.length, 1);
    assert.equal(factsAfter.rows[0].turn_id, newTurn.rows[0].id);

    // A restart reconciles from the watermark: nothing is reprocessed.
    const restartLlm = makeFakeLlm();
    const third = startMemoryRuntime({
      pool,
      config: runtimeConfig,
      configuration,
      callLlm: restartLlm,
      log: () => {},
    });
    await third.close();
    assert.equal(restartLlm.calls.extraction, 0);
    const factsFinal = await pool.query(`SELECT count(*)::int AS n FROM memory_fact`);
    assert.equal(factsFinal.rows[0].n, 1);
  });

  it("gates v1 profile summaries behind their own flag and makes them subject-aware", async () => {
    // One completed day summary (the v1 source material), stored with the
    // provisioned behavioral timezone.
    await pool.query(
      `INSERT INTO memory_temporal_summary (
         kind, period_key, timezone, start_at, end_at, content, message_count,
         fingerprint, model, prompt_version, prompt_content_hash, generated_at, status
       ) VALUES (
         'day', '2026-06-15-day', 'America/New_York', '2026-06-15T08:00:00Z',
         '2026-06-16T08:00:00Z', 'This morning, tea was lovely.', 4,
         'seeded-day-fingerprint', 'fake-memory-model', 'temporal-v6',
         'seeded-day-prompt-hash', '2026-06-16T08:30:00Z', 'complete'
       )`,
    );

    // Default: the flag is off — the sweep must not call the LLM for v1
    // sheets (the chat prompt consumes recent temporal summaries and v2
    // profiles only, so an on-by-default flag would bill with no consumer).
    const offLlm = makeFakeLlm();
    const off = startMemoryRuntime({
      pool,
      config: memoryConfig(),
      configuration: await loadMemoryConfiguration(pool, PROMPT_VERSIONS),
      callLlm: offLlm,
      log: () => {},
    });
    await off.close();
    assert.equal(offLlm.calls.profileV1, 0);
    const none = await pool.query(`SELECT count(*)::int AS n FROM memory_profile_summary`);
    assert.equal(none.rows[0].n, 0);

    // Enabled: each profile-enabled subject gets its own sheet, generated
    // from the same day summaries but prompted with its own provisioned
    // evidence rule — the subject distinction the pipeline encodes.
    const onLlm = makeFakeLlm();
    const on = startMemoryRuntime({
      pool,
      config: memoryConfig({ WORKER_MEMORY_PROFILE_SUMMARIES_ENABLED: "true" }),
      configuration: await loadMemoryConfiguration(pool, PROMPT_VERSIONS),
      callLlm: onLlm,
      log: () => {},
    });
    await on.close();
    assert.equal(onLlm.calls.profileV1, 2);
    const userPrompt = onLlm.systemPrompts.find((prompt) =>
      prompt.includes("Attribute statements to the owner only when the owner explicitly said them"));
    const assistantPrompt = onLlm.systemPrompts.find((prompt) =>
      prompt.includes("Literal assistant-authored statements are assistant evidence"));
    assert.ok(userPrompt !== undefined, "user subject evidence rule must be in the v1 system prompt");
    assert.ok(assistantPrompt !== undefined, "assistant subject evidence rule must be in the v1 system prompt");
    assert.ok(!userPrompt.includes("Literal assistant-authored statements"));
    assert.ok(!assistantPrompt.includes("Attribute statements to the owner only"));
    const sheets = await pool.query(
      `SELECT subject_id, content, status FROM memory_profile_summary ORDER BY subject_id`,
    );
    assert.deepEqual(sheets.rows.map((row) => row.subject_id), ["assistant", "user"]);
    assert.ok(sheets.rows.every((row) => row.status === "complete"));
    assert.ok(sheets.rows.every((row) => row.content === "Settled, steady mornings."));
  });

  it("keeps v1 profile sheets out of the chat prompt context (recent leaves and v2 only)", async () => {
    // A closed recent leaf summary and a v1 profile sheet exist.
    await pool.query(
      `INSERT INTO memory_temporal_summary (
         kind, period_key, timezone, start_at, end_at, content, message_count,
         fingerprint, model, prompt_version, prompt_content_hash, generated_at, status
       ) VALUES
         ('morning', '2026-06-15-morning', 'America/New_York', '2026-06-15T08:00:00Z',
          '2026-06-15T16:00:00Z', 'This morning, tea was lovely.', 4,
          'seeded-morning-fingerprint', 'fake-memory-model', 'temporal-v6',
          'seeded-morning-prompt-hash', '2026-06-15T16:30:00Z', 'complete'),
         ('day', '2026-06-15-day', 'America/New_York', '2026-06-15T08:00:00Z',
          '2026-06-16T08:00:00Z', 'Tea day summary.', 4,
          'seeded-day-fingerprint', 'fake-memory-model', 'temporal-v6',
          'seeded-day-prompt-hash', '2026-06-16T08:30:00Z', 'complete')`,
    );
    await pool.query(
      `INSERT INTO memory_profile_summary (subject_id, content, source_summary_keys,
         source_fingerprint, model, prompt_version, status, generated_at)
       VALUES ('user', 'Settled, steady mornings.', ARRAY['summary:day:2026-06-15-day'],
         'seeded-source-fingerprint', 'fake-memory-model', 'profile-v1',
         'complete', '2026-06-16T09:00:00Z')`,
    );

    const context = await getTemporalSummaryPromptContext(
      pool,
      [{ id: "user", profileEnabled: true }, { id: "assistant", profileEnabled: true }],
      new Date("2026-06-15T19:00:00Z"),
      BEHAVIOR,
    );
    // The chat prompt consumes recentText: the recent leaf is in, the v1
    // sheet is not.
    assert.ok(context.recentText !== undefined);
    assert.ok(context.recentText.includes(`<this_morning date="2026-06-15">`));
    assert.ok(!context.recentText.includes("<profile_memories>"));
    assert.ok(!context.recentText.includes("Settled, steady mornings."));
    // The full source-parity surface (the private HTTP API's `text`) does
    // carry the v1 sheets in the assembled memory context.
    assert.ok(context.text !== undefined);
    assert.ok(context.text.includes("<profile_memories>"));
    assert.ok(context.text.includes("<user_profile>"));
    assert.ok(context.text.includes("Settled, steady mornings."));

    // The composed chat message (what the processor assembles per turn:
    // v2 profile section + recent temporal + canonical recall) carries the
    // v2 sheet and the recent leaf, never the v1 block.
    const v2Profile = await getProfileDocument(pool, "user");
    assert.equal(v2Profile, null); // none generated yet in this test
    await pool.query(
      `INSERT INTO memory_observation_profile (subject_id, fingerprint, prompt_version,
         prompt_content_hash, content, source_count, model, generated_at)
       VALUES ('user', 'v2-fingerprint', 'v2-1', 'v2-prompt-hash',
         'The owner likes morning tea.', 1,
         'fake-memory-model', '2026-06-16T10:00:00Z')`,
    );
    const v2 = await getProfileDocument(pool, "user");
    assert.ok(v2 !== null);
    // Each section renders independently; the chat prompt assembles them as
    // separate chunks (see work/chat.ts), so here the renderers are checked
    // directly.
    const profileChunk = renderProfileSection({ profile: v2 });
    assert.ok(profileChunk !== undefined);
    assert.ok(profileChunk.includes("The owner likes morning tea."));
    assert.ok(context.recentText.includes("<recent_memories>"));
    assert.ok(context.recentText.includes("<this_morning"));
    assert.ok(!profileChunk.includes("<profile_memories>"));
    assert.ok(!profileChunk.includes("Settled, steady mornings."));
  });

  it("records metadata-only operation traces", async () => {
    const startedAt = new Date("2026-06-15T12:00:00Z");
    await recordMemoryOperation(pool, {
      kind: "fact_extraction",
      outcome: "ok",
      detail: "reason=reconciliation selected=2 extracted=2 facts=2 cacheHits=0",
      model: "fake-memory-model",
      promptVersion: "memory-facts-prompt-v7",
      llmCalls: 1,
      startedAt,
      finishedAt: new Date(startedAt.getTime() + 1000),
    });
    const traces = await pool.query(
      `SELECT kind, outcome, detail, prompt_version, llm_calls FROM memory_operation`,
    );
    assert.equal(traces.rows.length, 1);
    assert.equal(traces.rows[0].kind, "fact_extraction");
    assert.equal(traces.rows[0].outcome, "ok");
    assert.ok(traces.rows[0].detail.includes("reason=reconciliation"));
    // The trace schema carries no content columns; detail strings are
    // counters and identifiers only.
    assert.ok(!traces.rows[0].detail.includes("morning tea"));
    const columns = await pool.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'memory_operation'`,
    );
    const names = columns.rows.map((row) => row.column_name);
    for (const forbidden of ["prompt", "prompt_text", "response", "response_body", "content", "payload", "source_text"]) {
      assert.ok(
        !names.includes(forbidden),
        `memory_operation must not carry a ${forbidden} column`,
      );
    }
  });

  it("sends identity, separated memory chunks, and guidance as synthetic system messages", async () => {
    const history = [];
    const turnMessages = [{ id: "m-1", role: "user", content: "What tea do I like?" }];
    const request = buildChatRequest({
      model: "test-model",
      identity: "FIXTURE IDENTITY",
      history,
      turnMessages,
      profiles: "PROFILE",
      recall: "MEMORY CONTEXT",
      guidance: "PATTERN GUIDANCE",
    });
    assert.equal(request.messages[0].role, "system");
    assert.equal(request.messages[0].content, "FIXTURE IDENTITY");
    assert.equal(request.messages[1].content, "PROFILE");
    assert.equal(request.messages[2].content, "MEMORY CONTEXT");
    assert.equal(request.messages[3].content, "PATTERN GUIDANCE");
    assert.equal(request.messages[4].content, "What tea do I like?");

    // Without memory or guidance only the identity system message remains.
    const bare = buildChatRequest({
      model: "test-model",
      identity: "FIXTURE IDENTITY",
      history,
      turnMessages,
      guidance: null,
    });
    assert.deepEqual(
      bare.messages.map((message) => `${message.role}:${message.content}`),
      ["system:FIXTURE IDENTITY", "user:What tea do I like?"],
    );

    // The processor sends each loaded section as its own message and records
    // a null source for each; loader failures never fail the turn.
    const outcome = await processTurnWork(
      {
        turn: { id: "turn-1", status: "in_flight", attempt: 1, lease_owner: "o", lease_expires_at: new Date() },
        messages: turnMessages,
      },
      {
        decisionModel: "d",
        chatModel: "c",
        callDecisions: async () => { throw new Error("not used"); },
        callChat: async () => ({
          id: "chat-1",
          model: "chat-model",
          choices: [
            {
              message: { role: "assistant", content: "reply" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 },
        }),
        loadIdentity: async () => ({ content: "FIXTURE IDENTITY", revision: 1 }),
        loadPatterns: async () => [],
        loadContext: async () => [],
        loadMemoryContext: async ({ userText }) => ({
          memoryContext: `RECALL for ${userText}`,
          profileSection: "PROFILE",
        }),
      },
    );
    assert.equal(outcome.reply, "reply");
  });
  it("reports automation activity as metadata-only output", async () => {
    const lines = [];
    const originalLog = console.log;
    console.log = (message) => lines.push(String(message));
    try {
      await runReport(pool, {
        command: "report",
        ids: [],
        allActive: false,
        activeOnly: false,
        allowSingleTurnReviewed: false,
        reviewedIds: [],
        reviewedBy: undefined,
        reviewNote: undefined,
        execute: false,
        confirmToken: undefined,
        since: "2026-01-01",
      });
    } finally {
      console.log = originalLog;
    }
    const output = lines.join("\n");
    assert.match(output, /# Memory automation report/);
    assert.match(output, /## Canonical state/);
    assert.match(output, /## Ingest state/);
    assert.match(output, /## Recent failures/);
    assert.match(output, /Window: 2026-01-01T00:00:00Z/);
  });

  it("answers an explicit-date query in timeline mode within the named window", async () => {
    await seedCanonical(pool);
    // The seeded canonical observation's evidence is at a known observed_at;
    // query with a window that contains it and one that does not.
    const observed = await pool.query(
      `SELECT last_observed_at FROM memory_canonical_observation LIMIT 1`,
    );
    const observedAt = observed.rows[0].last_observed_at;
    // The window is a LOCAL day in the behavioral timezone,
    // so derive the date token from the observation's local calendar date.
    const iso = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(observedAt);

    const inWindow = await recallCanonical(pool, memoryConfig(), {
      query: `${iso} morning tea`,
      referenceTime: new Date(),
      limit: 8,
      maxChars: 12_000,
      timezone: "America/New_York",
    });
    assert.equal(inWindow.query.mode, "hybrid");
    assert.ok(inWindow.query.timeRange !== undefined);
    assert.ok(inWindow.results.length >= 1, "the in-window query must recall the observation");

    // A pure timeline query (temporal phrase, no keywords) ranks by time.
    const timeline = await recallCanonical(pool, memoryConfig(), {
      query: iso,
      referenceTime: new Date(),
      limit: 8,
      maxChars: 12_000,
      timezone: "America/New_York",
    });
    assert.equal(timeline.query.mode, "timeline");
    assert.ok(timeline.results.length >= 1);

    // A query without a temporal expression stays in keyword mode.
    const keyword = await recallCanonical(pool, memoryConfig(), {
      query: "morning tea",
      referenceTime: new Date(),
      limit: 8,
      maxChars: 12_000,
      timezone: "America/New_York",
    });
    assert.equal(keyword.query.mode, "keyword");
    assert.equal(keyword.query.timeRange, undefined);
  });

  it("runs the recall evaluation end to end and removes its own rows", async () => {
    // The bundled corpus is generic synthetic content; the evaluation seeds
    // it into the disposable database, runs every query through the real
    // recall pipeline, scores, and cleans up after itself. The evaluation's
    // target guard requires an EMPTY domain state, so the suite-seeded
    // subjects are removed first (this is the disposable database; the
    // suite re-seeds them per test via beforeEach).
    await pool.query(`DELETE FROM memory_subject`);
    const corpus = validateEvalCorpus(
      JSON.parse(
        readFileSync(
          new URL("../../apps/worker/src/memory/eval-corpus.json", import.meta.url),
          "utf8",
        ),
      ),
    );
    const config = memoryConfig();
    const first = await runRecallEval(pool, config, corpus, {
      k: 5,
      referenceTime: new Date(),
      timezone: "America/New_York",
    });
    assert.ok(first.metrics.recall >= 0.6, `recall@5 ${first.metrics.recall}`);
    assert.ok(first.metrics.precision >= 0.5, `precision@5 ${first.metrics.precision}`);
    assert.ok(first.metrics.mrr >= 0.5, `MRR ${first.metrics.mrr}`);
    assert.equal(first.metrics.temporalViolations, 0);

    // The target guard refuses any database that already holds domain rows:
    // this is what keeps the evaluation away from in-use or provisioned
    // databases (it cannot prove disposability beyond the empty-domain
    // precondition, and the tooling must not claim more than that).
    await pool.query(`INSERT INTO memory_subject (id, role, profile_enabled, source_label, profile_evidence_rule, position)
                      VALUES ('provisioned', 'user', false, 'User', 'rule', 0)`);
    await assert.rejects(
      () =>
        runRecallEval(pool, config, corpus, {
          k: 5,
          referenceTime: new Date(),
          timezone: "America/New_York",
        }),
      /refusing to run: the target database already holds domain rows/,
    );
    await pool.query(`DELETE FROM memory_subject WHERE id = 'provisioned'`);

    // Cleanup removed exactly this run's rows; a rerun works.
    const subjectLeft = await pool.query(
      `SELECT count(*)::int AS n FROM memory_subject WHERE id = $1`,
      [EVAL_SUBJECT_ID],
    );
    assert.equal(subjectLeft.rows[0].n, 0);
    const rowsLeft = await pool.query(
      `SELECT count(*)::int AS n FROM memory_canonical_observation
       WHERE canonical_observation_id LIKE 'eval-%'`,
    );
    assert.equal(rowsLeft.rows[0].n, 0);
    const second = await runRecallEval(pool, config, corpus, {
      k: 5,
      referenceTime: new Date(),
      timezone: "America/New_York",
    });
    assert.ok(second.metrics.recall >= 0.6);
  });

  it("serves the general recall surface over the private API with auth, validation, and availability semantics", async () => {
    const corpus = validateEvalCorpus(
      JSON.parse(
        readFileSync(
          new URL("../../apps/worker/src/memory/eval-corpus.json", import.meta.url),
          "utf8",
        ),
      ),
    );
    await seedEvalCorpus(pool, buildEvalSeeds(corpus));
    const config = memoryConfig();
    const behavior = await loadMemoryBehavior(pool);
    // The recall dependency is wired exactly the way main.ts wires it.
    const recall = async (input) =>
      recallCanonical(pool, config, {
        query: input.query,
        referenceTime: new Date(),
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
        maxChars: config.recallMaxChars,
        timezone: behavior.timezone,
      });
    const server = createApiServer({
      store: createConversationStore(pool),
      token: "test-api-token",
      host: "127.0.0.1",
      port: 0,
      recall,
    });
    const port = await server.start();
    try {
      const base = `http://127.0.0.1:${String(port)}`;
      const authorized = await fetch(`${base}/v1/memory/recall`, {
        method: "POST",
        headers: { authorization: "Bearer test-api-token", "content-type": "application/json" },
        body: JSON.stringify({ query: "green tea coffee lunch", limit: 5 }),
      });
      assert.equal(authorized.status, 200);
      const body = await authorized.json();
      assert.equal(body.query.mode, "keyword");
      assert.ok(body.results.length >= 1);
      assert.equal(body.results[0].id, "eval-tea-preference");

      // Unauthenticated and wrong-method requests are refused like every
      // other private route.
      const unauthenticated = await fetch(`${base}/v1/memory/recall`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: "tea" }),
      });
      assert.equal(unauthenticated.status, 401);
      const wrongMethod = await fetch(`${base}/v1/memory/recall`, { method: "GET" });
      assert.equal(wrongMethod.status, 405);

      // Shape errors are 400; semantic violations surface as the domain's
      // validation error, also 400.
      const malformed = await fetch(`${base}/v1/memory/recall`, {
        method: "POST",
        headers: { authorization: "Bearer test-api-token", "content-type": "application/json" },
        body: JSON.stringify({ nope: true }),
      });
      assert.equal(malformed.status, 400);
      const oversized = await fetch(`${base}/v1/memory/recall`, {
        method: "POST",
        headers: { authorization: "Bearer test-api-token", "content-type": "application/json" },
        body: JSON.stringify({ query: "x".repeat(600) }),
      });
      assert.equal(oversized.status, 400);
      const outOfRangeLimit = await fetch(`${base}/v1/memory/recall`, {
        method: "POST",
        headers: { authorization: "Bearer test-api-token", "content-type": "application/json" },
        body: JSON.stringify({ query: "tea", limit: 999 }),
      });
      assert.equal(outOfRangeLimit.status, 400);

      // A server without a wired recall dependency (memory unprovisioned)
      // reports the surface as unavailable, not unknown.
      const bare = createApiServer({
        store: createConversationStore(pool),
        token: "test-api-token",
        host: "127.0.0.1",
        port: 0,
      });
      const barePort = await bare.start();
      try {
        const unavailable = await fetch(`http://127.0.0.1:${String(barePort)}/v1/memory/recall`, {
          method: "POST",
          headers: { authorization: "Bearer test-api-token", "content-type": "application/json" },
          body: JSON.stringify({ query: "tea" }),
        });
        assert.equal(unavailable.status, 503);
      } finally {
        await bare.close();
      }
    } finally {
      await server.close();
      await cleanupEvalCorpus(pool);
    }
  });
});

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

async function ingestDeps(pool, callLlm) {
  return {
    pool,
    config: memoryConfig(),
    subjects: ["user", "assistant"],
    systemPrompt: "Extract durable facts. Test system prompt.",
    userLabel: "OWNER",
    assistantLabel: "COMPANION",
    callLlm,
  };
}

/**
 * Initialize the new-turn-only ingest cursor before any turn exists: the
 * first ingest attempt after enablement marks existing turns as covered and
 * extracts nothing. Tests that seed turns and expect them extracted call
 * this first, matching the documented rollout (enable memory, then new
 * turns arrive).
 */
async function enableIngest(currentPool) {
  const summary = await ingestTurns(
    await ingestDeps(currentPool, makeFakeLlm()),
    "reconciliation",
  );
  assert.equal(summary.watermarkInitialized, true);
  assert.equal(summary.selectedTurns, 0);
  return summary;
}

/**
 * Seed one single-turn canonical observation directly (the automatic
 * promotion path blocks single-turn evidence and has no manual exception),
 * referencing one real ingested fact so the review's evidence resolution
 * resolves. Returns the canonical observation id.
 */
async function seedSingleTurnCanonical(currentPool) {
  await enableIngest(currentPool);
  const storeLocal = createConversationStore(currentPool);
  await seedTurn(storeLocal, "I love morning tea with honey");
  await ingestTurns(await ingestDeps(currentPool, makeFakeLlm()), "reconciliation");
  const fact = await currentPool.query(
    `SELECT fact_key, observed_at FROM memory_fact ORDER BY fact_key LIMIT 1`,
  );
  assert.equal(fact.rows.length, 1);
  const observedAt = fact.rows[0].observed_at;
  await currentPool.query(
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
       $1, $2, 1, $3, 'user', 'preference', 'Likes morning tea',
       1, 1, 1, 0, $4, $4, ARRAY[$5::text], 'supported', 'active',
       'test-consolidation-version', 'test-content-hash', 1,
       'test-promotion-id', 1, 'test-artifact-id', 'test-run-id',
       'test-observation-set-id', 'test-fact-set-id',
       $4, $4, $4, $4
     )`,
    [
      "canon-single-turn-review-test",
      "user|preference|likes-morning-tea-review-test",
      "obs-key-single-turn-review-test",
      observedAt,
      fact.rows[0].fact_key,
    ],
  );
  return "canon-single-turn-review-test";
}

/** Seed one completed conversation turn now. */
async function seedTurn(store, userText) {
  await store.appendUserMessage({ content: userText, clientKey: `key-${Math.random()}` });
  const claim = await store.claimNextTurn({ owner: "test-owner", leaseSeconds: 60 });
  await store.publishReply({
    turnId: claim.work.turn.id,
    leaseOwner: "test-owner",
    content: `COMPANION reply about: ${userText}`,
  });
  return claim.work.turn.id;
}

/** Seed one completed turn at a specific instant (for temporal periods). */
async function seedTurnAt(currentPool, storeLocal, userText, when) {
  await storeLocal.appendUserMessage({ content: userText, clientKey: `key-${Math.random()}` });
  const claim = await storeLocal.claimNextTurn({ owner: "test-owner", leaseSeconds: 60 });
  await storeLocal.publishReply({
    turnId: claim.work.turn.id,
    leaseOwner: "test-owner",
    content: "COMPANION reply about the morning",
  });
  // Backdate the turn's messages into the period window (user at the window
  // start, reply two minutes later — both inside the morning).
  await currentPool.query(
    `UPDATE conversation_message SET created_at = $2
     WHERE turn_id = $1 AND role = 'user'`,
    [claim.work.turn.id, when],
  );
  await currentPool.query(
    `UPDATE conversation_message SET created_at = $2
     WHERE turn_id = $1 AND role = 'assistant'`,
    [claim.work.turn.id, new Date(when.getTime() + 120_000)],
  );
  return claim.work.turn.id;
}

/**
 * Seed the full pipeline state for one canonical observation: two completed
 * turns, ingested facts, a consolidated run, and a completed promotion.
 * Returns identifying keys for recall assertions.
 */
async function seedCanonical(currentPool) {
  await enableIngest(currentPool);
  const storeLocal = createConversationStore(currentPool);
  await seedTurn(storeLocal, "I love morning tea with honey");
  await seedTurn(storeLocal, "I take my tea with honey every morning");
  const callLlm = makeFakeLlm();
  const config = memoryConfig();
  await ingestTurns(
    {
      pool: currentPool,
      config,
      subjects: ["user", "assistant"],
      systemPrompt: "Extract durable facts. Test system prompt.",
      userLabel: "OWNER",
      assistantLabel: "COMPANION",
      callLlm,
    },
    "reconciliation",
  );
  const run = await runScheduledConsolidation({
    pool: currentPool,
    config,
    subjects: ["user", "assistant"],
    systemPrompt: "Consolidate observations. Test system prompt.",
    factExtractionPromptContentHash: promptContentHash("Extract durable facts. Test system prompt."),
    callLlm,
    behavior: BEHAVIOR,
  });
  const plan = await buildPromotionPlan(currentPool, {
    runId: run.runId,
    skipTentative: true,
    behavior: BEHAVIOR,
  });
  await promoteRun(currentPool, {
    runId: run.runId,
    confirmationToken: plan.confirmationToken,
    skipTentative: true,
    behavior: BEHAVIOR,
  });
  const facts = await currentPool.query(
    `SELECT fact_key FROM memory_fact ORDER BY fact_key`,
  );
  const canonical = await currentPool.query(
    `SELECT canonical_observation_id FROM memory_canonical_observation LIMIT 1`,
  );
  return {
    factKeys: facts.rows.map((row) => row.fact_key),
    canonicalObservationId: canonical.rows[0].canonical_observation_id,
  };
}
