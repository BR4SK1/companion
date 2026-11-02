// Failure-injection and runtime tests for the memory domain's durability
// fixes: promotion-vs-retraction races (never reactivates), partial-apply
// crash replay (resumable promotions), concurrent ingest counter accounting,
// transactional parent/child writes (facts, extraction cache, temporal
// summaries, observation profiles), per-run immutable consolidation
// artifacts, and the runtime's pending-promotion reconciliation and
// zero-fact consolidation guard.
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
import { ingestTurns } from "../../apps/worker/src/memory/ingest.ts";
import { runScheduledConsolidation } from "../../apps/worker/src/memory/consolidation.ts";
import {
  updateIngestState,
  getIngestState,
  upsertProductionFacts,
} from "../../apps/worker/src/memory/facts.ts";
import {
  buildPromotionPlan,
  promoteRun,
  resumePromotionForRun,
  retractCanonicalObservation,
  selectPendingPromotionRunIds,
  PROMOTION_RECONCILE_BACKOFF_MS,
} from "../../apps/worker/src/memory/promotion.ts";
import { promptContentHash, factKeyOf, MEMORY_PROFILE_PROMPT_VERSION } from "../../apps/worker/src/memory/prompts.ts";
import {
  buildCanonicalReviewPlan,
  reviewCanonicalObservations,
} from "../../apps/worker/src/memory/review.ts";
import {
  saveTemporalSummary,
  getTemporalSummary,
  getTemporalSummaryPromptContext,
} from "../../apps/worker/src/memory/temporal/store.ts";
import {
  generateProfileIfNeeded,
  getProfileDocument,
} from "../../apps/worker/src/memory/profiles-v2.ts";
import { loadProfileObservations } from "../../apps/worker/src/memory/profiles-v2.ts";
import { generateProfileSummary } from "../../apps/worker/src/memory/profiles-v1.ts";
import { loadMemoryConfiguration } from "../../apps/worker/src/memory/subjects.ts";
import { startMemoryRuntime } from "../../apps/worker/src/memory/runtime.ts";

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
  "memory_observation_profile_source",
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

const FACT_EXTRACTION_SYSTEM_PROMPT = "Extract durable facts. Test system prompt.";
const OBSERVATION_SYSTEM_PROMPT = "Consolidate observations. Test system prompt.";

/** The fact-extraction prompt content hash the test pipelines bind to. */
const FACT_PROMPT_CONTENT_HASH = promptContentHash(FACT_EXTRACTION_SYSTEM_PROMPT);

export function memoryConfig(overrides = {}) {
  return loadMemoryConfig({
    WORKER_MEMORY_INGEST_ENABLED: "true",
    WORKER_MEMORY_AUTOPROMOTE_ENABLED: "true",
    WORKER_MEMORY_PROFILES_ENABLED: "true",
    WORKER_MEMORY_INGEST_SETTLE_MS: "0",
    WORKER_MEMORY_CONSOLIDATION_INTERVAL_MS: "1",
    ...overrides,
  });
}

/** Prompt configs matching the provisioned rows, with content hashes. */
function runtimeConfiguration() {
  const rows = {
    fact_extraction: "Extract durable facts from the supplied turns. Test system prompt.",
    observation_consolidation: "Consolidate observations from the supplied facts. Test system prompt.",
    temporal_summary: "Write a diary-style memory summary. Test system prompt.",
    profile_summary: "Write a subject profile from day summaries. Test system prompt.",
    observation_profile: "Write a subject profile from observations. Test system prompt.",
  };
  const prompts = {};
  for (const [kind, systemPrompt] of Object.entries(rows)) {
    prompts[kind] = {
      kind,
      version: PROMPT_VERSIONS[kind],
      systemPrompt,
      contentHash: promptContentHash(systemPrompt),
    };
  }
  const subject = (id, role, position) => ({
    id,
    role,
    profileEnabled: false,
    sourceLabel: role === "user" ? "OWNER" : "COMPANION",
    profileEvidenceRule: "test evidence rule",
    position,
  });
  return {
    subjects: [subject("user", "user", 0), subject("assistant", "assistant", 1)],
    prompts,
    userSubject: subject("user", "user", 0),
    assistantSubject: subject("assistant", "assistant", 1),
    behavior: BEHAVIOR,
  };
}

// ---------------------------------------------------------------------------
// A fake memory LLM that produces two distinct claims so a consolidation run
// yields two separately promotable canonical identities.
// ---------------------------------------------------------------------------

function claimForText(text) {
  if (/\btea\b/i.test(text)) {
    return { kind: "preference", claim: "Likes morning tea", topics: ["tea"] };
  }
  if (/\bwalk\b/i.test(text)) {
    return { kind: "preference", claim: "Walks every evening", topics: ["exercise"] };
  }
  return null;
}

export function makeTwoClaimLlm() {
  const calls = { extraction: 0, consolidation: 0 };
  const fn = async (input) => {
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
      // Group FACT ID blocks by their CLAIM line.
      const blocks = [...message.matchAll(
        /FACT ID: (\S+)[\s\S]*?CLAIM: (.*)\n/g,
      )];
      const groups = new Map();
      for (const [, factId, claim] of blocks) {
        if (!groups.has(claim)) groups.set(claim, []);
        groups.get(claim).push(factId);
      }
      const observations = [];
      for (const [claim, factIds] of groups) {
        const shape = claim === "Likes morning tea"
          ? { kind: "preference", topics: ["tea"] }
          : { kind: "preference", topics: ["exercise"] };
        observations.push({
          subject: "user",
          kind: shape.kind,
          claim,
          topics: shape.topics,
          condition: "",
          consequence: "",
          sourceFactIds: factIds,
          contradictionFactIds: [],
        });
      }
      return respond(JSON.stringify({ observations }));
    }
    if (message.includes("SOURCE TURN ID:")) {
      calls.extraction += 1;
      // Parse each source turn block and derive the claim from the owner text.
      const blocks = [...message.matchAll(
        /SOURCE TURN ID: (\S+)[\s\S]*?OWNER: (.*)\n/g,
      )];
      const sources = [];
      for (const [, turnId, ownerText] of blocks) {
        const shape = claimForText(ownerText);
        if (shape === null) continue;
        sources.push({
          sourceTurnId: turnId,
          facts: [{
            subject: "user",
            kind: shape.kind,
            claim: shape.claim,
            topics: shape.topics,
            condition: "",
            consequence: "",
            explicitness: "explicit",
            evidenceBasis: "direct_statement",
          }],
        });
      }
      return respond(JSON.stringify({ sources }));
    }
    throw new Error(`fake LLM has no route for message: ${message.slice(0, 120)}`);
  };
  fn.calls = calls;
  return fn;
}

// ---------------------------------------------------------------------------
// Failure-injection pool wrapper: rules run as side effects (or throw) ahead
// of the real query, on both the pool and every transaction client drawn
// from it. Rule side effects that need another connection take the raw base
// pool explicitly.
// ---------------------------------------------------------------------------

export function injectingPool(base, rules) {
  const runRules = async (sql, params) => {
    for (const rule of rules) {
      if (rule.match(sql, params ?? [])) {
        await rule.handle({ sql, params, base });
      }
    }
  };
  // pg reuses client objects across checkouts: wrap each client exactly once
  // (WeakMap) so rule counters count statements, not wrapper layers.
  const wrappedClients = new WeakMap();
  const wrapClient = (client) => {
    if (wrappedClients.has(client)) return wrappedClients.get(client);
    const wrapped = {
      query: async (sql, params) => {
        await runRules(sql, params);
        return client.query(sql, params);
      },
      release: (...args) => client.release(...args),
    };
    wrappedClients.set(client, wrapped);
    return wrapped;
  };
  return {
    query: async (sql, params) => {
      await runRules(sql, params);
      return base.query(sql, params);
    },
    connect: async () => wrapClient(await base.connect()),
  };
}

/** Throw-once rule: fails the Nth matching query (1-based). */
export function throwOnNth(match, nth, message) {
  let seen = 0;
  return {
    match,
    handle: async () => {
      seen += 1;
      if (seen === nth) throw new Error(message);
    },
  };
}

// ---------------------------------------------------------------------------
// Seeding helpers
// ---------------------------------------------------------------------------

export async function seedTurn(store, userText) {
  await store.appendUserMessage({ content: userText, clientKey: `key-${Math.random()}` });
  const claim = await store.claimNextTurn({ owner: "test-owner", leaseSeconds: 60 });
  await store.publishReply({
    turnId: claim.work.turn.id,
    leaseOwner: "test-owner",
    content: `COMPANION reply about: ${userText}`,
  });
  return claim.work.turn.id;
}

export async function ingestDeps(currentPool, callLlm) {
  return {
    pool: currentPool,
    config: memoryConfig(),
    subjects: ["user", "assistant"],
    systemPrompt: FACT_EXTRACTION_SYSTEM_PROMPT,
    userLabel: "OWNER",
    assistantLabel: "COMPANION",
    callLlm,
  };
}

/**
 * Initialize the new-turn-only ingest cursor before any turn exists.
 */
export async function enableIngest(currentPool) {
  const summary = await ingestTurns(
    await ingestDeps(currentPool, makeTwoClaimLlm()),
    "reconciliation",
  );
  assert.equal(summary.watermarkInitialized, true);
}

/** Two completed turns per claim, ingested, then consolidated into one run. */
export async function seedTwoClaimRun(currentPool) {
  await enableIngest(currentPool);
  const storeLocal = createConversationStore(currentPool);
  await seedTurn(storeLocal, "I love morning tea with honey");
  await seedTurn(storeLocal, "I take my tea with honey every morning");
  await seedTurn(storeLocal, "I walk every evening after dinner");
  await seedTurn(storeLocal, "My evening walk keeps me steady");
  const callLlm = makeTwoClaimLlm();
  const config = memoryConfig();
  await ingestTurns(await ingestDeps(currentPool, callLlm), "reconciliation");
  const run = await runScheduledConsolidation({
    pool: currentPool,
    config,
    subjects: ["user", "assistant"],
    systemPrompt: OBSERVATION_SYSTEM_PROMPT,
    factExtractionPromptContentHash: FACT_PROMPT_CONTENT_HASH,
    callLlm,
    behavior: BEHAVIOR,
  });
  return { run, callLlm };
}

describe("memory durability under failure injection (PostgreSQL)", { skip: !hasDatabase }, () => {
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

  it("a retraction that lands between planning and applying is skipped, never reactivated, and does not block unrelated items", async () => {
    // Establish canonical state with a first promoted run, then re-run the
    // same window so the second promotion plans REVISIONS of existing
    // identities — the state in which a racing retraction is meaningful.
    const { run: run1 } = await seedTwoClaimRun(pool);
    const plan1 = await buildPromotionPlan(pool, {
      runId: run1.runId,
      skipTentative: true,
      behavior: BEHAVIOR,
    });
    const first = await promoteRun(pool, {
      runId: run1.runId,
      confirmationToken: plan1.confirmationToken,
      skipTentative: true,
      behavior: BEHAVIOR,
    });
    assert.equal(first.status, "completed");

    const run2 = await runScheduledConsolidation({
      pool,
      config: memoryConfig(),
      subjects: ["user", "assistant"],
      systemPrompt: OBSERVATION_SYSTEM_PROMPT,
      factExtractionPromptContentHash: FACT_PROMPT_CONTENT_HASH,
      callLlm: makeTwoClaimLlm(),
      behavior: BEHAVIOR,
    });
    assert.equal(run2.observations, 2);
    const plan2 = await buildPromotionPlan(pool, {
      runId: run2.runId,
      skipTentative: true,
      behavior: BEHAVIOR,
    });
    assert.equal(plan2.itemCount, 2);

    const targetItem = plan2.items.find(
      (item) => item.observation.claim === "Likes morning tea",
    ) ?? plan2.items[0];
    const targetIdentity = targetItem.canonicalIdentityKey;

    let retractionFired = false;
    const wrapped = injectingPool(pool, [{
      match: (sql, params) =>
        sql.includes("FOR UPDATE") &&
        params.length > 0 &&
        params[0] === targetIdentity,
      handle: async () => {
        if (retractionFired) return;
        retractionFired = true;
        // Another connection wins the race: the operator retracts the
        // observation while the promotion is mid-flight.
        await retractCanonicalObservation(pool, {
          canonicalObservationId: targetItem.canonicalObservationId,
          reasonCodes: ["test_race_retraction"],
          operationKey: "test-race-retraction",
        });
      },
    }]);

    const result = await promoteRun(wrapped, {
      runId: run2.runId,
      confirmationToken: plan2.confirmationToken,
      skipTentative: true,
      behavior: BEHAVIOR,
    });

    assert.equal(result.skippedInactive, 1);
    assert.equal(result.created + result.revised + result.unchanged, 1);
    assert.ok(retractionFired, "the injected retraction must have run");

    // The retracted identity was never reactivated and still belongs to the
    // first promotion's write.
    const retracted = await pool.query(
      `SELECT status, promotion_id FROM memory_canonical_observation
       WHERE canonical_identity_key = $1`,
      [targetIdentity],
    );
    assert.equal(retracted.rows[0].status, "retracted");
    assert.notEqual(retracted.rows[0].promotion_id, result.promotionId);

    // The unrelated identity was still promoted by this run.
    const promoted = await pool.query(
      `SELECT status FROM memory_canonical_observation
       WHERE promotion_id = $1 AND canonical_identity_key <> $2`,
      [result.promotionId, targetIdentity],
    );
    assert.equal(promoted.rows.length, 1);
    assert.equal(promoted.rows[0].status, "active");

    // The skipped item recorded its outcome and produced no history event.
    const items = await pool.query(
      `SELECT canonical_identity_key, outcome FROM memory_promotion_item
       WHERE promotion_id = $1`,
      [result.promotionId],
    );
    assert.equal(items.rows.length, 2);
    const skippedRow = items.rows.find(
      (row) => row.canonical_identity_key === targetIdentity,
    );
    assert.equal(skippedRow.outcome, "skipped_inactive");
    const history = await pool.query(
      `SELECT canonical_identity_key FROM memory_observation_history
       WHERE promotion_id = $1`,
      [result.promotionId],
    );
    assert.equal(history.rows.length, 1);
    assert.notEqual(history.rows[0].canonical_identity_key, targetIdentity);
  });

  it("a promotion interrupted mid-apply stays 'applying' and a replay resumes it to completion without duplicate history", async () => {
    const { run } = await seedTwoClaimRun(pool);
    const plan = await buildPromotionPlan(pool, {
      runId: run.runId,
      skipTentative: true,
      behavior: BEHAVIOR,
    });
    assert.equal(plan.itemCount, 2);

    // Fail the second item's history insert: item one commits, item two
    // rolls back, and the process "dies" with the manifest in 'applying'.
    const wrapped = injectingPool(pool, [
      throwOnNth(
        (sql) => sql.includes("INSERT INTO memory_observation_history"),
        2,
        "injected crash during apply",
      ),
    ]);
    await assert.rejects(
      () => promoteRun(wrapped, {
        runId: run.runId,
        confirmationToken: plan.confirmationToken,
        skipTentative: true,
        behavior: BEHAVIOR,
      }),
      /injected crash during apply/,
    );

    const manifest = await pool.query(
      `SELECT status FROM memory_promotion WHERE promotion_id = $1`,
      [plan.promotionId],
    );
    assert.equal(manifest.rows[0].status, "applying");

    const applied = await pool.query(
      `SELECT canonical_identity_key, status FROM memory_canonical_observation
       WHERE promotion_id = $1`,
      [plan.promotionId],
    );
    assert.equal(applied.rows.length, 1, "exactly one item applied before the crash");
    const historyBefore = await pool.query(
      `SELECT canonical_identity_key FROM memory_observation_history
       WHERE promotion_id = $1`,
      [plan.promotionId],
    );
    assert.equal(historyBefore.rows.length, 1);

    // Replay (same run, same token): the resume path re-applies from the
    // staged items and completes.
    const resumed = await promoteRun(pool, {
      runId: run.runId,
      confirmationToken: plan.confirmationToken,
      skipTentative: true,
      behavior: BEHAVIOR,
    });
    assert.equal(resumed.status, "completed");

    const manifestAfter = await pool.query(
      `SELECT status FROM memory_promotion WHERE promotion_id = $1`,
      [plan.promotionId],
    );
    assert.equal(manifestAfter.rows[0].status, "completed");

    // Both identities applied, each with exactly one history event.
    const canonicalAfter = await pool.query(
      `SELECT canonical_identity_key, status FROM memory_canonical_observation
       WHERE promotion_id = $1`,
      [plan.promotionId],
    );
    assert.equal(canonicalAfter.rows.length, 2);
    for (const row of canonicalAfter.rows) assert.equal(row.status, "active");
    const historyAfter = await pool.query(
      `SELECT canonical_identity_key, count(*)::int AS n
       FROM memory_observation_history
       WHERE promotion_id = $1
       GROUP BY canonical_identity_key`,
      [plan.promotionId],
    );
    assert.equal(historyAfter.rows.length, 2);
    for (const row of historyAfter.rows) assert.equal(row.n, 1);
  });

  it("concurrent ingest state updates never lose fact counts and never move the watermark backward", async () => {
    await enableIngest(pool);
    const storeLocal = createConversationStore(pool);
    const turnA = await seedTurn(storeLocal, "I love morning tea with honey");
    const turnB = await seedTurn(storeLocal, "I walk every evening after dinner");
    // The watermark cursor references real turns (foreign key): A is older
    // (seeded first), B is newer.
    const newerId = turnB;
    const olderId = turnA;

    await pool.query(
      `INSERT INTO memory_ingest_state (id) VALUES (true) ON CONFLICT (id) DO NOTHING`,
    );
    // 60 concurrent single-fact additions: a read-modify-write would lose
    // some of these; the atomic increment keeps every one.
    await Promise.all(
      Array.from({ length: 60 }, () =>
        updateIngestState(pool, { addFacts: 1 })),
    );
    let state = await getIngestState(pool);
    assert.equal(state.newFactsSinceConsolidation, 60);

    // A consume racing an add is order-independent under relative arithmetic.
    await Promise.all([
      updateIngestState(pool, { consumeFacts: 60 }),
      updateIngestState(pool, { addFacts: 5 }),
    ]);
    state = await getIngestState(pool);
    assert.equal(state.newFactsSinceConsolidation, 5);

    // Watermark monotonicity: an older pass's cursor never overwrites a
    // newer one.
    await updateIngestState(pool, {
      watermark: {
        turnId: newerId,
        endAt: new Date("2026-06-02T10:00:00Z"),
      },
    });
    await updateIngestState(pool, {
      watermark: {
        turnId: olderId,
        endAt: new Date("2026-06-01T10:00:00Z"),
      },
    });
    state = await getIngestState(pool);
    assert.equal(state.watermarkTurnId, newerId);
    assert.equal(state.watermarkEndAt.toISOString(), "2026-06-02T10:00:00.000Z");
  });

  it("a failure between a fact and its source links rolls the whole batch back, and a retry inserts everything", async () => {
    await enableIngest(pool);
    const turnA = await seedTurn(store, "I love morning tea with honey");
    const turnB = await seedTurn(store, "I walk every evening after dinner");

    const messages = await pool.query(
      `SELECT id, turn_id FROM conversation_message
       WHERE turn_id = ANY($1::uuid[]) ORDER BY created_at`,
      [[turnA, turnB]],
    );
    const messagesByTurn = new Map();
    for (const message of messages.rows) {
      if (!messagesByTurn.has(message.turn_id)) messagesByTurn.set(message.turn_id, []);
      messagesByTurn.get(message.turn_id).push(message.id);
    }

    const observedAt = new Date("2026-06-02T09:00:00Z");
    const facts = [turnA, turnB].map((turnId, index) => {
      const shape = index === 0
        ? { kind: "preference", claim: "Likes morning tea", topics: ["tea"] }
        : { kind: "preference", claim: "Walks every evening", topics: ["exercise"] };
      return {
        id: `test-fact-${index}`,
        factKey: factKeyOf({
          turnKey: turnId,
          subject: "user",
          kind: shape.kind,
          claim: shape.claim,
          topics: shape.topics,
          explicitness: "explicit",
        }),
        turnId,
        turnKey: turnId,
        subject: "user",
        kind: shape.kind,
        claim: shape.claim,
        condition: null,
        consequence: null,
        topics: shape.topics,
        observedAt,
        explicitness: "explicit",
        evidenceBasis: "direct_statement",
        extractionVersion: "test-extraction-version",
        ingestVersion: "test-ingest-version",
      };
    });
    const sourceMessageIdsByTurn = new Map(
      facts.map((fact) => [fact.turnKey, messagesByTurn.get(fact.turnId) ?? []]),
    );

    // Fail the SECOND fact's source-link insert: the whole batch (both facts
    // and the first fact's already-written links) must roll back.
    const wrapped = injectingPool(pool, [
      throwOnNth(
        (sql) => sql.includes("INSERT INTO memory_fact_source_message"),
        2,
        "injected source-link failure",
      ),
    ]);
    await assert.rejects(
      () => upsertProductionFacts(wrapped, facts, sourceMessageIdsByTurn),
      /injected source-link failure/,
    );
    const afterFailure = await pool.query(`SELECT count(*)::int AS n FROM memory_fact`);
    assert.equal(afterFailure.rows[0].n, 0);
    const linksAfterFailure = await pool.query(
      `SELECT count(*)::int AS n FROM memory_fact_source_message`,
    );
    assert.equal(linksAfterFailure.rows[0].n, 0);

    // Retry on the real pool heals: all facts and their links land.
    const inserted = await upsertProductionFacts(pool, facts, sourceMessageIdsByTurn);
    assert.equal(inserted, 2);
    const links = await pool.query(
      `SELECT fact_id, count(*)::int AS n FROM memory_fact_source_message
       GROUP BY fact_id`,
    );
    assert.equal(links.rows.length, 2);
    for (const row of links.rows) assert.ok(row.n >= 1);
  });

  it("a failure between an extraction cache entry and its items leaves no parentless entry, and a retry completes the ingest", async () => {
    await enableIngest(pool);
    const storeLocal = createConversationStore(pool);
    await seedTurn(storeLocal, "I love morning tea with honey");
    await seedTurn(storeLocal, "I walk every evening after dinner");

    const wrapped = injectingPool(pool, [
      throwOnNth(
        (sql) => sql.includes("INSERT INTO memory_turn_extraction_item"),
        2,
        "injected extraction-item failure",
      ),
    ]);
    await assert.rejects(
      async () => ingestTurns(await ingestDeps(wrapped, makeTwoClaimLlm()), "reconciliation"),
      /injected extraction-item failure/,
    );

    // No cache entry may exist without its full item set.
    const orphans = await pool.query(
      `SELECT e.id, e.item_count, count(i.*)::int AS stored
       FROM memory_turn_extraction e
       LEFT JOIN memory_turn_extraction_item i ON i.extraction_id = e.id
       GROUP BY e.id, e.item_count
       HAVING count(i.*) <> e.item_count`,
    );
    assert.equal(orphans.rows.length, 0);

    // The watermark has not advanced, so a retry re-runs the ingest and
    // every entry ends up complete.
    const summary = await ingestTurns(
      await ingestDeps(pool, makeTwoClaimLlm()),
      "reconciliation",
    );
    assert.equal(summary.factsInserted, 2);
    const entries = await pool.query(
      `SELECT e.id, e.item_count, count(i.*)::int AS stored
       FROM memory_turn_extraction e
       LEFT JOIN memory_turn_extraction_item i ON i.extraction_id = e.id
       GROUP BY e.id, e.item_count`,
    );
    assert.equal(entries.rows.length, 2);
    for (const row of entries.rows) assert.equal(row.stored, row.item_count);
  });

  it("a failure during a temporal summary re-save leaves the previous summary and its links intact", async () => {
    const period = {
      kind: "day",
      periodKey: "2026-06-02",
      startAt: new Date("2026-06-02T04:00:00Z"),
      endAt: new Date("2026-06-03T03:59:59Z"),
    };
    // A real message id for the link row (foreign key).
    const storeLocal = createConversationStore(pool);
    const turnId = await seedTurn(storeLocal, "I love morning tea with honey");
    const messageId = (await pool.query(
      `SELECT id FROM conversation_message WHERE turn_id = $1 AND role = 'user'`,
      [turnId],
    )).rows[0].id;

    const first = {
      period,
      timezone: BEHAVIOR.timezone,
      content: "First summary content.",
      messageCount: 1,
      fingerprint: "fingerprint-1",
      selectionVersion: "selection-v1",
      selectedPairIds: ["pair-1"],
      segmentPairCounts: [1],
      withTurnLog: 0,
      childSummaryKeys: [],
      model: "fake-memory-model",
      promptVersion: "temporal-v6",
      promptContentHash: "seeded-prompt-hash",
      generatedAt: new Date("2026-06-03T04:00:00Z"),
      inputTokens: 10,
      outputTokens: 10,
      callCount: 1,
      status: "complete",
      messageIds: [messageId],
    };
    await saveTemporalSummary(pool, first);
    const stored = await getTemporalSummary(pool, period);
    assert.equal(stored.content, "First summary content.");
    const linksBefore = await pool.query(
      `SELECT count(*)::int AS n FROM memory_temporal_summary_message
       WHERE summary_id = $1`,
      [stored.id],
    );
    assert.equal(linksBefore.rows[0].n, 1);

    // A re-save whose links phase fails must leave the stored summary and
    // its links exactly as they were.
    const wrapped = injectingPool(pool, [
      throwOnNth(
        (sql) => sql.includes("DELETE FROM memory_temporal_summary_message"),
        1,
        "injected temporal-links failure",
      ),
    ]);
    await assert.rejects(
      () => saveTemporalSummary(wrapped, {
        ...first,
        content: "Second summary content.",
        fingerprint: "fingerprint-2",
      }),
      /injected temporal-links failure/,
    );
    const afterFailure = await getTemporalSummary(pool, period);
    assert.equal(afterFailure.content, "First summary content.");
    assert.equal(afterFailure.fingerprint, "fingerprint-1");
    const linksAfter = await pool.query(
      `SELECT count(*)::int AS n FROM memory_temporal_summary_message
       WHERE summary_id = $1`,
      [afterFailure.id],
    );
    assert.equal(linksAfter.rows[0].n, 1);

    // Retry without the injection saves the new content and links.
    await saveTemporalSummary(pool, {
      ...first,
      content: "Second summary content.",
      fingerprint: "fingerprint-2",
    });
    const afterRetry = await getTemporalSummary(pool, period);
    assert.equal(afterRetry.content, "Second summary content.");
  });

  it("a failure between a profile upsert and its claims insert leaves the previous profile intact", async () => {
    await enableIngest(pool);
    const storeLocal = createConversationStore(pool);
    const turnId = await seedTurn(storeLocal, "I love morning tea with honey");

    let profileCalls = 0;
    const fakeLlm = async () => {
      profileCalls += 1;
      return {
        text: JSON.stringify({
          content: `Generated profile v${String(profileCalls)}.`,
          claims: [],
        }),
        model: "fake-memory-model",
        finishReason: "stop",
        inputTokens: 10,
        outputTokens: 10,
        attemptCount: 1,
        structuredOutputFallback: false,
      };
    };

    // Seed one active canonical observation for the profile to cite.
    const observedAt = new Date("2026-06-02T09:00:00Z");
    const fact = await pool.query(
      `INSERT INTO memory_fact
         (fact_key, turn_id, subject_id, kind, claim, topics, observed_at,
          explicitness, evidence_basis, extraction_version, ingest_version)
       VALUES ($1, $2, 'user', 'preference', 'Likes morning tea',
               ARRAY['tea']::text[], $3, 'explicit', 'direct_statement',
               'v', 'v')
       RETURNING fact_key`,
      [
        factKeyOf({
          turnKey: turnId,
          subject: "user",
          kind: "preference",
          claim: "Likes morning tea",
          topics: ["tea"],
          explicitness: "explicit",
        }),
        turnId,
        observedAt,
      ],
    );
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
         'canon-profile-test', 'user|preference|likes-morning-tea-profile-test',
         1, 'obs-key-profile-test', 'user', 'preference', 'Likes morning tea',
         1, 1, 1, 0, $1, $1, ARRAY[$2::text], 'supported', 'active',
         'test-consolidation-version', 'test-content-hash', 1,
         'test-promotion-id', 1, 'test-artifact-id', 'test-run-id',
         'test-observation-set-id', 'test-fact-set-id',
         $1, $1, $1, $1
       )`,
      [observedAt, fact.rows[0].fact_key],
    );

    const deps = (targetPool) => ({
      pool: targetPool,
      config: memoryConfig(),
      systemPrompt: "Write a subject profile from observations. Test system prompt.",
      callLlm: fakeLlm,
    });

    const first = await generateProfileIfNeeded(deps(pool), "user");
    assert.equal(first.regenerated, true);
    const storedBefore = await getProfileDocument(pool, "user");
    assert.match(storedBefore.content, /Generated profile v1\./);

    // Move the fingerprinted state (revision + content hash) so a
    // regeneration is due, then fail the claims insert mid-save.
    await pool.query(
      `UPDATE memory_canonical_observation
       SET claim = 'Loves morning tea strongly', revision = revision + 1,
           content_hash = 'test-content-hash-2'
       WHERE canonical_observation_id = 'canon-profile-test'`,
    );
    const wrapped = injectingPool(pool, [
      throwOnNth(
        (sql) => sql.includes("INSERT INTO memory_observation_profile_claim"),
        1,
        "injected profile-claims failure",
      ),
    ]);
    await assert.rejects(
      async () => generateProfileIfNeeded(deps(wrapped), "user"),
      /injected profile-claims failure/,
    );
    // The moved observation set makes the previous profile's source rows
    // stale, so the serve gate suppresses the OLD document — and the failed
    // re-save must not have left any half-written replacement to serve.
    const storedAfterFailure = await getProfileDocument(pool, "user");
    assert.equal(storedAfterFailure, null,
      "a stale previous profile is suppressed, and a failed re-save serves nothing partial");

    // Retry without the injection completes the regeneration.
    const second = await generateProfileIfNeeded(deps(pool), "user");
    assert.equal(second.regenerated, true);
    const storedAfter = await getProfileDocument(pool, "user");
    assert.match(storedAfter.content, /Generated profile v3\./,
      "the retry regenerates from the moved observation set and serves again");
  });

  it("re-consolidating the same window keeps every run's artifacts and evidence (per-run immutable artifacts)", async () => {
    const { run: run1 } = await seedTwoClaimRun(pool);
    assert.equal(run1.observations, 2);
    // A second run over the same turns re-derives the same logical
    // observation set under a new run id.
    const run2 = await runScheduledConsolidation({
      pool,
      config: memoryConfig(),
      subjects: ["user", "assistant"],
      systemPrompt: OBSERVATION_SYSTEM_PROMPT,
      factExtractionPromptContentHash: FACT_PROMPT_CONTENT_HASH,
      callLlm: makeTwoClaimLlm(),
      behavior: BEHAVIOR,
    });
    assert.equal(run2.observations, 2);
    assert.notEqual(run1.runId, run2.runId);

    const perRun = await pool.query(
      `SELECT run_id, count(*)::int AS n FROM memory_observation
       WHERE run_id = ANY($1::text[])
       GROUP BY run_id`,
      [[run1.runId, run2.runId]],
    );
    assert.equal(perRun.rows.length, 2, "both runs keep their own artifacts");
    for (const row of perRun.rows) assert.equal(row.n, 2);

    // Evidence survived for both runs (the old destructive delete is gone).
    const evidence = await pool.query(
      `SELECT o.run_id, count(e.fact_id)::int AS links
       FROM memory_observation o
       LEFT JOIN memory_observation_evidence e ON e.observation_id = o.id
       WHERE o.run_id = ANY($1::text[])
       GROUP BY o.run_id`,
      [[run1.runId, run2.runId]],
    );
    assert.equal(evidence.rows.length, 2);
    for (const row of evidence.rows) assert.ok(row.links >= 2);
  });

  it("the runtime reconciles a run whose promotion crashed mid-apply on startup", async () => {
    const { run } = await seedTwoClaimRun(pool);
    const plan = await buildPromotionPlan(pool, {
      runId: run.runId,
      skipTentative: true,
      behavior: BEHAVIOR,
    });
    // Simulate the crash: the manifest reaches 'applying' with nothing applied.
    const wrapped = injectingPool(pool, [
      throwOnNth(
        (sql) => sql.includes("INSERT INTO memory_observation_history"),
        1,
        "injected crash before any apply",
      ),
    ]);
    await assert.rejects(
      () => promoteRun(wrapped, {
        runId: run.runId,
        confirmationToken: plan.confirmationToken,
        skipTentative: true,
        behavior: BEHAVIOR,
      }),
      /injected crash before any apply/,
    );

    const runtime = startMemoryRuntime({
      pool,
      config: memoryConfig({
        WORKER_MEMORY_CONSOLIDATION_NEW_FACTS_THRESHOLD: "999",
      }),
      configuration: runtimeConfiguration(),
      callLlm: makeTwoClaimLlm(),
      log: () => {},
    });

    // The startup ingest pass reconciles pending promotions before any gate.
    const deadline = Date.now() + 10_000;
    let status = null;
    while (Date.now() < deadline) {
      const current = await pool.query(
        `SELECT status FROM memory_promotion WHERE promotion_id = $1`,
        [plan.promotionId],
      );
      status = current.rows[0]?.status ?? null;
      if (status === "completed") break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await runtime.close();
    assert.equal(status, "completed", "the runtime must reconcile the pending promotion");

    const canonicalAfter = await pool.query(
      `SELECT count(*)::int AS n FROM memory_canonical_observation
       WHERE promotion_id = $1 AND status = 'active'`,
      [plan.promotionId],
    );
    assert.equal(canonicalAfter.rows[0].n, 2);
  });

  it("the zero-fact guard skips interval-triggered consolidations when no new facts arrived", async () => {
    await enableIngest(pool);
    const storeLocal = createConversationStore(pool);
    await seedTurn(storeLocal, "I love morning tea with honey");
    await seedTurn(storeLocal, "I take my tea with honey every morning");
    const callLlm = makeTwoClaimLlm();
    await ingestTurns(await ingestDeps(pool, callLlm), "reconciliation");
    await runScheduledConsolidation({
      pool,
      config: memoryConfig(),
      subjects: ["user", "assistant"],
      systemPrompt: OBSERVATION_SYSTEM_PROMPT,
      factExtractionPromptContentHash: FACT_PROMPT_CONTENT_HASH,
      callLlm,
      behavior: BEHAVIOR,
    });
    const runsBefore = await pool.query(`SELECT count(*)::int AS n FROM memory_run`);
    const counter = await getIngestState(pool);
    assert.equal(counter.newFactsSinceConsolidation, 0);

    const runtime = startMemoryRuntime({
      pool,
      config: memoryConfig({
        WORKER_MEMORY_CONSOLIDATION_INTERVAL_MS: "1",
        WORKER_MEMORY_INGEST_RECONCILIATION_MS: "120",
        WORKER_MEMORY_TEMPORAL_RECONCILIATION_MS: "600000",
      }),
      configuration: runtimeConfiguration(),
      callLlm: makeTwoClaimLlm(),
      log: () => {},
    });
    // Several reconciliation passes fire while the interval gate is met and
    // the counter is zero: the guard must keep skipping the run.
    await new Promise((resolve) => setTimeout(resolve, 800));
    await runtime.close();
    const runsAfter = await pool.query(`SELECT count(*)::int AS n FROM memory_run`);
    assert.equal(runsAfter.rows[0].n, runsBefore.rows[0].n,
      "no new consolidation run may be created without new facts");
  });

  // -------------------------------------------------------------------------
  // Round 3: atomic ingest accounting, plan exclusion + reconcile fairness,
  // atomic retraction, applied-then-retracted resume, profile source
  // dependencies, omission evidence, temporal provenance read-back, exact
  // prompt pair selection, and the v1 evidence-rule fingerprint.
  // -------------------------------------------------------------------------

  it("a crash between fact writes and ingest accounting rolls back the whole batch, and the replay counts correctly", async () => {
    await enableIngest(pool);
    const storeLocal = createConversationStore(pool);
    await seedTurn(storeLocal, "I love morning tea with honey");
    await seedTurn(storeLocal, "I take my tea with honey every morning");

    // Fail the in-transaction accounting UPDATE (the statement that carries
    // the addFacts increment): the whole ingest transaction must roll back —
    // facts, source links, watermark, and counter together.
    const wrapped = injectingPool(pool, [
      throwOnNth(
        (sql) =>
          sql.includes("UPDATE memory_ingest_state") &&
          sql.includes(
            "new_facts_since_consolidation = memory_ingest_state.new_facts_since_consolidation +",
          ),
        1,
        "injected crash before ingest accounting",
      ),
    ]);
    await assert.rejects(
      async () => ingestTurns(await ingestDeps(wrapped, makeTwoClaimLlm()), "reconciliation"),
      /injected crash before ingest accounting/,
    );

    const facts = await pool.query(`SELECT count(*)::int AS n FROM memory_fact`);
    assert.equal(facts.rows[0].n, 0, "no fact may survive without its accounting");
    const state = await getIngestState(pool);
    assert.equal(state.watermarkTurnId, null, "the watermark must not have advanced");
    assert.equal(state.newFactsSinceConsolidation, 0);

    // Replay without the injection: facts land AND the counter counts them.
    const summary = await ingestTurns(
      await ingestDeps(pool, makeTwoClaimLlm()),
      "reconciliation",
    );
    assert.equal(summary.factsInserted, 2);
    const stateAfter = await getIngestState(pool);
    assert.equal(stateAfter.newFactsSinceConsolidation, 2,
      "the replay must credit exactly the facts it inserted");
    assert.ok(stateAfter.watermarkTurnId !== null);
  });

  it("an already-retracted canonical identity is excluded from planning and never blocks unrelated items", async () => {
    const { run: run1 } = await seedTwoClaimRun(pool);
    const plan1 = await buildPromotionPlan(pool, {
      runId: run1.runId,
      skipTentative: true,
      behavior: BEHAVIOR,
    });
    const first = await promoteRun(pool, {
      runId: run1.runId,
      confirmationToken: plan1.confirmationToken,
      skipTentative: true,
      behavior: BEHAVIOR,
    });
    assert.equal(first.status, "completed");

    // Retract ONE of the two canonical identities.
    const target = (
      await pool.query(
        `SELECT canonical_observation_id, canonical_identity_key
         FROM memory_canonical_observation
         WHERE subject_id = 'user' AND status = 'active'
         ORDER BY canonical_identity_key LIMIT 1`,
      )
    ).rows[0];
    await retractCanonicalObservation(pool, {
      canonicalObservationId: target.canonical_observation_id,
      reasonCodes: ["user_request"],
      operationKey: "test-retract-before-replan",
    });

    // Re-run the same window: the fresh run plans revisions of both identities.
    const run2 = await runScheduledConsolidation({
      pool,
      config: memoryConfig(),
      subjects: ["user", "assistant"],
      systemPrompt: OBSERVATION_SYSTEM_PROMPT,
      factExtractionPromptContentHash: FACT_PROMPT_CONTENT_HASH,
      callLlm: makeTwoClaimLlm(),
      behavior: BEHAVIOR,
    });
    assert.equal(run2.observations, 2);

    const plan2 = await buildPromotionPlan(pool, {
      runId: run2.runId,
      skipTentative: true,
      behavior: BEHAVIOR,
    });
    assert.equal(plan2.itemCount, 1,
      "the inactive identity must be excluded from the plan, not planned as a reactivation");
    assert.equal(plan2.summary.inactiveCanonicalSkipped, 1);
    assert.ok(!plan2.items.some(
      (item) => item.canonicalIdentityKey === target.canonical_identity_key,
    ));

    // The whole promotion succeeds with the unrelated item only.
    const second = await promoteRun(pool, {
      runId: run2.runId,
      confirmationToken: plan2.confirmationToken,
      skipTentative: true,
      behavior: BEHAVIOR,
    });
    assert.equal(second.status, "completed");
    // And the retraction was never restored.
    const after = await pool.query(
      `SELECT status FROM memory_canonical_observation
       WHERE canonical_observation_id = $1`,
      [target.canonical_observation_id],
    );
    assert.equal(after.rows[0].status, "retracted");
  });

  it("promotion reconcile selection backs off recently failed runs so older runs are not starved", async () => {
    const { run } = await seedTwoClaimRun(pool);
    // An older pending run fabricated behind the real one.
    await pool.query(
      `INSERT INTO memory_run
         (run_id, status, facts_status, observations_status, max_turns,
          source_fingerprint, fact_set_id, observation_set_id,
          fact_generation_signature, observation_generation_signature,
          created_at, completed_at)
       VALUES ('run-older', 'observations-ready', 'complete', 'complete', 10,
               'fp', 'fs', 'os', 'fg', 'og',
               now() - interval '2 hours', now() - interval '1 hour')`,
    );
    // The newest run's latest promotion attempt failed just now.
    await pool.query(
      `INSERT INTO memory_operation (kind, run_id, outcome, detail, started_at, finished_at)
       VALUES ('promotion', $1, 'failed', 'error=llm_timeout', now(), now())`,
      [run.runId],
    );

    // Within the backoff window: the failing newest run steps aside and the
    // older run is selected first.
    const pending = await selectPendingPromotionRunIds(
      pool,
      PROMOTION_RECONCILE_BACKOFF_MS,
      10,
    );
    assert.deepEqual(pending, ["run-older"]);

    // Without the backoff the failing run would occupy the batch (oldest-first).
    const noBackoff = await selectPendingPromotionRunIds(pool, 0, 10);
    assert.deepEqual(noBackoff, ["run-older", run.runId]);

    // After the window passes, the failing run re-enters candidacy.
    await pool.query(
      `UPDATE memory_operation SET finished_at = now() - interval '10 minutes'
       WHERE kind = 'promotion' AND run_id = $1`,
      [run.runId],
    );
    const later = await selectPendingPromotionRunIds(
      pool,
      PROMOTION_RECONCILE_BACKOFF_MS,
      10,
    );
    assert.deepEqual(later, ["run-older", run.runId]);
  });

  it("a retraction crash leaves no orphan history event, and the replay is an idempotent no-op", async () => {
    const { run } = await seedTwoClaimRun(pool);
    const plan = await buildPromotionPlan(pool, {
      runId: run.runId,
      skipTentative: true,
      behavior: BEHAVIOR,
    });
    await promoteRun(pool, {
      runId: run.runId,
      confirmationToken: plan.confirmationToken,
      skipTentative: true,
      behavior: BEHAVIOR,
    });
    const target = (
      await pool.query(
        `SELECT canonical_observation_id FROM memory_canonical_observation
         WHERE subject_id = 'user' AND status = 'active'
         ORDER BY canonical_identity_key LIMIT 1`,
      )
    ).rows[0];

    // Crash inside the retraction transaction, at the history insert.
    const wrapped = injectingPool(pool, [
      throwOnNth(
        (sql) => sql.includes("INSERT INTO memory_observation_history"),
        1,
        "injected crash inside the retraction transaction",
      ),
    ]);
    await assert.rejects(
      () => retractCanonicalObservation(wrapped, {
        canonicalObservationId: target.canonical_observation_id,
        reasonCodes: ["user_request"],
        operationKey: "op-crash",
      }),
      /injected crash inside the retraction transaction/,
    );
    // Full rollback: the row is still active and no history event leaked.
    const statusNow = await pool.query(
      `SELECT status FROM memory_canonical_observation
       WHERE canonical_observation_id = $1`,
      [target.canonical_observation_id],
    );
    assert.equal(statusNow.rows[0].status, "active");
    const events = await pool.query(
      `SELECT count(*)::int AS n FROM memory_observation_history
       WHERE operation_key = 'op-crash'`,
    );
    assert.equal(events.rows[0].n, 0, "no orphan history event may survive the crash");

    // Retry completes; a same-key replay is a no-op with no second event.
    const result = await retractCanonicalObservation(pool, {
      canonicalObservationId: target.canonical_observation_id,
      reasonCodes: ["user_request"],
      operationKey: "op-crash",
    });
    assert.equal(result.status, "completed");
    const replay = await retractCanonicalObservation(pool, {
      canonicalObservationId: target.canonical_observation_id,
      reasonCodes: ["user_request"],
      operationKey: "op-crash",
    });
    assert.equal(replay.status, "no-op");
    const eventsAfter = await pool.query(
      `SELECT count(*)::int AS n FROM memory_observation_history
       WHERE operation_key = 'op-crash'`,
    );
    assert.equal(eventsAfter.rows[0].n, 1);
  });

  it("competing retractions serialize: one completes, the other is rejected, exactly one event", async () => {
    const { run } = await seedTwoClaimRun(pool);
    const plan = await buildPromotionPlan(pool, {
      runId: run.runId,
      skipTentative: true,
      behavior: BEHAVIOR,
    });
    await promoteRun(pool, {
      runId: run.runId,
      confirmationToken: plan.confirmationToken,
      skipTentative: true,
      behavior: BEHAVIOR,
    });
    const target = (
      await pool.query(
        `SELECT canonical_observation_id FROM memory_canonical_observation
         WHERE subject_id = 'user' AND status = 'active'
         ORDER BY canonical_identity_key LIMIT 1`,
      )
    ).rows[0];

    const attempts = await Promise.allSettled([
      retractCanonicalObservation(pool, {
        canonicalObservationId: target.canonical_observation_id,
        reasonCodes: ["user_request"],
        operationKey: "op-racer-a",
      }),
      retractCanonicalObservation(pool, {
        canonicalObservationId: target.canonical_observation_id,
        reasonCodes: ["user_request"],
        operationKey: "op-racer-b",
      }),
    ]);
    const fulfilled = attempts.filter((attempt) => attempt.status === "fulfilled");
    const rejected = attempts.filter((attempt) => attempt.status === "rejected");
    assert.equal(fulfilled.length, 1, "exactly one retraction may win");
    assert.equal(rejected.length, 1, "the loser must be rejected, not silently applied");
    assert.match(rejected[0].reason.message, /manual retraction|not active/);
    const events = await pool.query(
      `SELECT count(*)::int AS n FROM memory_observation_history
       WHERE operation_key IN ('op-racer-a', 'op-racer-b')
         AND action IN ('manual_retracted', 'policy_retracted')`,
    );
    assert.equal(events.rows[0].n, 1);
  });

  it("an interrupted promotion resumes with an applied-then-retracted item settled as applied and never restores the retraction", async () => {
    const { run } = await seedTwoClaimRun(pool);
    const plan = await buildPromotionPlan(pool, {
      runId: run.runId,
      skipTentative: true,
      behavior: BEHAVIOR,
    });
    // Crash on the SECOND item's apply (the first item commits fully).
    const wrapped = injectingPool(pool, [
      throwOnNth(
        (sql) => sql.includes("INSERT INTO memory_observation_history"),
        2,
        "injected crash after the first item applied",
      ),
    ]);
    await assert.rejects(
      () => promoteRun(wrapped, {
        runId: run.runId,
        confirmationToken: plan.confirmationToken,
        skipTentative: true,
        behavior: BEHAVIOR,
      }),
      /injected crash after the first item applied/,
    );
    const manifest = await pool.query(
      `SELECT status FROM memory_promotion WHERE promotion_id = $1`,
      [plan.promotionId],
    );
    assert.equal(manifest.rows[0].status, "applying");
    // Exactly one canonical document exists for this promotion: item 1.
    const applied = (
      await pool.query(
        `SELECT canonical_observation_id, promotion_sequence
         FROM memory_canonical_observation WHERE promotion_id = $1`,
        [plan.promotionId],
      )
    ).rows[0];
    assert.ok(applied !== undefined, "item 1 must be durably applied before the crash");

    // Retract the applied item, THEN resume the promotion.
    await retractCanonicalObservation(pool, {
      canonicalObservationId: applied.canonical_observation_id,
      reasonCodes: ["user_request"],
      operationKey: "op-resume-retract",
    });

    const resumed = await promoteRun(pool, {
      runId: run.runId,
      confirmationToken: plan.confirmationToken,
      skipTentative: true,
      behavior: BEHAVIOR,
    });
    assert.equal(resumed.status, "completed",
      "the resume must complete from the staged items despite the retraction");
    assert.equal(resumed.skippedInactive, 0,
      "the applied item must settle as applied, not mislabeled as skipped");
    assert.equal(resumed.historyEvents, 2,
      "one history event per item: item 1's from the first attempt, item 2's from the resume");

    // The retraction was NOT restored by the resume.
    const afterResume = await pool.query(
      `SELECT status FROM memory_canonical_observation
       WHERE canonical_observation_id = $1`,
      [applied.canonical_observation_id],
    );
    assert.equal(afterResume.rows[0].status, "retracted");

    // Item 2 applied normally.
    const item2 = await pool.query(
      `SELECT count(*)::int AS n FROM memory_canonical_observation
       WHERE promotion_id = $1 AND status = 'active'`,
      [plan.promotionId],
    );
    assert.equal(item2.rows[0].n, 1);
    const outcomes = await pool.query(
      `SELECT canonical_identity_key, outcome FROM memory_promotion_item
       WHERE promotion_id = $1 ORDER BY canonical_identity_key`,
      [plan.promotionId],
    );
    for (const row of outcomes.rows) {
      assert.equal(row.outcome, "applied");
    }
  });

  it("a profile is suppressed when an unclaimed generation source is retracted or revised", async () => {
    const { run } = await seedTwoClaimRun(pool);
    const plan = await buildPromotionPlan(pool, {
      runId: run.runId,
      skipTentative: true,
      behavior: BEHAVIOR,
    });
    await promoteRun(pool, {
      runId: run.runId,
      confirmationToken: plan.confirmationToken,
      skipTentative: true,
      behavior: BEHAVIOR,
    });

    const observations = await loadProfileObservations(pool, "user");
    assert.ok(observations.length >= 2, "the test needs at least two sources");
    // The fake model CLAIMS only the first source (a partial claim list).
    const calls = { n: 0 };
    const callLlm = async () => {
      calls.n += 1;
      return {
        text: JSON.stringify({
          content: "Profile prose about the claimed source.",
          claims: [{
            observationId: observations[0].observationId,
            text: "Claimed source",
          }],
        }),
        model: "fake-profile-model",
        finishReason: "stop",
        inputTokens: 10,
        outputTokens: 10,
        attemptCount: 1,
        structuredOutputFallback: false,
      };
    };
    const deps = {
      pool,
      config: memoryConfig(),
      systemPrompt: "Write a subject profile from observations. Test system prompt.",
      callLlm,
    };
    const generated = await generateProfileIfNeeded(deps, "user");
    assert.equal(generated.regenerated, true);
    const served = await getProfileDocument(pool, "user");
    assert.ok(served !== null, "the profile serves while every source is intact");

    // The FULL input set was persisted, not just the claimed subset.
    const sources = await pool.query(
      `SELECT observation_id FROM memory_observation_profile_source
       WHERE subject_id = 'user' ORDER BY position`,
    );
    assert.equal(sources.rows.length, observations.length);

    // Retract the UNCLAIMED source: the serve gate must suppress the document
    // even though the model's claim list does not mention it.
    const unclaimed = observations.find(
      (observation) => observation.observationId !== observations[0].observationId,
    );
    await retractCanonicalObservation(pool, {
      canonicalObservationId: unclaimed.observationId,
      reasonCodes: ["user_request"],
      operationKey: "op-unclaimed-source",
    });
    assert.equal(await getProfileDocument(pool, "user"), null,
      "a retracted unclaimed source must suppress the profile");

    // Regeneration from the smaller active set serves again.
    const regenerated = await generateProfileIfNeeded(deps, "user");
    assert.equal(regenerated.regenerated, true);
    const servedAgain = await getProfileDocument(pool, "user");
    assert.ok(servedAgain !== null);

    // A content revision of a source (same id, changed hash) also suppresses.
    await pool.query(
      `UPDATE memory_canonical_observation
       SET content_hash = 'revised-hash', revision = revision + 1
       WHERE canonical_observation_id = $1`,
      [observations[0].observationId],
    );
    assert.equal(await getProfileDocument(pool, "user"), null,
      "a revised source must suppress the profile until regeneration");
  });

  it("omissions carry their supporting and contradicting fact evidence", async () => {
    await enableIngest(pool);
    const storeLocal = createConversationStore(pool);
    await seedTurn(storeLocal, "I love morning tea with honey");
    await seedTurn(storeLocal, "I take my tea with honey every morning");
    const callLlm = async (input) => {
      const respond = (text) => ({
        text,
        model: "fake-memory-model",
        finishReason: "stop",
        inputTokens: 10,
        outputTokens: 10,
        attemptCount: 1,
        structuredOutputFallback: false,
      });
      if (/^EXTRACTED FACTS$/m.test(input.userMessage)) {
        // Two facts, same claim, different turns — but the consolidation step
        // below references only the FIRST, so the candidate is omitted.
        const ids = [...input.userMessage.matchAll(/FACT ID: (\S+)/g)].map(
          (match) => match[1],
        );
        assert.ok(ids.length >= 2);
        return respond(JSON.stringify({
          observations: [{
            subject: "user",
            kind: "preference",
            claim: "Likes morning tea",
            topics: ["tea"],
            condition: "",
            consequence: "",
            sourceFactIds: [ids[0]],
            contradictionFactIds: [],
          }],
        }));
      }
      if (input.userMessage.includes("SOURCE TURN ID:")) {
        const blocks = [...input.userMessage.matchAll(
          /SOURCE TURN ID: (\S+)[\s\S]*?OWNER: (.*)\n/g,
        )];
        const sources = blocks.map(([, turnId]) => ({
          sourceTurnId: turnId,
          facts: [{
            subject: "user",
            kind: "preference",
            claim: "Likes morning tea",
            topics: ["tea"],
            condition: "",
            consequence: "",
            explicitness: "explicit",
            // Not a direct statement: a one-turn preference without direct
            // statement evidence is policy-omitted (the point of this test).
            evidenceBasis: "inferred",
          }],
        }));
        return respond(JSON.stringify({ sources }));
      }
      throw new Error(`fake LLM has no route for message: ${input.userMessage.slice(0, 80)}`);
    };
    await ingestTurns(await ingestDeps(pool, callLlm), "reconciliation");
    const run = await runScheduledConsolidation({
      pool,
      config: memoryConfig(),
      subjects: ["user", "assistant"],
      systemPrompt: OBSERVATION_SYSTEM_PROMPT,
      factExtractionPromptContentHash: FACT_PROMPT_CONTENT_HASH,
      callLlm,
      behavior: BEHAVIOR,
    });

    const omissions = await pool.query(
      `SELECT omission_id, reason FROM memory_observation_omission WHERE run_id = $1`,
      [run.runId],
    );
    assert.equal(omissions.rows.length, 1, "the single-turn candidate is omitted");
    const evidence = await pool.query(
      `SELECT e.role, e.position, f.fact_key
       FROM memory_observation_omission_evidence e
       JOIN memory_observation_omission o ON o.id = e.omission_id
       JOIN memory_fact f ON f.id = e.fact_id
       WHERE o.run_id = $1
       ORDER BY e.role, e.position`,
      [run.runId],
    );
    assert.equal(evidence.rows.length, 1,
      "the omission must carry the fact evidence the candidate cited");
    assert.equal(evidence.rows[0].role, "support");
  });

  it("a cached temporal summary keeps its source-message and selection provenance", async () => {
    const turnId = await seedTurn(store, "hello there for the summary");
    const message = (
      await pool.query(
        `SELECT id FROM conversation_message WHERE turn_id = $1 ORDER BY id LIMIT 1`,
        [turnId],
      )
    ).rows[0];
    const startAt = new Date("2026-01-01T05:00:00.000Z");
    const endAt = new Date("2026-01-02T05:00:00.000Z");
    await saveTemporalSummary(pool, {
      period: { kind: "day", periodKey: "2026-01-01", startAt, endAt },
      timezone: BEHAVIOR.timezone,
      content: "Day summary content.",
      messageCount: 1,
      fingerprint: "day-fingerprint",
      selectionVersion: "selection-v1",
      selectedPairIds: ["pair-1", "pair-2"],
      segmentPairCounts: [2, 3],
      withTurnLog: null,
      childSummaryKeys: [],
      model: "fake-memory-model",
      promptVersion: "temporal-v6",
      promptContentHash: "seeded-prompt-hash",
      generatedAt: new Date(),
      inputTokens: 10,
      outputTokens: 10,
      callCount: 1,
      messageIds: [message.id],
      status: "complete",
    });

    const stored = await getTemporalSummary(pool, {
      kind: "day",
      periodKey: "2026-01-01",
      startAt,
      endAt,
    });
    assert.ok(stored !== null);
    assert.deepEqual([...(stored.messageIds ?? [])], [message.id],
      "source-message provenance must be read back from the links table");
    assert.deepEqual([...(stored.selectedPairIds ?? [])], ["pair-1", "pair-2"]);
    assert.deepEqual([...(stored.segmentPairCounts ?? [])], [2, 3]);
  });

  it("prompt selection matches exact (kind, version) pairs and ignores decoy rows", async () => {
    // A decoy row whose (kind, version) combination matches the old
    // cross-product predicate but is not a required pair.
    await pool.query(
      `INSERT INTO memory_prompt (kind, version, system_prompt)
       VALUES ('fact_extraction', 'temporal-v6', 'DECOY prompt content.')
       ON CONFLICT (kind, version) DO NOTHING`,
    );
    const configuration = await loadMemoryConfiguration(pool, PROMPT_VERSIONS);
    assert.equal(
      configuration.prompts["fact_extraction"].version,
      PROMPT_VERSIONS.fact_extraction,
      "the required version must win, never the decoy",
    );
    assert.equal(
      configuration.prompts["fact_extraction"].systemPrompt,
      "Extract durable facts from the supplied turns. Test system prompt.",
    );
  });

  it("changing a subject's evidence rule regenerates the v1 profile sheet", async () => {
    const startAt = new Date("2026-01-01T05:00:00.000Z");
    const endAt = new Date("2026-01-02T05:00:00.000Z");
    await saveTemporalSummary(pool, {
      period: { kind: "day", periodKey: "2026-01-01", startAt, endAt },
      timezone: BEHAVIOR.timezone,
      content: "A day of tea and walks.",
      messageCount: 2,
      fingerprint: "day-fp-1",
      selectionVersion: null,
      selectedPairIds: [],
      segmentPairCounts: [],
      withTurnLog: null,
      childSummaryKeys: [],
      model: "fake-memory-model",
      promptVersion: "temporal-v6",
      promptContentHash: "seeded-prompt-hash",
      generatedAt: new Date(),
      inputTokens: 10,
      outputTokens: 10,
      callCount: 1,
      messageIds: [],
      status: "complete",
    });
    const configuration = runtimeConfiguration();
    let calls = 0;
    const callLlm = async () => {
      calls += 1;
      return {
        text: JSON.stringify({ profile: "Sheet prose.", claims: [] }),
        model: "fake-memory-model",
        finishReason: "stop",
        inputTokens: 10,
        outputTokens: 10,
        attemptCount: 1,
        structuredOutputFallback: false,
      };
    };
    const deps = {
      pool,
      config: memoryConfig(),
      subjects: configuration.subjects,
      systemPrompt: configuration.prompts["profile_summary"].systemPrompt,
      callLlm,
    };
    const first = await generateProfileSummary(deps, "user");
    assert.ok(first !== null);
    assert.equal(calls, 1);
    // Unchanged inputs: cached, zero further LLM calls.
    const cached = await generateProfileSummary(deps, "user");
    assert.equal(calls, 1, "an unchanged fingerprint must not call the LLM");
    assert.equal(cached.content, first.content);

    // The evidence rule is part of the actual prompt: changing it must
    // invalidate the fingerprint and force regeneration.
    await pool.query(
      `UPDATE memory_subject SET profile_evidence_rule = 'changed evidence rule' WHERE id = 'user'`,
    );
    // The deps carry the rule from the provisioned row set in this test, so
    // reload the subject to mirror what the runtime would pass.
    const reloaded = await loadMemoryConfiguration(pool, PROMPT_VERSIONS);
    const regenerated = await generateProfileSummary({
      ...deps,
      subjects: reloaded.subjects,
    }, "user");
    assert.equal(calls, 2, "a changed evidence rule must force regeneration");
    assert.ok(regenerated !== null);
  });

  // -------------------------------------------------------------------------
  // Round 4 (reviewer defects): reconcile independence from extraction,
  // manifest-first recovery without replanning, fair retry selection, the
  // policy-review snapshot fence, and serve-time generation-settings checks.
  // -------------------------------------------------------------------------

  it("promotion manifest recovery runs even when every extraction attempt fails", async () => {
    const { run } = await seedTwoClaimRun(pool);
    const plan = await buildPromotionPlan(pool, {
      runId: run.runId,
      skipTentative: true,
      behavior: BEHAVIOR,
    });
    // Crash the first history insert: the manifest stays 'applying' with no
    // applied items.
    const wrapped = injectingPool(pool, [
      throwOnNth(
        (sql) => sql.includes("INSERT INTO memory_observation_history"),
        1,
        "injected crash before any apply",
      ),
    ]);
    await assert.rejects(
      () => promoteRun(wrapped, {
        runId: run.runId,
        confirmationToken: plan.confirmationToken,
        skipTentative: true,
        behavior: BEHAVIOR,
      }),
      /injected crash before any apply/,
    );

    // Every extraction attempt fails for this runtime's lifetime. A new
    // un-ingested turn gives the next ingest pass real work, so its
    // extraction genuinely calls the failing LLM and records a failed
    // fact_extraction — without pending work, ingest succeeds trivially and
    // this test would prove nothing.
    const failingStore = createConversationStore(pool);
    await seedTurn(failingStore, "A fresh turn so the next extraction pass has work to fail on");
    const failingLlm = async () => {
      throw new Error("extraction is down");
    };
    const runtime = startMemoryRuntime({
      pool,
      config: memoryConfig({
        WORKER_MEMORY_CONSOLIDATION_NEW_FACTS_THRESHOLD: "999",
      }),
      configuration: runtimeConfiguration(),
      callLlm: failingLlm,
      log: () => {},
    });
    const deadline = Date.now() + 10_000;
    let status = null;
    while (Date.now() < deadline) {
      const current = await pool.query(
        `SELECT status FROM memory_promotion WHERE promotion_id = $1`,
        [plan.promotionId],
      );
      status = current.rows[0]?.status ?? null;
      if (status === "completed") break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await runtime.close();
    // The test is only meaningful if extraction really failed.
    const failedExtractions = await pool.query(
      `SELECT count(*)::int AS n FROM memory_operation
       WHERE kind = 'fact_extraction' AND outcome = 'failed'`,
    );
    assert.ok(failedExtractions.rows[0].n >= 1,
      "the test requires at least one failed extraction pass");
    // ...and the manifest still completed: manifest recovery is independent
    // of extraction success.
    assert.equal(status, "completed",
      "manifest recovery must not be held hostage by extraction failures");
    const canonicalAfter = await pool.query(
      `SELECT count(*)::int AS n FROM memory_canonical_observation
       WHERE promotion_id = $1 AND status = 'active'`,
      [plan.promotionId],
    );
    assert.equal(canonicalAfter.rows[0].n, 2);
  });

  it("an applying manifest whose identities all became inactive recovers from its staged items instead of being replanned away", async () => {
    const { run } = await seedTwoClaimRun(pool);
    const plan = await buildPromotionPlan(pool, {
      runId: run.runId,
      skipTentative: true,
      behavior: BEHAVIOR,
    });
    // Crash before the manifest's completed flip: both items applied, the
    // manifest left 'applying'.
    const wrapped = injectingPool(pool, [
      throwOnNth(
        (sql) => sql.includes("UPDATE memory_promotion SET"),
        2,
        "injected crash before completion",
      ),
    ]);
    await assert.rejects(
      () => promoteRun(wrapped, {
        runId: run.runId,
        confirmationToken: plan.confirmationToken,
        skipTentative: true,
        behavior: BEHAVIOR,
      }),
      /injected crash before completion/,
    );
    const mid = await pool.query(
      `SELECT status FROM memory_promotion WHERE promotion_id = $1`,
      [plan.promotionId],
    );
    assert.equal(mid.rows[0].status, "applying");
    const applied = await pool.query(
      `SELECT canonical_observation_id FROM memory_canonical_observation
       WHERE promotion_id = $1`,
      [plan.promotionId],
    );
    assert.equal(applied.rows.length, 2);

    // Retract BOTH applied identities: a fresh plan would now be empty.
    for (const [index, row] of applied.rows.entries()) {
      await retractCanonicalObservation(pool, {
        canonicalObservationId: row.canonical_observation_id,
        reasonCodes: ["user_request"],
        operationKey: `op-drain-${String(index)}`,
      });
    }
    const wouldReplan = await buildPromotionPlan(pool, {
      runId: run.runId,
      skipTentative: true,
      behavior: BEHAVIOR,
    });
    assert.equal(wouldReplan.itemCount, 0,
      "precondition: a fresh plan would mark this recovery as nothing eligible");

    // Recovery must use the stored manifest instead.
    const recovered = await resumePromotionForRun(pool, { runId: run.runId });
    assert.equal(recovered.status, "completed");
    assert.equal(recovered.itemCount, 2);
    assert.equal(recovered.unchanged, 2,
      "both items settle as applied from their durable history events");
    assert.equal(recovered.historyEvents, 2);
    // The retractions stand — recovery never restores them.
    const statuses = await pool.query(
      `SELECT status FROM memory_canonical_observation WHERE promotion_id = $1`,
      [plan.promotionId],
    );
    for (const row of statuses.rows) assert.equal(row.status, "retracted");
    // And no "nothing eligible" settlement was recorded for the run.
    const ops = await pool.query(
      `SELECT count(*)::int AS n FROM memory_operation
       WHERE kind = 'promotion' AND run_id = $1 AND detail LIKE '%nothing-eligible%'`,
      [run.runId],
    );
    assert.equal(ops.rows[0].n, 0);
  });

  it("a completed manifest verifies its original staged history even after later canonical state changes", async () => {
    const { run } = await seedTwoClaimRun(pool);
    const plan = await buildPromotionPlan(pool, {
      runId: run.runId,
      skipTentative: true,
      behavior: BEHAVIOR,
    });
    await promoteRun(pool, {
      runId: run.runId,
      confirmationToken: plan.confirmationToken,
      skipTentative: true,
      behavior: BEHAVIOR,
    });
    // Canonical state changes AFTER completion: one identity retracted.
    const rows = await pool.query(
      `SELECT canonical_observation_id FROM memory_canonical_observation
       WHERE promotion_id = $1 ORDER BY canonical_identity_key`,
      [plan.promotionId],
    );
    await retractCanonicalObservation(pool, {
      canonicalObservationId: rows.rows[0].canonical_observation_id,
      reasonCodes: ["user_request"],
      operationKey: "op-after-complete",
    });

    // Recovery verifies the ORIGINAL stored manifest (staged items, plan
    // hash, history) — a fresh plan would now disagree with the manifest and
    // the old flow rejected finished work on that basis.
    const recovered = await resumePromotionForRun(pool, { runId: run.runId });
    assert.equal(recovered.status, "already-completed");
    assert.equal(recovered.itemCount, 2);
    assert.equal(recovered.historyEvents, 2);
    // The retraction stands.
    const status = await pool.query(
      `SELECT status FROM memory_canonical_observation
       WHERE canonical_observation_id = $1`,
      [rows.rows[0].canonical_observation_id],
    );
    assert.equal(status.rows[0].status, "retracted");
  });

  it("promotion reconcile selection rotates fairly so pending runs behind failing runs are selected", async () => {
    // Twelve older runs, each with one failed promotion attempt 8 minutes ago
    // (outside the five-minute backoff), plus one newer run never attempted.
    for (let i = 0; i < 12; i += 1) {
      const runId = `run-fail-${String(i)}`;
      await pool.query(
        `INSERT INTO memory_run
           (run_id, status, facts_status, observations_status, max_turns,
            source_fingerprint, fact_set_id, observation_set_id,
            fact_generation_signature, observation_generation_signature,
            created_at, completed_at)
         VALUES ($1, 'observations-ready', 'complete', 'complete', 10,
                 'fp', 'fs', 'os', 'fg', 'og',
                 now() - make_interval(mins => $2::int),
                 now() - make_interval(mins => $2::int))`,
        [runId, 60 - i],
      );
      await pool.query(
        `INSERT INTO memory_operation (kind, run_id, outcome, detail, started_at, finished_at)
         VALUES ('promotion', $1, 'failed', 'error=llm_timeout',
                 now() - interval '8 minutes', now() - interval '8 minutes')`,
        [runId],
      );
    }
    await pool.query(
      `INSERT INTO memory_run
         (run_id, status, facts_status, observations_status, max_turns,
          source_fingerprint, fact_set_id, observation_set_id,
          fact_generation_signature, observation_generation_signature,
          created_at, completed_at)
       VALUES ('run-fresh', 'observations-ready', 'complete', 'complete', 10,
               'fp', 'fs', 'os', 'fg', 'og',
               now() - interval '9 minutes', now() - interval '9 minutes')`,
    );

    // Fair ordering keys each run by its latest failed attempt (never-
    // attempted runs by completion): the fresh run's completion (9 minutes
    // ago) precedes the failing runs' latest attempts (8 minutes ago), so it
    // leads the batch. Under the previous oldest-run-first ordering the same
    // ten oldest failing runs monopolized every batch.
    const pending = await selectPendingPromotionRunIds(
      pool,
      PROMOTION_RECONCILE_BACKOFF_MS,
      10,
    );
    assert.equal(pending.length, 10);
    assert.equal(pending[0], "run-fresh",
      "the never-attempted run must be selected ahead of the recently-failed runs");
  });

  it("a policy review skips an observation revised after the plan was built instead of retracting the new content", async () => {
    // One single-turn canonical observation (policy-retractable), referencing
    // one real ingested fact so evidence resolution resolves.
    await enableIngest(pool);
    const storeLocal = createConversationStore(pool);
    await seedTurn(storeLocal, "I love morning tea with honey");
    await ingestTurns(await ingestDeps(pool, makeTwoClaimLlm()), "reconciliation");
    const fact = (
      await pool.query(
        `SELECT fact_key, observed_at FROM memory_fact ORDER BY fact_key LIMIT 1`,
      )
    ).rows[0];
    assert.ok(fact !== undefined);
    const observedAt = fact.observed_at;
    const canonicalId = "canon-review-fence-test";
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
         $1, $2, 1, $3, 'user', 'preference', 'Likes morning tea',
         1, 1, 1, 0, $4, $4, ARRAY[$5::text], 'supported', 'active',
         'test-consolidation-version', 'review-fence-content-hash', 1,
         'test-promotion-id', 1, 'test-artifact-id', 'test-run-id',
         'test-observation-set-id', 'test-fact-set-id',
         $4, $4, $4, $4
       )`,
      [
        canonicalId,
        "user|preference|likes-morning-tea-review-fence",
        "obs-key-review-fence",
        observedAt,
        fact.fact_key,
      ],
    );

    const plan = await buildCanonicalReviewPlan(pool, {
      canonicalObservationIds: [canonicalId],
      behavior: BEHAVIOR,
    });
    assert.equal(plan.items[0].decision, "policy_retract");
    assert.equal(plan.items[0].reviewedRevision, 1);

    // A concurrent promotion revises the observation AFTER the plan was
    // built: new content, new revision, still active.
    await pool.query(
      `UPDATE memory_canonical_observation
       SET content_hash = 'revised-after-review', revision = revision + 1
       WHERE canonical_observation_id = $1`,
      [canonicalId],
    );

    const result = await reviewCanonicalObservations(pool, {
      plan,
      confirmationToken: plan.confirmationToken,
    });
    assert.equal(result.status, "completed");
    assert.equal(result.staleSkipped, 1,
      "the revised observation must be skipped, not retracted on the stale plan");
    assert.equal(result.policyRetracted, 0);
    assert.equal(result.historyEvents, 0);
    const row = await pool.query(
      `SELECT status, content_hash, revision FROM memory_canonical_observation
       WHERE canonical_observation_id = $1`,
      [canonicalId],
    );
    assert.equal(row.rows[0].status, "active",
      "the newly-updated content stays active for the next review to re-plan");
    assert.equal(row.rows[0].content_hash, "revised-after-review");
    const events = await pool.query(
      `SELECT count(*)::int AS n FROM memory_observation_history
       WHERE canonical_observation_id = $1`,
      [canonicalId],
    );
    assert.equal(events.rows[0].n, 0);
  });

  it("a v2 profile stops being served when the prompt content or generation model changes", async () => {
    const { run } = await seedTwoClaimRun(pool);
    const plan = await buildPromotionPlan(pool, {
      runId: run.runId,
      skipTentative: true,
      behavior: BEHAVIOR,
    });
    await promoteRun(pool, {
      runId: run.runId,
      confirmationToken: plan.confirmationToken,
      skipTentative: true,
      behavior: BEHAVIOR,
    });

    const profileSystemPrompt =
      "Write a subject profile from observations. Test system prompt.";
    let profileCalls = 0;
    const callLlm = async () => {
      profileCalls += 1;
      return {
        text: JSON.stringify({
          content: "Profile prose about the claimed source.",
          claims: [],
        }),
        model: "fake-profile-model",
        finishReason: "stop",
        inputTokens: 10,
        outputTokens: 10,
        attemptCount: 1,
        structuredOutputFallback: false,
      };
    };
    const deps = {
      pool,
      config: memoryConfig(),
      systemPrompt: profileSystemPrompt,
      callLlm,
    };
    await generateProfileIfNeeded(deps, "user");
    const expected = {
      promptVersion: MEMORY_PROFILE_PROMPT_VERSION,
      promptContentHash: promptContentHash(profileSystemPrompt),
      // The stored model is whatever the generating caller reported.
      model: "fake-profile-model",
    };
    assert.ok(await getProfileDocument(pool, "user", expected) !== null,
      "the profile serves under the settings it was generated with");

    // A same-version prompt row edited in the DB: the content hash moves and
    // the document is suppressed until regeneration.
    assert.equal(
      await getProfileDocument(pool, "user", {
        ...expected,
        promptContentHash: "edited-prompt-hash",
      }),
      null,
      "a prompt content edit must suppress the served profile",
    );
    // A changed generation model must suppress the served profile.
    assert.equal(
      await getProfileDocument(pool, "user", {
        ...expected,
        model: "other-memory-model",
      }),
      null,
      "a model change must suppress the served profile",
    );
    // Unchanged settings still serve.
    assert.ok(await getProfileDocument(pool, "user", expected) !== null);
  });

  it("a temporal summary is excluded from the prompt context when the model or prompt content changed", async () => {
    // A completed recent morning leaf, generated under 'fake-memory-model'
    // and the seeded prompt hash (bounds mirror the behavioral-day config).
    await pool.query(
      `INSERT INTO memory_temporal_summary (
         kind, period_key, timezone, start_at, end_at, content, message_count,
         fingerprint, model, prompt_version, prompt_content_hash, generated_at, status
       ) VALUES (
         'morning', '2026-06-15-morning', 'America/New_York', '2026-06-15T08:00:00Z',
         '2026-06-15T16:00:00Z', 'This morning, tea was lovely.', 4,
         'seeded-morning-fingerprint', 'fake-memory-model', 'temporal-v6',
         'seeded-morning-prompt-hash', '2026-06-15T16:30:00Z', 'complete'
       )`,
    );
    const subjects = [
      { id: "user", profileEnabled: false },
      { id: "assistant", profileEnabled: false },
    ];
    const now = new Date("2026-06-15T19:00:00Z");

    const serving = await getTemporalSummaryPromptContext(pool, subjects, now, BEHAVIOR, {
      model: "fake-memory-model",
      promptContentHash: "seeded-morning-prompt-hash",
    });
    assert.ok(serving.recentText !== undefined);
    assert.ok(serving.recentText.includes("<this_morning"));

    const editedPrompt = await getTemporalSummaryPromptContext(
      pool, subjects, now, BEHAVIOR,
      { model: "fake-memory-model", promptContentHash: "edited-prompt-hash" },
    );
    assert.ok(
      editedPrompt.recentText === undefined ||
        !editedPrompt.recentText.includes("<this_morning"),
      "a same-version prompt edit must exclude the stored summary",
    );

    const changedModel = await getTemporalSummaryPromptContext(
      pool, subjects, now, BEHAVIOR,
      { model: "other-memory-model", promptContentHash: "seeded-morning-prompt-hash" },
    );
    assert.ok(
      changedModel.recentText === undefined ||
        !changedModel.recentText.includes("<this_morning"),
      "a model change must exclude the stored summary",
    );
  });

  // -------------------------------------------------------------------------
  // Manifest staging atomicity: the manifest row and its complete item set
  // commit together. A crash during staging must leave either no manifest at
  // all (next attempt plans fresh) or a complete staged manifest — never an
  // incomplete staged set, which the resumable path would reject on every
  // retry and which would make re-staging unreachable.
  // -------------------------------------------------------------------------

  it("an injected crash at manifest creation leaves no partial manifest and a retry stages fresh", async () => {
    const { run } = await seedTwoClaimRun(pool);
    const plan = await buildPromotionPlan(pool, {
      runId: run.runId,
      skipTentative: true,
      behavior: BEHAVIOR,
    });
    // Crash on the manifest INSERT itself (the first statement of the
    // atomic staging transaction).
    const wrapped = injectingPool(pool, [
      throwOnNth(
        (sql) => sql.includes("INSERT INTO memory_promotion\n"),
        1,
        "injected crash at manifest creation",
      ),
    ]);
    await assert.rejects(
      () => promoteRun(wrapped, {
        runId: run.runId,
        confirmationToken: plan.confirmationToken,
        skipTentative: true,
        behavior: BEHAVIOR,
      }),
      /injected crash at manifest creation/,
    );
    // Nothing survived: no manifest row, no items.
    const manifest = await pool.query(
      `SELECT count(*)::int AS n FROM memory_promotion WHERE run_id = $1`,
      [run.runId],
    );
    assert.equal(manifest.rows[0].n, 0);
    const items = await pool.query(
      `SELECT count(*)::int AS n FROM memory_promotion_item WHERE promotion_id = $1`,
      [plan.promotionId],
    );
    assert.equal(items.rows[0].n, 0);

    // A retry plans fresh and completes; re-staging is reachable, not
    // deadlocked behind an unverifiable staged manifest.
    const retryPlan = await buildPromotionPlan(pool, {
      runId: run.runId,
      skipTentative: true,
      behavior: BEHAVIOR,
    });
    const result = await promoteRun(pool, {
      runId: run.runId,
      confirmationToken: retryPlan.confirmationToken,
      skipTentative: true,
      behavior: BEHAVIOR,
    });
    assert.equal(result.status, "completed");
    assert.equal(result.itemCount, 2);
  });

  it("an injected crash mid-item-staging rolls back atomically and the runtime auto-recovers", async () => {
    const { run } = await seedTwoClaimRun(pool);
    const plan = await buildPromotionPlan(pool, {
      runId: run.runId,
      skipTentative: true,
      behavior: BEHAVIOR,
    });
    // Crash on the SECOND item insert: under atomic staging the manifest and
    // the first item roll back together.
    const wrapped = injectingPool(pool, [
      throwOnNth(
        (sql) => sql.includes("INSERT INTO memory_promotion_item"),
        2,
        "injected crash mid-item-staging",
      ),
    ]);
    await assert.rejects(
      () => promoteRun(wrapped, {
        runId: run.runId,
        confirmationToken: plan.confirmationToken,
        skipTentative: true,
        behavior: BEHAVIOR,
      }),
      /injected crash mid-item-staging/,
    );
    const manifest = await pool.query(
      `SELECT count(*)::int AS n FROM memory_promotion WHERE run_id = $1`,
      [run.runId],
    );
    assert.equal(manifest.rows[0].n, 0,
      "atomic staging must not leave a manifest behind when item staging aborts");
    const items = await pool.query(
      `SELECT count(*)::int AS n FROM memory_promotion_item WHERE promotion_id = $1`,
      [plan.promotionId],
    );
    assert.equal(items.rows[0].n, 0);

    // The RUNTIME recovers automatically: reconcile selects the pending run,
    // plans fresh (no manifest exists), stages atomically, and completes —
    // no manual step, no retry deadlock.
    const runtime = startMemoryRuntime({
      pool,
      config: memoryConfig({
        WORKER_MEMORY_CONSOLIDATION_NEW_FACTS_THRESHOLD: "999",
      }),
      configuration: runtimeConfiguration(),
      callLlm: makeTwoClaimLlm(),
      log: () => {},
    });
    const deadline = Date.now() + 10_000;
    let status = null;
    while (Date.now() < deadline) {
      const current = await pool.query(
        `SELECT status FROM memory_promotion WHERE run_id = $1`,
        [run.runId],
      );
      status = current.rows[0]?.status ?? null;
      if (status === "completed") break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await runtime.close();
    assert.equal(status, "completed",
      "the runtime must auto-recover a crashed staging by planning fresh");
    const canonical = await pool.query(
      `SELECT count(*)::int AS n FROM memory_canonical_observation
       WHERE promotion_id = (SELECT promotion_id FROM memory_promotion WHERE run_id = $1)
         AND status = 'active'`,
      [run.runId],
    );
    assert.equal(canonical.rows[0].n, 2);
  });
});
