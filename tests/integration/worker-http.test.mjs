// Database-backed integration tests for the worker's private HTTP API
// (apps/worker/src/api/server.ts) over the real domain store: idempotent
// and conflicting ingestion through HTTP, cursor-paged thread reads with
// published replies in persisted seq order, allocated-seq reconciliation
// (in-flight and burned seqs), the sanitized trailing-failure flag, generic
// thread status, and the full accept → process → publish → poll path with
// fake provider calls.
//
// These tests need a real PostgreSQL. They run ONLY against the
// non-production database provided via WORKER_TEST_DATABASE_URL and are
// skipped otherwise — never point this variable at a real application
// database: the suites below TRUNCATE the domain tables on every test. Use
// a disposable, isolated non-production database only. No network calls are
// made: decision and chat calls are fake functions.

import { describe, it, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";

import { closePostgresPool, createPostgresPool, runMigrations } from "../../libraries/postgres/src/index.ts";
import { conversationMigrations } from "../../apps/worker/src/conversation/migrations.ts";
import { createConversationStore } from "../../apps/worker/src/conversation/store.ts";
import { createApiServer } from "../../apps/worker/src/api/server.ts";
import { processTurnWork } from "../../apps/worker/src/work/processor.ts";
import { runEngineOnce } from "../../apps/worker/src/work/engine.ts";

const DATABASE_URL = process.env.WORKER_TEST_DATABASE_URL;
const hasDatabase =
  typeof DATABASE_URL === "string" && DATABASE_URL.length > 0;
const TOKEN = "integration-test-service-token";

describe("worker private HTTP API (PostgreSQL)", { skip: !hasDatabase }, () => {
  /** @type {import("pg").Pool} */
  let pool;
  let store;
  /** @type {import("../../apps/worker/src/api/server.ts").ApiServer | null} */
  let server = null;
  let baseUrl = "";

  const authHeaders = {
    authorization: `Bearer ${TOKEN}`,
    "content-type": "application/json",
  };

  /** Authenticated thread read; asserts success and returns the body. */
  const getThread = async (query = "") => {
    const response = await fetch(`${baseUrl}/v1/thread${query}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(response.status, 200);
    return response.json();
  };

  before(async () => {
    pool = createPostgresPool({ connectionString: DATABASE_URL });
    store = createConversationStore(pool);
    await runMigrations(pool, conversationMigrations);
    // The chat identity is required runtime configuration: provision a
    // generic fixture row for the engine cycle below (configuration, not
    // per-test data, so the truncate leaves it in place).
    await pool.query(
      `INSERT INTO chat_identity (id, content, revision)
       VALUES ('identity', 'Integration fixture identity: generic test text.', 1)
       ON CONFLICT (id) DO UPDATE SET content = EXCLUDED.content`,
    );
    server = createApiServer({
      store,
      token: TOKEN,
      host: "127.0.0.1",
      port: 0,
      ready: async () => {
        try {
          await pool.query("SELECT 1");
          return true;
        } catch {
          return false;
        }
      },
    });
    const port = await server.start();
    baseUrl = `http://127.0.0.1:${String(port)}`;
  });

  after(async () => {
    if (server !== null) {
      await server.close();
      server = null;
    }
    if (pool !== undefined) {
      await closePostgresPool(pool);
    }
  });

  beforeEach(async () => {
    // CASCADE: memory-domain child tables reference conversation rows (the
    // memory suite runs against the same disposable database); truncating
    // them here keeps the database-backed suites order-independent.
    await pool.query(
      "TRUNCATE conversation_message, conversation_turn, response_pattern, trace_attempt, trace_attempt_context, trace_attempt_pattern, trace_attempt_decision, trace_attempt_decision_probability, trace_attempt_chat, trace_attempt_chat_message, trace_attempt_chat_choice RESTART IDENTITY CASCADE",
    );
  });

  it("reports health and database-backed readiness", async () => {
    const health = await fetch(`${baseUrl}/healthz`);
    assert.equal(health.status, 200);
    const ready = await fetch(`${baseUrl}/readyz`);
    assert.equal(ready.status, 200);
    assert.deepEqual(await ready.json(), { ok: true });
  });

  it("requires the service token on API endpoints", async () => {
    const noToken = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "x", clientKey: "k" }),
    });
    assert.equal(noToken.status, 401);
    const wrongToken = await fetch(`${baseUrl}/v1/thread`, {
      headers: { authorization: "Bearer wrong" },
    });
    assert.equal(wrongToken.status, 401);
  });

  it("ingests messages idempotently by client key over HTTP", async () => {
    const first = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ text: "hello there", clientKey: "key-1" }),
    });
    assert.equal(first.status, 200);
    const firstBody = await first.json();
    assert.equal(firstBody.message.content, "hello there");
    assert.equal(firstBody.message.clientKey, "key-1");
    assert.equal(firstBody.message.role, "user");

    // Retried request with the same key and content: same durable message.
    const replay = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ text: "hello there", clientKey: "key-1" }),
    });
    assert.equal(replay.status, 200);
    const replayBody = await replay.json();
    assert.equal(replayBody.message.id, firstBody.message.id);
    assert.equal(replayBody.message.seq, firstBody.message.seq);

    // Same key with different content: conflicting reuse, rejected.
    const conflict = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ text: "different content", clientKey: "key-1" }),
    });
    assert.equal(conflict.status, 409);
    assert.deepEqual(await conflict.json(), { error: "conflict" });

    // The database still holds exactly one message for the key.
    const count = await pool.query(
      "SELECT count(*)::int AS n FROM conversation_message WHERE client_key = 'key-1'",
    );
    assert.equal(count.rows[0].n, 1);
  });

  it("validates message input over HTTP", async () => {
    const bad = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ text: "", clientKey: "k" }),
    });
    assert.equal(bad.status, 400);
    const badKey = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ text: "hi", clientKey: "not a valid key!" }),
    });
    assert.equal(badKey.status, 400);
  });

  it("reflects queued and generating status generically", async () => {
    const empty = await getThread();
    assert.deepEqual(empty.status, {
      queued: 0,
      generating: false,
      highestAllocatedSeq: 0,
      hasRecentFailure: false,
    });

    await store.appendUserMessage({ content: "waiting", clientKey: "k1" });
    const queued = await getThread();
    assert.equal(queued.status.queued, 1);
    assert.equal(queued.status.generating, false);
    assert.equal(queued.status.highestAllocatedSeq, 1);

    const claim = await store.claimNextTurn({ owner: "owner-a", leaseSeconds: 60 });
    assert.equal(claim.kind, "claimed");
    const generating = await getThread();
    assert.equal(generating.status.queued, 0);
    assert.equal(generating.status.generating, true);
  });

  it("serves the durable thread in persisted seq order including published replies", async () => {
    await store.appendUserMessage({ content: "first", clientKey: "k1" });
    const claim = await store.claimNextTurn({ owner: "owner-a", leaseSeconds: 60 });
    assert.equal(claim.kind, "claimed");
    // A message arriving during generation joins the next turn but is
    // visible in the thread page immediately.
    await store.appendUserMessage({ content: "second", clientKey: "k2" });
    const published = await store.publishReply({
      turnId: claim.work.turn.id,
      leaseOwner: "owner-a",
      content: "a reply",
    });
    assert.equal(published, "published");

    const body = await getThread();
    assert.deepEqual(
      body.messages.map((message) => `${message.role}:${message.content}`),
      ["user:first", "user:second", "assistant:a reply"],
      "the page is ordered by persisted seq, so the later-arriving message precedes the reply published after it",
    );
    // The worker HTTP surface exposes the durable domain shape; the BFF is
    // the layer that reduces it to the client-facing fields.
    for (const message of body.messages) {
      assert.deepEqual(
        Object.keys(message).sort(),
        ["clientKey", "content", "createdAt", "id", "role", "seq", "turnId"],
      );
    }
    assert.deepEqual(body.page, { oldestSeq: 1, hasMore: false });
    assert.equal(body.status.highestAllocatedSeq, 3);
  });

  it("pages backward through history with the before cursor", async () => {
    for (let index = 1; index <= 7; index += 1) {
      await store.appendUserMessage({
        content: `m${String(index)}`,
        clientKey: `k${String(index)}`,
      });
    }

    const newest = await getThread("?limit=3");
    assert.deepEqual(newest.messages.map((message) => message.seq), [5, 6, 7]);
    assert.deepEqual(newest.page, { oldestSeq: 5, hasMore: true });

    const middle = await getThread("?limit=3&before=5");
    assert.deepEqual(middle.messages.map((message) => message.seq), [2, 3, 4]);
    assert.deepEqual(middle.page, { oldestSeq: 2, hasMore: true });

    const bottom = await getThread("?limit=3&before=2");
    assert.deepEqual(bottom.messages.map((message) => message.seq), [1]);
    assert.deepEqual(bottom.page, { oldestSeq: 1, hasMore: false });

    // A cursor beyond the newest allocation selects the newest page.
    const beyond = await getThread("?limit=3&before=100");
    assert.deepEqual(beyond.messages.map((message) => message.seq), [5, 6, 7]);

    // A cursor at the oldest message selects an empty page below it.
    const exhausted = await getThread("?limit=3&before=1");
    assert.deepEqual(exhausted.messages, []);
    assert.deepEqual(exhausted.page, { oldestSeq: null, hasMore: false });
  });

  it("exposes allocated-but-uncommitted seqs for hole reconciliation", async () => {
    await store.appendUserMessage({ content: "one", clientKey: "k1" });
    await store.appendUserMessage({ content: "two", clientKey: "k2" });

    // Simulate a publication transaction that has drawn its seq but not
    // yet committed: the row is invisible to other transactions, but
    // identity sequences are non-transactional, so the allocation is
    // already observable — every seq up to the reported bound is
    // committed, in flight, or burned, never simply absent. The web
    // client relies on exactly this invariant (plus contiguous
    // allocation) when it re-derives gaps between its loaded seqs and
    // walks pages downward to recover late-committing messages.
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "INSERT INTO conversation_message (role, content) VALUES ('assistant', 'slow reply')",
      );

      const inFlight = await getThread();
      assert.deepEqual(
        inFlight.messages.map((message) => message.seq),
        [1, 2],
      );
      assert.equal(inFlight.status.highestAllocatedSeq, 3);

      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }

    // After commit the hole fills with the next read.
    const committed = await getThread();
    assert.deepEqual(
      committed.messages.map((message) => message.seq),
      [1, 2, 3],
    );
    assert.equal(committed.status.highestAllocatedSeq, 3);
  });

  it("keeps reporting a burned seq so clients can keep probing its hole", async () => {
    await store.appendUserMessage({ content: "one", clientKey: "k1" });

    // A rolled-back insert consumes a seq that will never become visible:
    // the worker crashed mid-publication, say. The allocation stays spent.
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "INSERT INTO conversation_message (role, content) VALUES ('assistant', 'doomed reply')",
      );
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }

    const after = await getThread();
    assert.deepEqual(
      after.messages.map((message) => message.seq),
      [1],
    );
    assert.equal(after.status.highestAllocatedSeq, 2);

    // The next real message continues after the burned seq; a consumer
    // sees the permanent hole at 2 and keeps probing it (bounded work per
    // cycle, no timing assumption) rather than ever treating the range as
    // complete.
    const next = await store.appendUserMessage({
      content: "three",
      clientKey: "k3",
    });
    assert.equal(next.seq, 3);
    const resumed = await getThread();
    assert.deepEqual(
      resumed.messages.map((message) => message.seq),
      [1, 3],
    );
    assert.equal(resumed.status.highestAllocatedSeq, 3);
  });

  it("surfaces the sanitized trailing-failure flag scoped to the last completed turn", async () => {
    // The first turn fails before anything has completed: the flag is on.
    await store.appendUserMessage({ content: "doomed", clientKey: "k1" });
    const first = await store.claimNextTurn({ owner: "owner-a", leaseSeconds: 60 });
    assert.equal(first.kind, "claimed");
    assert.equal(
      await store.failTurn({
        turnId: first.work.turn.id,
        leaseOwner: "owner-a",
        error: "secret provider detail: upstream exploded",
      }),
      "failed",
    );

    const afterFailure = await getThread();
    assert.equal(afterFailure.status.hasRecentFailure, true);
    // Sanitized: the error text stored on the turn never reaches the HTTP
    // surface.
    assert.ok(
      !JSON.stringify(afterFailure).includes("secret provider detail"),
      "failure detail must not leak through the thread endpoint",
    );

    // A later turn completes: the earlier failure is history, and the
    // flag clears.
    await store.appendUserMessage({ content: "after", clientKey: "k2" });
    const second = await store.claimNextTurn({ owner: "owner-b", leaseSeconds: 60 });
    assert.equal(second.kind, "claimed");
    assert.equal(
      await store.publishReply({
        turnId: second.work.turn.id,
        leaseOwner: "owner-b",
        content: "recovered",
      }),
      "published",
    );
    const afterCompletion = await getThread();
    assert.equal(afterCompletion.status.hasRecentFailure, false);
  });

  it("runs the full accept → process → publish → poll path with fake provider calls", async () => {
    const accepted = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ text: "question over http", clientKey: "k-http" }),
    });
    assert.equal(accepted.status, 200);

    const result = await runEngineOnce({
      store,
      processTurn: (work) =>
        processTurnWork(work, {
          decisionModel: "decision-model",
          chatModel: "chat-model",
          callDecisions: async () => {
            throw new Error("decision must not be called without patterns");
          },
          callChat: async () => ({
            model: "chat-model-build",
            choices: [
              {
                message: { role: "assistant", content: "reply over http" },
                finish_reason: "stop",
              },
            ],
          }),
          loadIdentity: () => store.getChatIdentity(),
          loadPatterns: () => store.getEnabledResponsePatterns(),
          loadContext: (turnId) => store.getThreadContext({ turnId, limit: 50 }),
        }),
      leaseSeconds: 60,
      pollSeconds: 1,
      ownerLabel: "http-integration",
    });
    assert.equal(result, "worked");

    const body = await getThread();
    assert.deepEqual(
      body.messages.map((message) => `${message.role}:${message.content}`),
      ["user:question over http", "assistant:reply over http"],
    );
    assert.deepEqual(body.status, {
      queued: 0,
      generating: false,
      highestAllocatedSeq: 2,
      hasRecentFailure: false,
    });
  });
});
