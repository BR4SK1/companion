// Database-backed integration tests for the article domain (apps/worker/src/
// articles): migrations, fail-closed configuration loading from PostgreSQL on
// every attempt (with the exact `ingestion not configured` rollout line and
// no external work), the runtime discovering provisioned configuration
// without a restart, bounded RSS/Atom ingestion with SSRF-checked fetching
// through an injected fake pinned-connector transport (no network, no DNS), the durable reaction pipeline
// with lease fencing and bounded retries, accepted reactions becoming real
// assistant-attributed memory facts with article provenance written in the
// same transaction, deterministic source-filtered retrieval with a
// caller-configurable limit over the private API, the per-turn article-memory
// share decision (typed `none` option, cooldown and recall dedupe, prompt-
// inclusion records that never claim a share), and the turn-free article
// interest consolidation feeding source-aware memory observations and
// promotion.
//
// These tests need a real PostgreSQL. They run ONLY against the
// non-production database provided via WORKER_TEST_DATABASE_URL and are
// skipped otherwise. All LLM calls are fake functions and all feed fetches
// are injected fakes — no network, and no live model calls are made from
// tests. All test data is synthetic and generic.

import { describe, it, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  closePostgresPool,
  createPostgresPool,
  runMigrations,
} from "../../libraries/postgres/src/index.ts";
import { conversationMigrations } from "../../apps/worker/src/conversation/migrations.ts";
import { memoryMigrations } from "../../apps/worker/src/memory/migrations.ts";
import { articleMigrations } from "../../apps/worker/src/articles/migrations.ts";
import { createConversationStore } from "../../apps/worker/src/conversation/store.ts";
import { loadArticleConfiguration } from "../../apps/worker/src/articles/config.ts";
import {
  ArticleConfigurationInvalidError,
  ArticleConfigurationMissingError,
  ArticleDisabledError,
} from "../../apps/worker/src/articles/errors.ts";
import {
  MAX_FEEDS_PER_RUN,
  runIngestionAttempt,
  startArticleRuntime,
} from "../../apps/worker/src/articles/runner.ts";
import {
  ArticleMemoriesValidationError,
  getRecentArticleMemories,
} from "../../apps/worker/src/articles/retrieval.ts";
import {
  ARTICLE_SHARE_NONE_CHOICE,
  ARTICLE_SHARE_QUESTION_ID,
  loadArticleShareContext,
  recordArticleShareInclusion,
} from "../../apps/worker/src/articles/share.ts";
import {
  ARTICLE_INTEREST_CONSOLIDATION_PROMPT_VERSION,
  ARTICLE_REACTION_GENERATION_PROMPT_VERSION,
  ARTICLE_REACTION_REVIEW_PROMPT_VERSION,
} from "../../apps/worker/src/articles/prompts.ts";
import { runArticleObservationConsolidation } from "../../apps/worker/src/articles/observation.ts";
import {
  buildPromotionPlan,
  promoteRun,
  verifyPromotion,
} from "../../apps/worker/src/memory/promotion.ts";
import { processTurnWork } from "../../apps/worker/src/work/processor.ts";
import { createApiServer } from "../../apps/worker/src/api/server.ts";

const DATABASE_URL = process.env.WORKER_TEST_DATABASE_URL;
const hasDatabase =
  typeof DATABASE_URL === "string" && DATABASE_URL.length > 0;

const ARTICLE_TABLES = [
  "article_share", "article_reaction", "article_item",
  "article_feed", "article_behavior", "article_prompt",
];

const MEMORY_TABLES = [
  "memory_subject", "memory_prompt", "memory_behavior", "memory_fact",
  "memory_fact_source_message", "memory_turn_extraction",
  "memory_turn_extraction_item", "memory_run", "memory_run_turn",
  "memory_observation", "memory_observation_evidence",
  "memory_observation_omission", "memory_observation_omission_evidence",
  "memory_canonical_observation", "memory_observation_history",
  "memory_promotion", "memory_promotion_item", "memory_operation",
];

const SUBJECTS_SQL = `
  INSERT INTO memory_subject (id, role, profile_enabled, source_label, profile_evidence_rule, position)
  VALUES
    ('user', 'user', true, 'OWNER',
     'Attribute statements to the owner only when the owner explicitly said them; assistant suggestions are not owner evidence.', 0),
    ('assistant', 'assistant', true, 'COMPANION',
     'Literal assistant-authored statements are assistant evidence; roleplay and hypotheticals are not stable facts.', 1)
  ON CONFLICT (id) DO NOTHING`;

const MEMORY_BEHAVIOR_SQL = `
  INSERT INTO memory_behavior (id, timezone, day_start_hour)
  VALUES ('behavior', 'America/New_York', 4)
  ON CONFLICT (id) DO NOTHING`;

const BEHAVIOR = { timezone: "America/New_York", dayStartHour: 4 };

const ARTICLE_BEHAVIOR_SQL = `
  INSERT INTO article_behavior
    (id, enabled, model, max_generations_per_run, max_reaction_attempts,
     max_article_age_days, max_reaction_chars, max_excerpt_chars,
     decision_max_candidates, share_cooldown_minutes)
  VALUES ('behavior', true, 'fake-article-model', 3, 3, 120, 1000, 2000, 3, 60)
  ON CONFLICT (id) DO NOTHING`;

const ARTICLE_FEEDS_SQL = `
  INSERT INTO article_feed (id, url, enabled, position)
  VALUES ('feed-a', 'https://feeds.example.com/tea.xml', true, 0)
  ON CONFLICT (id) DO NOTHING`;

const ARTICLE_PROMPTS_SQL = `
  INSERT INTO article_prompt (kind, version, system_prompt)
  VALUES
    ('reaction_generation', 'article-reaction-generation-v1', 'React to the supplied article in your own voice. Test system prompt.'),
    ('reaction_review', 'article-reaction-review-v1', 'Review the proposed reaction against the persona. Test system prompt.'),
    ('article_interest_consolidation', 'article-interest-consolidation-v1', 'Group recorded article reactions into interests. Test system prompt.')
  ON CONFLICT (kind, version) DO NOTHING`;

const GENERATION_PROMPT_VERSION = "article-reaction-generation-v1";
const REVIEW_PROMPT_VERSION = "article-reaction-review-v1";
const CONSOLIDATION_PROMPT_VERSION = "article-interest-consolidation-v1";

/**
 * The feed XML is built per call so the dated item's pubDate stays recent
 * relative to the test clock: a static date drifts past the configured
 * max_article_age_days cutoff and silently changes which items are reaction
 * candidates. The undated item is treated as recent by contract.
 */
function buildFeedXml() {
  const publishedAt = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toUTCString();
  return `<rss version="2.0"><channel>
<item>
  <title>Tea rituals reconsidered</title>
  <link>https://example.com/tea/rituals</link>
  <description>A quiet essay on daily brewing habits and what they reveal.</description>
  <pubDate>${publishedAt}</pubDate>
</item>
<item>
  <title>Oolong season opens</title>
  <link>https://example.com/tea/oolong</link>
  <description>Producers report an early spring harvest with floral lots.</description>
</item>
</channel></rss>`;
}

const REACTION_TEXT = "Really enjoyed this piece about tea rituals; the pacing argument lands.";

/**
 * The article fake LLM routes on the mechanical envelope markers: the
 * generation input carries SOURCE ARTICLE, the review carries REVIEW
 * REQUEST, and the interest consolidation carries RECORDED ARTICLE
 * REACTIONS. Each route's response is configurable per test; the
 * consolidation route can derive its answer from the rendered fact keys.
 */
function makeArticleLlm(overrides = {}) {
  const calls = { generation: 0, review: 0, consolidation: 0 };
  const generationBodies = [];
  const reviewBodies = [];
  const models = [];
  let gateResolve;
  const gated = overrides.gated === true;
  const gatePromise = gated
    ? new Promise((resolve) => {
        gateResolve = resolve;
      })
    : null;
  const fn = async (model, input) => {
    models.push(model);
    const respond = (text) => ({
      text,
      model: "fake-article-model-build",
      finishReason: "stop",
      inputTokens: 10,
      outputTokens: 10,
      attemptCount: 1,
      structuredOutputFallback: false,
    });
    if (input.userMessage.includes("SOURCE ARTICLE")) {
      calls.generation += 1;
      generationBodies.push(input.userMessage);
      if (gatePromise !== null) await gatePromise;
      return respond(overrides.reaction ?? REACTION_TEXT);
    }
    if (input.userMessage.includes("REVIEW REQUEST")) {
      calls.review += 1;
      reviewBodies.push(input.userMessage);
      if (overrides.reviewVerdict === "reject") {
        return respond(JSON.stringify({ verdict: "reject", reason: "off persona" }));
      }
      if (overrides.unusableReview === true) {
        return respond("not json at all");
      }
      return respond(JSON.stringify({ verdict: "accept", reason: "fits persona" }));
    }
    if (input.userMessage.includes("RECORDED ARTICLE REACTIONS")) {
      calls.consolidation += 1;
      if (gatePromise !== null) await gatePromise;
      if (overrides.consolidateFromRenderedFacts === true) {
        const factKeys = [...input.userMessage.matchAll(/^FACT (\S+)$/gm)].map((m) => m[1]);
        return respond(JSON.stringify({
          observations: [
            {
              claim: "Drawn to thoughtful tea writing",
              topics: ["tea", "writing"],
              sourceFactIds: factKeys.slice(0, 2),
            },
          ],
        }));
      }
      return respond(JSON.stringify({
        observations: overrides.observations ?? [],
      }));
    }
    throw new Error(`fake article LLM has no route for: ${input.userMessage.slice(0, 80)}`);
  };
  fn.calls = calls;
  fn.generationBodies = generationBodies;
  fn.reviewBodies = reviewBodies;
  fn.models = models;
  fn.releaseGate = () => {
    if (gateResolve !== undefined) gateResolve();
  };
  return fn;
}

/**
 * A fake pinned-connector transport serving the (mutable) feed XML — never
 * touches a network or DNS. Shaped like node's http(s).request: it receives
 * (url, options, callback) and returns a request-like object; the fake
 * stands in for the whole transport+connect layer (including DNS — the
 * pinned lookup hook is not invoked here; its fail-closed behavior is
 * covered by unit tests).
 */
function makeFeedTransport(xmlHolder) {
  const seenUrls = [];
  const fn = (url, options, callback) => {
    seenUrls.push(String(url));
    const req = new EventEmitter();
    let destroyed = false;
    req.destroy = () => {
      destroyed = true;
    };
    // Mirror ClientRequest: the connector ends the bodiless GET to flush it.
    req.end = () => {};
    const res = new Readable({ read() {} });
    res.statusCode = 200;
    res.headers = { "content-type": "application/rss+xml" };
    setImmediate(() => {
      if (destroyed) return;
      callback(res);
      res.push(Buffer.from(xmlHolder.xml, "utf-8"));
      res.push(null);
    });
    return req;
  };
  fn.seenUrls = seenUrls;
  return fn;
}

/** A fake host resolver: every feed host "resolves" to a public address. */
const FAKE_RESOLVER = async () => ({ ok: true });

function provisionArticleConfig(pool) {
  return pool.query(
    `${SUBJECTS_SQL}; ${MEMORY_BEHAVIOR_SQL}; ${ARTICLE_BEHAVIOR_SQL}; ${ARTICLE_FEEDS_SQL}; ${ARTICLE_PROMPTS_SQL};`,
  );
}

/** Seed one accepted reaction with its item and assistant fact, via SQL. */
async function seedAcceptedReaction(pool, input) {
  const item = await pool.query(
    `INSERT INTO article_item (feed_id, url, title, excerpt, published_at, fetched_at)
     VALUES ('feed-a', $1, $2, $3, now() - interval '2 days', now() - interval '1 day')
     RETURNING id`,
    [input.url, input.title, input.excerpt],
  );
  const reactionRow = await pool.query(
    `INSERT INTO article_reaction
       (item_id, state, attempt_count, reaction, model,
        generation_prompt_version, generated_at, review_prompt_version, reviewed_at, fact_key)
     VALUES ($1, 'accepted', 1, $2, 'fake-article-model',
             $3, $4, $5, $4, $6)
     RETURNING id`,
    [
      item.rows[0].id,
      input.reaction,
      GENERATION_PROMPT_VERSION,
      input.generatedAt,
      REVIEW_PROMPT_VERSION,
      input.factKey,
    ],
  );
  await pool.query(
    `INSERT INTO memory_fact
       (fact_key, turn_id, subject_id, kind, claim, condition, consequence, topics,
        observed_at, explicitness, evidence_basis, extraction_version, ingest_version,
        article_reaction_id, source_type)
     VALUES ($1, NULL, 'assistant', 'preference', $2, NULL, NULL, '{}', $3,
             'explicit', 'observed_behavior', $4, 'article-ingest-v1', $5, 'article')
     ON CONFLICT (fact_key) DO NOTHING`,
    [input.factKey, input.reaction, input.generatedAt, GENERATION_PROMPT_VERSION, reactionRow.rows[0].id],
  );
  return reactionRow.rows[0].id;
}

async function insertTestTurn(pool) {
  const turnRow = await pool.query(
    `INSERT INTO conversation_turn (id, status, attempt, lease_owner, lease_expires_at)
     VALUES (gen_random_uuid(), 'in_flight', 1, 'turn-owner', now() + interval '5 minutes')
     RETURNING id`,
  );
  return turnRow.rows[0].id;
}

/** Poll until the SQL returns at least one row; bounded, for cross-attempt visibility. */
async function waitForRow(pool, sql, params = []) {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const result = await pool.query(sql, params);
    if (result.rows.length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`expected rows within the wait window: ${sql}`);
}

describe("article domain work (PostgreSQL)", { skip: !hasDatabase }, () => {
  /** @type {import("pg").Pool} */
  let pool;
  let store;

  before(async () => {
    pool = createPostgresPool({ connectionString: DATABASE_URL });
    store = createConversationStore(pool);
    // The article composition matches main.ts: conversation, memory, then the
    // article extension (article_share references conversation turns; 0007
    // extends memory_fact).
    await runMigrations(pool, [
      ...conversationMigrations,
      ...memoryMigrations,
      ...articleMigrations,
    ]);
  });

  after(async () => {
    if (pool !== undefined) {
      await closePostgresPool(pool);
    }
  });

  beforeEach(async () => {
    await pool.query(
      `TRUNCATE ${[...ARTICLE_TABLES, ...MEMORY_TABLES].join(", ")} RESTART IDENTITY CASCADE`,
    );
    await pool.query(
      `TRUNCATE conversation_message, conversation_turn RESTART IDENTITY CASCADE`,
    );
  });

  // --- Migrations -----------------------------------------------------------

  it("applies the article migrations idempotently with the domain tables present", async () => {
    const second = await runMigrations(pool, [
      ...conversationMigrations,
      ...memoryMigrations,
      ...articleMigrations,
    ]);
    assert.deepEqual(second.applied, []);
    assert.deepEqual(second.alreadyApplied, [
      "0001_conversation_work",
      "0002_conversation_tracing",
      "0004_chat_identity",
      "0005_message_timing",
      "0006_conversation_thread_order",
      "0003_memory_work",
      "0007_article_work",
      "0008_article_share_and_evidence",
      "0009_article_observation_claim",
    ]);
    const tables = await pool.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name IN ('article_feed', 'article_behavior', 'article_prompt',
                            'article_item', 'article_reaction', 'article_share')
       ORDER BY table_name`,
    );
    assert.deepEqual(
      tables.rows.map((row) => row.table_name),
      [
        "article_behavior",
        "article_feed",
        "article_item",
        "article_prompt",
        "article_reaction",
        "article_share",
      ],
    );
  });

  // --- Configuration loading --------------------------------------------------

  it("loads configuration fail-closed from PostgreSQL", async () => {
    await provisionArticleConfig(pool);

    // No behavior row at all: missing.
    await pool.query(`DELETE FROM article_behavior`);
    await assert.rejects(
      () => loadArticleConfiguration(pool),
      ArticleConfigurationMissingError,
    );

    // Disabled behavior row: a distinct state, not missing.
    await pool.query(ARTICLE_BEHAVIOR_SQL);
    await pool.query(`UPDATE article_behavior SET enabled = false WHERE id = 'behavior'`);
    await assert.rejects(() => loadArticleConfiguration(pool), ArticleDisabledError);
    await pool.query(`UPDATE article_behavior SET enabled = true WHERE id = 'behavior'`);

    // No enabled feed: missing.
    await pool.query(`UPDATE article_feed SET enabled = false`);
    await assert.rejects(
      () => loadArticleConfiguration(pool),
      ArticleConfigurationMissingError,
    );
    await pool.query(`UPDATE article_feed SET enabled = true`);

    // Missing required prompt rows: missing.
    await pool.query(`DELETE FROM article_prompt WHERE kind = 'reaction_review'`);
    await assert.rejects(
      () => loadArticleConfiguration(pool),
      ArticleConfigurationMissingError,
    );
    await pool.query(
      `INSERT INTO article_prompt (kind, version, system_prompt)
       VALUES ('reaction_review', $1, 'Review the proposed reaction against the persona. Test system prompt.')`,
      [REVIEW_PROMPT_VERSION],
    );

    // A malformed feed URL: invalid, distinct from missing.
    await pool.query(`UPDATE article_feed SET url = 'not a url at all'`);
    await assert.rejects(
      () => loadArticleConfiguration(pool),
      ArticleConfigurationInvalidError,
    );

    // A non-http scheme: invalid.
    await pool.query(`UPDATE article_feed SET url = 'ftp://feeds.example.com/tea.xml'`);
    await assert.rejects(
      () => loadArticleConfiguration(pool),
      ArticleConfigurationInvalidError,
    );
    await pool.query(`UPDATE article_feed SET url = 'https://feeds.example.com/tea.xml'`);

    // An out-of-range limit: invalid. The share-cooldown column's DB check
    // permits 0, so this exercises the loader's own positive-integer bound
    // rather than the schema's.
    await pool.query(`UPDATE article_behavior SET share_cooldown_minutes = 0`);
    await assert.rejects(
      () => loadArticleConfiguration(pool),
      ArticleConfigurationInvalidError,
    );
    await pool.query(`UPDATE article_behavior SET share_cooldown_minutes = 60`);

    // No assistant subject: reactions could not be attributed; fail closed.
    await pool.query(`DELETE FROM memory_subject`);
    await assert.rejects(
      () => loadArticleConfiguration(pool),
      ArticleConfigurationMissingError,
    );
    await pool.query(SUBJECTS_SQL);

    // The complete configuration loads, with limits clamped to hard maxima.
    await pool.query(`UPDATE article_behavior SET max_generations_per_run = 99999`);
    const config = await loadArticleConfiguration(pool);
    assert.equal(config.behavior.maxGenerationsPerRun, 10);
    assert.equal(config.behavior.model, "fake-article-model");
    assert.deepEqual(
      config.feeds.map((feed) => feed.id),
      ["feed-a"],
    );
    assert.equal(config.prompts.reaction_generation.systemPrompt.length > 0, true);
    assert.equal(config.assistantSubjectId, "assistant");
  });

  // --- Runtime rollout states -------------------------------------------------

  it("logs exactly 'ingestion not configured' and does no external work when unprovisioned", async () => {
    const logs = [];
    const llm = makeArticleLlm();
    const fetchCalls = [];
    const transport = async (url) => {
      fetchCalls.push(String(url));
      return new Response("<rss></rss>", { status: 200 });
    };
    const summary = await runIngestionAttempt(
      {
        pool,
        callLlm: llm,
        log: (message) => logs.push(message),
        transport,
      },
      "test",
    );
    assert.equal(summary.status, "not_configured");
    assert.deepEqual(summary.result, {
      feedsAttempted: 0,
      feedsFailed: 0,
      itemsFetched: 0,
      itemsNew: 0,
      candidatesAttempted: 0,
      generated: 0,
      rejected: 0,
      failed: 0,
      skippedClaims: 0,
      lostFinalizes: 0,
      llmCalls: 0,
    });
    // Exactly the contracted rollout line, nothing else.
    assert.deepEqual(logs, ["ingestion not configured"]);
    // No external work: no fetch, no provider call, no state write.
    assert.deepEqual(fetchCalls, []);
    assert.equal(llm.calls.generation + llm.calls.review, 0);
    const items = await pool.query(`SELECT count(*)::int AS n FROM article_item`);
    assert.equal(items.rows[0].n, 0);
    const reactions = await pool.query(`SELECT count(*)::int AS n FROM article_reaction`);
    assert.equal(reactions.rows[0].n, 0);
    const ops = await pool.query(
      `SELECT count(*)::int AS n FROM memory_operation WHERE kind = 'article_ingestion'`,
    );
    assert.equal(ops.rows[0].n, 0);
  });

  it("discovers provisioned configuration on a later attempt without a restart", async () => {
    const logs = [];
    const llm = makeArticleLlm();
    const xmlHolder = { xml: buildFeedXml() };
    const transport = makeFeedTransport(xmlHolder);
    const runtime = startArticleRuntime({
      pool,
      callLlm: llm,
      log: (message) => logs.push(message),
      pollIntervalMs: 3_600_000,
      transport,
      resolveFeedHost: FAKE_RESOLVER,
    });
    try {
      // The runtime keeps polling while unprovisioned: the startup attempt
      // (and the awaited manual one) log the rollout line and fetch nothing.
      const before = await runtime.runOnce();
      assert.equal(before.status, "not_configured");
      assert.deepEqual(transport.seenUrls, []);
      assert.ok(logs.every((message) => message === "ingestion not configured"));
      assert.ok(logs.length >= 1);

      // Provisioning the tables is enough: the same runtime picks the
      // configuration up on the next attempt.
      await provisionArticleConfig(pool);
      const after = await runtime.runOnce();
      assert.equal(after.status, "ok");
      assert.equal(after.result.itemsNew, 2);
      assert.equal(after.result.generated, 2);
      assert.deepEqual(transport.seenUrls, ["https://feeds.example.com/tea.xml"]);
    } finally {
      await runtime.close();
    }
  });

  it("treats an explicitly disabled behavior row as a distinct no-op state", async () => {
    await provisionArticleConfig(pool);
    await pool.query(`UPDATE article_behavior SET enabled = false WHERE id = 'behavior'`);
    const logs = [];
    const llm = makeArticleLlm();
    const transport = makeFeedTransport({ xml: buildFeedXml() });
    const summary = await runIngestionAttempt(
      {
        pool,
        callLlm: llm,
        log: (message) => logs.push(message),
        transport,
      },
      "test",
    );
    assert.equal(summary.status, "disabled");
    assert.deepEqual(logs, ["article ingestion disabled"]);
    assert.deepEqual(transport.seenUrls, []);
    assert.equal(llm.calls.generation, 0);
  });

  it("reports an invalid configuration distinctly and writes no state", async () => {
    await provisionArticleConfig(pool);
    await pool.query(`UPDATE article_feed SET url = 'not a url at all'`);
    const logs = [];
    const llm = makeArticleLlm();
    const transport = makeFeedTransport({ xml: buildFeedXml() });
    const summary = await runIngestionAttempt(
      {
        pool,
        callLlm: llm,
        log: (message) => logs.push(message),
        transport,
      },
      "test",
    );
    assert.equal(summary.status, "invalid");
    assert.deepEqual(transport.seenUrls, []);
    assert.equal(llm.calls.generation, 0);
    const items = await pool.query(`SELECT count(*)::int AS n FROM article_item`);
    assert.equal(items.rows[0].n, 0);
  });

  // --- Ingestion pipeline -----------------------------------------------------

  it("ingests feeds, generates and reviews a reaction, and attributes an assistant memory fact", async () => {
    await provisionArticleConfig(pool);
    // A one-item budget proves the per-run budget caps generation attempts.
    await pool.query(`UPDATE article_behavior SET max_generations_per_run = 1`);
    const llm = makeArticleLlm();
    const transport = makeFeedTransport({ xml: buildFeedXml() });
    const summary = await runIngestionAttempt(
      {
        pool,
        callLlm: llm,
        log: () => {},
        transport,
        resolveFeedHost: FAKE_RESOLVER,
      },
      "test",
    );
    assert.equal(summary.status, "ok");
      assert.equal(summary.result.feedsAttempted, 1);
      assert.equal(summary.result.feedsFailed, 0);
      assert.equal(summary.result.itemsFetched, 2);
      assert.equal(summary.result.itemsNew, 2);
      assert.equal(summary.result.candidatesAttempted, 1);
      assert.equal(summary.result.generated, 1);
      assert.equal(summary.result.rejected, 0);
      assert.equal(summary.result.failed, 0);

      // Items persisted with excerpt-level content.
      const items = await pool.query(
        `SELECT url, title, excerpt, published_at FROM article_item ORDER BY title`,
      );
      assert.equal(items.rows.length, 2);
      const rituals = items.rows.find((row) => row.url === "https://example.com/tea/rituals");
      assert.ok(rituals !== undefined);
      assert.match(rituals.excerpt, /daily brewing habits/);
      assert.ok(rituals.published_at !== null);

      // The generation call carried the bounded article envelope, and the
      // configured model was used for both tasks. Either item may claim the
      // one-slot budget (equal fetch stamps), so assert on the envelope, not
      // on which item won.
      assert.equal(llm.calls.generation, 1);
      assert.match(llm.generationBodies[0], /SOURCE ARTICLE/);
      assert.match(llm.generationBodies[0], /TITLE: (Tea rituals reconsidered|Oolong season opens)/);
      assert.match(llm.reviewBodies[0], /REVIEW REQUEST/);
      assert.deepEqual([...new Set(llm.models)], ["fake-article-model"]);

      // The accepted reaction is a real assistant-attributed memory fact with
      // article provenance: no turn, an article-reaction link, and a stable
      // synthetic fact key.
      const reactions = await pool.query(
        `SELECT id, item_id, state, attempt_count, reaction, fact_key, model,
                generation_prompt_version, review_prompt_version
         FROM article_reaction WHERE state = 'accepted'`,
      );
      assert.equal(reactions.rows.length, 1);
      const reaction = reactions.rows[0];
      assert.equal(reaction.attempt_count, 1);
      assert.equal(reaction.reaction, REACTION_TEXT);
      assert.equal(reaction.model, "fake-article-model");
      assert.equal(reaction.generation_prompt_version, GENERATION_PROMPT_VERSION);
      assert.equal(reaction.review_prompt_version, REVIEW_PROMPT_VERSION);

      const facts = await pool.query(
        `SELECT fact_key, turn_id, subject_id, kind, claim, source_type,
                article_reaction_id, ingest_version
         FROM memory_fact WHERE source_type = 'article'`,
      );
      assert.equal(facts.rows.length, 1);
      const fact = facts.rows[0];
      assert.equal(fact.fact_key, `article:${reaction.id}`);
      assert.equal(fact.turn_id, null);
      assert.equal(fact.subject_id, "assistant");
      assert.equal(fact.kind, "preference");
      assert.equal(fact.claim, REACTION_TEXT);
      assert.equal(fact.article_reaction_id, reaction.id);
      assert.equal(fact.ingest_version, "article-ingest-v1");
      assert.equal(reaction.fact_key, fact.fact_key);

      // The attempt's trace is metadata-only: counts and ids, never content.
      const ops = await pool.query(
        `SELECT outcome, detail, model, prompt_version, llm_calls
         FROM memory_operation WHERE kind = 'article_ingestion'`,
      );
      assert.equal(ops.rows.length, 1);
      assert.equal(ops.rows[0].outcome, "ok");
      assert.match(ops.rows[0].detail, /generated=1/);
      assert.equal(ops.rows[0].model, "fake-article-model");
      assert.equal(ops.rows[0].prompt_version, GENERATION_PROMPT_VERSION);
      assert.ok(!ops.rows[0].detail.includes(REACTION_TEXT));
      assert.ok(!ops.rows[0].detail.includes("daily brewing habits"));
  });

  it("keeps re-ingestion idempotent and never re-claims an accepted reaction", async () => {
    await provisionArticleConfig(pool);
    const xmlHolder = { xml: buildFeedXml() };
    const llm = makeArticleLlm();
    const transport = makeFeedTransport(xmlHolder);
    const deps = { pool, callLlm: llm, log: () => {}, transport, resolveFeedHost: FAKE_RESOLVER };
    const first = await runIngestionAttempt(deps, "test");
    assert.equal(first.status, "ok");
    assert.equal(first.result.generated, 2);
    assert.equal(llm.calls.generation, 2);

    // Re-fetch the same feed with an edited excerpt: the URL-keyed item is
    // updated, not duplicated, and the stored excerpt (the reaction's
    // provenance) is never overwritten.
    xmlHolder.xml = buildFeedXml().replace(
      "A quiet essay on daily brewing habits and what they reveal.",
      "An edited summary that must not replace the stored excerpt.",
    );
    const second = await runIngestionAttempt(deps, "test");
    assert.equal(second.status, "ok");
    assert.equal(second.result.itemsFetched, 2);
    assert.equal(second.result.itemsNew, 0);
    assert.equal(second.result.candidatesAttempted, 0);
    assert.equal(second.result.generated, 0);
    assert.equal(llm.calls.generation, 2);

    const items = await pool.query(`SELECT count(*)::int AS n FROM article_item`);
    assert.equal(items.rows[0].n, 2);
    const stored = await pool.query(
      `SELECT excerpt FROM article_item WHERE url = 'https://example.com/tea/rituals'`,
    );
    assert.match(stored.rows[0].excerpt, /daily brewing habits/);

    const facts = await pool.query(
      `SELECT count(*)::int AS n FROM memory_fact WHERE source_type = 'article'`,
    );
    assert.equal(facts.rows[0].n, 2);
  });

  it("records a review rejection without a fact and retries within the attempt budget", async () => {
    await provisionArticleConfig(pool);
    await pool.query(`UPDATE article_behavior SET max_generations_per_run = 1`);
    const rejecting = makeArticleLlm({ reviewVerdict: "reject" });
    const transport = makeFeedTransport({ xml: buildFeedXml() });
    const firstSummary = await runIngestionAttempt(
      {
        pool,
        callLlm: rejecting,
        log: () => {},
        transport,
        resolveFeedHost: FAKE_RESOLVER,
      },
      "test",
    );
    assert.equal(firstSummary.status, "ok");
    assert.equal(firstSummary.result.rejected, 1);
    assert.equal(firstSummary.result.generated, 0);

    const rejected = await pool.query(
      `SELECT state, attempt_count, reaction, fact_key, last_error FROM article_reaction`,
    );
    assert.equal(rejected.rows.length, 1);
    assert.equal(rejected.rows[0].state, "rejected");
    assert.equal(rejected.rows[0].attempt_count, 1);
    assert.equal(rejected.rows[0].reaction, null);
    assert.equal(rejected.rows[0].fact_key, null);
    assert.equal(rejected.rows[0].last_error, "off persona");
    const factsAfterReject = await pool.query(
      `SELECT count(*)::int AS n FROM memory_fact WHERE source_type = 'article'`,
    );
    assert.equal(factsAfterReject.rows[0].n, 0);

    // A rejected reaction with attempts left is a candidate again; with the
    // review now accepting, the same item reaches the accepted state and its
    // fact is written.
    const accepting = makeArticleLlm();
    const secondSummary = await runIngestionAttempt(
      {
        pool,
        callLlm: accepting,
        log: () => {},
        transport,
        resolveFeedHost: FAKE_RESOLVER,
      },
      "test",
    );
    assert.equal(secondSummary.status, "ok");
    assert.equal(secondSummary.result.generated, 1);
    const reaction = await pool.query(`SELECT state, attempt_count FROM article_reaction`);
    assert.equal(reaction.rows[0].state, "accepted");
    assert.equal(reaction.rows[0].attempt_count, 2);
    const facts = await pool.query(
      `SELECT count(*)::int AS n FROM memory_fact WHERE source_type = 'article'`,
    );
    assert.equal(facts.rows[0].n, 1);
  });

  it("marks unusable model output as failed with a bounded category", async () => {
    await provisionArticleConfig(pool);
    await pool.query(`UPDATE article_behavior SET max_generations_per_run = 1`);
    const llm = makeArticleLlm({ unusableReview: true });
    const summary = await runIngestionAttempt(
      {
        pool,
        callLlm: llm,
        log: () => {},
        transport: makeFeedTransport({ xml: buildFeedXml() }),
        resolveFeedHost: FAKE_RESOLVER,
      },
      "test",
    );
    assert.equal(summary.status, "ok");
    assert.equal(summary.result.failed, 1);
    assert.equal(summary.result.generated, 0);
    const reaction = await pool.query(`SELECT state, last_error FROM article_reaction`);
    assert.equal(reaction.rows[0].state, "failed");
    assert.equal(reaction.rows[0].last_error, "unusable review output");
  });

  it("never double-generates: a live lease makes a concurrent claim a no-op", async () => {
    await provisionArticleConfig(pool);
    // A one-slot budget keeps the gated attempt to a single claim and makes
    // the concurrent attempt's single candidate the leased one, so the
    // lease observation is deterministic rather than order-dependent.
    await pool.query(`UPDATE article_behavior SET max_generations_per_run = 1`);
    const depsA = {
      pool,
      callLlm: makeArticleLlm({ gated: true }),
      log: () => {},
      transport: makeFeedTransport({ xml: buildFeedXml() }),
      resolveFeedHost: FAKE_RESOLVER,
    };
    const depsB = {
      pool,
      callLlm: makeArticleLlm(),
      log: () => {},
      transport: makeFeedTransport({ xml: buildFeedXml() }),
      resolveFeedHost: FAKE_RESOLVER,
    };
    // A claims the item and blocks inside its generation call; B's concurrent
    // attempt observes the live lease and generates nothing. Waiting for the
    // claim row to be durably visible makes B's observation deterministic.
    const attemptA = runIngestionAttempt(depsA, "test");
    await waitForRow(pool, `SELECT 1 FROM article_reaction WHERE state = 'generating'`);
    const summaryB = await runIngestionAttempt(depsB, "test");
    assert.equal(summaryB.status, "ok");
    assert.equal(summaryB.result.skippedClaims, 1);
    assert.equal(summaryB.result.generated, 0);
    assert.equal(depsB.callLlm.calls.generation, 0);

    depsA.callLlm.releaseGate();
    const summaryA = await attemptA;
    assert.equal(summaryA.status, "ok");
    assert.equal(summaryA.result.generated, 1);
    assert.equal(depsA.callLlm.calls.generation, 1);

    const accepted = await pool.query(
      `SELECT count(*)::int AS n FROM article_reaction WHERE state = 'accepted'`,
    );
    assert.equal(accepted.rows[0].n, 1);
    const facts = await pool.query(
      `SELECT count(*)::int AS n FROM memory_fact WHERE source_type = 'article'`,
    );
    assert.equal(facts.rows[0].n, 1);
  });

  it("never finalizes under an expired lease when nobody takes over", async () => {
    await provisionArticleConfig(pool);
    // A one-slot budget keeps the gated attempt to a single claim, so the
    // expired-lease observation is deterministic rather than order-dependent
    // (a second candidate would claim a fresh lease and finalize within it).
    await pool.query(`UPDATE article_behavior SET max_generations_per_run = 1`);
    // Worker A claims with a lease short enough to expire while it stalls
    // inside its generation call, and NOBODY takes the claim over: the row
    // still shows A's lease, but the lease is dead.
    const depsA = {
      pool,
      callLlm: makeArticleLlm({ gated: true }),
      log: () => {},
      transport: makeFeedTransport({ xml: buildFeedXml() }),
      resolveFeedHost: FAKE_RESOLVER,
      leaseMs: 5,
    };
    const attemptA = runIngestionAttempt(depsA, "test");
    await waitForRow(pool, `SELECT 1 FROM article_reaction WHERE state = 'generating'`);
    await new Promise((resolve) => setTimeout(resolve, 30));

    // A's finalize must fail closed: an expired lease is a lost lease even
    // though ownership was never transferred. (Before the fence checked
    // lease liveness, A committed the accepted reaction and its memory fact
    // here, and counted the success.)
    depsA.callLlm.releaseGate();
    const summaryA = await attemptA;
    assert.equal(summaryA.status, "ok");
    assert.equal(summaryA.result.generated, 0);
    assert.equal(summaryA.result.lostFinalizes, 1);
    assert.equal(depsA.callLlm.calls.generation, 1);
    assert.equal(depsA.callLlm.calls.review, 1);

    const reaction = await pool.query(
      `SELECT state, reaction, fact_key, lease_expires_at FROM article_reaction`,
    );
    assert.equal(reaction.rows[0].state, "generating");
    assert.equal(reaction.rows[0].reaction, null);
    assert.equal(reaction.rows[0].fact_key, null);
    // The row keeps A's dead lease: recoverable by a takeover claim or the
    // exhausted-lease sweep, never finalized by A.
    assert.ok(reaction.rows[0].lease_expires_at !== null);
    const factsA = await pool.query(
      `SELECT count(*)::int AS n FROM memory_fact WHERE source_type = 'article'`,
    );
    assert.equal(factsA.rows[0].n, 0);

    // The phase is not wedged: a fresh attempt takes the expired lease over
    // and completes it honestly.
    const depsB = {
      pool,
      callLlm: makeArticleLlm(),
      log: () => {},
      transport: makeFeedTransport({ xml: buildFeedXml() }),
      resolveFeedHost: FAKE_RESOLVER,
    };
    const summaryB = await runIngestionAttempt(depsB, "test");
    assert.equal(summaryB.status, "ok");
    assert.equal(summaryB.result.generated, 1);
    assert.equal(summaryB.result.lostFinalizes, 0);
    const finalized = await pool.query(
      `SELECT state, attempt_count, lease_expires_at FROM article_reaction`,
    );
    assert.equal(finalized.rows[0].state, "accepted");
    assert.equal(finalized.rows[0].attempt_count, 2); // A's claim + B's takeover bump
    assert.equal(finalized.rows[0].lease_expires_at, null);
    const factsB = await pool.query(
      `SELECT count(*)::int AS n FROM memory_fact WHERE source_type = 'article'`,
    );
    assert.equal(factsB.rows[0].n, 1);
  });

  it("never finalizes after its lease was taken over and counts no success", async () => {
    await provisionArticleConfig(pool);
    // A one-slot budget keeps the gated attempt to a single claim (see the
    // expired-lease test above).
    await pool.query(`UPDATE article_behavior SET max_generations_per_run = 1`);
    // Worker A claims and stalls inside its generation call past expiry.
    const depsA = {
      pool,
      callLlm: makeArticleLlm({ gated: true }),
      log: () => {},
      transport: makeFeedTransport({ xml: buildFeedXml() }),
      resolveFeedHost: FAKE_RESOLVER,
      leaseMs: 5,
    };
    const attemptA = runIngestionAttempt(depsA, "test");
    await waitForRow(pool, `SELECT 1 FROM article_reaction WHERE state = 'generating'`);
    await new Promise((resolve) => setTimeout(resolve, 30));

    // Worker B takes the expired lease over and completes the item with its
    // own, distinct reaction.
    const takeoverReaction = "Worker B completed this reaction after taking over the lease.";
    const depsB = {
      pool,
      callLlm: makeArticleLlm({ reaction: takeoverReaction }),
      log: () => {},
      transport: makeFeedTransport({ xml: buildFeedXml() }),
      resolveFeedHost: FAKE_RESOLVER,
    };
    const summaryB = await runIngestionAttempt(depsB, "test");
    assert.equal(summaryB.status, "ok");
    assert.equal(summaryB.result.generated, 1);
    assert.equal(summaryB.result.lostFinalizes, 0);

    // A's late finalize must not overwrite B's terminal state, must not
    // write a spurious fact, and must count no success.
    depsA.callLlm.releaseGate();
    const summaryA = await attemptA;
    assert.equal(summaryA.status, "ok");
    assert.equal(summaryA.result.generated, 0);
    assert.equal(summaryA.result.lostFinalizes, 1);
    const reaction = await pool.query(
      `SELECT state, reaction, attempt_count, lease_expires_at FROM article_reaction`,
    );
    assert.equal(reaction.rows[0].state, "accepted");
    assert.equal(reaction.rows[0].reaction, takeoverReaction);
    assert.equal(reaction.rows[0].attempt_count, 2);
    assert.equal(reaction.rows[0].lease_expires_at, null);
    const facts = await pool.query(
      `SELECT claim FROM memory_fact WHERE source_type = 'article'`,
    );
    assert.equal(facts.rows.length, 1);
    assert.equal(facts.rows[0].claim, takeoverReaction);
  });

  it("never finalizes a rejected verdict under an expired lease", async () => {
    await provisionArticleConfig(pool);
    // A one-slot budget keeps the gated attempt to a single claim (see the
    // expired-lease test above).
    await pool.query(`UPDATE article_behavior SET max_generations_per_run = 1`);
    const depsA = {
      pool,
      callLlm: makeArticleLlm({ gated: true, reviewVerdict: "reject" }),
      log: () => {},
      transport: makeFeedTransport({ xml: buildFeedXml() }),
      resolveFeedHost: FAKE_RESOLVER,
      leaseMs: 5,
    };
    const attemptA = runIngestionAttempt(depsA, "test");
    await waitForRow(pool, `SELECT 1 FROM article_reaction WHERE state = 'generating'`);
    await new Promise((resolve) => setTimeout(resolve, 30));
    depsA.callLlm.releaseGate();
    const summaryA = await attemptA;
    assert.equal(summaryA.status, "ok");
    assert.equal(summaryA.result.rejected, 0);
    assert.equal(summaryA.result.lostFinalizes, 1);
    const reaction = await pool.query(`SELECT state, last_error FROM article_reaction`);
    assert.equal(reaction.rows[0].state, "generating");
    assert.equal(reaction.rows[0].last_error, null);
  });

  it("never reacts to items older than the configured age limit", async () => {
    await provisionArticleConfig(pool);
    // One undated item (treated as recent) and one clearly old item.
    await pool.query(
      `INSERT INTO article_item (feed_id, url, title, excerpt, published_at, fetched_at)
       VALUES ('feed-a', 'https://example.com/tea/old', 'Ancient entry', 'Old excerpt text.',
               now() - interval '400 days', now())`,
    );
    const llm = makeArticleLlm();
    const summary = await runIngestionAttempt(
      {
        pool,
        callLlm: llm,
        log: () => {},
        transport: makeFeedTransport({ xml: buildFeedXml() }),
        resolveFeedHost: FAKE_RESOLVER,
      },
      "test",
    );
    assert.equal(summary.status, "ok");
    // Only the feed items are candidates (the budget allows 3); the old item
    // is never selected.
    const reacted = await pool.query(
      `SELECT i.url FROM article_reaction r JOIN article_item i ON i.id = r.item_id`,
    );
    assert.deepEqual(
      reacted.rows.map((row) => row.url).sort(),
      ["https://example.com/tea/oolong", "https://example.com/tea/rituals"],
    );
    const oldReaction = await pool.query(
      `SELECT count(*)::int AS n FROM article_reaction r
       JOIN article_item i ON i.id = r.item_id WHERE i.url = 'https://example.com/tea/old'`,
    );
    assert.equal(oldReaction.rows[0].n, 0);
  });

  it("never reacts to items of feeds disabled after they were fetched", async () => {
    await provisionArticleConfig(pool);
    // An item from a second feed that was enabled when fetched and is
    // disabled now: candidate selection must filter on the feed's CURRENT
    // enabled state, not the item's fetch history.
    await pool.query(
      `INSERT INTO article_feed (id, url, enabled, position)
       VALUES ('feed-disabled', 'https://feeds.example.com/disabled.xml', false, 1)`,
    );
    await pool.query(
      `INSERT INTO article_item (feed_id, url, title, excerpt, published_at, fetched_at)
       VALUES ('feed-disabled', 'https://example.com/disabled/one', 'Disabled feed item',
               'Excerpt from a since-disabled feed.', now() - interval '2 days', now())`,
    );
    const llm = makeArticleLlm();
    const summary = await runIngestionAttempt(
      {
        pool,
        callLlm: llm,
        log: () => {},
        transport: makeFeedTransport({ xml: buildFeedXml() }),
        resolveFeedHost: FAKE_RESOLVER,
      },
      "test",
    );
    assert.equal(summary.status, "ok");
    // Only the enabled feed's items are candidates; the disabled feed's item
    // is never reacted to.
    const reacted = await pool.query(
      `SELECT i.feed_id FROM article_reaction r JOIN article_item i ON i.id = r.item_id`,
    );
    assert.deepEqual([...new Set(reacted.rows.map((row) => row.feed_id))], ["feed-a"]);
    // Re-enabling the feed makes its item a candidate again.
    await pool.query(`UPDATE article_feed SET enabled = true WHERE id = 'feed-disabled'`);
    const second = await runIngestionAttempt(
      {
        pool,
        callLlm: makeArticleLlm(),
        log: () => {},
        transport: makeFeedTransport({ xml: buildFeedXml() }),
        resolveFeedHost: FAKE_RESOLVER,
      },
      "test",
    );
    assert.equal(second.status, "ok");
    const reactedAfter = await pool.query(
      `SELECT i.feed_id FROM article_reaction r JOIN article_item i ON i.id = r.item_id`,
    );
    assert.deepEqual([...new Set(reactedAfter.rows.map((row) => row.feed_id))].sort(), [
      "feed-a",
      "feed-disabled",
    ]);
  });

  it("enforces the attempt cap atomically and settles exhausted stalled rows", async () => {
    await provisionArticleConfig(pool);
    await pool.query(`UPDATE article_behavior SET max_reaction_attempts = 2`);
    await pool.query(
      `INSERT INTO article_item (feed_id, url, title, excerpt, published_at, fetched_at)
       VALUES ('feed-a', 'https://example.com/tea/exhausted', 'Exhausted item', 'Excerpt.',
               now() - interval '2 days', now())`,
    );
    // A crashed worker left a generating row at the attempt cap with an
    // expired lease. It is never a candidate: the claim-time cap is atomic,
    // so no selection/claim race can bump it past the cap. The feed fetch
    // fails (HTTP 500) so only the seeded item exists at all.
    await pool.query(
      `INSERT INTO article_reaction (item_id, state, attempt_count, lease_expires_at, last_error)
       SELECT id, 'generating', 2, now() - interval '1 hour', 'crashed'
       FROM article_item WHERE url = 'https://example.com/tea/exhausted'`,
    );
    const failingFetch = (url, options, callback) => {
      const req = new EventEmitter();
      req.destroy = () => {};
      // Mirror ClientRequest: the connector ends the bodiless GET to flush it.
      req.end = () => {};
      const res = new Readable({ read() {} });
      res.statusCode = 500;
      res.headers = {};
      setImmediate(() => {
        callback(res);
        res.push(Buffer.from("nope"));
        res.push(null);
      });
      return req;
    };
    const llm = makeArticleLlm();
    const summary = await runIngestionAttempt(
      {
        pool,
        callLlm: llm,
        log: () => {},
        transport: failingFetch,
        resolveFeedHost: FAKE_RESOLVER,
      },
      "test",
    );
    assert.equal(summary.status, "ok");
    assert.equal(summary.result.candidatesAttempted, 0);
    assert.equal(llm.calls.generation, 0);
    // The stalled row is settled into an honest terminal failure instead of
    // sitting as a zombie lease forever.
    const settled = await pool.query(
      `SELECT state, attempt_count, lease_expires_at, last_error FROM article_reaction`,
    );
    assert.equal(settled.rows[0].state, "failed");
    assert.equal(settled.rows[0].attempt_count, 2);
    assert.equal(settled.rows[0].lease_expires_at, null);
    assert.equal(settled.rows[0].last_error, "reaction attempt budget exhausted");

    // A stale generating row BELOW the cap is still retried (and the cap
    // holds at the claim itself): bump it to one attempt with a stale lease
    // and run again — the retry lands on attempt 2, the cap, and a failing
    // generation stops there.
    await pool.query(
      `UPDATE article_reaction
       SET state = 'generating', attempt_count = 1,
           lease_expires_at = now() - interval '1 hour', last_error = 'crashed'`,
    );
    const failing = makeArticleLlm({ unusableReview: true });
    const retried = await runIngestionAttempt(
      {
        pool,
        callLlm: failing,
        log: () => {},
        transport: failingFetch,
        resolveFeedHost: FAKE_RESOLVER,
      },
      "test",
    );
    assert.equal(retried.status, "ok");
    assert.equal(retried.result.failed, 1);
    assert.equal(failing.calls.generation, 1);
    const afterRetry = await pool.query(
      `SELECT state, attempt_count FROM article_reaction`,
    );
    assert.equal(afterRetry.rows[0].attempt_count, 2);
    // At the cap the row is never selected again, on any later attempt.
    const later = await runIngestionAttempt(
      {
        pool,
        callLlm: makeArticleLlm(),
        log: () => {},
        transport: failingFetch,
        resolveFeedHost: FAKE_RESOLVER,
      },
      "test",
    );
    assert.equal(later.result.candidatesAttempted, 0);
    const finalRow = await pool.query(`SELECT attempt_count FROM article_reaction`);
    assert.equal(finalRow.rows[0].attempt_count, 2);
  });

  it("isolates a hostile item from the persistence batch at parse time", async () => {
    await provisionArticleConfig(pool);
    // One good item and one hostile item whose URL is over the cap. The
    // hostile item is skipped at parse time; the good item persists and the
    // batch's transaction is never poisoned.
    const xml = `<rss version="2.0"><channel>
<item>
  <title>Good item</title>
  <link>https://example.com/tea/good</link>
  <description>A perfectly ordinary excerpt.</description>
</item>
<item>
  <title>Hostile item</title>
  <link>https://example.com/${"x".repeat(5000)}</link>
  <description>An oversized-URL item.</description>
</item>
</channel></rss>`;
    const llm = makeArticleLlm();
    const logs = [];
    const summary = await runIngestionAttempt(
      {
        pool,
        callLlm: llm,
        log: (message) => logs.push(message),
        transport: makeFeedTransport({ xml }),
        resolveFeedHost: FAKE_RESOLVER,
      },
      "test",
    );
    assert.equal(summary.status, "ok");
    assert.equal(summary.result.itemsFetched, 1);
    assert.equal(summary.result.itemsNew, 1);
    const items = await pool.query(`SELECT url FROM article_item`);
    assert.deepEqual(items.rows.map((row) => row.url), ["https://example.com/tea/good"]);
    assert.ok(logs.every((message) => !/persistence failed/.test(message)));
  });

  // --- Feed bounding and runtime scheduling ------------------------------------

  it("caps feeds per run and rotates the starting position across runs", async () => {
    await provisionArticleConfig(pool);
    for (let i = 1; i <= 9; i += 1) {
      await pool.query(
        `INSERT INTO article_feed (id, url, enabled, position)
         VALUES ($1, $2, true, $3)`,
        [`feed-${String(i)}`, `https://feeds.example.com/f${String(i)}.xml`, i],
      );
    }
    // Ten enabled feeds (feed-a plus these nine): one run attempts at most
    // MAX_FEEDS_PER_RUN, in position order from the rotation start.
    const llm = makeArticleLlm();
    const transport = makeFeedTransport({ xml: buildFeedXml() });
    const deps = { pool, callLlm: llm, log: () => {}, transport, resolveFeedHost: FAKE_RESOLVER };
    const first = await runIngestionAttempt(deps, "test");
    assert.equal(first.status, "ok");
    assert.equal(first.feedsAvailable, 10);
    assert.equal(first.result.feedsAttempted, MAX_FEEDS_PER_RUN);
    // Rotation: the next run starts past the attempted feeds and wraps, so
    // the capped tail feeds AND the head feeds rotate through over
    // successive runs — no enabled feed is starved by the cap.
    const second = await runIngestionAttempt(deps, "test", { feedStartIndex: 8 });
    assert.equal(second.result.feedsAttempted, MAX_FEEDS_PER_RUN);
    const expectedUrls = [
      "https://feeds.example.com/tea.xml",
      ...Array.from({ length: 9 }, (_, i) => `https://feeds.example.com/f${String(i + 1)}.xml`),
    ];
    const rotated = [
      expectedUrls[8], expectedUrls[9],
      ...expectedUrls.slice(0, MAX_FEEDS_PER_RUN - 2),
    ];
    assert.deepEqual(
      transport.seenUrls,
      [...expectedUrls.slice(0, MAX_FEEDS_PER_RUN), ...rotated],
    );
  });

  it("coalesces interval ticks into at most one queued attempt", async (t) => {
    await provisionArticleConfig(pool);
    await pool.query(`UPDATE article_behavior SET max_generations_per_run = 1`);
    const llm = makeArticleLlm({ gated: true });
    const transport = makeFeedTransport({ xml: buildFeedXml() });
    // Virtual time for the runtime's interval: ticks only fire when this
    // test advances them. Real timers stay available for the wait helpers.
    t.mock.timers.enable({ apis: ["setInterval"] });
    const runtime = startArticleRuntime({
      pool,
      callLlm: llm,
      log: () => {},
      pollIntervalMs: 60_000,
      transport,
      resolveFeedHost: FAKE_RESOLVER,
    });
    try {
      // The startup attempt runs immediately and stalls inside its gated
      // provider call.
      await waitForRow(pool, `SELECT 1 FROM article_reaction WHERE state = 'generating'`);
      // Five interval ticks fire while the attempt runs. They must coalesce
      // into at most ONE queued follow-up attempt, not one attempt per tick.
      for (let i = 0; i < 5; i += 1) t.mock.timers.tick(60_000);
      llm.releaseGate();
      // The gated attempt completes, then exactly the one coalesced attempt
      // runs (its fetch is the second and last).
      for (let i = 0; i < 400 && transport.seenUrls.length < 2; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(transport.seenUrls.length, 2);
    } finally {
      await runtime.close();
    }
  });

  // --- Retrieval --------------------------------------------------------------

  it("serves deterministic newest-first accepted memories with a caller-configurable limit", async () => {
    await provisionArticleConfig(pool);
    await seedAcceptedReaction(pool, {
      url: "https://example.com/tea/one",
      title: "First article",
      excerpt: "First excerpt.",
      reaction: "First reaction text.",
      factKey: "article:00000000-0000-4000-8000-000000000001",
      generatedAt: new Date("2026-11-01T10:00:00Z"),
    });
    await seedAcceptedReaction(pool, {
      url: "https://example.com/tea/two",
      title: "Second article",
      excerpt: "Second excerpt.",
      reaction: "Second reaction text.",
      factKey: "article:00000000-0000-4000-8000-000000000002",
      generatedAt: new Date("2026-11-02T10:00:00Z"),
    });
    await seedAcceptedReaction(pool, {
      url: "https://example.com/tea/three",
      title: "Third article",
      excerpt: "Third excerpt.",
      reaction: "Third reaction text.",
      factKey: "article:00000000-0000-4000-8000-000000000003",
      generatedAt: new Date("2026-11-03T10:00:00Z"),
    });
    // A rejected reaction must never appear on the retrieval surface.
    await pool.query(
      `INSERT INTO article_item (feed_id, url, title, excerpt, fetched_at)
       VALUES ('feed-a', 'https://example.com/tea/rejected', 'Rejected article', 'Excerpt.', now())`,
    );
    await pool.query(
      `INSERT INTO article_reaction (item_id, state, attempt_count, last_error)
       SELECT id, 'rejected', 1, 'off persona' FROM article_item
       WHERE url = 'https://example.com/tea/rejected'`,
    );

    const all = await getRecentArticleMemories(pool, {});
    assert.equal(all.limit, 20);
    assert.deepEqual(
      all.results.map((item) => item.title),
      ["Third article", "Second article", "First article"],
    );
    assert.equal(all.results[0].factKey, "article:00000000-0000-4000-8000-000000000003");
    assert.ok(all.results[0].reaction.length > 0);

    // Caller-configurable limits: 1 and 5 (5 exceeds the corpus; the response
    // carries every available result).
    const one = await getRecentArticleMemories(pool, { limit: 1 });
    assert.equal(one.limit, 1);
    assert.deepEqual(one.results.map((item) => item.title), ["Third article"]);
    const five = await getRecentArticleMemories(pool, { limit: 5 });
    assert.equal(five.limit, 5);
    assert.equal(five.results.length, 3);

    // Out-of-range and non-integer limits are validation errors (the API maps
    // them to 400).
    for (const bad of [0, -3, 101, 2.5]) {
      await assert.rejects(
        () => getRecentArticleMemories(pool, { limit: bad }),
        ArticleMemoriesValidationError,
      );
    }
  });

  it("serves the article-memory retrieval over the private API with auth and limits", async () => {
    await provisionArticleConfig(pool);
    await seedAcceptedReaction(pool, {
      url: "https://example.com/tea/one",
      title: "First article",
      excerpt: "First excerpt.",
      reaction: "First reaction text.",
      factKey: "article:00000000-0000-4000-8000-000000000001",
      generatedAt: new Date("2026-11-01T10:00:00Z"),
    });
    await seedAcceptedReaction(pool, {
      url: "https://example.com/tea/two",
      title: "Second article",
      excerpt: "Second excerpt.",
      reaction: "Second reaction text.",
      factKey: "article:00000000-0000-4000-8000-000000000002",
      generatedAt: new Date("2026-11-02T10:00:00Z"),
    });

    const server = createApiServer({
      store,
      token: "test-api-token",
      host: "127.0.0.1",
      port: 0,
      articleMemories: (input) => getRecentArticleMemories(pool, input),
    });
    const port = await server.start();
    try {
      const base = `http://127.0.0.1:${String(port)}`;
      const authorized = await fetch(`${base}/v1/articles/memories`, {
        headers: { authorization: "Bearer test-api-token" },
      });
      assert.equal(authorized.status, 200);
      const body = await authorized.json();
      assert.equal(body.limit, 20);
      assert.equal(body.results.length, 2);
      assert.equal(body.results[0].title, "Second article");

      const limited = await fetch(`${base}/v1/articles/memories?limit=1`, {
        headers: { authorization: "Bearer test-api-token" },
      });
      assert.equal(limited.status, 200);
      const limitedBody = await limited.json();
      assert.equal(limitedBody.limit, 1);
      assert.equal(limitedBody.results.length, 1);
      assert.equal(limitedBody.results[0].title, "Second article");

      const unauthenticated = await fetch(`${base}/v1/articles/memories`);
      assert.equal(unauthenticated.status, 401);
      const wrongMethod = await fetch(`${base}/v1/articles/memories`, {
        method: "POST",
        headers: { authorization: "Bearer test-api-token" },
      });
      assert.equal(wrongMethod.status, 405);
      const badLimit = await fetch(`${base}/v1/articles/memories?limit=0`, {
        headers: { authorization: "Bearer test-api-token" },
      });
      assert.equal(badLimit.status, 400);
      const hugeLimit = await fetch(`${base}/v1/articles/memories?limit=999`, {
        headers: { authorization: "Bearer test-api-token" },
      });
      assert.equal(hugeLimit.status, 400);
      const notInteger = await fetch(`${base}/v1/articles/memories?limit=abc`, {
        headers: { authorization: "Bearer test-api-token" },
      });
      assert.equal(notInteger.status, 400);
    } finally {
      await server.close();
    }

    // A server without the article surface wired reports it unavailable
    // rather than serving an empty imitation.
    const bare = createApiServer({
      store,
      token: "test-api-token",
      host: "127.0.0.1",
      port: 0,
    });
    const barePort = await bare.start();
    try {
      const response = await fetch(
        `http://127.0.0.1:${String(barePort)}/v1/articles/memories`,
        { headers: { authorization: "Bearer test-api-token" } },
      );
      assert.equal(response.status, 503);
    } finally {
      await bare.close();
    }
  });

  // --- Per-turn article-memory share decision ---------------------------------

  it("offers cooldown-eligible accepted reactions with recall dedupe and a bounded candidate cap", async () => {
    await provisionArticleConfig(pool);
    const oldest = await seedAcceptedReaction(pool, {
      url: "https://example.com/tea/one",
      title: "First article",
      excerpt: "First excerpt.",
      reaction: "First reaction text.",
      factKey: "article:00000000-0000-4000-8000-000000000001",
      generatedAt: new Date("2026-11-01T10:00:00Z"),
    });
    const newest = await seedAcceptedReaction(pool, {
      url: "https://example.com/tea/two",
      title: "Second article",
      excerpt: "Second excerpt.",
      reaction: "Second reaction text.",
      factKey: "article:00000000-0000-4000-8000-000000000002",
      generatedAt: new Date("2026-11-02T10:00:00Z"),
    });

    // Unprovisioned or disabled deployments ask no question: null, no throw.
    await pool.query(`DELETE FROM article_behavior`);
    assert.equal(await loadArticleShareContext(pool, {}), null);
    await pool.query(ARTICLE_BEHAVIOR_SQL);
    await pool.query(`UPDATE article_behavior SET enabled = false WHERE id = 'behavior'`);
    assert.equal(await loadArticleShareContext(pool, {}), null);
    await pool.query(`UPDATE article_behavior SET enabled = true WHERE id = 'behavior'`);

    const context = await loadArticleShareContext(pool, {});
    assert.ok(context !== null);
    assert.deepEqual(
      context.candidates.map((candidate) => candidate.reactionId),
      [newest, oldest],
    );
    assert.equal(context.candidates[0].factKey, "article:00000000-0000-4000-8000-000000000002");

    // A fact the lexical recall chunk already surfaced is not offered again.
    const deduped = await loadArticleShareContext(pool, {
      recallFactKeys: ["article:00000000-0000-4000-8000-000000000002"],
    });
    assert.ok(deduped !== null);
    assert.deepEqual(
      deduped.candidates.map((candidate) => candidate.reactionId),
      [oldest],
    );

    // The candidate cap is the configured decision_max_candidates.
    await pool.query(`UPDATE article_behavior SET decision_max_candidates = 1`);
    const capped = await loadArticleShareContext(pool, {});
    assert.ok(capped !== null);
    assert.equal(capped.candidates.length, 1);
    assert.equal(capped.candidates[0].reactionId, newest);
    await pool.query(`UPDATE article_behavior SET decision_max_candidates = 3`);

    // A prompt inclusion starts the cooldown: the reaction is not offered
    // again until the window has passed.
    const turnId = await insertTestTurn(pool);
    const now = new Date("2026-11-03T10:00:00Z");
    await recordArticleShareInclusion(pool, { turnId, reactionId: newest, now });
    const cooled = await loadArticleShareContext(pool, { now });
    assert.ok(cooled !== null);
    assert.deepEqual(
      cooled.candidates.map((candidate) => candidate.reactionId),
      [oldest],
    );
    const afterCooldown = await loadArticleShareContext(pool, {
      now: new Date(now.getTime() + 61 * 60_000),
    });
    assert.ok(afterCooldown !== null);
    assert.deepEqual(
      afterCooldown.candidates.map((candidate) => candidate.reactionId),
      [newest, oldest],
    );
  });

  it("records prompt inclusions idempotently per reaction and turn", async () => {
    await provisionArticleConfig(pool);
    const reactionId = await seedAcceptedReaction(pool, {
      url: "https://example.com/tea/one",
      title: "First article",
      excerpt: "First excerpt.",
      reaction: "First reaction text.",
      factKey: "article:00000000-0000-4000-8000-000000000001",
      generatedAt: new Date("2026-11-01T10:00:00Z"),
    });
    const turnId = await insertTestTurn(pool);

    await recordArticleShareInclusion(pool, { turnId, reactionId });
    await recordArticleShareInclusion(pool, { turnId, reactionId });
    const rows = await pool.query(
      `SELECT count(*)::int AS n FROM article_share WHERE reaction_id = $1 AND turn_id = $2`,
      [reactionId, turnId],
    );
    assert.equal(rows.rows[0].n, 1);

    // A second turn is a distinct inclusion.
    const secondTurnId = await insertTestTurn(pool);
    await recordArticleShareInclusion(pool, { turnId: secondTurnId, reactionId });
    const all = await pool.query(
      `SELECT count(*)::int AS n FROM article_share WHERE reaction_id = $1`,
      [reactionId],
    );
    assert.equal(all.rows[0].n, 2);

    // The inclusion trace is metadata-only.
    const ops = await pool.query(
      `SELECT outcome, detail FROM memory_operation WHERE kind = 'article_memory_share'`,
    );
    assert.ok(ops.rows.length >= 1);
    assert.equal(ops.rows[0].outcome, "ok");
    assert.ok(!ops.rows.some((row) => row.detail.includes("First reaction text")));
  });

  it("includes the chosen article memory as its own chat chunk and records the inclusion", async () => {
    await provisionArticleConfig(pool);
    const reactionId = await seedAcceptedReaction(pool, {
      url: "https://example.com/tea/one",
      title: "First article",
      excerpt: "First excerpt.",
      reaction: "First reaction text.",
      factKey: "article:00000000-0000-4000-8000-000000000001",
      generatedAt: new Date("2026-11-01T10:00:00Z"),
    });
    const turnId = await insertTestTurn(pool);

    const chatRequests = [];
    const outcome = await processTurnWork(
      {
        turn: { id: turnId, status: "in_flight", attempt: 1, lease_owner: "turn-owner", lease_expires_at: new Date(Date.now() + 300_000) },
        messages: [{ id: "m-1", role: "user", content: "What have you been reading?" }],
      },
      {
        decisionModel: "decision-model",
        chatModel: "chat-model",
        callDecisions: async (request) => {
          // The decision request carries ONLY the article question (no
          // patterns are enabled), including the permanent none option.
          assert.deepEqual(Object.keys(request.questions), [ARTICLE_SHARE_QUESTION_ID]);
          const criteria = request.questions[ARTICLE_SHARE_QUESTION_ID].criteria;
          assert.ok(Object.keys(criteria).includes(ARTICLE_SHARE_NONE_CHOICE));
          assert.ok(Object.keys(criteria).includes(reactionId));
          return {
            model: "decision-model-build",
            answers: {
              [ARTICLE_SHARE_QUESTION_ID]: { type: "choice", choice: reactionId },
            },
            usage: { input_tokens: 5, output_tokens: 2 },
          };
        },
        callChat: async (request) => {
          chatRequests.push(request);
          return {
            id: "chat-1",
            model: "chat-model-build",
            choices: [
              { message: { role: "assistant", content: "reply" }, finish_reason: "stop" },
            ],
            usage: { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 },
          };
        },
        loadIdentity: async () => ({ content: "FIXTURE IDENTITY", revision: 1 }),
        loadPatterns: async () => [],
        loadContext: async () => [],
        loadMemoryContext: async () => ({
          memoryContext: "RECALL CHUNK",
          recallFactKeys: [],
        }),
        loadArticleShareCandidates: async ({ recallFactKeys }) =>
          loadArticleShareContext(pool, { recallFactKeys }).then(
            (context) => context?.candidates ?? null,
          ),
        recordArticleShareInclusion: async (input) =>
          recordArticleShareInclusion(pool, input),
      },
    );
    assert.equal(outcome.reply, "reply");

    // Chunk order: identity, recall, article, then the conversation. The
    // article chunk is background context with provenance; it never claims a
    // share happened.
    assert.equal(chatRequests.length, 1);
    const messages = chatRequests[0].messages;
    assert.equal(messages.length, 4);
    assert.equal(messages[0].role, "system");
    assert.equal(messages[0].content, "FIXTURE IDENTITY");
    assert.equal(messages[1].role, "system");
    assert.equal(messages[1].content, "RECALL CHUNK");
    assert.equal(messages[2].role, "system");
    assert.match(messages[2].content, /^An article you read earlier/);
    assert.match(messages[2].content, /First article/);
    assert.match(messages[2].content, /Reaction you noted at the time:/);
    assert.doesNotMatch(messages[2].content, /you (already )?(told|said|shared)/i);
    assert.equal(messages[3].role, "user");
    assert.equal(messages[3].content, "What have you been reading?");

    // The inclusion record exists exactly once for the turn.
    const shares = await pool.query(
      `SELECT count(*)::int AS n FROM article_share WHERE reaction_id = $1 AND turn_id = $2`,
      [reactionId, turnId],
    );
    assert.equal(shares.rows[0].n, 1);
  });

  it("includes nothing when the share decision selects none", async () => {
    await provisionArticleConfig(pool);
    await seedAcceptedReaction(pool, {
      url: "https://example.com/tea/one",
      title: "First article",
      excerpt: "First excerpt.",
      reaction: "First reaction text.",
      factKey: "article:00000000-0000-4000-8000-000000000001",
      generatedAt: new Date("2026-11-01T10:00:00Z"),
    });
    const turnId = await insertTestTurn(pool);

    const chatRequests = [];
    const outcome = await processTurnWork(
      {
        turn: { id: turnId, status: "in_flight", attempt: 1, lease_owner: "turn-owner", lease_expires_at: new Date(Date.now() + 300_000) },
        messages: [{ id: "m-1", role: "user", content: "hello there" }],
      },
      {
        decisionModel: "decision-model",
        chatModel: "chat-model",
        callDecisions: async () => ({
          model: "decision-model-build",
          answers: {
            [ARTICLE_SHARE_QUESTION_ID]: { type: "choice", choice: ARTICLE_SHARE_NONE_CHOICE },
          },
          usage: { input_tokens: 5, output_tokens: 2 },
        }),
        callChat: async (request) => {
          chatRequests.push(request);
          return {
            id: "chat-2",
            model: "chat-model-build",
            choices: [
              { message: { role: "assistant", content: "reply" }, finish_reason: "stop" },
            ],
            usage: { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 },
          };
        },
        loadIdentity: async () => ({ content: "FIXTURE IDENTITY", revision: 1 }),
        loadPatterns: async () => [],
        loadContext: async () => [],
        loadArticleShareCandidates: async ({ recallFactKeys }) =>
          loadArticleShareContext(pool, { recallFactKeys }).then(
            (context) => context?.candidates ?? null,
          ),
        recordArticleShareInclusion: async (input) =>
          recordArticleShareInclusion(pool, input),
      },
    );
    assert.equal(outcome.reply, "reply");

    // `none` includes nothing: no article chunk, no inclusion row. Mentioning
    // is never a requirement.
    assert.equal(chatRequests.length, 1);
    assert.deepEqual(
      chatRequests[0].messages.map((message) => `${message.role}:${message.content}`),
      ["system:FIXTURE IDENTITY", "user:hello there"],
    );
    const shares = await pool.query(
      `SELECT count(*)::int AS n FROM article_share WHERE turn_id = $1`,
      [turnId],
    );
    assert.equal(shares.rows[0].n, 0);
  });

  it("fails the turn on an unusable share answer, with no silent fallback", async () => {
    await provisionArticleConfig(pool);
    await seedAcceptedReaction(pool, {
      url: "https://example.com/tea/one",
      title: "First article",
      excerpt: "First excerpt.",
      reaction: "First reaction text.",
      factKey: "article:00000000-0000-4000-8000-000000000001",
      generatedAt: new Date("2026-11-01T10:00:00Z"),
    });
    const turnId = await insertTestTurn(pool);

    await assert.rejects(
      () =>
        processTurnWork(
          {
            turn: { id: turnId, status: "in_flight", attempt: 1, lease_owner: "turn-owner", lease_expires_at: new Date(Date.now() + 300_000) },
            messages: [{ id: "m-1", role: "user", content: "hello there" }],
          },
          {
            decisionModel: "decision-model",
            chatModel: "chat-model",
            callDecisions: async () => ({
              model: "decision-model-build",
              answers: {
                [ARTICLE_SHARE_QUESTION_ID]: { type: "choice", choice: "not-offered" },
              },
              usage: { input_tokens: 5, output_tokens: 2 },
            }),
            callChat: async () => {
              throw new Error("chat must not be called after an unusable decision");
            },
            loadIdentity: async () => ({ content: "FIXTURE IDENTITY", revision: 1 }),
            loadPatterns: async () => [],
            loadContext: async () => [],
            loadArticleShareCandidates: async ({ recallFactKeys }) =>
              loadArticleShareContext(pool, { recallFactKeys }).then(
                (context) => context?.candidates ?? null,
              ),
            recordArticleShareInclusion: async (input) =>
              recordArticleShareInclusion(pool, input),
          },
        ),
      /not an offered option/,
    );
  });

  // --- Turn-free article interest consolidation -------------------------------

  it("consolidates independent article reactions into an assistant interest observation", async () => {
    await provisionArticleConfig(pool);
    await seedAcceptedReaction(pool, {
      url: "https://example.com/tea/one",
      title: "First article",
      excerpt: "First excerpt.",
      reaction: "First reaction text.",
      factKey: "article:00000000-0000-4000-8000-000000000001",
      generatedAt: new Date("2026-11-01T10:00:00Z"),
    });
    await seedAcceptedReaction(pool, {
      url: "https://example.com/tea/two",
      title: "Second article",
      excerpt: "Second excerpt.",
      reaction: "Second reaction text.",
      factKey: "article:00000000-0000-4000-8000-000000000002",
      generatedAt: new Date("2026-11-02T10:00:00Z"),
    });

    // The model only groups claims and cites the fact ids; subject and kind
    // are code-owned (assistant, preference).
    const llm = makeArticleLlm({
      observations: [
        {
          claim: "Drawn to thoughtful tea writing",
          topics: ["tea", "writing"],
          sourceFactIds: [
            "article:00000000-0000-4000-8000-000000000002",
            "article:00000000-0000-4000-8000-000000000001",
          ],
        },
      ],
    });
    const outcome = await runArticleObservationConsolidation({ pool, callLlm: llm });
    assert.equal(outcome.status, "ok");
    assert.equal(outcome.factCount, 2);
    assert.equal(outcome.accepted, 1);
    assert.equal(outcome.omitted, 0);

    const run = await pool.query(
      `SELECT run_id, status, max_turns, observation_count FROM memory_run`,
    );
    assert.equal(run.rows.length, 1);
    assert.equal(run.rows[0].status, "observations-ready");
    // Turn-free evidence path: the run's turn bound is zero, and the
    // observation records ZERO turn evidence (breadth is distinct reactions).
    assert.equal(run.rows[0].max_turns, 0);
    assert.equal(run.rows[0].observation_count, 1);

    const observation = await pool.query(
      `SELECT subject_id, kind, claim, status, support_count, distinct_turn_count,
              consolidation_version
       FROM memory_observation`,
    );
    assert.equal(observation.rows.length, 1);
    assert.equal(observation.rows[0].subject_id, "assistant");
    assert.equal(observation.rows[0].kind, "preference");
    assert.equal(observation.rows[0].claim, "Drawn to thoughtful tea writing");
    assert.equal(observation.rows[0].status, "active");
    assert.equal(observation.rows[0].support_count, 2);
    assert.equal(observation.rows[0].distinct_turn_count, 0);
    assert.equal(observation.rows[0].consolidation_version, CONSOLIDATION_PROMPT_VERSION);

    const evidence = await pool.query(
      `SELECT role FROM memory_observation_evidence ORDER BY position`,
    );
    assert.equal(evidence.rows.length, 2);
    assert.deepEqual([...new Set(evidence.rows.map((row) => row.role))], ["support"]);

    // Promotion through the standard engine: the article-sourced observation
    // becomes a canonical interest with the article facts as independent
    // evidence.
    const plan = await buildPromotionPlan(pool, {
      runId: run.rows[0].run_id,
      skipTentative: true,
      behavior: BEHAVIOR,
    });
    assert.equal(plan.itemCount, 1);
    const promotion = await promoteRun(pool, {
      runId: run.rows[0].run_id,
      confirmationToken: plan.confirmationToken,
      skipTentative: true,
      behavior: BEHAVIOR,
    });
    assert.equal(promotion.status, "completed");
    assert.equal(promotion.created, 1);
    const canonical = await pool.query(
      `SELECT subject_id, kind, status, source_fact_keys, distinct_turn_count
       FROM memory_canonical_observation`,
    );
    assert.equal(canonical.rows.length, 1);
    assert.equal(canonical.rows[0].subject_id, "assistant");
    assert.equal(canonical.rows[0].kind, "preference");
    assert.equal(canonical.rows[0].status, "active");
    assert.equal(canonical.rows[0].distinct_turn_count, 0);
    assert.deepEqual(
      [...canonical.rows[0].source_fact_keys].sort(),
      [
        "article:00000000-0000-4000-8000-000000000001",
        "article:00000000-0000-4000-8000-000000000002",
      ],
    );
    const verification = await verifyPromotion(pool, promotion.promotionId);
    assert.equal(verification.valid, true);
  });

  it("records an omission when a candidate rests on a single independent source", async () => {
    await provisionArticleConfig(pool);
    await seedAcceptedReaction(pool, {
      url: "https://example.com/tea/one",
      title: "First article",
      excerpt: "First excerpt.",
      reaction: "First reaction text.",
      factKey: "article:00000000-0000-4000-8000-000000000001",
      generatedAt: new Date("2026-11-01T10:00:00Z"),
    });
    await seedAcceptedReaction(pool, {
      url: "https://example.com/tea/two",
      title: "Second article",
      excerpt: "Second excerpt.",
      reaction: "Second reaction text.",
      factKey: "article:00000000-0000-4000-8000-000000000002",
      generatedAt: new Date("2026-11-02T10:00:00Z"),
    });

    const llm = makeArticleLlm({
      observations: [
        {
          claim: "Only one article supports this",
          topics: ["tea"],
          sourceFactIds: ["article:00000000-0000-4000-8000-000000000001"],
        },
      ],
    });
    const outcome = await runArticleObservationConsolidation({ pool, callLlm: llm });
    assert.equal(outcome.status, "ok");
    assert.equal(outcome.accepted, 0);
    assert.equal(outcome.omitted, 1);

    const omission = await pool.query(
      `SELECT reason, support_count, distinct_turn_count FROM memory_observation_omission`,
    );
    assert.equal(omission.rows.length, 1);
    assert.equal(omission.rows[0].reason, "insufficient_independent_sources");
    assert.equal(omission.rows[0].support_count, 1);
    assert.equal(omission.rows[0].distinct_turn_count, 0);
    // No accepted candidate: the run is terminally failed so promotion never
    // retries it, and the facts stay pending for a later attempt.
    const run = await pool.query(`SELECT status, error FROM memory_run`);
    assert.equal(run.rows[0].status, "failed");
    assert.equal(run.rows[0].error, "no_accepted_article_interest_candidates");
    // The omitted candidate's own fact is now referenced by omission
    // evidence; only the untouched second fact stays pending for a later
    // attempt.
    const pending = await pool.query(
      `SELECT count(*)::int AS n FROM memory_fact f
       WHERE f.source_type = 'article'
         AND NOT EXISTS (SELECT 1 FROM memory_observation_evidence e WHERE e.fact_id = f.id)
         AND NOT EXISTS (SELECT 1 FROM memory_observation_omission_evidence e WHERE e.fact_id = f.id)`,
    );
    assert.equal(pending.rows[0].n, 1);
  });

  it("skips consolidation as a rollout state without unconsolidated reactions", async () => {
    await provisionArticleConfig(pool);
    const llm = makeArticleLlm();
    const outcome = await runArticleObservationConsolidation({ pool, callLlm: llm });
    assert.equal(outcome.status, "skipped");
    assert.equal(outcome.reason, "insufficient_unconsolidated_reactions");
    assert.equal(llm.calls.consolidation, 0);

    // A missing behavioral boundary is also a skip, not a failure.
    await pool.query(`DELETE FROM memory_behavior`);
    const outcome2 = await runArticleObservationConsolidation({ pool, callLlm: llm });
    assert.equal(outcome2.status, "skipped");
    assert.equal(outcome2.reason, "behavior_boundary_not_provisioned");
  });

  it("bounds the consolidation batch by characters and still makes progress", async () => {
    await provisionArticleConfig(pool);
    // Twelve accepted reactions with long claims: the COUNT selector bounds
    // the batch at twelve, but the rendered source would exceed the source
    // cap, which used to fail the run and then re-select the same batch
    // forever. The batch is trimmed to what fits and the rest stays pending.
    for (let i = 1; i <= 12; i += 1) {
      await seedAcceptedReaction(pool, {
        url: `https://example.com/tea/batch-${String(i).padStart(2, "0")}`,
        title: `Batch article ${String(i)}`,
        excerpt: "Excerpt.",
        reaction: `r`.repeat(1700) + ` #${String(i)}`,
        factKey: `article:batch-${String(i).padStart(2, "0")}`,
        generatedAt: new Date(Date.parse(`2026-11-01T10:00:00Z`) + i * 60_000),
      });
    }
    const llm = makeArticleLlm({ consolidateFromRenderedFacts: true });
    const first = await runArticleObservationConsolidation({ pool, callLlm: llm });
    // The regression this test pins: an oversized batch used to FAIL the run
    // and then re-select the same batch forever. The trimmed batch runs ok.
    assert.equal(first.status, "ok");
    assert.ok(first.factCount < 12, `expected a trimmed batch, got ${String(first.factCount)}`);
    assert.ok(first.factCount >= 2, `expected the minimum batch, got ${String(first.factCount)}`);
    assert.equal(llm.calls.consolidation, 1);

    // Progress: only the facts the model cites become evidence-linked, so
    // unconsolidated facts are re-selected on later attempts (bounded, and
    // each attempt either cites more facts or trims them in). Successive
    // runs must keep succeeding until every reaction is consolidated.
    const pendingCount = async () =>
      (await pool.query(
        `SELECT count(*)::int AS n FROM memory_fact f
         WHERE f.source_type = 'article'
           AND NOT EXISTS (SELECT 1 FROM memory_observation_evidence e WHERE e.fact_id = f.id)
           AND NOT EXISTS (SELECT 1 FROM memory_observation_omission_evidence e WHERE e.fact_id = f.id)`,
      )).rows[0].n;
    let previous = await pendingCount();
    assert.ok(previous < 12);
    for (let i = 0; i < 8 && previous > 0; i += 1) {
      const outcome = await runArticleObservationConsolidation({ pool, callLlm: llm });
      assert.equal(outcome.status, "ok");
      const now = await pendingCount();
      assert.ok(now < previous, `expected progress, pending ${String(now)} after ${String(previous)}`);
      previous = now;
    }
    assert.equal(previous, 0);
  });

  it("coordinates concurrent consolidation through a durable claim", async () => {
    await provisionArticleConfig(pool);
    await seedAcceptedReaction(pool, {
      url: "https://example.com/tea/one",
      title: "First article",
      excerpt: "First excerpt.",
      reaction: "First reaction text.",
      factKey: "article:00000000-0000-4000-8000-000000000001",
      generatedAt: new Date("2026-11-01T10:00:00Z"),
    });
    await seedAcceptedReaction(pool, {
      url: "https://example.com/tea/two",
      title: "Second article",
      excerpt: "Second excerpt.",
      reaction: "Second reaction text.",
      factKey: "article:00000000-0000-4000-8000-000000000002",
      generatedAt: new Date("2026-11-02T10:00:00Z"),
    });

    // Worker A claims the phase and stalls inside its provider call.
    const llmA = makeArticleLlm({ consolidateFromRenderedFacts: true, gated: true });
    const attemptA = runArticleObservationConsolidation({ pool, callLlm: llmA });
    await waitForRow(pool, `SELECT 1 FROM article_observation_claim`);

    // Worker B observes the live claim and runs nothing — no duplicate
    // provider call, no second run, no artifacts.
    const llmB = makeArticleLlm();
    const outcomeB = await runArticleObservationConsolidation({ pool, callLlm: llmB });
    assert.equal(outcomeB.status, "skipped");
    assert.equal(outcomeB.reason, "consolidation_in_progress_elsewhere");
    assert.equal(llmB.calls.consolidation, 0);

    llmA.releaseGate();
    const outcomeA = await attemptA;
    assert.equal(outcomeA.status, "ok");
    // Exactly one provider call and one artifact set across both workers,
    // and the claim is released on completion.
    assert.equal(llmA.calls.consolidation + llmB.calls.consolidation, 1);
    const runs = await pool.query(`SELECT count(*)::int AS n FROM memory_run`);
    assert.equal(runs.rows[0].n, 1);
    const observations = await pool.query(`SELECT count(*)::int AS n FROM memory_observation`);
    assert.equal(observations.rows[0].n, 1);
    const claims = await pool.query(`SELECT count(*)::int AS n FROM article_observation_claim`);
    assert.equal(claims.rows[0].n, 0);
  });

  it("recovers an expired consolidation claim and fences the stalled worker", async () => {
    await provisionArticleConfig(pool);
    await seedAcceptedReaction(pool, {
      url: "https://example.com/tea/one",
      title: "First article",
      excerpt: "First excerpt.",
      reaction: "First reaction text.",
      factKey: "article:00000000-0000-4000-8000-000000000001",
      generatedAt: new Date("2026-11-01T10:00:00Z"),
    });
    await seedAcceptedReaction(pool, {
      url: "https://example.com/tea/two",
      title: "Second article",
      excerpt: "Second excerpt.",
      reaction: "Second reaction text.",
      factKey: "article:00000000-0000-4000-8000-000000000002",
      generatedAt: new Date("2026-11-02T10:00:00Z"),
    });

    // Worker A claims with a lease short enough to expire while it stalls
    // inside its provider call (a simulated crash).
    const llmA = makeArticleLlm({ consolidateFromRenderedFacts: true, gated: true });
    const attemptA = runArticleObservationConsolidation({
      pool,
      callLlm: llmA,
      consolidationLeaseMs: 5,
    });
    await waitForRow(pool, `SELECT 1 FROM article_observation_claim`);
    await new Promise((resolve) => setTimeout(resolve, 30));

    // Worker B takes the expired lease over and completes the phase.
    const llmB = makeArticleLlm({ consolidateFromRenderedFacts: true });
    const outcomeB = await runArticleObservationConsolidation({ pool, callLlm: llmB });
    assert.equal(outcomeB.status, "ok");
    assert.equal(llmB.calls.consolidation, 1);

    // A's call resolves late; its artifact writes are fenced out by the
    // claim it no longer holds, so its run fails without duplicating
    // artifacts or evidence.
    llmA.releaseGate();
    const outcomeA = await attemptA;
    assert.equal(outcomeA.status, "failed");
    const runs = await pool.query(`SELECT status FROM memory_run ORDER BY run_id`);
    assert.deepEqual(runs.rows.map((row) => row.status).sort(), [
      "failed",
      "observations-ready",
    ]);
    const artifacts = await pool.query(`SELECT count(*)::int AS n FROM memory_observation`);
    assert.equal(artifacts.rows[0].n, 1);
    // Evidence exists exactly once per fact — never duplicated by A's late
    // writes.
    const evidence = await pool.query(
      `SELECT fact_id, count(*)::int AS n FROM memory_observation_evidence GROUP BY fact_id`,
    );
    assert.equal(evidence.rows.length, 2);
    assert.ok(evidence.rows.every((row) => row.n === 1));
    const claims = await pool.query(`SELECT count(*)::int AS n FROM article_observation_claim`);
    assert.equal(claims.rows[0].n, 0);
  });

  it("never writes artifacts under an expired lease when nobody takes over", async () => {
    await provisionArticleConfig(pool);
    await seedAcceptedReaction(pool, {
      url: "https://example.com/tea/one",
      title: "First article",
      excerpt: "First excerpt.",
      reaction: "First reaction text.",
      factKey: "article:00000000-0000-4000-8000-000000000001",
      generatedAt: new Date("2026-11-01T10:00:00Z"),
    });
    await seedAcceptedReaction(pool, {
      url: "https://example.com/tea/two",
      title: "Second article",
      excerpt: "Second excerpt.",
      reaction: "Second reaction text.",
      factKey: "article:00000000-0000-4000-8000-000000000002",
      generatedAt: new Date("2026-11-02T10:00:00Z"),
    });

    // Worker A claims with a lease short enough to expire while it stalls
    // inside its provider call, and NOBODY takes the claim over: the claim
    // row still names A, but its lease is dead.
    const llmA = makeArticleLlm({ consolidateFromRenderedFacts: true, gated: true });
    const attemptA = runArticleObservationConsolidation({
      pool,
      callLlm: llmA,
      consolidationLeaseMs: 5,
    });
    await waitForRow(pool, `SELECT 1 FROM article_observation_claim`);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const holder = await pool.query(`SELECT owner FROM article_observation_claim`);
    assert.equal(holder.rows.length, 1);

    // A's artifact commit must fail closed: an expired lease is a lost claim
    // even though ownership was never transferred. (Before the fence checked
    // lease liveness, A committed artifacts under a dead lease here.)
    llmA.releaseGate();
    const outcomeA = await attemptA;
    assert.equal(outcomeA.status, "failed");
    const observations = await pool.query(
      `SELECT count(*)::int AS n FROM memory_observation`,
    );
    assert.equal(observations.rows[0].n, 0);
    const evidence = await pool.query(
      `SELECT count(*)::int AS n FROM memory_observation_evidence`,
    );
    assert.equal(evidence.rows[0].n, 0);

    // The phase is not wedged: a fresh worker claims the expired lease and
    // completes it.
    const llmB = makeArticleLlm({ consolidateFromRenderedFacts: true });
    const outcomeB = await runArticleObservationConsolidation({ pool, callLlm: llmB });
    assert.equal(outcomeB.status, "ok");
    assert.equal(llmB.calls.consolidation, 1);
    const claims = await pool.query(
      `SELECT count(*)::int AS n FROM article_observation_claim`,
    );
    assert.equal(claims.rows[0].n, 0);
  });

  it("serializes the artifact fence against takeover with the claim row lock", async () => {
    // Direct proof of the serialization the fence relies on: a transaction
    // holding the claim row lock (the fence's SELECT ... FOR UPDATE) blocks
    // the takeover's conflict-update path until it commits, so a check/write
    // interleaving with a concurrent takeover cannot tear state.
    await pool.query(
      `INSERT INTO article_observation_claim (id, owner, lease_expires_at)
       VALUES ('consolidation', 'worker-a', now() + interval '1 hour')`,
    );
    const holder = await pool.connect();
    const taker = await pool.connect();
    try {
      // The artifact-fence shape: verify the exact live lease FOR UPDATE.
      await holder.query("BEGIN");
      await holder.query(
        `SELECT id FROM article_observation_claim
         WHERE id = 'consolidation' AND owner = 'worker-a' AND lease_expires_at > now()
         FOR UPDATE`,
      );
      // The takeover path (the runner's own INSERT ... ON CONFLICT DO UPDATE)
      // must wait on the locked claim row; a short lock_timeout makes the
      // block observable and deterministic.
      await taker.query("SET lock_timeout = '250ms'");
      await assert.rejects(
        taker.query(
          `INSERT INTO article_observation_claim (id, owner, lease_expires_at)
           VALUES ('consolidation', 'worker-b', now() + interval '1 hour')
           ON CONFLICT (id) DO UPDATE SET owner = 'worker-b', updated_at = now()
           WHERE article_observation_claim.lease_expires_at < now()`,
        ),
        /lock timeout|55P03/i,
      );
      // Nothing changed under the lock: the takeover never committed.
      const midOwner = await pool.query(`SELECT owner FROM article_observation_claim`);
      assert.equal(midOwner.rows[0].owner, "worker-a");
      await holder.query("COMMIT");
      // Once the artifact transaction is done, the lock is released.
      await pool.query(
        `UPDATE article_observation_claim SET lease_expires_at = now() - interval '1 hour'`,
      );
      await taker.query(
        `INSERT INTO article_observation_claim (id, owner, lease_expires_at)
         VALUES ('consolidation', 'worker-b', now() + interval '1 hour')
         ON CONFLICT (id) DO UPDATE SET owner = 'worker-b', updated_at = now()
         WHERE article_observation_claim.lease_expires_at < now()`,
      );
      const takenOver = await pool.query(`SELECT owner FROM article_observation_claim`);
      assert.equal(takenOver.rows[0].owner, "worker-b");
    } finally {
      await pool.query(`DELETE FROM article_observation_claim`).catch(() => undefined);
      holder.release();
      taker.release();
    }
  });

  it("rejects a corrupted article artifact at promotion planning and keeps the normal path", async () => {
    await provisionArticleConfig(pool);
    await seedAcceptedReaction(pool, {
      url: "https://example.com/tea/one",
      title: "First article",
      excerpt: "First excerpt.",
      reaction: "First reaction text.",
      factKey: "article:00000000-0000-4000-8000-000000000001",
      generatedAt: new Date("2026-11-01T10:00:00Z"),
    });
    await seedAcceptedReaction(pool, {
      url: "https://example.com/tea/two",
      title: "Second article",
      excerpt: "Second excerpt.",
      reaction: "Second reaction text.",
      factKey: "article:00000000-0000-4000-8000-000000000002",
      generatedAt: new Date("2026-11-02T10:00:00Z"),
    });
    const llm = makeArticleLlm({
      observations: [
        {
          claim: "Drawn to thoughtful tea writing",
          topics: ["tea", "writing"],
          sourceFactIds: [
            "article:00000000-0000-4000-8000-000000000002",
            "article:00000000-0000-4000-8000-000000000001",
          ],
        },
      ],
    });
    const outcome = await runArticleObservationConsolidation({ pool, callLlm: llm });
    assert.equal(outcome.status, "ok");
    const runId = (await pool.query(`SELECT run_id FROM memory_run`)).rows[0].run_id;
    const artifact = await pool.query(
      `SELECT distinct_day_count, distinct_turn_count FROM memory_observation`,
    );
    // The honest artifact: two reactions on two distinct behavioral days,
    // zero turn breadth.
    assert.equal(artifact.rows[0].distinct_day_count, 2);
    assert.equal(artifact.rows[0].distinct_turn_count, 0);

    // The normal path: promotion planning validates the honest artifact and
    // plans it.
    const normal = await buildPromotionPlan(pool, {
      runId,
      skipTentative: true,
      behavior: BEHAVIOR,
    });
    assert.equal(normal.itemCount, 1);
    assert.equal(normal.summary.creates, 1);

    // A corrupted recorded breadth (not the recomputed one) must reject the
    // artifact at planning — never promote it.
    await pool.query(`UPDATE memory_observation SET distinct_day_count = 7`);
    await assert.rejects(
      buildPromotionPlan(pool, { runId, skipTentative: true, behavior: BEHAVIOR }),
      /invalid evidence breadth/,
    );

    // Restoring the honest value restores the normal plan.
    await pool.query(`UPDATE memory_observation SET distinct_day_count = 2`);
    const restored = await buildPromotionPlan(pool, {
      runId,
      skipTentative: true,
      behavior: BEHAVIOR,
    });
    assert.equal(restored.itemCount, 1);
    assert.equal(restored.summary.creates, 1);
  });

  // --- Real pinned-connector TLS transport (local rig, no external network) ---

  it("performs a real TLS handshake with a pinned lookup, preserved SNI, and enforced hostname validation", async function (t) {
    if (spawnSync("openssl", ["version"], { encoding: "utf-8" }).status !== 0) {
      t.skip("openssl unavailable");
      return;
    }
    const dir = mkdtempSync(join(tmpdir(), "feed-tls-"));
    try {
      const run = (args) => execFileSync("openssl", args, { cwd: dir, stdio: "pipe" });
      // A throwaway test CA and two server certs signed by it: one valid for
      // feed.test, one valid only for other.test. The child trusts ONLY this
      // CA via NODE_EXTRA_CA_CERTS — an explicit test-trust decision; the
      // connector itself takes no trust configuration, so production
      // certificate validation is unchanged.
      run(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "ca.key", "-out", "ca.pem", "-days", "2", "-subj", "/CN=feed-test-ca"]);
      run(["req", "-newkey", "rsa:2048", "-nodes", "-keyout", "ok.key", "-out", "ok.csr", "-subj", "/CN=feed.test"]);
      writeFileSync(join(dir, "ok.ext"), "subjectAltName=DNS:feed.test\n");
      run(["x509", "-req", "-in", "ok.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-out", "ok.pem", "-days", "2", "-extfile", "ok.ext"]);
      run(["req", "-newkey", "rsa:2048", "-nodes", "-keyout", "other.key", "-out", "other.csr", "-subj", "/CN=other.test"]);
      writeFileSync(join(dir, "other.ext"), "subjectAltName=DNS:other.test\n");
      run(["x509", "-req", "-in", "other.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-out", "other.pem", "-days", "2", "-extfile", "other.ext"]);

      const childScript = `
import { readFileSync } from "node:fs";
import tls from "node:tls";
const { pinnedFetchText } = await import(process.env.PINNED_HTTP_PATH);
const rigAddress = "127.0.0.1";
const makeRig = (keyPath, certPath) => {
  const seen = [];
  const server = tls.createServer(
    { key: readFileSync(keyPath), cert: readFileSync(certPath) },
    (socket) => {
      let buffer = Buffer.alloc(0);
      socket.on("data", (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        const end = buffer.indexOf("\\r\\n\\r\\n");
        if (end < 0) return;
        const head = buffer.subarray(0, end).toString("utf-8");
        const host = /^host:[ \\t]*(.*)$/im.exec(head)?.[1]?.trim() ?? null;
        seen.push({ sni: socket.servername ?? null, host });
        socket.end("HTTP/1.1 200 OK\\r\\ncontent-type: application/rss+xml\\r\\ncontent-length: 13\\r\\n\\r\\n<rss>ok</rss>");
      });
    },
  );
  return { server, seen };
};
const listen = (server) =>
  new Promise((resolve) => server.listen(0, rigAddress, () => resolve(server.address().port)));
const happy = makeRig(process.env.TLS_KEY, process.env.TLS_CERT_OK);
const hostile = makeRig(process.env.TLS_KEY_OTHER, process.env.TLS_CERT_OTHER);
const happyPort = await listen(happy.server);
const hostilePort = await listen(hostile.server);
// The lookup is pinned to the rig address and the validator admits only
// that address (the test rig stands in for a public address).
const fetchOptions = {
  timeoutMs: 8000,
  maxBytes: 100000,
  lookupAll: async () => [{ address: rigAddress, family: 4 }],
  validateAddress: (address) => address === rigAddress
    ? { ok: true }
    : { ok: false, reason: "the test rig allows only its own address" },
};
const happyFetch = await pinnedFetchText(
  "https://feed.test:" + happyPort + "/feed.xml",
  fetchOptions,
);
console.log(JSON.stringify({
  stage: "happy",
  sni: happy.seen[0]?.sni ?? null,
  host: happy.seen[0]?.host ?? null,
  body: happyFetch.body,
  bytes: happyFetch.bytes,
}));
let negativeCode = null;
let negativeMessage = null;
try {
  await pinnedFetchText("https://feed.test:" + hostilePort + "/feed.xml", fetchOptions);
  negativeMessage = "unexpectedly succeeded";
} catch (error) {
  negativeCode = error.code ?? null;
  negativeMessage = error.message ?? String(error);
}
console.log(JSON.stringify({ stage: "negative", code: negativeCode, message: negativeMessage }));
happy.server.close();
hostile.server.close();
`;
      writeFileSync(join(dir, "child.mjs"), childScript);
      const child = spawn(
        process.execPath,
        ["--experimental-strip-types", join(dir, "child.mjs")],
        {
          env: {
            ...process.env,
            NODE_EXTRA_CA_CERTS: join(dir, "ca.pem"),
            PINNED_HTTP_PATH: new URL(
              "../../apps/worker/src/articles/pinnedHttp.ts",
              import.meta.url,
            ).href,
            TLS_KEY: join(dir, "ok.key"),
            TLS_KEY_OTHER: join(dir, "other.key"),
            TLS_CERT_OK: join(dir, "ok.pem"),
            TLS_CERT_OTHER: join(dir, "other.pem"),
          },
        },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += String(chunk);
      });
      child.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });
      const code = await new Promise((resolve) => child.on("close", resolve));
      assert.equal(code, 0, `tls rig child failed (${stderr.trim()})`);
      const reports = stdout.trim().split("\n").map((line) => JSON.parse(line));
      const happy = reports.find((report) => report.stage === "happy");
      const negative = reports.find((report) => report.stage === "negative");
      assert.ok(happy !== undefined, "no happy-path report from the tls rig");
      // The handshake completed through the test CA against the pinned rig
      // address, with the ORIGINAL hostname carried as SNI and Host.
      assert.equal(happy.sni, "feed.test");
      assert.match(happy.host, /^feed\.test:\d+$/);
      assert.equal(happy.body, "<rss>ok</rss>");
      assert.equal(happy.bytes, "<rss>ok</rss>".length);
      assert.ok(negative !== undefined, "no negative report from the tls rig");
      // A trusted-chain cert whose SAN does not match the hostname must fail
      // hostname validation: chain trust alone is not sufficient.
      assert.equal(negative.code, "ERR_TLS_CERT_ALTNAME_INVALID", negative.message);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- Ingestion drives consolidation end to end ------------------------------

  it("feeds accepted reactions into interest consolidation within the same attempt", async () => {
    await provisionArticleConfig(pool);
    // The wired consolidation phase derives its answer from the fact keys
    // rendered in its source, so the test needs no pre-known ids.
    const llm = makeArticleLlm({ consolidateFromRenderedFacts: true });
    const summary = await runIngestionAttempt(
      {
        pool,
        callLlm: llm,
        log: () => {},
        transport: makeFeedTransport({ xml: buildFeedXml() }),
        resolveFeedHost: FAKE_RESOLVER,
      },
      "test",
    );
    assert.equal(summary.status, "ok");
    assert.equal(summary.result.generated, 2);
    // The same attempt ran the consolidation phase over the two accepted
    // reactions and accepted one interest observation.
    assert.equal(llm.calls.consolidation, 1);
    const observation = await pool.query(
      `SELECT subject_id, kind, support_count, distinct_turn_count FROM memory_observation`,
    );
    assert.equal(observation.rows.length, 1);
    assert.equal(observation.rows[0].subject_id, "assistant");
    assert.equal(observation.rows[0].kind, "preference");
    assert.equal(observation.rows[0].support_count, 2);
    assert.equal(observation.rows[0].distinct_turn_count, 0);
  });
});
