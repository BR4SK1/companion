// Database-backed integration tests for canonical recall's attribution
// fields: every recall result carries its subject's configured role, and
// article-derived memories carry their article source — conversation facts
// stay conversation-sourced, article-reaction facts are assistant-attributed
// with their reaction link, and observations follow their support evidence.
// The rendered memory context attributes them honestly.
//
// These tests need a real PostgreSQL. They run ONLY against the
// non-production database provided via WORKER_TEST_DATABASE_URL and are
// skipped otherwise. No network calls are made; no LLM is involved.

import { describe, it, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";

import {
  closePostgresPool,
  createPostgresPool,
  runMigrations,
} from "../../libraries/postgres/src/index.ts";
import { conversationMigrations } from "../../apps/worker/src/conversation/migrations.ts";
import { memoryMigrations } from "../../apps/worker/src/memory/migrations.ts";
import { articleMigrations } from "../../apps/worker/src/articles/migrations.ts";
import { temporalMigrations } from "../../apps/worker/src/temporal/migrations.ts";
import { recallCanonical } from "../../apps/worker/src/memory/recall.ts";
import { loadMemoryConfig } from "../../apps/worker/src/memory/config.ts";
import { buildCanonicalMemoryContextForPrompt } from "../../apps/worker/src/memory/chat-context.ts";

const DATABASE_URL = process.env.WORKER_TEST_DATABASE_URL;
const hasDatabase =
  typeof DATABASE_URL === "string" && DATABASE_URL.length > 0;

const NOW = new Date("2026-11-06T12:00:00.000Z");

describe("canonical recall attribution (PostgreSQL)", { skip: !hasDatabase }, () => {
  /** @type {import("pg").Pool} */
  let pool;
  let config;

  before(async () => {
    pool = createPostgresPool({ connectionString: DATABASE_URL });
    config = loadMemoryConfig({});
    await runMigrations(pool, [
      ...conversationMigrations,
      ...memoryMigrations,
      ...articleMigrations,
      ...temporalMigrations,
    ]);
  });

  after(async () => {
    if (pool !== undefined) {
      await closePostgresPool(pool);
    }
  });

  beforeEach(async () => {
    await pool.query(
      `TRUNCATE conversation_message, conversation_turn, response_pattern,
        memory_fact, memory_run, memory_observation,
        memory_canonical_observation, memory_subject,
        article_feed, article_item, article_reaction, article_share
        RESTART IDENTITY CASCADE`,
    );
    await seedMemories(pool);
  });

  it("carries subject role and source on facts and observations", async () => {
    const recall = await recallCanonical(pool, config, {
      query: "tea rss",
      referenceTime: NOW,
      limit: 8,
    });
    const byId = new Map(recall.results.map((item) => [item.id, item]));

    const userFact = byId.get("fact:user-tea");
    assert.ok(userFact, "the user conversation fact must be recalled");
    assert.equal(userFact.type, "fact");
    assert.equal(userFact.subjectRole, "user");
    assert.equal(userFact.sourceType, "conversation");
    assert.ok(userFact.turnId);
    assert.equal(userFact.articleReactionId, undefined);

    const articleFact = byId.get("fact:assistant-rss");
    assert.ok(articleFact, "the assistant article fact must be recalled");
    assert.equal(articleFact.type, "fact");
    assert.equal(articleFact.subjectRole, "assistant");
    assert.equal(articleFact.sourceType, "article");
    assert.ok(articleFact.articleReactionId);
    assert.equal(articleFact.turnId, undefined);

    const userObservation = byId.get("obs:user-tea");
    assert.ok(userObservation, "the user observation must be recalled");
    assert.equal(userObservation.type, "observation");
    assert.equal(userObservation.subjectRole, "user");
    assert.equal(userObservation.sourceType, "conversation");

    const articleObservation = byId.get("obs:assistant-rss");
    assert.ok(articleObservation, "the article-derived observation must be recalled");
    assert.equal(articleObservation.type, "observation");
    assert.equal(articleObservation.subjectRole, "assistant");
    assert.equal(articleObservation.sourceType, "article");
  });

  it("keeps the attribution fields on the recency fallback query variant", async () => {
    // An empty keyword result (every token stripped) exercises the
    // recency-fallback query variant with the same attribution columns.
    const recall = await recallCanonical(pool, config, {
      query: "'\"",
      referenceTime: NOW,
      limit: 8,
    });
    assert.equal(recall.query.emptyQueryFallback, true);
    const byId = new Map(recall.results.map((item) => [item.id, item]));
    assert.equal(byId.get("obs:assistant-rss").sourceType, "article");
    assert.equal(byId.get("obs:assistant-rss").subjectRole, "assistant");
    assert.equal(byId.get("fact:assistant-rss").sourceType, "article");
    assert.equal(byId.get("fact:assistant-rss").subjectRole, "assistant");
  });

  it("renders recalled results with honest attribution", async () => {
    const recall = await recallCanonical(pool, config, {
      query: "tea rss",
      referenceTime: NOW,
      limit: 8,
    });
    const text = buildCanonicalMemoryContextForPrompt({
      items: recall.results,
      now: NOW,
    });
    assert.ok(
      text.startsWith("Use these memories as background context."),
      `expected the attributed header, got:\n${text}`,
    );
    assert.ok(!text.includes("user-specific context"));
    // The user's conversation memories stay untagged with the legacy shape.
    assert.ok(text.includes("- (fact) [1h ago] Prefers tea in the morning"));
    assert.ok(
      text.includes("- (observation) [1h ago] Usually takes tea in the morning"),
    );
    const lines = text.split("\n").filter((line) => line.startsWith("- "));
    assert.ok(
      lines.some(
        (line) =>
          line.startsWith("- (fact) [the assistant's own, from an article]") &&
          line.includes("I find rss readers interesting"),
      ),
      `expected the attributed assistant fact line, got:\n${text}`,
    );
    assert.ok(
      lines.some(
        (line) =>
          line.startsWith("- (observation) [the assistant's own, from an article]") &&
          line.includes("The assistant keeps returning to rss readers"),
      ),
      `expected the attributed assistant observation line, got:\n${text}`,
    );
  });
});

async function seedMemories(pool) {
  await pool.query(
    `INSERT INTO memory_subject (id, role, profile_enabled, source_label, profile_evidence_rule, position)
     VALUES
       ('user', 'user', false, 'User', 'Fixture attribution rule.', 0),
       ('assistant', 'assistant', false, 'Assistant', 'Fixture attribution rule.', 1)`,
  );
  // A completed conversation turn for the conversation-sourced fact.
  const turn = await pool.query(
    `INSERT INTO conversation_turn (id, lease_owner, lease_expires_at, status, completed_at)
     VALUES (gen_random_uuid(), 'fixture-owner', now() + interval '5 minutes', 'completed', now())
     RETURNING id`,
  );
  const turnId = turn.rows[0].id;

  // Conversation-sourced user fact.
  await pool.query(
    `INSERT INTO memory_fact
       (fact_key, turn_id, subject_id, kind, claim, observed_at,
        explicitness, evidence_basis, extraction_version, ingest_version)
     VALUES ('fact:user-tea', $1, 'user', 'preference', 'Prefers tea in the morning',
             $2, 'explicit', 'direct_statement', 'fixture-v1', 'fixture-v1')`,
    [turnId, new Date(NOW.getTime() - 3_600_000)],
  );

  // Article chain and the assistant-attributed article fact.
  await pool.query(
    `INSERT INTO article_feed (id, url, position)
     VALUES ('feed-a', 'https://example.com/feed-a.xml', 0)`,
  );
  await pool.query(
    `INSERT INTO article_item (feed_id, url, title, excerpt, fetched_at)
     VALUES ('feed-a', 'https://example.com/local-first', 'A local-first piece',
             'A bounded excerpt.', $1)`,
    [new Date(NOW.getTime() - 86_400_000)],
  );
  await pool.query(
    `INSERT INTO article_reaction (item_id, state, reaction, fact_key, generated_at)
     SELECT i.id, 'accepted', 'The assistant found this piece interesting.',
            'fact:assistant-rss', $1
     FROM article_item i WHERE i.url = 'https://example.com/local-first'`,
    [new Date(NOW.getTime() - 7_200_000)],
  );
  await pool.query(
    `INSERT INTO memory_fact
       (fact_key, turn_id, article_reaction_id, subject_id, kind, claim, observed_at,
        explicitness, evidence_basis, extraction_version, ingest_version, source_type)
     SELECT 'fact:assistant-rss', NULL, r.id, 'assistant', 'preference',
            'I find rss readers interesting', $1,
            'explicit', 'observed_behavior', 'fixture-v1', 'fixture-v1', 'article'
     FROM article_reaction r WHERE r.fact_key = 'fact:assistant-rss'`,
    [new Date(NOW.getTime() - 7_200_000)],
  );

  // Active canonical observations: one conversation-derived (user), one
  // article-derived (assistant interests, zero turn evidence per 0008).
  await pool.query(
    `INSERT INTO memory_canonical_observation
       (canonical_observation_id, canonical_identity_key, identity_version, observation_key,
        subject_id, kind, claim, topics, support_count, distinct_turn_count,
        distinct_day_count, contradiction_count, first_observed_at, last_observed_at,
        source_fact_keys, evidence_strength, status, consolidation_version, content_hash,
        revision, promotion_id, promotion_sequence, latest_artifact_id, latest_run_id,
        latest_observation_set_id, latest_fact_set_id, latest_artifact_created_at,
        latest_artifact_updated_at, canonical_created_at, canonical_updated_at)
     VALUES
       ('obs:user-tea', 'identity:user-tea', 1, 'key:user-tea',
        'user', 'preference', 'Usually takes tea in the morning', '{}', 2, 2, 1, 0,
        $1, $2, ARRAY['fact:user-tea'], 'supported', 'active', 'fixture-v1', 'hash-1',
        1, 'promo-1', 1, 'artifact-1', 'run-1', 'oset-1', 'fset-1', $1, $2, $1, $2),
       ('obs:assistant-rss', 'identity:assistant-rss', 1, 'key:assistant-rss',
        'assistant', 'preference', 'The assistant keeps returning to rss readers',
        '{}', 2, 0, 1, 0,
        $3, $1, ARRAY['fact:assistant-rss'], 'supported', 'active', 'fixture-v1', 'hash-2',
        1, 'promo-2', 1, 'artifact-2', 'run-2', 'oset-2', 'fset-2', $3, $1, $3, $1)`,
    [
      new Date(NOW.getTime() - 7_200_000),
      new Date(NOW.getTime() - 3_600_000),
      new Date(NOW.getTime() - 86_400_000 * 3),
    ],
  );
}
