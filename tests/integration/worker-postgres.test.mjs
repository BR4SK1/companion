// Database-backed integration tests for the worker's durable conversation
// work (apps/worker/src): migrations, idempotent ingestion, claim-time
// grouping, snapshot/next-turn behavior, prior-turn context snapshots in
// conversation order (including replies published after later messages
// arrived, exclusions, lease-reclaim coherence, and full decision/chat
// context when messages arrive during generation), lease renewal and
// reclaim, fenced publication, reply ordering, and the engine cycle with
// fake provider calls.
//
// These tests need a real PostgreSQL. They run ONLY against the
// non-production database provided via WORKER_TEST_DATABASE_URL and are
// skipped otherwise — `pnpm test:unit` stays deterministic with no database.
// No network calls are made: decision and chat calls are fake functions.

import { describe, it, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

import {
  closePostgresPool,
  createPostgresPool,
  runMigrations,
  withTransaction,
} from "../../libraries/postgres/src/index.ts";
import { conversationMigrations } from "../../apps/worker/src/conversation/migrations.ts";
import { memoryMigrations } from "../../apps/worker/src/memory/migrations.ts";
import { articleMigrations } from "../../apps/worker/src/articles/migrations.ts";
import { engagementMigrations } from "../../apps/worker/src/engagement/migrations.ts";
import { temporalMigrations } from "../../apps/worker/src/temporal/migrations.ts";
import {
  CLAIM_ADVISORY_LOCK_KEY,
  createConversationStore,
  TraceWriteFencedError,
} from "../../apps/worker/src/conversation/store.ts";
import { IdentityConfigurationError } from "../../apps/worker/src/conversation/types.ts";
import { processTurnWork } from "../../apps/worker/src/work/processor.ts";
import { runEngineOnce } from "../../apps/worker/src/work/engine.ts";
import {
  DECISION_QUESTION_ID,
  buildPatternChoiceRequest,
} from "../../apps/worker/src/work/decision.ts";
import { buildChatRequest } from "../../apps/worker/src/work/chat.ts";
import { renderReport } from "../../apps/worker/src/cli.ts";

const DATABASE_URL = process.env.WORKER_TEST_DATABASE_URL;
const hasDatabase =
  typeof DATABASE_URL === "string" && DATABASE_URL.length > 0;

/**
 * Migration-upgrade fixtures live in a uniquely named schema, never public.
 * The schema is created and dropped by the supplied application role; the
 * connection's search_path contains only this fixture schema. Cleanup checks
 * ownership before using CASCADE, so it cannot remove unrelated objects.
 */
async function createIsolatedMigrationFixture(ownerPool, databaseUrl, prefix) {
  if (!/^[a-z][a-z0-9_]*$/.test(prefix)) {
    throw new Error(`invalid isolated-schema prefix: ${prefix}`);
  }
  const schema = `${prefix}_${randomUUID().replaceAll("-", "")}`;
  let created = false;
  let fixturePool;
  try {
    await ownerPool.query(`CREATE SCHEMA "${schema}"`);
    created = true;
    const connection = new URL(databaseUrl);
    connection.searchParams.set("options", `-csearch_path=${schema}`);
    fixturePool = createPostgresPool({ connectionString: connection.toString() });
    const path = await fixturePool.query(
      "SELECT current_schema() AS schema, array_to_json(current_schemas(false)) AS schemas",
    );
    assert.equal(path.rows[0].schema, schema);
    assert.deepEqual(path.rows[0].schemas, [schema]);

    const ownership = await ownerPool.query(
      `SELECT pg_get_userbyid(nspowner) AS owner, current_user AS role
       FROM pg_namespace WHERE nspname = $1`,
      [schema],
    );
    assert.equal(ownership.rows[0]?.owner, ownership.rows[0]?.role);

    return {
      schema,
      pool: fixturePool,
      async dispose() {
        await closePostgresPool(fixturePool);
        const owner = await ownerPool.query(
          `SELECT pg_get_userbyid(nspowner) AS owner, current_user AS role
           FROM pg_namespace WHERE nspname = $1`,
          [schema],
        );
        if (owner.rows.length !== 1 || owner.rows[0].owner !== owner.rows[0].role) {
          throw new Error(`refusing to drop non-owned migration fixture schema ${schema}`);
        }
        await ownerPool.query(`DROP SCHEMA "${schema}" CASCADE`);
      },
    };
  } catch (error) {
    if (fixturePool !== undefined) await closePostgresPool(fixturePool);
    if (created) {
      const owner = await ownerPool.query(
        `SELECT pg_get_userbyid(nspowner) AS owner, current_user AS role
         FROM pg_namespace WHERE nspname = $1`,
        [schema],
      );
      if (owner.rows.length === 1 && owner.rows[0].owner === owner.rows[0].role) {
        await ownerPool.query(`DROP SCHEMA "${schema}" CASCADE`);
      }
    }
    throw error;
  }
}

async function readVectorExtensionFingerprint(db) {
  const result = await db.query(
    `SELECT e.oid::text AS oid, e.extname, e.extversion,
            n.nspname AS schema, pg_get_userbyid(e.extowner) AS owner,
            e.extconfig::text AS config, e.extcondition::text AS condition
     FROM pg_extension e
     JOIN pg_namespace n ON n.oid = e.extnamespace
     WHERE e.extname = 'vector'`,
  );
  return result.rows;
}

describe("worker durable conversation work (PostgreSQL)", { skip: !hasDatabase }, () => {
  /** @type {import("pg").Pool} */
  let pool;
  let store;

  before(async () => {
    pool = createPostgresPool({ connectionString: DATABASE_URL });
    store = createConversationStore(pool);
    // Fresh application against the provided non-production database; the
    // worker applies the conversation and memory domain migrations together
    // (see main.ts), so every test below assumes both domain schemas exist.
    await runMigrations(pool, [...conversationMigrations, ...memoryMigrations, ...articleMigrations, ...temporalMigrations]);
    // The chat identity is required runtime configuration (like
    // response_pattern): provision a generic fixture row so engine cycles
    // can run. It is configuration, not per-test data, so the beforeEach
    // truncate leaves it in place; the fail-closed test manages its own
    // delete/restore.
    await pool.query(
      `INSERT INTO chat_identity (id, content, revision)
       VALUES ('identity', 'Integration fixture identity: generic test text.', 1)
       ON CONFLICT (id) DO UPDATE SET
         content = EXCLUDED.content, revision = EXCLUDED.revision`,
    );
  });

  after(async () => {
    if (pool !== undefined) {
      await closePostgresPool(pool);
    }
  });

  beforeEach(async () => {
    // CASCADE: memory-domain child tables reference conversation rows (the
    // memory suite runs against the same disposable database); truncating
    // them here keeps the suites order-independent. The memory suite
    // truncates its own tables before each of its tests.
    await pool.query(
      `TRUNCATE conversation_message, conversation_turn, response_pattern,
        trace_attempt, trace_attempt_context, trace_attempt_pattern,
        trace_attempt_decision, trace_attempt_decision_probability,
        trace_attempt_chat, trace_attempt_chat_message,
        trace_attempt_chat_choice RESTART IDENTITY CASCADE`,
    );
  });

  it("re-applies migrations idempotently with the domain tables present", async () => {
    const second = await runMigrations(pool, [
      ...conversationMigrations,
      ...memoryMigrations,
      ...articleMigrations,
      ...temporalMigrations,
    ]);
    assert.deepEqual(second.applied, []);
    // Ids are feature-owned labels, not a global sequence: the composition
    // array applies the conversation domain's migrations (0001, 0002, 0004)
    // before the memory domain's (0003), because memory tables hold foreign
    // keys into conversation tables.
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
      "0016_authoritative_temporal_context",
      "0017_trace_attempt_temporal_context",
    ]);
    const tables = await pool.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name IN ('conversation_message', 'conversation_turn', 'response_pattern', 'chat_identity')
       ORDER BY table_name`,
    );
    assert.deepEqual(
      tables.rows.map((row) => row.table_name),
      [
        "chat_identity",
        "conversation_message",
        "conversation_turn",
        "response_pattern",
      ],
    );
  });

  it("isolates migration upgrade fixtures and preserves vector extension installation", async () => {
    const vectorBefore = await readVectorExtensionFingerprint(pool);
    const publicLedgerBefore = await pool.query(
      "SELECT id FROM companion_schema_migration ORDER BY id",
    );
    assert.equal(vectorBefore.length, 1, "the verified test database must contain pgvector");
    assert.deepEqual(
      { schema: vectorBefore[0].schema, owner: vectorBefore[0].owner },
      { schema: "public", owner: "postgres" },
      "pgvector's existing installation location and owner are part of the fixture invariant",
    );

    const fixture = await createIsolatedMigrationFixture(pool, DATABASE_URL, "extension_isolation");
    try {
      await runMigrations(fixture.pool, conversationMigrations.slice(0, 1));
      const fixtureExtensions = await fixture.pool.query(
        `SELECT e.extname FROM pg_extension e
         JOIN pg_namespace n ON n.oid = e.extnamespace
         WHERE n.nspname = $1`,
        [fixture.schema],
      );
      assert.deepEqual(fixtureExtensions.rows, [], "migration fixtures must not install extensions");
    } finally {
      await fixture.dispose();
    }

    assert.deepEqual(
      await readVectorExtensionFingerprint(pool),
      vectorBefore,
      "isolated migration fixture creation and cleanup must leave vector metadata unchanged",
    );
    assert.deepEqual(
      (await pool.query("SELECT id FROM companion_schema_migration ORDER BY id")).rows,
      publicLedgerBefore.rows,
      "isolated migrations must not alter the public application migration ledger",
    );
  });

  it("backfills thread order by first-user seq despite inverted turn timestamps, with defined legacy notice placement", async () => {
    const fixture = await createIsolatedMigrationFixture(pool, DATABASE_URL, "thread_order_upgrade");
    const upgradePool = fixture.pool;
    try {
      await runMigrations(upgradePool, conversationMigrations.slice(0, -1));

      const firstTurn = randomUUID();
      const secondTurn = randomUUID();
      await upgradePool.query(
        `INSERT INTO conversation_turn (id, status, created_at, completed_at)
         VALUES ($1, 'completed', '2026-11-10T12:00:00Z', '2026-11-10T12:01:00Z'),
                ($2, 'completed', '2026-11-10T11:00:00Z', '2026-11-10T11:01:00Z')`,
        [firstTurn, secondTurn],
      );
      const insertMessage = (role, content, turnId) => upgradePool.query(
        `INSERT INTO conversation_message
           (role, content, turn_id, effective_at, time_source,
            client_time_status, server_received_at)
         VALUES ($1, $2, $3, '2026-11-10T10:00:00Z', 'server', 'absent',
                 '2026-11-10T10:00:00Z')`,
        [role, content, turnId],
      );
      await insertMessage("user", "legacy u1", firstTurn);
      await insertMessage("assistant", "legacy standalone notice", null);
      await insertMessage("user", "legacy u2", secondTurn);
      await insertMessage("assistant", "legacy r1", firstTurn);
      await insertMessage("assistant", "legacy r2", secondTurn);

      const threadOrderMigration = conversationMigrations.at(-1);
      assert.ok(threadOrderMigration);
      await runMigrations(upgradePool, [threadOrderMigration]);
      const orderedTurns = await upgradePool.query(
        `SELECT id, thread_order FROM conversation_turn ORDER BY thread_order`,
      );
      assert.deepEqual(orderedTurns.rows.map((row) => row.id), [firstTurn, secondTurn],
        "legacy turns retain first-user-seq order even when created_at is inverted");

      const isolatedStore = createConversationStore(upgradePool);
      await isolatedStore.appendUserMessage({ content: "current u3" });
      const current = await isolatedStore.claimNextTurn({ owner: "legacy-order-check", leaseSeconds: 60 });
      assert.equal(current.kind, "claimed");
      const context = await isolatedStore.getThreadContext({ turnId: current.work.turn.id, limit: 20 });
      assert.deepEqual(context.map((message) => message.content), [
        "legacy u1",
        "legacy r1",
        "legacy standalone notice",
        "legacy u2",
        "legacy r2",
      ], "legacy standalone notices use the documented prior-turn-by-first-user-seq placement");
    } finally {
      await fixture.dispose();
    }
  });

  it("upgrades a populated pre-timing schema with honest provenance and no invented client time", async () => {
    // Build the historical schema in a run-owned search_path. Nothing in
    // public is dropped or recreated; only this fixture schema is cleaned up.
    const fixture = await createIsolatedMigrationFixture(pool, DATABASE_URL, "pre_timing_upgrade");
    const upgradePool = fixture.pool;
    try {
      const legacy = conversationMigrations.find((m) => m.id === "0001_conversation_work");
      const timing = conversationMigrations.find((m) => m.id === "0005_message_timing");
      assert.ok(legacy && timing);
      await upgradePool.query(legacy.sql);
      const legacyCreated = new Date("2026-01-01T10:00:00.000Z");
      await upgradePool.query(
        `INSERT INTO conversation_message (role, content, client_key, created_at)
         VALUES ('user', 'legacy message', 'legacy-1', $1),
                ('assistant', 'legacy reply', NULL, $1)`,
        [legacyCreated],
      );
      await upgradePool.query(timing.sql);

      // Honest backfill from each row's own recorded history: the server
      // receive time and effective time are the row's server insert instant
      // (`created_at` — same clock, same statement), the status is `absent`,
      // and NO original client time is invented.
      const rows = await upgradePool.query(
        `SELECT client_sent_at, effective_at, time_source, client_time_status,
                server_received_at, created_at
         FROM conversation_message ORDER BY seq`,
      );
      assert.equal(rows.rows.length, 2);
      for (const row of rows.rows) {
        assert.equal(row.client_sent_at, null, "no client time may be invented");
        assert.equal(row.time_source, "server");
        assert.equal(row.client_time_status, "absent");
        assert.equal(row.server_received_at.getTime(), row.created_at.getTime());
        assert.equal(row.effective_at.getTime(), row.created_at.getTime());
      }
      const nulls = await upgradePool.query(
        `SELECT count(*)::int AS n FROM conversation_message
         WHERE server_received_at IS NULL OR effective_at IS NULL
            OR time_source IS NULL OR client_time_status IS NULL`,
      );
      assert.equal(nulls.rows[0].n, 0);
      const nullability = await upgradePool.query(
        `SELECT is_nullable FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = 'conversation_message'
           AND column_name = 'server_received_at'`,
        [fixture.schema],
      );
      assert.equal(nullability.rows[0].is_nullable, "NO",
        "server_received_at must be NOT NULL after the backfill");

      // The store's message mapping reads the migrated legacy history without
      // relying on or mutating the public application schema.
      const upgradedStore = createConversationStore(upgradePool);
      const page = await upgradedStore.getThreadPage({ limit: 10 });
      assert.equal(page.messages.length, 2);
      for (const message of page.messages) {
        assert.equal(message.clientSentAt, null);
        assert.equal(message.timeSource, "server");
        assert.equal(message.clientTimeStatus, "absent");
        assert.equal(message.serverReceivedAt, message.createdAt);
        assert.equal(message.effectiveAt, message.createdAt);
      }
    } finally {
      await fixture.dispose();
    }
  });

  it("reads the provisioned chat identity and fails closed without one", async () => {
    const identity = await store.getChatIdentity();
    assert.equal(
      identity.content,
      "Integration fixture identity: generic test text.",
    );
    assert.equal(identity.revision, 1);

    // Missing row: the typed configuration error, never a silent default.
    await pool.query("DELETE FROM chat_identity WHERE id = 'identity'");
    try {
      await assert.rejects(
        () => store.getChatIdentity(),
        (error) => {
          assert.ok(error instanceof IdentityConfigurationError);
          assert.ok(error.message.includes("chat_identity"));
          return true;
        },
      );
    } finally {
      // Restore the fixture row the rest of the suite assumes.
      await pool.query(
        `INSERT INTO chat_identity (id, content, revision)
         VALUES ('identity', 'Integration fixture identity: generic test text.', 1)`,
      );
    }
    const restored = await store.getChatIdentity();
    assert.equal(restored.revision, 1);
  });

  it("fails the turn as a configuration error when identity is missing, with no provider calls", async () => {
    const decisionResponse = (choice) => ({
      model: "decision-model-build",
      answers: { [DECISION_QUESTION_ID]: { type: "choice", choice } },
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const chatResponse = (content) => ({
      id: "chat-x",
      model: "chat-model-build",
      choices: [
        { message: { role: "assistant", content }, finish_reason: "stop" },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
    await store.appendUserMessage({ content: "no identity" });
    const decisionCalls = [];
    const chatCalls = [];
    await pool.query("DELETE FROM chat_identity WHERE id = 'identity'");
    try {
      const result = await runEngineOnce({
        store,
        processTurn: (work, { leaseOwner }) =>
          processTurnWork(work, {
            decisionModel: "decision-model",
            chatModel: "chat-model",
            callDecisions: async (request) => {
              decisionCalls.push(request);
              return decisionResponse("concise");
            },
            callChat: async () => {
              chatCalls.push("chat");
              return chatResponse("unreachable");
            },
            loadIdentity: () => store.getChatIdentity(),
            loadPatterns: () => store.getEnabledResponsePatterns(),
            loadContext: (turnId) =>
              store.getThreadContext({ turnId, limit: 40 }),
          }),
        leaseSeconds: 60,
        pollSeconds: 1,
        ownerLabel: "identity-missing",
      });
      assert.equal(result, "worked");

      const turn = await pool.query(
        "SELECT status, error FROM conversation_turn",
      );
      assert.equal(turn.rows[0].status, "failed");
      assert.ok(
        turn.rows[0].error.includes("chat_identity"),
        `expected the configuration error on the turn, got: ${turn.rows[0].error}`,
      );
      // Fail-closed: no snapshot, no decision spend, no chat call.
      assert.equal(decisionCalls.length, 0);
      assert.equal(chatCalls.length, 0);
      const snapshots = await pool.query(
        "SELECT count(*)::int AS n FROM trace_attempt",
      );
      assert.equal(snapshots.rows[0].n, 1); // the attempt row exists (created at claim)
      const chats = await pool.query(
        "SELECT count(*)::int AS n FROM trace_attempt_chat",
      );
      assert.equal(chats.rows[0].n, 0);
    } finally {
      await pool.query(
        `INSERT INTO chat_identity (id, content, revision)
         VALUES ('identity', 'Integration fixture identity: generic test text.', 1)`,
      );
    }
  });

  it("ingests user messages idempotently by client key", async () => {
    const first = await store.appendUserMessage({
      content: "hello",
      clientKey: "key-1",
    });
    const duplicate = await store.appendUserMessage({
      content: "hello",
      clientKey: "key-1",
    });
    assert.equal(duplicate.id, first.id);
    assert.equal(duplicate.seq, first.seq);

    const second = await store.appendUserMessage({
      content: "again",
      clientKey: "key-2",
    });
    assert.notEqual(second.id, first.id);
    assert.ok(second.seq > first.seq);

    const withoutKey = await store.appendUserMessage({ content: "no key" });
    assert.equal(withoutKey.clientKey, null);

    const count = await pool.query(
      "SELECT count(*)::int AS n FROM conversation_message",
    );
    assert.equal(count.rows[0].n, 3);
  });

  it("groups all pending user messages into one claimed turn", async () => {
    await store.appendUserMessage({ content: "one" });
    await store.appendUserMessage({ content: "two" });
    await store.appendUserMessage({ content: "three" });

    const claim = await store.claimNextTurn({
      owner: "owner-a",
      leaseSeconds: 60,
    });
    assert.equal(claim.kind, "claimed");
    assert.equal(claim.work.messages.length, 3);
    assert.deepEqual(
      claim.work.messages.map((m) => m.content),
      ["one", "two", "three"],
    );
    assert.equal(claim.work.turn.status, "in_flight");
    assert.equal(claim.work.turn.attempt, 1);
    assert.equal(claim.work.turn.leaseOwner, "owner-a");
    assert.ok(claim.work.turn.leaseExpiresAt !== null);

    // The snapshot's messages are assigned; nothing else is claimable.
    const assigned = await pool.query(
      "SELECT count(*)::int AS n FROM conversation_message WHERE turn_id = $1",
      [claim.work.turn.id],
    );
    assert.equal(assigned.rows[0].n, 3);
    const next = await store.claimNextTurn({ owner: "owner-b", leaseSeconds: 60 });
    assert.equal(next.kind, "idle");
  });

  it("leaves messages that arrive during generation for the next turn", async () => {
    await store.appendUserMessage({ content: "first wave" });
    const claim = await store.claimNextTurn({ owner: "owner-a", leaseSeconds: 60 });
    assert.equal(claim.kind, "claimed");

    // Arrive while the turn is in flight.
    await store.appendUserMessage({ content: "late one" });
    await store.appendUserMessage({ content: "late two" });

    const during = await store.claimNextTurn({ owner: "owner-b", leaseSeconds: 60 });
    assert.equal(during.kind, "idle");

    const published = await store.publishReply({
      turnId: claim.work.turn.id,
      leaseOwner: "owner-a",
      content: "wave one reply",
    });
    assert.equal(published, "published");

    const nextClaim = await store.claimNextTurn({ owner: "owner-b", leaseSeconds: 60 });
    assert.equal(nextClaim.kind, "claimed");
    assert.deepEqual(
      nextClaim.work.messages.map((m) => m.content),
      ["late one", "late two"],
    );

    // Thread order: all user messages, then replies in turn order.
    const thread = await pool.query(
      "SELECT role, content FROM conversation_message ORDER BY seq",
    );
    assert.deepEqual(
      thread.rows.map((row) => `${row.role}:${row.content}`),
      [
        "user:first wave",
        "user:late one",
        "user:late two",
        "assistant:wave one reply",
      ],
    );
  });

  it("includes a reply published after later messages arrived in the next turn's context", async () => {
    // Finish-then-group: "during" arrives while turn 1 is generating, so it
    // joins turn 2 and its seq is lower than turn 1's reply (published after
    // it). The reply must still precede "during" in turn 2's context.
    await store.appendUserMessage({ content: "one" });
    const first = await store.claimNextTurn({ owner: "owner-a", leaseSeconds: 60 });
    assert.equal(first.kind, "claimed");
    await store.appendUserMessage({ content: "during" });
    const published = await store.publishReply({
      turnId: first.work.turn.id,
      leaseOwner: "owner-a",
      content: "reply one",
    });
    assert.equal(published, "published");

    const second = await store.claimNextTurn({ owner: "owner-b", leaseSeconds: 60 });
    assert.equal(second.kind, "claimed");
    assert.deepEqual(
      second.work.messages.map((message) => message.content),
      ["during"],
    );

    const context = await store.getThreadContext({
      turnId: second.work.turn.id,
      limit: 50,
    });
    assert.deepEqual(
      context.map((message) => `${message.role}:${message.content}`),
      ["user:one", "assistant:reply one"],
      "the just-published reply must be in context despite its higher seq; the turn's own message must not be duplicated",
    );
  });

  it("builds prior-turn context in conversation order across interleaved turns and bounds the tail", async () => {
    // Thread shape by seq: u1(1) → u2(2, during turn 1) → r1(3) →
    // u3(4, during turn 2) → r2(5) → u4(6, ingested after turn 3 was
    // claimed: unclaimed). Conversation order is u1, r1, u2, r2 — r1
    // precedes u2 and r2 precedes u3 despite their seq positions.
    await store.appendUserMessage({ content: "u1" });
    const t1 = await store.claimNextTurn({ owner: "o1", leaseSeconds: 60 });
    assert.equal(t1.kind, "claimed");
    await store.appendUserMessage({ content: "u2" });
    await store.publishReply({
      turnId: t1.work.turn.id,
      leaseOwner: "o1",
      content: "r1",
    });

    const t2 = await store.claimNextTurn({ owner: "o2", leaseSeconds: 60 });
    assert.equal(t2.kind, "claimed");
    await store.appendUserMessage({ content: "u3" });
    await store.publishReply({
      turnId: t2.work.turn.id,
      leaseOwner: "o2",
      content: "r2",
    });

    const t3 = await store.claimNextTurn({ owner: "o3", leaseSeconds: 60 });
    assert.equal(t3.kind, "claimed");
    assert.deepEqual(
      t3.work.messages.map((message) => message.content),
      ["u3"],
    );
    await store.appendUserMessage({ content: "u4" });

    const full = await store.getThreadContext({
      turnId: t3.work.turn.id,
      limit: 50,
    });
    assert.deepEqual(
      full.map((message) => `${message.role}:${message.content}`),
      ["user:u1", "assistant:r1", "user:u2", "assistant:r2"],
      "conversation order must place each reply before the messages that arrived while it was being generated",
    );

    // The limit keeps the tail of the conversation-order snapshot.
    const bounded = await store.getThreadContext({
      turnId: t3.work.turn.id,
      limit: 2,
    });
    assert.deepEqual(
      bounded.map((message) => `${message.role}:${message.content}`),
      ["user:u2", "assistant:r2"],
    );

    // Turn 2's context: prior completed work only — not turn 3's messages.
    const t2Context = await store.getThreadContext({
      turnId: t2.work.turn.id,
      limit: 50,
    });
    assert.deepEqual(
      t2Context.map((message) => `${message.role}:${message.content}`),
      ["user:u1", "assistant:r1"],
    );
  });

  it("orders notices by turn/publication order, not queued user seq, including bounded later-turn context", async () => {
    await store.appendUserMessage({ content: "notice scenario u1" });
    const first = await store.claimNextTurn({ owner: "notice-o1", leaseSeconds: 60 });
    assert.equal(first.kind, "claimed");
    await store.appendUserMessage({ content: "notice scenario u2 queued before notice" });
    await store.publishReply({
      turnId: first.work.turn.id,
      leaseOwner: "notice-o1",
      content: "notice scenario r1",
    });

    assert.equal(await store.publishScheduledAssistantMessage({
      prepare: async () => ({
        content: "synthetic standalone schedule notice",
        validUntil: null,
        cancel: async () => {},
        recordPublication: async () => {},
      }),
    }), true);

    const second = await store.claimNextTurn({ owner: "notice-o2", leaseSeconds: 60 });
    assert.equal(second.kind, "claimed");
    assert.deepEqual(second.work.messages.map((message) => message.content), [
      "notice scenario u2 queued before notice",
    ]);
    await store.publishReply({
      turnId: second.work.turn.id,
      leaseOwner: "notice-o2",
      content: "notice scenario r2",
    });

    await store.appendUserMessage({ content: "notice scenario u3" });
    const third = await store.claimNextTurn({ owner: "notice-o3", leaseSeconds: 60 });
    assert.equal(third.kind, "claimed");
    const context = await store.getThreadContext({ turnId: third.work.turn.id, limit: 20 });
    assert.deepEqual(
      context.map((message) => `${message.role}:${message.content}`),
      [
        "user:notice scenario u1",
        "assistant:notice scenario r1",
        "assistant:synthetic standalone schedule notice",
        "user:notice scenario u2 queued before notice",
        "assistant:notice scenario r2",
      ],
      "the queued user's later turn follows the announcement that was published before that turn was claimed",
    );
    const bounded = await store.getThreadContext({ turnId: third.work.turn.id, limit: 4 });
    assert.deepEqual(
      bounded.map((message) => `${message.role}:${message.content}`),
      [
        "assistant:notice scenario r1",
        "assistant:synthetic standalone schedule notice",
        "user:notice scenario u2 queued before notice",
        "assistant:notice scenario r2",
      ],
      "the bounded tail preserves the same persisted turn/publication order",
    );
  });

  it("bounds the context to the most recent 40 prior messages, sent oldest-to-newest", async () => {
    // 45 prior turns, each one user message plus its reply (conversation
    // order: u_i, r_i); then a live turn claims the pending message.
    for (let index = 1; index <= 45; index += 1) {
      const turn = await pool.query(
        `INSERT INTO conversation_turn (id, status, created_at, completed_at)
         VALUES (gen_random_uuid(), 'completed', now(), now()) RETURNING id`,
      );
      const turnId = turn.rows[0].id;
      await pool.query(
        `INSERT INTO conversation_message (role, content, turn_id, effective_at, time_source, client_time_status, server_received_at) VALUES ('user', $1, $2, now(), 'server', 'absent', now())`,
        [`u${String(index)}`, turnId],
      );
      await pool.query(
        `INSERT INTO conversation_message (role, content, turn_id, effective_at, time_source, client_time_status, server_received_at) VALUES ('assistant', $1, $2, now(), 'server', 'absent', now())`,
        [`r${String(index)}`, turnId],
      );
    }

    await store.appendUserMessage({ content: "current" });
    const claim = await store.claimNextTurn({ owner: "o-40", leaseSeconds: 60 });
    assert.equal(claim.kind, "claimed");

    const window = await store.getThreadContext({
      turnId: claim.work.turn.id,
      limit: 40,
    });
    assert.equal(window.length, 40);
    // Exactly the most recent 40 conversation-order messages: turn 26's user
    // message through turn 45's reply — oldest first, newest last.
    assert.deepEqual(
      window.map((message) => message.content),
      [
        "u26", "r26", "u27", "r27", "u28", "r28", "u29", "r29", "u30", "r30",
        "u31", "r31", "u32", "r32", "u33", "r33", "u34", "r34", "u35", "r35",
        "u36", "r36", "u37", "r37", "u38", "r38", "u39", "r39", "u40", "r40",
        "u41", "r41", "u42", "r42", "u43", "r43", "u44", "r44", "u45", "r45",
      ],
      "limit 40 must select the most recent 40 messages and send them oldest-to-newest",
    );
  });

  it("keeps a failed turn's user messages in later turns' context without a reply", async () => {
    await store.appendUserMessage({ content: "doomed" });
    const first = await store.claimNextTurn({ owner: "owner-a", leaseSeconds: 60 });
    assert.equal(first.kind, "claimed");
    const failed = await store.failTurn({
      turnId: first.work.turn.id,
      leaseOwner: "owner-a",
      error: "provider unavailable",
    });
    assert.equal(failed, "failed");

    await store.appendUserMessage({ content: "after failure" });
    const second = await store.claimNextTurn({ owner: "owner-b", leaseSeconds: 60 });
    assert.equal(second.kind, "claimed");
    const context = await store.getThreadContext({
      turnId: second.work.turn.id,
      limit: 50,
    });
    assert.deepEqual(
      context.map((message) => `${message.role}:${message.content}`),
      ["user:doomed"],
      "a failed turn is terminal here, but its user messages stay part of the visible thread and of later context",
    );
  });

  it("keeps the prior-turn context snapshot identical across a lease reclaim", async () => {
    await store.appendUserMessage({ content: "one" });
    const first = await store.claimNextTurn({ owner: "owner-a", leaseSeconds: 60 });
    assert.equal(first.kind, "claimed");
    await store.appendUserMessage({ content: "during" });
    await store.publishReply({
      turnId: first.work.turn.id,
      leaseOwner: "owner-a",
      content: "reply one",
    });

    const second = await store.claimNextTurn({ owner: "owner-b", leaseSeconds: 60 });
    assert.equal(second.kind, "claimed");

    // Force lease expiry deterministically (no wall-clock waiting), then
    // reclaim: the same turn, a new attempt, a fresh lease.
    await pool.query(
      "UPDATE conversation_turn SET lease_expires_at = now() - interval '1 second' WHERE id = $1",
      [second.work.turn.id],
    );
    const reclaimed = await store.claimNextTurn({ owner: "owner-c", leaseSeconds: 60 });
    assert.equal(reclaimed.kind, "claimed");
    assert.equal(reclaimed.work.turn.id, second.work.turn.id);
    assert.equal(reclaimed.work.turn.attempt, 2);

    // A message ingested after the original claim must not leak into the
    // snapshot, and the reclaimed attempt sees the same prior work.
    await store.appendUserMessage({ content: "ingested after reclaim" });
    const context = await store.getThreadContext({
      turnId: reclaimed.work.turn.id,
      limit: 50,
    });
    assert.deepEqual(
      context.map((message) => `${message.role}:${message.content}`),
      ["user:one", "assistant:reply one"],
    );
  });

  it("serializes concurrent claims so the same messages are never double-claimed", async () => {
    await store.appendUserMessage({ content: "concurrent one" });
    await store.appendUserMessage({ content: "concurrent two" });

    const results = await Promise.allSettled([
      store.claimNextTurn({ owner: "candidate-a", leaseSeconds: 60 }),
      store.claimNextTurn({ owner: "candidate-b", leaseSeconds: 60 }),
    ]);
    const outcomes = results.map((result) => {
      assert.equal(result.status, "fulfilled");
      return result.value;
    });
    const claimed = outcomes.filter((outcome) => outcome.kind === "claimed");
    assert.equal(claimed.length, 1);
    assert.equal(claimed[0].work.messages.length, 2);
    const turnIds = new Set(
      claimed.map((outcome) => outcome.work.turn.id),
    );
    assert.equal(turnIds.size, 1);
  });

  it("blocks ingestion behind an in-flight ingest transaction so seq order matches commit order", async () => {
    // Emulate the exact in-flight state a store ingest creates: the
    // serialization lock held, a seq drawn, the row not yet committed. A
    // PostgreSQL sequence is not transactional, so without serialization a
    // later ingest could commit a higher seq first and be claimed while the
    // earlier message was still invisible to the claim snapshot.
    const holder = await pool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT pg_advisory_xact_lock($1)", [
        CLAIM_ADVISORY_LOCK_KEY,
      ]);
      await holder.query(
        "INSERT INTO conversation_message (role, content, client_key, effective_at, time_source, client_time_status, server_received_at) VALUES ('user', 'slow', 'key-slow', now(), 'server', 'absent', now())",
      );

      const ingestPromise = store
        .appendUserMessage({ content: "fast", clientKey: "key-fast" })
        .then((message) => ({ settled: true, message }))
        .catch((error) => ({ settled: true, error }));
      const claimPromise = store.claimNextTurn({
        owner: "owner-a",
        leaseSeconds: 60,
      });

      // The in-flight ingest must hold both the concurrent store ingest and
      // the claim until it commits; neither may settle while it is open.
      const ingestBlocked = await Promise.race([
        ingestPromise.then(() => false),
        sleep(150).then(() => true),
      ]);
      assert.equal(
        ingestBlocked,
        true,
        "ingestion must wait for the in-flight ingest transaction (serialization with claiming)",
      );
      const claimBlocked = await Promise.race([
        claimPromise.then(() => false),
        sleep(150).then(() => true),
      ]);
      assert.equal(
        claimBlocked,
        true,
        "claiming must wait for the in-flight ingest transaction",
      );

      await holder.query("COMMIT");

      const ingestResult = await ingestPromise;
      assert.equal(ingestResult.settled, true, "ingest completes after the in-flight transaction commits");
      const slow = await pool.query(
        "SELECT seq FROM conversation_message WHERE client_key = 'key-slow'",
      );
      assert.ok(
        Number(slow.rows[0].seq) < ingestResult.message.seq,
        "the committed-later ingest must hold a higher seq than the in-flight ingest",
      );

      // The claim either ran before the ingest (nothing pending yet: idle) or
      // after it (both messages grouped in seq order). Grouping 'fast' while
      // 'slow' is still unassigned must be impossible in either interleaving.
      const claim = await claimPromise;
      if (claim.kind === "claimed") {
        assert.deepEqual(
          claim.work.messages.map((message) => message.content),
          ["slow", "fast"],
        );
      } else {
        const next = await store.claimNextTurn({
          owner: "owner-b",
          leaseSeconds: 60,
        });
        assert.equal(next.kind, "claimed");
        assert.deepEqual(
          next.work.messages.map((message) => message.content),
          ["slow", "fast"],
        );
      }
    } finally {
      await holder.query("ROLLBACK").catch(() => {});
      holder.release();
    }
  });

  it("resolves concurrent duplicate ingests to one message without error", async () => {
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        store.appendUserMessage({ content: "same", clientKey: "dup-key" }),
      ),
    );
    assert.equal(new Set(results.map((message) => message.id)).size, 1);
    const count = await pool.query(
      "SELECT count(*)::int AS n FROM conversation_message WHERE client_key = 'dup-key'",
    );
    assert.equal(count.rows[0].n, 1);
  });

  it("keeps assigned turns in seq order across interleaved ingest/claim/publish churn", async () => {
    const claimedTurnIds = [];
    for (let round = 0; round < 5; round += 1) {
      const owner = `owner-${String(round)}`;
      const [, claim] = await Promise.all([
        store.appendUserMessage({ content: `round ${String(round)}` }),
        store.claimNextTurn({ owner, leaseSeconds: 60 }),
      ]);
      if (claim.kind === "claimed") {
        claimedTurnIds.push(claim.work.turn.id);
        const published = await store.publishReply({
          turnId: claim.work.turn.id,
          leaseOwner: owner,
          content: `reply ${String(round)}`,
        });
        assert.equal(published, "published");
      }
    }
    // Drain whatever is still pending.
    for (;;) {
      const claim = await store.claimNextTurn({
        owner: "drain",
        leaseSeconds: 60,
      });
      if (claim.kind !== "claimed") {
        break;
      }
      await store.publishReply({
        turnId: claim.work.turn.id,
        leaseOwner: "drain",
        content: "drain reply",
      });
    }

    // Every user message must have been assigned exactly once, and along seq
    // order the owning turns must be non-decreasing in creation time: a turn
    // created earlier never contains a higher seq than a turn created later.
    const unassigned = await pool.query(
      "SELECT count(*)::int AS n FROM conversation_message WHERE role = 'user' AND turn_id IS NULL",
    );
    assert.equal(unassigned.rows[0].n, 0);
    const assigned = await pool.query(
      `SELECT m.seq, m.turn_id, t.created_at
       FROM conversation_message m
       JOIN conversation_turn t ON t.id = m.turn_id
       WHERE m.role = 'user'
       ORDER BY m.seq`,
    );
    assert.equal(assigned.rows.length, 5);
    for (let index = 1; index < assigned.rows.length; index += 1) {
      const earlier = assigned.rows[index - 1];
      const later = assigned.rows[index];
      if (earlier.turn_id !== later.turn_id) {
        assert.ok(
          earlier.created_at <= later.created_at,
          `turn of seq ${earlier.seq} was created after the turn of seq ${later.seq}`,
        );
      }
    }
  });

  it("persists replies in strictly increasing thread order across turns", async () => {
    await store.appendUserMessage({ content: "a" });
    const first = await store.claimNextTurn({ owner: "o1", leaseSeconds: 60 });
    await store.publishReply({
      turnId: first.work.turn.id,
      leaseOwner: "o1",
      content: "reply one",
    });
    await store.appendUserMessage({ content: "b" });
    const second = await store.claimNextTurn({ owner: "o2", leaseSeconds: 60 });
    await store.publishReply({
      turnId: second.work.turn.id,
      leaseOwner: "o2",
      content: "reply two",
    });

    const thread = await pool.query(
      "SELECT role, content, seq FROM conversation_message ORDER BY seq",
    );
    assert.deepEqual(
      thread.rows.map((row) => `${row.role}:${row.content}`),
      ["user:a", "assistant:reply one", "user:b", "assistant:reply two"],
    );
    const seqs = thread.rows.map((row) => Number(row.seq));
    for (let index = 1; index < seqs.length; index += 1) {
      assert.ok(seqs[index] > seqs[index - 1]);
    }
  });

  it("reclaims an expired lease with a new attempt and fences the stale owner", async () => {
    await store.appendUserMessage({ content: "will crash" });
    const first = await store.claimNextTurn({ owner: "stale-owner", leaseSeconds: 1 });
    assert.equal(first.kind, "claimed");

    await sleep(1100);

    // Another candidate reclaims the same turn (restart recovery).
    const reclaimed = await store.claimNextTurn({ owner: "fresh-owner", leaseSeconds: 60 });
    assert.equal(reclaimed.kind, "claimed");
    assert.equal(reclaimed.work.turn.id, first.work.turn.id);
    assert.equal(reclaimed.work.turn.attempt, 2);
    assert.equal(reclaimed.work.turn.leaseOwner, "fresh-owner");

    // The stale owner can no longer publish, record decisions, or fail the turn.
    const stalePublish = await store.publishReply({
      turnId: first.work.turn.id,
      leaseOwner: "stale-owner",
      content: "stale reply",
    });
    assert.equal(stalePublish, "fenced");
    // The stale owner can no longer record any trace boundary: every trace
    // write is fenced by the in-flight lease the fresh owner now holds.
    const staleRequest = await store.recordDecisionRequest({
      turnId: first.work.turn.id,
      leaseOwner: "stale-owner",
      trace: {
        questionId: DECISION_QUESTION_ID,
        request: {
          model: "decision-model",
          questions: {
            [DECISION_QUESTION_ID]: { instructions: "pick a pattern" },
          },
          state: { conversation: [] },
        },
      },
    });
    assert.equal(staleRequest, false);
    const staleSelection = await store.recordDecisionSelection({
      turnId: first.work.turn.id,
      leaseOwner: "stale-owner",
      questionId: "response_pattern",
      selection: { kind: "rejected", reason: "stale owner" },
    });
    assert.equal(staleSelection, false);
    const staleChatRequest = await store.recordChatRequest({
      turnId: first.work.turn.id,
      leaseOwner: "stale-owner",
      payload: {
        request: { model: "chat-model", messages: [{ role: "user", content: "stale" }] },
        messageSources: [null],
        messageChunks: ["conversation"],
        identityRevision: 1,
      },
    });
    assert.equal(staleChatRequest, false);
    const staleChatOutcome = await store.recordChatOutcome({
      turnId: first.work.turn.id,
      leaseOwner: "stale-owner",
      payload: {
        request: { model: "chat-model", messages: [{ role: "user", content: "stale" }] },
        messageSources: [null],
        messageChunks: ["conversation"],
        identityRevision: 1,
        outcome: {
          kind: "failed",
          errorKind: "error",
          message: "stale failure",
          body: null,
        },
      },
    });
    assert.equal(staleChatOutcome, false);
    const staleFail = await store.failTurn({
      turnId: first.work.turn.id,
      leaseOwner: "stale-owner",
      error: "stale failure",
    });
    assert.equal(staleFail, "fenced");

    const replies = await pool.query(
      "SELECT count(*)::int AS n FROM conversation_message WHERE turn_id = $1 AND role = 'assistant'",
      [first.work.turn.id],
    );
    assert.equal(replies.rows[0].n, 0);
    const turn = await pool.query(
      "SELECT status, attempt, error FROM conversation_turn WHERE id = $1",
      [first.work.turn.id],
    );
    assert.equal(turn.rows[0].status, "in_flight");
    assert.equal(turn.rows[0].attempt, 2);
    assert.equal(turn.rows[0].error, null);

    // The fresh owner publishes; a duplicate attempt is an idempotent no-op.
    const freshPublish = await store.publishReply({
      turnId: first.work.turn.id,
      leaseOwner: "fresh-owner",
      content: "fresh reply",
    });
    assert.equal(freshPublish, "published");
    const duplicate = await store.publishReply({
      turnId: first.work.turn.id,
      leaseOwner: "fresh-owner",
      content: "fresh reply",
    });
    assert.equal(duplicate, "already_published");
    const repliesAfter = await pool.query(
      "SELECT count(*)::int AS n FROM conversation_message WHERE turn_id = $1 AND role = 'assistant'",
      [first.work.turn.id],
    );
    assert.equal(repliesAfter.rows[0].n, 1);
    assert.equal(
      (await pool.query("SELECT content FROM conversation_message WHERE turn_id = $1 AND role = 'assistant'", [first.work.turn.id])).rows[0].content,
      "fresh reply",
    );
  });

  it("renews a held lease and reports a lost lease", async () => {
    await store.appendUserMessage({ content: "long work" });
    const claim = await store.claimNextTurn({ owner: "owner-a", leaseSeconds: 5 });
    assert.equal(claim.kind, "claimed");

    const renewed = await store.renewLease({
      turnId: claim.work.turn.id,
      leaseOwner: "owner-a",
      leaseSeconds: 5,
    });
    assert.equal(renewed, true);

    const wrongOwner = await store.renewLease({
      turnId: claim.work.turn.id,
      leaseOwner: "owner-b",
      leaseSeconds: 5,
    });
    assert.equal(wrongOwner, false);
  });

  it("records a failed turn without a reply and stops retrying it", async () => {
    await store.appendUserMessage({ content: "doomed" });
    const claim = await store.claimNextTurn({ owner: "owner-a", leaseSeconds: 60 });
    assert.equal(claim.kind, "claimed");

    const outcome = await store.failTurn({
      turnId: claim.work.turn.id,
      leaseOwner: "owner-a",
      error: "provider unavailable",
    });
    assert.equal(outcome, "failed");

    const turn = await pool.query(
      "SELECT status, error FROM conversation_turn WHERE id = $1",
      [claim.work.turn.id],
    );
    assert.equal(turn.rows[0].status, "failed");
    assert.equal(turn.rows[0].error, "provider unavailable");

    const replies = await pool.query(
      "SELECT count(*)::int AS n FROM conversation_message WHERE turn_id = $1 AND role = 'assistant'",
      [claim.work.turn.id],
    );
    assert.equal(replies.rows[0].n, 0);

    // A failed turn is terminal in this slice: no automatic retry.
    const next = await store.claimNextTurn({ owner: "owner-b", leaseSeconds: 60 });
    assert.equal(next.kind, "idle");
  });

  it("runs the full engine cycle: decision then chat, published once", async () => {
    await pool.query(
      `INSERT INTO response_pattern (id, selection_description, response_guidance, position)
       VALUES ('concise', 'Short factual replies fit here.', 'Answer in one short paragraph.', 0),
              ('detailed', 'Longer structured explanations fit here.', 'Explain step by step.', 1)`,
    );
    await store.appendUserMessage({ content: "question one", clientKey: "k1" });
    await store.appendUserMessage({ content: "question two", clientKey: "k2" });

    const decisionCalls = [];
    const chatCalls = [];
    const outcome = await runEngineOnce({
      store,
      processTurn: (work, { leaseOwner }) =>
        processTurnWork(work, {
          decisionModel: "decision-model",
          chatModel: "chat-model",
          callDecisions: async (request) => {
            decisionCalls.push(request);
            return {
              model: "decision-model-build",
              answers: {
                response_pattern: {
                  type: "choice",
                  choice: "detailed",
                  probabilities: { concise: 0.25, detailed: 0.75 },
                },
              },
              usage: { input_tokens: 5, output_tokens: 2 },
            };
          },
          callChat: async (request) => {
            chatCalls.push(request);
            return {
              id: "chat-1",
              model: "chat-model-build",
              choices: [
                {
                  message: { role: "assistant", content: "here is the answer" },
                  finish_reason: "stop",
                },
              ],
              usage: { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 },
            };
          },
          loadIdentity: () => store.getChatIdentity(),
          loadPatterns: () => store.getEnabledResponsePatterns(),
          loadContext: (turnId) =>
            store.getThreadContext({ turnId, limit: 50 }),
          recordSnapshot: (snapshot) =>
            store.recordAttemptSnapshot({
              turnId: work.turn.id,
              leaseOwner,
              snapshot,
            }),
          recordDecisionRequest: (payload) =>
            store.recordDecisionRequest({
              turnId: work.turn.id,
              leaseOwner,
              trace: payload.trace,
            }),
          recordDecisionOutcome: (payload) =>
            store.recordDecisionOutcome({
              turnId: work.turn.id,
              leaseOwner,
              payload,
            }),
          recordDecisionSelection: (payload) =>
            store.recordDecisionSelection({
              turnId: work.turn.id,
              leaseOwner,
              questionId: payload.questionId,
              selection: payload.selection,
            }),
          recordChatRequest: (payload) =>
            store.recordChatRequest({
              turnId: work.turn.id,
              leaseOwner,
              payload,
            }),
          recordChatOutcome: (payload) =>
            store.recordChatOutcome({
              turnId: work.turn.id,
              leaseOwner,
              payload,
            }),
        }),
      leaseSeconds: 60,
      pollSeconds: 1,
      ownerLabel: "engine-test",
    });
    assert.equal(outcome, "worked");

    // One decision call happened before the chat call, with the patterns as options.
    assert.equal(decisionCalls.length, 1);
    assert.equal(chatCalls.length, 1);
    const question = decisionCalls[0].questions.response_pattern;
    assert.deepEqual(Object.keys(question.criteria), ["concise", "detailed"]);
    // Selection descriptions in, response guidance never sent to the decision.
    assert.ok(JSON.stringify(decisionCalls[0]).includes("Longer structured explanations"));
    assert.ok(!JSON.stringify(decisionCalls[0]).includes("Explain step by step."));

    // The chat request carries the identity as the leading system message,
    // then the guidance as a second system message, plus both grouped messages.
    const roles = chatCalls[0].messages.map((message) => message.role);
    assert.deepEqual(roles, ["system", "system", "user", "user"]);
    assert.equal(
      chatCalls[0].messages[0].content,
      "Integration fixture identity: generic test text.",
    );
    assert.equal(chatCalls[0].messages[1].content, "Explain step by step.");

    const turn = await pool.query(
      "SELECT status, selected_pattern_id, decision, error FROM conversation_turn",
    );
    assert.equal(turn.rows[0].status, "completed");
    assert.equal(turn.rows[0].selected_pattern_id, "detailed");
    assert.equal(turn.rows[0].error, null);
    // The legacy decision JSONB column stays untouched for new work: decision
    // diagnostics now live in the relational trace tables, and pre-tracing
    // history is preserved in the column without new fabricated rows.
    assert.equal(turn.rows[0].decision, null);

    const replies = await pool.query(
      "SELECT content FROM conversation_message WHERE role = 'assistant'",
    );
    assert.deepEqual(
      replies.rows.map((row) => row.content),
      ["here is the answer"],
    );

    // The attempt trace: one attempt, snapshot recorded, published outcome.
    const attempt = await pool.query(
      `SELECT attempt, outcome, finished_at IS NOT NULL AS finished,
              snapshot_recorded_at IS NOT NULL AS snapshotted
       FROM trace_attempt`,
    );
    assert.equal(attempt.rows.length, 1);
    assert.equal(attempt.rows[0].attempt, 1);
    assert.equal(attempt.rows[0].outcome, "published");
    assert.equal(attempt.rows[0].finished, true);
    assert.equal(attempt.rows[0].snapshotted, true);

    // The snapshot: mutable patterns (both, with full content) and the exact
    // ordered context (the turn's own grouped messages only — no prior turns).
    const snapPatterns = await pool.query(
      `SELECT position, pattern_id, selection_description, response_guidance
       FROM trace_attempt_pattern ORDER BY position`,
    );
    assert.deepEqual(
      snapPatterns.rows.map((row) => [
        row.pattern_id,
        row.selection_description,
        row.response_guidance,
      ]),
      [
        ["concise", "Short factual replies fit here.", "Answer in one short paragraph."],
        ["detailed", "Longer structured explanations fit here.", "Explain step by step."],
      ],
    );
    const turnMessages = await pool.query(
      "SELECT id, content FROM conversation_message WHERE role = 'user' AND turn_id IS NOT NULL ORDER BY seq",
    );
    const snapContext = await pool.query(
      `SELECT position, message_id FROM trace_attempt_context ORDER BY position`,
    );
    assert.deepEqual(
      snapContext.rows.map((row) => row.message_id),
      turnMessages.rows.map((row) => row.id),
    );

    // The decision boundary: native typed values in relational columns, with
    // the selection recorded separately before the chat step.
    const decision = await pool.query(
      `SELECT question_id, question_type, request_model, choice, confidence,
              selection, rejection_reason,
              response_model, usage_input_tokens, usage_output_tokens
       FROM trace_attempt_decision`,
    );
    assert.equal(decision.rows.length, 1);
    assert.equal(decision.rows[0].question_id, "response_pattern");
    assert.equal(decision.rows[0].choice, "detailed");
    assert.equal(decision.rows[0].confidence, null); // absent stays absent
    assert.equal(decision.rows[0].selection, "selected");
    assert.equal(decision.rows[0].rejection_reason, null);
    assert.equal(decision.rows[0].usage_input_tokens, 5);
    assert.equal(decision.rows[0].usage_output_tokens, 2);
    const probabilities = await pool.query(
      "SELECT option_id, value FROM trace_attempt_decision_probability ORDER BY option_id",
    );
    assert.deepEqual(probabilities.rows, [
      { option_id: "concise", value: "0.25" },
      { option_id: "detailed", value: "0.75" },
    ]);

    // The chat boundary: request messages (with source linkage and chunk
    // classification), response, usage, the identity revision, and the
    // published reply content, in the final responded state.
    const chat = await pool.query(
      `SELECT state, request_model, identity_revision, response_id, response_model, reply_content,
              usage_prompt_tokens, usage_completion_tokens, usage_total_tokens
       FROM trace_attempt_chat`,
    );
    assert.equal(chat.rows.length, 1);
    assert.equal(chat.rows[0].state, "responded");
    assert.equal(chat.rows[0].request_model, "chat-model");
    assert.equal(chat.rows[0].identity_revision, 1);
    assert.equal(chat.rows[0].response_id, "chat-1");
    assert.equal(chat.rows[0].response_model, "chat-model-build");
    assert.equal(chat.rows[0].reply_content, "here is the answer");
    assert.deepEqual(
      [chat.rows[0].usage_prompt_tokens, chat.rows[0].usage_completion_tokens, chat.rows[0].usage_total_tokens],
      [9, 4, 13],
    );
    const chatMessages = await pool.query(
      `SELECT position, role, content, source_message_id, chunk
       FROM trace_attempt_chat_message ORDER BY position`,
    );
    assert.deepEqual(chatMessages.rows.map((row) => row.role), ["system", "system", "user", "user"]);
    assert.deepEqual(
      chatMessages.rows.map((row) => row.chunk),
      ["identity", "guidance", "conversation", "conversation"],
    );
    assert.equal(chatMessages.rows[0].source_message_id, null); // identity has no source
    assert.equal(chatMessages.rows[0].content, "Integration fixture identity: generic test text.");
    assert.equal(chatMessages.rows[1].source_message_id, null); // guidance has no source
    assert.equal(chatMessages.rows[1].content, "Explain step by step.");
    assert.ok(chatMessages.rows[2].source_message_id !== null);
    assert.ok(chatMessages.rows[3].source_message_id !== null);
    assert.notEqual(
      chatMessages.rows[2].source_message_id,
      chatMessages.rows[3].source_message_id,
    );

    // Nothing else to do.
    const idle = await runEngineOnce({
      store,
      processTurn: async () => {
        throw new Error("must not be called");
      },
      leaseSeconds: 60,
      pollSeconds: 1,
    });
    assert.equal(idle, "idle");
  });

  it("feeds the prior reply to the decision and chat of a follow-up turn whose message arrived during generation", async () => {
    await pool.query(
      `INSERT INTO response_pattern (id, selection_description, response_guidance, position)
       VALUES ('concise', 'Short factual replies fit here.', 'Answer in one short paragraph.', 0)`,
    );

    const decisionResponse = (choice) => ({
      model: "decision-model-build",
      answers: {
        response_pattern: { type: "choice", choice },
      },
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const chatResponse = (content) => ({
      model: "chat-model-build",
      choices: [
        { message: { role: "assistant", content }, finish_reason: "stop" },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
    const processorDeps = (overrides = {}) => ({
      decisionModel: "decision-model",
      chatModel: "chat-model",
      callDecisions: async () => decisionResponse("concise"),
      callChat: async () => chatResponse("unobserved reply"),
      loadIdentity: () => store.getChatIdentity(),
      loadPatterns: () => store.getEnabledResponsePatterns(),
      loadContext: (turnId) =>
        store.getThreadContext({ turnId, limit: 50 }),
      ...overrides,
    });

    // Turn 1 processes "first question"; "follow-up" arrives while it is
    // generating, before turn 1's reply is published — so the follow-up's
    // seq is lower than the reply's, and the reply must still precede the
    // follow-up in turn 2's context.
    await store.appendUserMessage({ content: "first question" });
    const firstClaim = await store.claimNextTurn({ owner: "owner-a", leaseSeconds: 60 });
    assert.equal(firstClaim.kind, "claimed");
    await store.appendUserMessage({ content: "follow-up during generation" });

    const firstChatCalls = [];
    const firstOutcome = await processTurnWork(firstClaim.work, {
      ...processorDeps(),
      callChat: async (request) => {
        firstChatCalls.push(request);
        return chatResponse("reply one");
      },
    });
    assert.equal(firstOutcome.reply, "reply one");
    assert.deepEqual(
      firstChatCalls[0].messages.map((message) => `${message.role}:${message.content}`),
      [
        "system:Integration fixture identity: generic test text.",
        "system:Answer in one short paragraph.",
        "user:first question",
      ],
    );
    const published = await store.publishReply({
      turnId: firstClaim.work.turn.id,
      leaseOwner: "owner-a",
      content: firstOutcome.reply,
    });
    assert.equal(published, "published");

    // Turn 2 claims the follow-up; a further message arrives while turn 2
    // is "generating" and must not leak into turn 2's snapshot.
    const secondClaim = await store.claimNextTurn({ owner: "owner-b", leaseSeconds: 60 });
    assert.equal(secondClaim.kind, "claimed");
    assert.deepEqual(
      secondClaim.work.messages.map((message) => message.content),
      ["follow-up during generation"],
    );
    await store.appendUserMessage({ content: "later unclaimed message" });

    const secondDecisionCalls = [];
    const secondChatCalls = [];
    const secondOutcome = await processTurnWork(secondClaim.work, {
      ...processorDeps(),
      callDecisions: async (request) => {
        secondDecisionCalls.push(request);
        return decisionResponse("concise");
      },
      callChat: async (request) => {
        secondChatCalls.push(request);
        return chatResponse("reply two");
      },
    });
    assert.equal(secondOutcome.reply, "reply two");

    // The decision state carries the just-published reply before the
    // follow-up, despite the reply's higher seq.
    assert.deepEqual(
      secondDecisionCalls[0].state.conversation.map(
        (message) => `${message.role}:${message.content}`,
      ),
      ["user:first question", "assistant:reply one", "user:follow-up during generation"],
    );
    // The chat request carries the same coherent snapshot plus the turn's
    // own grouped messages, with no duplicate of them.
    assert.deepEqual(
      secondChatCalls[0].messages.map((message) => `${message.role}:${message.content}`),
      [
        "system:Integration fixture identity: generic test text.",
        "system:Answer in one short paragraph.",
        "user:first question",
        "assistant:reply one",
        "user:follow-up during generation",
      ],
    );
    // No message ingested after the claim leaks into either request.
    const serialized =
      JSON.stringify(secondDecisionCalls[0]) + JSON.stringify(secondChatCalls[0]);
    assert.ok(
      !serialized.includes("later unclaimed message"),
      "an unclaimed message ingested after the claim must not leak into the decision or chat context",
    );
  });

  it("runs no decision and publishes without guidance when no patterns are enabled", async () => {
    // response_pattern is empty: the decision step is skipped entirely.
    await store.appendUserMessage({ content: "anything" });
    const chatCalls = [];
    const result = await runEngineOnce({
      store,
      processTurn: (work) =>
        processTurnWork(work, {
          decisionModel: "decision-model",
          chatModel: "chat-model",
          callDecisions: async () => {
            throw new Error("decision must not be called");
          },
          callChat: async (request) => {
            chatCalls.push(request);
            return {
              model: "chat-model-build",
              choices: [
                { message: { role: "assistant", content: "plain answer" } },
              ],
            };
          },
          loadIdentity: () => store.getChatIdentity(),
          loadPatterns: () => store.getEnabledResponsePatterns(),
          loadContext: (turnId) =>
            store.getThreadContext({ turnId, limit: 50 }),
        }),
      leaseSeconds: 60,
      pollSeconds: 1,
    });
    assert.equal(result, "worked");
    assert.equal(chatCalls.length, 1);
    assert.deepEqual(
      chatCalls[0].messages.map((message) => message.role),
      ["system", "user"],
    );
    assert.equal(
      chatCalls[0].messages[0].content,
      "Integration fixture identity: generic test text.",
    );
    const turn = await pool.query(
      "SELECT status, selected_pattern_id, decision FROM conversation_turn",
    );
    assert.equal(turn.rows[0].status, "completed");
    assert.equal(turn.rows[0].selected_pattern_id, null);
    assert.equal(turn.rows[0].decision, null);
  });

  it("records a failed turn when the provider call fails, without a reply", async () => {
    await store.appendUserMessage({ content: "trigger failure" });
    const result = await runEngineOnce({
      store,
      processTurn: (work) =>
        processTurnWork(work, {
          decisionModel: "decision-model",
          chatModel: "chat-model",
          callDecisions: async () => {
            throw new Error("decisions endpoint unreachable");
          },
          callChat: async () => {
            throw new Error("chat must not be called");
          },
          loadIdentity: () => store.getChatIdentity(),
          loadPatterns: () =>
            Promise.resolve([
              {
                id: "concise",
                selectionDescription: "d",
                responseGuidance: "g",
                position: 0,
              },
            ]),
          loadContext: (turnId) =>
            store.getThreadContext({ turnId, limit: 50 }),
        }),
      leaseSeconds: 60,
      pollSeconds: 1,
    });
    assert.equal(result, "worked");

    const turn = await pool.query(
      "SELECT status, error FROM conversation_turn",
    );
    assert.equal(turn.rows[0].status, "failed");
    assert.ok(turn.rows[0].error.includes("decisions endpoint unreachable"));
    const replies = await pool.query(
      "SELECT count(*)::int AS n FROM conversation_message WHERE role = 'assistant'",
    );
    assert.equal(replies.rows[0].n, 0);
  });

  it("records the decision boundary before a rejected selection, leaving every response detail behind", async () => {
    await pool.query(
      `INSERT INTO response_pattern (id, selection_description, response_guidance, position)
       VALUES ('concise', 'Short factual replies fit here.', 'Answer in one short paragraph.', 0)`,
    );
    await store.appendUserMessage({ content: "reject me" });
    const outcome = await runEngineOnce({
      store,
      processTurn: (work, { leaseOwner }) =>
        processTurnWork(work, {
          decisionModel: "decision-model",
          chatModel: "chat-model",
          callDecisions: async () => ({
            model: "decision-model-build",
            answers: {
              response_pattern: {
                type: "choice",
                choice: "no-such-pattern",
                confidence: 0.4,
                probabilities: { concise: 0.3, "no-such-pattern": 0.7 },
              },
            },
            usage: { input_tokens: 6, output_tokens: 3 },
          }),
          callChat: async () => {
            throw new Error("chat must not be called");
          },
          loadIdentity: () => store.getChatIdentity(),
          loadPatterns: () => store.getEnabledResponsePatterns(),
          loadContext: (turnId) =>
            store.getThreadContext({ turnId, limit: 50 }),
          recordSnapshot: (snapshot) =>
            store.recordAttemptSnapshot({
              turnId: work.turn.id,
              leaseOwner,
              snapshot,
            }),
          recordDecisionRequest: (payload) =>
            store.recordDecisionRequest({
              turnId: work.turn.id,
              leaseOwner,
              trace: payload.trace,
            }),
          recordDecisionOutcome: (payload) =>
            store.recordDecisionOutcome({
              turnId: work.turn.id,
              leaseOwner,
              payload,
            }),
          recordDecisionSelection: (payload) =>
            store.recordDecisionSelection({
              turnId: work.turn.id,
              leaseOwner,
              questionId: payload.questionId,
              selection: payload.selection,
            }),
          recordChatRequest: (payload) =>
            store.recordChatRequest({
              turnId: work.turn.id,
              leaseOwner,
              payload,
            }),
          recordChatOutcome: (payload) =>
            store.recordChatOutcome({
              turnId: work.turn.id,
              leaseOwner,
              payload,
            }),
        }),
      leaseSeconds: 60,
      pollSeconds: 1,
    });
    assert.equal(outcome, "worked");

    // The boundary survived the rejected selection: the full native response
    // (choice, confidence, probabilities, usage) is intact even though the
    // selection step rejected it and the turn failed.
    const decision = await pool.query(
      `SELECT choice, confidence, selection, rejection_reason,
              response_model, usage_input_tokens, usage_output_tokens
       FROM trace_attempt_decision`,
    );
    assert.equal(decision.rows.length, 1);
    assert.equal(decision.rows[0].choice, "no-such-pattern");
    assert.equal(Number(decision.rows[0].confidence), 0.4);
    assert.equal(decision.rows[0].selection, "rejected");
    assert.ok(decision.rows[0].rejection_reason.length > 0);
    assert.equal(decision.rows[0].response_model, "decision-model-build");
    assert.equal(decision.rows[0].usage_input_tokens, 6);
    assert.equal(decision.rows[0].usage_output_tokens, 3);
    const probabilities = await pool.query(
      "SELECT option_id, value FROM trace_attempt_decision_probability ORDER BY option_id",
    );
    assert.deepEqual(
      probabilities.rows.map((row) => [row.option_id, Number(row.value)]),
      [["concise", 0.3], ["no-such-pattern", 0.7]],
    );

    // The turn is failed with no chat boundary and no reply.
    const turn = await pool.query(
      "SELECT status, selected_pattern_id FROM conversation_turn",
    );
    assert.equal(turn.rows[0].status, "failed");
    assert.equal(turn.rows[0].selected_pattern_id, null);
    const chat = await pool.query("SELECT count(*)::int AS n FROM trace_attempt_chat");
    assert.equal(chat.rows[0].n, 0);
    const replies = await pool.query(
      "SELECT count(*)::int AS n FROM conversation_message WHERE role = 'assistant'",
    );
    assert.equal(replies.rows[0].n, 0);
  });

  it("records a chat request before the call and the invalid outcome after a contract failure", async () => {
    await store.appendUserMessage({ content: "break the contract" });
    const result = await runEngineOnce({
      store,
      processTurn: (work, { leaseOwner }) =>
        processTurnWork(work, {
          decisionModel: "decision-model",
          chatModel: "chat-model",
          callDecisions: async () => {
            throw new Error("decision must not be called");
          },
          callChat: async () => ({
            wrong: "shape",
          }),
          loadIdentity: () => store.getChatIdentity(),
          loadPatterns: () => Promise.resolve([]),
          loadContext: (turnId) =>
            store.getThreadContext({ turnId, limit: 50 }),
          recordSnapshot: (snapshot) =>
            store.recordAttemptSnapshot({
              turnId: work.turn.id,
              leaseOwner,
              snapshot,
            }),
          recordChatRequest: (payload) =>
            store.recordChatRequest({
              turnId: work.turn.id,
              leaseOwner,
              payload,
            }),
          recordChatOutcome: (payload) =>
            store.recordChatOutcome({
              turnId: work.turn.id,
              leaseOwner,
              payload,
            }),
        }),
      leaseSeconds: 60,
      pollSeconds: 1,
    });
    assert.equal(result, "worked");

    // The chat row went through both boundary steps: requested before the
    // call, then transitioned to the invalid state with the validation error.
    const chat = await pool.query(
      `SELECT state, request_model, response_id, reply_content,
              error_kind, error_message
       FROM trace_attempt_chat`,
    );
    assert.equal(chat.rows.length, 1);
    assert.equal(chat.rows[0].state, "invalid");
    assert.equal(chat.rows[0].request_model, "chat-model");
    assert.equal(chat.rows[0].response_id, null);
    assert.equal(chat.rows[0].reply_content, null);
    assert.equal(chat.rows[0].error_kind, "invalid");
    assert.ok(chat.rows[0].error_message.length > 0);

    // The chat messages were recorded with the request (boundary survives
    // the contract failure), and the attempt is terminally failed.
    const chatMessages = await pool.query(
      "SELECT role, source_message_id, chunk FROM trace_attempt_chat_message ORDER BY position",
    );
    assert.deepEqual(chatMessages.rows.map((row) => row.role), ["system", "user"]);
    assert.deepEqual(chatMessages.rows.map((row) => row.chunk), ["identity", "conversation"]);
    assert.equal(chatMessages.rows[0].source_message_id, null);
    assert.ok(chatMessages.rows[1].source_message_id !== null);
    const attempt = await pool.query(
      "SELECT outcome, finished_at IS NOT NULL AS finished FROM trace_attempt",
    );
    assert.equal(attempt.rows[0].outcome, "failed");
    assert.equal(attempt.rows[0].finished, true);
    const turn = await pool.query("SELECT status FROM conversation_turn");
    assert.equal(turn.rows[0].status, "failed");
    const replies = await pool.query(
      "SELECT count(*)::int AS n FROM conversation_message WHERE role = 'assistant'",
    );
    assert.equal(replies.rows[0].n, 0);
  });

  it("records the decision trace before a chat failure, with the attempt failed", async () => {
    await pool.query(
      `INSERT INTO response_pattern (id, selection_description, response_guidance, position)
       VALUES ('concise', 'Short factual replies fit here.', 'Answer in one short paragraph.', 0)`,
    );
    await store.appendUserMessage({ content: "hello" });
    const result = await runEngineOnce({
      store,
      processTurn: (work, { leaseOwner }) =>
        processTurnWork(work, {
          decisionModel: "decision-model",
          chatModel: "chat-model",
          callDecisions: async () => ({
            model: "decision-model-build",
            answers: {
              response_pattern: {
                type: "choice",
                choice: "concise",
                probabilities: { concise: 1 },
              },
            },
            usage: { input_tokens: 3, output_tokens: 1 },
          }),
          callChat: async () => {
            throw new Error("chat endpoint exploded");
          },
          loadIdentity: () => store.getChatIdentity(),
          loadPatterns: () => store.getEnabledResponsePatterns(),
          loadContext: (turnId) =>
            store.getThreadContext({ turnId, limit: 50 }),
          recordSnapshot: (snapshot) =>
            store.recordAttemptSnapshot({
              turnId: work.turn.id,
              leaseOwner,
              snapshot,
            }),
          recordDecisionRequest: (payload) =>
            store.recordDecisionRequest({
              turnId: work.turn.id,
              leaseOwner,
              trace: payload.trace,
            }),
          recordDecisionOutcome: (payload) =>
            store.recordDecisionOutcome({
              turnId: work.turn.id,
              leaseOwner,
              payload,
            }),
          recordDecisionSelection: (payload) =>
            store.recordDecisionSelection({
              turnId: work.turn.id,
              leaseOwner,
              questionId: payload.questionId,
              selection: payload.selection,
            }),
          recordChatRequest: (payload) =>
            store.recordChatRequest({
              turnId: work.turn.id,
              leaseOwner,
              payload,
            }),
          recordChatOutcome: (payload) =>
            store.recordChatOutcome({
              turnId: work.turn.id,
              leaseOwner,
              payload,
            }),
        }),
      leaseSeconds: 60,
      pollSeconds: 1,
    });
    assert.equal(result, "worked");

    // The decision boundary survived the later chat failure, with the
    // selection recorded separately before the chat step began.
    const decision = await pool.query(
      `SELECT choice, selection, rejection_reason, response_model,
              usage_input_tokens
       FROM trace_attempt_decision`,
    );
    assert.equal(decision.rows.length, 1);
    assert.equal(decision.rows[0].choice, "concise");
    assert.equal(decision.rows[0].selection, "selected");
    assert.equal(decision.rows[0].rejection_reason, null);
    assert.equal(decision.rows[0].response_model, "decision-model-build");
    assert.equal(decision.rows[0].usage_input_tokens, 3);

    // The chat request was recorded before the provider call, and the failed
    // call transitioned that same row to the honest failure state.
    const chat = await pool.query(
      `SELECT state, request_model, response_id, reply_content,
              error_kind, error_message
       FROM trace_attempt_chat`,
    );
    assert.equal(chat.rows.length, 1);
    assert.equal(chat.rows[0].state, "failed");
    assert.equal(chat.rows[0].request_model, "chat-model");
    assert.equal(chat.rows[0].response_id, null);
    assert.equal(chat.rows[0].reply_content, null);
    assert.equal(chat.rows[0].error_kind, "error");
    assert.equal(chat.rows[0].error_message, "chat endpoint exploded");

    // The attempt is terminally failed, fenced-safe, with no reply published.
    const attempt = await pool.query(
      `SELECT outcome, finished_at IS NOT NULL AS finished FROM trace_attempt`,
    );
    assert.equal(attempt.rows.length, 1);
    assert.equal(attempt.rows[0].outcome, "failed");
    assert.equal(attempt.rows[0].finished, true);
    const turn = await pool.query(
      "SELECT status, selected_pattern_id FROM conversation_turn",
    );
    assert.equal(turn.rows[0].status, "failed");
    assert.equal(turn.rows[0].selected_pattern_id, "concise");
    const replies = await pool.query(
      "SELECT count(*)::int AS n FROM conversation_message WHERE role = 'assistant'",
    );
    assert.equal(replies.rows[0].n, 0);
  });

  it("preserves each attempt's pattern snapshot when the mutable patterns change between attempts", async () => {
    await pool.query(
      `INSERT INTO response_pattern (id, selection_description, response_guidance, position)
       VALUES ('concise', 'v1 selection', 'v1 guidance', 0)`,
    );
    await store.appendUserMessage({ content: "needs two attempts" });
    const first = await store.claimNextTurn({ owner: "owner-a", leaseSeconds: 1 });
    assert.equal(first.kind, "claimed");

    // Attempt 1 snapshots the v1 configuration.
    const context = await store.getThreadContext({
      turnId: first.work.turn.id,
      limit: 50,
    });
    const snap1 = await store.recordAttemptSnapshot({
      turnId: first.work.turn.id,
      leaseOwner: "owner-a",
      snapshot: { context, patterns: await store.getEnabledResponsePatterns() },
    });
    assert.equal(snap1, true);

    // The lease expires and the configuration is edited before the reclaim.
    await sleep(1100);
    await pool.query(
      `UPDATE response_pattern
       SET selection_description = 'v2 selection', response_guidance = 'v2 guidance'
       WHERE id = 'concise'`,
    );
    const reclaimed = await store.claimNextTurn({ owner: "owner-b", leaseSeconds: 60 });
    assert.equal(reclaimed.kind, "claimed");
    const snap2 = await store.recordAttemptSnapshot({
      turnId: first.work.turn.id,
      leaseOwner: "owner-b",
      snapshot: {
        context,
        patterns: await store.getEnabledResponsePatterns(),
      },
    });
    assert.equal(snap2, true);

    // A duplicate snapshot of the same attempt is an idempotent no-op: the
    // first snapshot is what the attempt actually saw.
    const snapAgain = await store.recordAttemptSnapshot({
      turnId: first.work.turn.id,
      leaseOwner: "owner-b",
      snapshot: {
        context: [],
        patterns: [
          {
            id: "concise",
            selectionDescription: "overwritten",
            responseGuidance: "overwritten",
            position: 0,
          },
        ],
      },
    });
    assert.equal(snapAgain, true);

    const snaps = await pool.query(
      `SELECT t.attempt, p.selection_description, p.response_guidance
       FROM trace_attempt t JOIN trace_attempt_pattern p ON p.attempt_id = t.id
       ORDER BY t.attempt`,
    );
    assert.deepEqual(
      snaps.rows.map((row) => [row.attempt, row.selection_description, row.response_guidance]),
      [
        [1, "v1 selection", "v1 guidance"],
        [2, "v2 selection", "v2 guidance"],
      ],
    );
  });

  it("records fenced and superseded attempts across a lease reclaim", async () => {
    await store.appendUserMessage({ content: "reclaim me" });
    const first = await store.claimNextTurn({ owner: "stale-owner", leaseSeconds: 1 });
    assert.equal(first.kind, "claimed");
    await sleep(1100);
    const reclaimed = await store.claimNextTurn({ owner: "fresh-owner", leaseSeconds: 60 });
    assert.equal(reclaimed.kind, "claimed");

    // The reclaim atomically superseded the stale worker's open attempt in
    // the same transaction as the lease replacement: no self-report is
    // needed, and a late self-report is an idempotent no-op.
    const fenced = await store.markAttemptFenced({
      turnId: first.work.turn.id,
      leaseOwner: "stale-owner",
    });
    assert.equal(fenced, false);
    const superseded = await pool.query(
      `SELECT outcome, finished_at IS NOT NULL AS finished
       FROM trace_attempt WHERE attempt = 1`,
    );
    assert.equal(superseded.rows[0].outcome, "superseded");
    assert.equal(superseded.rows[0].finished, true);

    // The stale owner cannot record any trace boundary either: every write
    // is fenced by the in-flight lease the fresh owner now holds.
    const staleRequest = await store.recordDecisionRequest({
      turnId: first.work.turn.id,
      leaseOwner: "stale-owner",
      trace: {
        questionId: DECISION_QUESTION_ID,
        request: {
          model: "decision-model",
          questions: {
            [DECISION_QUESTION_ID]: { instructions: "pick a pattern" },
          },
          state: { conversation: [] },
        },
      },
    });
    assert.equal(staleRequest, false);
    const staleChatOutcome = await store.recordChatOutcome({
      turnId: first.work.turn.id,
      leaseOwner: "stale-owner",
      payload: {
        request: { model: "chat-model", messages: [{ role: "user", content: "stale" }] },
        messageSources: [null],
        messageChunks: ["conversation"],
        identityRevision: 1,
        outcome: {
          kind: "failed",
          errorKind: "error",
          message: "stale failure",
          body: null,
        },
      },
    });
    assert.equal(staleChatOutcome, false);
    const stalePublish = await store.publishReply({
      turnId: first.work.turn.id,
      leaseOwner: "stale-owner",
      content: "stale reply",
    });
    assert.equal(stalePublish, "fenced");

    // The fresh owner records its chat boundary (request before the call,
    // outcome after), then publishes.
    const messageId = reclaimed.work.messages[0].id;
    const freshChatRequest = {
      model: "chat-model",
      messages: [
        { role: "system", content: "guidance" },
        { role: "user", content: "reclaim me" },
      ],
    };
    const freshRequestRecorded = await store.recordChatRequest({
      turnId: first.work.turn.id,
      leaseOwner: "fresh-owner",
      payload: {
        request: freshChatRequest,
        messageSources: [null, messageId],
        messageChunks: ["guidance", "conversation"],
        identityRevision: 1,
      },
    });
    assert.equal(freshRequestRecorded, true);
    const freshOutcomeRecorded = await store.recordChatOutcome({
      turnId: first.work.turn.id,
      leaseOwner: "fresh-owner",
      payload: {
        request: freshChatRequest,
        messageSources: [null, messageId],
        messageChunks: ["guidance", "conversation"],
        identityRevision: 1,
        outcome: {
          kind: "responded",
          response: {
            id: "chat-r1",
            model: "chat-model-build",
            choices: [
              {
                message: { role: "assistant", content: "fresh reply" },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
          },
          replyContent: "fresh reply",
        },
      },
    });
    assert.equal(freshOutcomeRecorded, true);
    const published = await store.publishReply({
      turnId: first.work.turn.id,
      leaseOwner: "fresh-owner",
      content: "fresh reply",
    });
    assert.equal(published, "published");

    const attempts = await pool.query(
      `SELECT attempt, lease_owner, outcome, finished_at IS NOT NULL AS finished
       FROM trace_attempt ORDER BY attempt`,
    );
    assert.deepEqual(
      attempts.rows.map((row) => [row.attempt, row.lease_owner, row.outcome]),
      [
        [1, "stale-owner", "superseded"],
        [2, "fresh-owner", "published"],
      ],
    );
    // Only the published attempt carries a chat boundary record.
    const chatRows = await pool.query(
      `SELECT t.attempt, c.request_model, c.reply_content
       FROM trace_attempt t JOIN trace_attempt_chat c ON c.attempt_id = t.id
       ORDER BY t.attempt`,
    );
    assert.deepEqual(
      chatRows.rows.map((row) => [row.attempt, row.request_model, row.reply_content]),
      [[2, "chat-model", "fresh reply"]],
    );
    const turn = await pool.query(
      "SELECT status FROM conversation_turn WHERE id = $1",
      [first.work.turn.id],
    );
    assert.equal(turn.rows[0].status, "completed");
  });

  it("records the chat boundary atomically before publication", async () => {
    await store.appendUserMessage({ content: "atomic" });
    const claim = await store.claimNextTurn({ owner: "owner-atomic", leaseSeconds: 60 });
    assert.equal(claim.kind, "claimed");
    const messageId = claim.work.messages[0].id;
    const chatRequest = {
      model: "chat-model",
      messages: [{ role: "user", content: "atomic" }],
    };

    // A misaligned messageSources payload fails the whole record
    // transaction: no chat row, no chat messages, and the attempt stays open.
    await assert.rejects(
      () =>
        store.recordChatRequest({
          turnId: claim.work.turn.id,
          leaseOwner: "owner-atomic",
          payload: {
            request: chatRequest,
            messageSources: [messageId, messageId],
            messageChunks: ["conversation"],
            identityRevision: 1,
          },
        }),
      /messageSources must align/,
    );
    // A misaligned messageChunks payload fails the same way.
    await assert.rejects(
      () =>
        store.recordChatRequest({
          turnId: claim.work.turn.id,
          leaseOwner: "owner-atomic",
          payload: {
            request: chatRequest,
            messageSources: [messageId],
            messageChunks: ["conversation", "conversation"],
            identityRevision: 1,
          },
        }),
      /messageChunks must align/,
    );
    const afterFailure = await pool.query(
      `SELECT (SELECT status FROM conversation_turn WHERE id = $1) AS status,
              (SELECT count(*)::int FROM conversation_message
                WHERE turn_id = $1 AND role = 'assistant') AS replies,
              (SELECT count(*)::int FROM trace_attempt_chat) AS chats,
              (SELECT count(*)::int FROM trace_attempt_chat_message) AS chat_messages,
              (SELECT finished_at IS NULL FROM trace_attempt WHERE turn_id = $1) AS attempt_open`,
      [claim.work.turn.id],
    );
    assert.equal(afterFailure.rows[0].status, "in_flight");
    assert.equal(afterFailure.rows[0].replies, 0);
    assert.equal(afterFailure.rows[0].chats, 0);
    assert.equal(afterFailure.rows[0].chat_messages, 0);
    assert.equal(afterFailure.rows[0].attempt_open, true);

    // The corrected request record writes the request in 'requested' state,
    // then the outcome transitions that same row before publication.
    const requested = await store.recordChatRequest({
      turnId: claim.work.turn.id,
      leaseOwner: "owner-atomic",
      payload: {
        request: chatRequest,
        messageSources: [messageId],
        messageChunks: ["conversation"],
        identityRevision: 1,
      },
    });
    assert.equal(requested, true);
    const requestedRow = await pool.query(
      "SELECT state FROM trace_attempt_chat",
    );
    assert.equal(requestedRow.rows[0].state, "requested");

    const outcomeRecorded = await store.recordChatOutcome({
      turnId: claim.work.turn.id,
      leaseOwner: "owner-atomic",
      payload: {
        request: chatRequest,
        messageSources: [messageId],
        messageChunks: ["conversation"],
        identityRevision: 1,
        outcome: {
          kind: "responded",
          response: {
            id: "chat-a1",
            model: "chat-model-build",
            choices: [
              {
                message: { role: "assistant", content: "atomic reply" },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 },
          },
          replyContent: "atomic reply",
        },
      },
    });
    assert.equal(outcomeRecorded, true);

    // Publication completes the turn; the trace row survives untouched.
    const published = await store.publishReply({
      turnId: claim.work.turn.id,
      leaseOwner: "owner-atomic",
      content: "atomic reply",
    });
    assert.equal(published, "published");
    const afterSuccess = await pool.query(
      `SELECT (SELECT status FROM conversation_turn WHERE id = $1) AS status,
              (SELECT count(*)::int FROM conversation_message
                WHERE turn_id = $1 AND role = 'assistant') AS replies,
              (SELECT state FROM trace_attempt_chat
                WHERE reply_content = 'atomic reply') AS state,
              (SELECT outcome FROM trace_attempt WHERE turn_id = $1) AS outcome`,
      [claim.work.turn.id],
    );
    assert.equal(afterSuccess.rows[0].status, "completed");
    assert.equal(afterSuccess.rows[0].replies, 1);
    assert.equal(afterSuccess.rows[0].state, "responded");
    assert.equal(afterSuccess.rows[0].outcome, "published");
  });

  it("assembles the turn trace report with every recorded boundary", async () => {
    await pool.query(
      `INSERT INTO response_pattern (id, selection_description, response_guidance, position)
       VALUES ('concise', 'Short factual replies fit here.', 'Answer in one short paragraph.', 0)`,
    );
    await store.appendUserMessage({ content: "report me" });
    const claim = await store.claimNextTurn({ owner: "owner-report", leaseSeconds: 60 });
    assert.equal(claim.kind, "claimed");
    const turnId = claim.work.turn.id;

    const history = await store.getThreadContext({ turnId, limit: 50 });
    const context = [...history, ...claim.work.messages];
    const patterns = await store.getEnabledResponsePatterns();
    await store.recordAttemptSnapshot({
      turnId,
      leaseOwner: "owner-report",
      snapshot: { context, patterns },
    });
    const decisionRequest = buildPatternChoiceRequest({
      model: "decision-model",
      patterns,
      state: {
        conversation: claim.work.messages.map((message) => ({
          role: message.role,
          content: message.content,
        })),
      },
    });
    const decisionResponse = {
      model: "decision-model-build",
      answers: {
        response_pattern: {
          type: "choice",
          choice: "concise",
          confidence: 0.9,
          probabilities: { concise: 0.9 },
        },
      },
      usage: { input_tokens: 4, output_tokens: 2 },
    };
    await store.recordDecisionRequest({
      turnId,
      leaseOwner: "owner-report",
      trace: { questionId: DECISION_QUESTION_ID, request: decisionRequest },
    });
    await store.recordDecisionOutcome({
      turnId,
      leaseOwner: "owner-report",
      payload: {
        trace: { questionId: DECISION_QUESTION_ID, request: decisionRequest },
        outcome: {
          kind: "responded",
          trace: {
            questionId: DECISION_QUESTION_ID,
            request: decisionRequest,
            response: decisionResponse,
          },
        },
      },
    });
    await store.recordDecisionSelection({
      turnId,
      leaseOwner: "owner-report",
      questionId: "response_pattern",
      selection: { kind: "selected", patternId: "concise" },
    });
    const chatRequest = buildChatRequest({
      model: "chat-model",
      identity: "Integration fixture identity: generic test text.",
      history: [],
      turnMessages: claim.work.messages,
      guidance: "Answer in one short paragraph.",
    });
    const messageSources = [
      null,
      null,
      claim.work.messages[0].id,
    ];
    await store.recordChatRequest({
      turnId,
      leaseOwner: "owner-report",
      payload: {
        request: chatRequest,
        messageSources,
        messageChunks: ["identity", "guidance", "conversation"],
        identityRevision: 1,
      },
    });
    await store.recordChatOutcome({
      turnId,
      leaseOwner: "owner-report",
      payload: {
        request: chatRequest,
        messageSources,
        messageChunks: ["identity", "guidance", "conversation"],
        identityRevision: 1,
        outcome: {
          kind: "responded",
          response: {
            id: "chat-report",
            model: "chat-model-build",
            choices: [
              {
                message: { role: "assistant", content: "reported reply" },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
          },
          replyContent: "reported reply",
        },
      },
    });
    const published = await store.publishReply({
      turnId,
      leaseOwner: "owner-report",
      content: "reported reply",
    });
    assert.equal(published, "published");

    const report = await store.getTurnTraceReport({ turnId });
    assert.equal(report.turn.id, turnId);
    assert.equal(report.turn.status, "completed");
    assert.equal(report.turn.selectedPatternId, "concise");
    assert.equal(report.attempts.length, 1);

    const attempt = report.attempts[0];
    assert.equal(attempt.attempt, 1);
    assert.equal(attempt.leaseOwner, "owner-report");
    assert.equal(attempt.outcome, "published");
    assert.notEqual(attempt.finishedAt, null);
    assert.notEqual(attempt.snapshotRecordedAt, null);

    // The context snapshot: the turn's own message in order, fromTurn true.
    assert.deepEqual(
      attempt.context.map((message) => [message.position, message.role, message.content, message.fromTurn]),
      [[0, "user", "report me", true]],
    );
    // The pattern snapshot: the offered configuration at attempt time.
    assert.deepEqual(
      attempt.patterns.map((pattern) => pattern.patternId),
      ["concise"],
    );
    assert.equal(attempt.patterns[0].selectionDescription, "Short factual replies fit here.");
    assert.equal(attempt.patterns[0].responseGuidance, "Answer in one short paragraph.");

    // The decision boundary in the report: native values preserved.
    assert.notEqual(attempt.decision, null);
    assert.equal(attempt.decision.questionId, "response_pattern");
    assert.equal(attempt.decision.questionType, "choice");
    assert.equal(attempt.decision.choice, "concise");
    assert.equal(attempt.decision.confidence, 0.9);
    assert.deepEqual(attempt.decision.probabilities, [{ optionId: "concise", value: 0.9 }]);
    assert.equal(attempt.decision.responseModel, "decision-model-build");
    assert.equal(attempt.decision.usageInputTokens, 4);
    assert.equal(attempt.decision.usageOutputTokens, 2);
    // The selection outcome, recorded separately from the boundary.
    assert.equal(attempt.decision.selection, "selected");
    assert.equal(attempt.decision.rejectionReason, null);

    // The chat boundary in the report: request messages with source linkage
    // and chunk classification, choices, usage, the identity revision, and
    // the reply.
    assert.notEqual(attempt.chat, null);
    assert.equal(attempt.chat.state, "responded");
    assert.equal(attempt.chat.identityRevision, 1);
    assert.deepEqual(
      attempt.chat.messages.map((message) => [
        message.role,
        message.sourceMessageId,
        message.chunk,
      ]),
      [
        ["system", null, "identity"],
        ["system", null, "guidance"],
        ["user", claim.work.messages[0].id, "conversation"],
      ],
    );
    assert.deepEqual(
      attempt.chat.choices.map((choice) => [choice.finishReason, choice.content]),
      [["stop", "reported reply"]],
    );
    assert.equal(attempt.chat.replyContent, "reported reply");
    assert.equal(attempt.chat.responseId, "chat-report");
    assert.deepEqual(
      [attempt.chat.usagePromptTokens, attempt.chat.usageCompletionTokens, attempt.chat.usageTotalTokens],
      [5, 3, 8],
    );
  });

  it("preserves a legacy pre-tracing turn and its decision JSONB through the tracing migration", async () => {
    // Roll the database back to its pre-tracing shape: drop the tracing
    // tables and their migration bookkeeping rows, keep the domain tables.
    // The chat-identity migration (0004) ALTERs the tracing tables, so it is
    // rolled back and re-applied together with 0002 — the same order the
    // conversation domain's migration array supplies.
    await pool.query(
      `DROP TABLE IF EXISTS
         trace_attempt_chat_choice, trace_attempt_chat_message, trace_attempt_chat,
         trace_attempt_decision_probability, trace_attempt_decision,
         trace_attempt_pattern, trace_attempt_context, trace_attempt,
         chat_identity CASCADE`,
    );
    await pool.query(`DROP INDEX IF EXISTS article_share_turn_reaction_idx`);
    await pool.query(
      `DELETE FROM companion_schema_migration
       WHERE id IN ('0002_conversation_tracing', '0004_chat_identity',
                    '0008_article_share_and_evidence', '0017_trace_attempt_temporal_context')`,
    );

    // A legacy turn exactly as pre-tracing code wrote it.
    const legacy = await pool.query(
      `INSERT INTO conversation_turn
         (id, status, attempt, selected_pattern_id, decision, completed_at)
       VALUES (gen_random_uuid(), 'completed', 1, 'concise',
               '{"choice":"concise","confidence":0.9,"model":"legacy-model"}', now())
       RETURNING id`,
    );
    const legacyTurnId = legacy.rows[0].id;
    await pool.query(
      `INSERT INTO conversation_message
         (role, content, turn_id, effective_at, time_source,
          client_time_status, server_received_at)
       VALUES ('assistant', 'legacy reply', $1, now(), 'server', 'absent', now())`,
      [legacyTurnId],
    );

    // The tracing migrations apply cleanly over the legacy data. The article
    // migration set is re-applied with them: 0008 owns the trace-decision
    // uniqueness AND the article trace-kind/chunk constraint widenings this
    // suite's later engine tests rely on (per-question trace rows; the
    // article chunk classification), and re-running it over the recreated
    // tracing tables restores that shape — the article composition belongs to
    // the same array main.ts applies.
    const applied = await runMigrations(pool, [
      ...conversationMigrations,
      ...articleMigrations,
      ...temporalMigrations,
    ]);
    assert.deepEqual(applied.applied, [
      "0002_conversation_tracing",
      "0004_chat_identity",
      "0008_article_share_and_evidence",
      "0017_trace_attempt_temporal_context",
    ]);

    // The legacy row is untouched: the decision JSONB is exactly as inserted,
    // and no attempt rows were fabricated for it.
    const turn = await pool.query(
      "SELECT status, selected_pattern_id, decision FROM conversation_turn WHERE id = $1",
      [legacyTurnId],
    );
    assert.deepEqual(turn.rows[0].decision, {
      choice: "concise",
      confidence: 0.9,
      model: "legacy-model",
    });
    const attemptRows = await pool.query(
      "SELECT count(*)::int AS n FROM trace_attempt WHERE turn_id = $1",
      [legacyTurnId],
    );
    assert.equal(attemptRows.rows[0].n, 0);

    // The report presents the legacy turn with no recorded attempts and its
    // legacy decision JSONB, clearly kept apart from traced attempts.
    const report = await store.getTurnTraceReport({ turnId: legacyTurnId });
    assert.equal(report.turn.id, legacyTurnId);
    assert.deepEqual(report.turn.decision, {
      choice: "concise",
      confidence: 0.9,
      model: "legacy-model",
    });
    assert.equal(report.attempts.length, 0);

    // The rolled-back-and-reapplied chat-identity table starts empty again:
    // re-provision the fixture row the rest of the suite assumes.
    await pool.query(
      `INSERT INTO chat_identity (id, content, revision)
       VALUES ('identity', 'Integration fixture identity: generic test text.', 1)`,
    );
  });

  /**
   * Store-wired tracing deps, exactly as main.ts composes them: every record
   * dep writes through the real store and refuses to continue when the write
   * reports fencing (lease lost), so a stale attempt stops processing instead
   * of proceeding on an unrecorded boundary. These tests therefore verify the
   * persisted trace and the stop-on-fence behavior, not merely that the
   * processor called its dependencies.
   */
  const tracingDeps = (turnId, leaseOwner) => ({
    recordSnapshot: async (snapshot) => {
      const recorded = await store.recordAttemptSnapshot({
        turnId,
        leaseOwner,
        snapshot,
      });
      if (!recorded) {
        throw new TraceWriteFencedError(
          `snapshot trace write fenced: lease for turn ${turnId} no longer held`,
        );
      }
    },
    recordDecisionRequest: async (payload) => {
      const recorded = await store.recordDecisionRequest({
        turnId,
        leaseOwner,
        trace: payload.trace,
      });
      if (!recorded) {
        throw new TraceWriteFencedError(
          `decision request trace write fenced: lease for turn ${turnId} no longer held`,
        );
      }
    },
    recordDecisionOutcome: async (payload) => {
      const recorded = await store.recordDecisionOutcome({
        turnId,
        leaseOwner,
        payload,
      });
      if (!recorded) {
        throw new TraceWriteFencedError(
          `decision outcome trace write fenced: lease for turn ${turnId} no longer held`,
        );
      }
    },
    recordDecisionSelection: async (payload) => {
      const recorded = await store.recordDecisionSelection({
        turnId,
        leaseOwner,
        questionId: payload.questionId,
        selection: payload.selection,
      });
      if (!recorded) {
        throw new TraceWriteFencedError(
          `decision selection trace write fenced: lease for turn ${turnId} no longer held`,
        );
      }
    },
    recordChatRequest: async (payload) => {
      const recorded = await store.recordChatRequest({
        turnId,
        leaseOwner,
        payload,
      });
      if (!recorded) {
        throw new TraceWriteFencedError(
          `chat request trace write fenced: lease for turn ${turnId} no longer held`,
        );
      }
    },
    recordChatOutcome: async (payload) => {
      const recorded = await store.recordChatOutcome({
        turnId,
        leaseOwner,
        payload,
      });
      if (!recorded) {
        throw new TraceWriteFencedError(
          `chat outcome trace write fenced: lease for turn ${turnId} no longer held`,
        );
      }
    },
  });

  it("records a decision request before the provider call and a failed outcome with the real error when the decision call throws", async () => {
    await pool.query(
      `INSERT INTO response_pattern (id, selection_description, response_guidance, position)
       VALUES ('concise', 'd', 'g', 0)`,
    );
    await store.appendUserMessage({ content: "ask for decision failure" });
    const claim = await store.claimNextTurn({ owner: "owner-a", leaseSeconds: 60 });
    assert.equal(claim.kind, "claimed");

    let chatWasCalled = false;
    await assert.rejects(
      processTurnWork(claim.work, {
        decisionModel: "decision-model",
        chatModel: "chat-model",
        callDecisions: async () => {
          throw new Error("decisions endpoint unreachable");
        },
        callChat: async () => {
          chatWasCalled = true;
          throw new Error("chat must not be called after decision failure");
        },
        loadIdentity: () => store.getChatIdentity(),
        loadPatterns: () => store.getEnabledResponsePatterns(),
        loadContext: (turnId) =>
          store.getThreadContext({ turnId, limit: 50 }),
        ...tracingDeps(claim.work.turn.id, "owner-a"),
      }),
      /decisions endpoint unreachable/,
    );
    assert.equal(chatWasCalled, false);

    // The decision trace exists in the failed state with the real error: the
    // request was recorded before the failing call (question and instructions
    // are present), and no response data was invented.
    const report = await store.getTurnTraceReport({ turnId: claim.work.turn.id });
    assert.equal(report.attempts.length, 1);
    const decision = report.attempts[0].decision;
    assert.notEqual(decision, null);
    assert.equal(decision.state, "failed");
    assert.equal(decision.requestModel, "decision-model");
    assert.ok(decision.instructions.length > 0);
    assert.equal(decision.errorKind, "error");
    assert.equal(decision.errorMessage, "decisions endpoint unreachable");
    assert.equal(decision.errorBody, null);
    assert.equal(decision.choice, null);
    assert.equal(decision.responseModel, null);
    assert.equal(decision.selection, null);
  });

  it("records an invalid decision outcome when a body arrives but fails the contract", async () => {
    await pool.query(
      `INSERT INTO response_pattern (id, selection_description, response_guidance, position)
       VALUES ('concise', 'd', 'g', 0)`,
    );
    await store.appendUserMessage({ content: "ask for decision contract failure" });
    const claim = await store.claimNextTurn({ owner: "owner-a", leaseSeconds: 60 });
    assert.equal(claim.kind, "claimed");

    await assert.rejects(
      processTurnWork(claim.work, {
        decisionModel: "decision-model",
        chatModel: "chat-model",
        callDecisions: async () => ({ not: "a decisions envelope" }),
        callChat: async () => {
          throw new Error("chat must not be called after decision failure");
        },
        loadIdentity: () => store.getChatIdentity(),
        loadPatterns: () => store.getEnabledResponsePatterns(),
        loadContext: (turnId) =>
          store.getThreadContext({ turnId, limit: 50 }),
        ...tracingDeps(claim.work.turn.id, "owner-a"),
      }),
    );

    // The decision trace is invalid: the offending untyped value is not
    // persisted (it has no relational home), but the validation error message
    // is, and the recorded request is still there.
    const report = await store.getTurnTraceReport({ turnId: claim.work.turn.id });
    assert.equal(report.attempts.length, 1);
    const decision = report.attempts[0].decision;
    assert.notEqual(decision, null);
    assert.equal(decision.state, "invalid");
    assert.equal(decision.requestModel, "decision-model");
    assert.notEqual(decision.errorMessage, null);
    assert.equal(decision.errorBody, null);
    assert.equal(decision.choice, null);
    assert.equal(decision.responseModel, null);
  });

  it("records a chat invalid outcome with the contract error when the provider returns no choices", async () => {
    await store.appendUserMessage({ content: "empty chat choices" });
    const claim = await store.claimNextTurn({ owner: "owner-a", leaseSeconds: 60 });
    assert.equal(claim.kind, "claimed");

    await assert.rejects(
      processTurnWork(claim.work, {
        decisionModel: "decision-model",
        chatModel: "chat-model",
        callDecisions: async () => {
          throw new Error("decision must not be called with no patterns");
        },
        callChat: async () => ({
          model: "chat-model-build",
          choices: [],
        }),
        loadIdentity: () => store.getChatIdentity(),
        loadPatterns: () => store.getEnabledResponsePatterns(),
        loadContext: (turnId) =>
          store.getThreadContext({ turnId, limit: 50 }),
        ...tracingDeps(claim.work.turn.id, "owner-a"),
      }),
      /choices: expected at least one choice/,
    );

    // The chat contract rejects an empty choices array, so the honest trace
    // is `invalid` with the real validation error: no response content is
    // invented, and the report is unambiguous about what arrived.
    const report = await store.getTurnTraceReport({ turnId: claim.work.turn.id });
    assert.equal(report.attempts.length, 1);
    const chat = report.attempts[0].chat;
    assert.notEqual(chat, null);
    assert.equal(chat.state, "invalid");
    assert.equal(chat.errorKind, "invalid");
    assert.ok(
      chat.errorMessage.includes("choices: expected at least one choice"),
      `expected the contract validation error, got: ${chat.errorMessage}`,
    );
    assert.equal(chat.replyContent, null);
    assert.equal(chat.applicationRejection, null);
    assert.deepEqual(chat.choices, []);
  });

  it("persists a responded chat outcome carrying an application rejection and renders publication only from the turn outcome", async () => {
    await store.appendUserMessage({ content: "application rejection path" });
    const claim = await store.claimNextTurn({ owner: "owner-a", leaseSeconds: 60 });
    assert.equal(claim.kind, "claimed");

    const chatRequest = buildChatRequest({
      model: "chat-model",
      identity: "Integration fixture identity: generic test text.",
      history: [],
      turnMessages: claim.work.messages,
      guidance: null,
    });
    const response = {
      id: "chat-reject-1",
      model: "chat-model-build",
      choices: [
        {
          message: { role: "assistant", content: "unusable reply" },
          finish_reason: "stop",
        },
      ],
    };
    const recorded = await store.recordChatOutcome({
      turnId: claim.work.turn.id,
      leaseOwner: "owner-a",
      payload: {
        request: chatRequest,
        messageSources: [
          null,
          ...claim.work.messages.map((message) => message.id),
        ],
        messageChunks: [
          "identity",
          ...claim.work.messages.map(() => "conversation"),
        ],
        identityRevision: 1,
        outcome: {
          kind: "responded",
          response,
          replyContent: null,
          applicationRejection: "chat response has no usable choices",
        },
      },
    });
    assert.equal(recorded, true);

    // The row carries the application rejection separately from the transport
    // outcome: the response arrived, and the application rejected it.
    const report = await store.getTurnTraceReport({ turnId: claim.work.turn.id });
    assert.equal(report.attempts.length, 1);
    const chat = report.attempts[0].chat;
    assert.notEqual(chat, null);
    assert.equal(chat.state, "responded");
    assert.equal(chat.responseModel, "chat-model-build");
    assert.equal(chat.replyContent, null);
    assert.equal(chat.applicationRejection, "chat response has no usable choices");
    assert.deepEqual(
      chat.choices.map((choice) => choice.content),
      ["unusable reply"],
    );

    // The CLI renders the generated reply and the application rejection from
    // the attempt boundary, and publication only from the turn's actual
    // status: this turn is still in flight, so nothing was published.
    const text = renderReport(report);
    assert.ok(text.includes("status: in_flight"));
    assert.ok(text.includes("reply published: no"));
    assert.ok(
      text.includes('application rejection: "chat response has no usable choices"'),
      `expected the application rejection in the rendered report, got:\n${text}`,
    );
    assert.ok(
      text.includes("generated reply: (none — response unusable or not returned)"),
      `expected the no-generated-reply marker, got:\n${text}`,
    );
    assert.ok(
      !text.includes('reply published: "unusable reply"'),
      "the renderer must not claim publication of a reply the turn never published",
    );
  });

  it("stops processing when the lease was lost before processing began, making no provider calls", async () => {
    await pool.query(
      `INSERT INTO response_pattern (id, selection_description, response_guidance, position)
       VALUES ('concise', 'd', 'g', 0)`,
    );
    await store.appendUserMessage({ content: "stale before any write" });
    const first = await store.claimNextTurn({ owner: "owner-a", leaseSeconds: 60 });
    assert.equal(first.kind, "claimed");

    // Expire the lease and reclaim: the stale worker's attempt is superseded
    // and the turn now belongs to owner-b.
    await pool.query(
      `UPDATE conversation_turn
       SET lease_expires_at = now() - interval '1 second' WHERE id = $1`,
      [first.work.turn.id],
    );
    const reclaim = await store.claimNextTurn({ owner: "owner-b", leaseSeconds: 60 });
    assert.equal(reclaim.kind, "claimed");
    assert.equal(reclaim.work.turn.attempt, 2);

    let decisionsCalled = 0;
    let chatCalled = 0;
    await assert.rejects(
      processTurnWork(first.work, {
        decisionModel: "decision-model",
        chatModel: "chat-model",
        callDecisions: async () => {
          decisionsCalled += 1;
          return {
            model: "decision-model-build",
            answers: {
              response_pattern: { type: "choice", choice: "concise" },
            },
            usage: { input_tokens: 1, output_tokens: 1 },
          };
        },
        callChat: async () => {
          chatCalled += 1;
          throw new Error("chat must not be reached");
        },
        loadIdentity: () => store.getChatIdentity(),
        loadPatterns: () => store.getEnabledResponsePatterns(),
        loadContext: (turnId) =>
          store.getThreadContext({ turnId, limit: 50 }),
        ...tracingDeps(first.work.turn.id, "owner-a"),
      }),
      (error) => error instanceof TraceWriteFencedError,
    );
    assert.equal(decisionsCalled, 0);
    assert.equal(chatCalled, 0);

    // Nothing was recorded for the stale attempt, and the turn belongs to
    // the reclaiming worker.
    const staleRows = await pool.query(
      `SELECT count(*)::int AS n
       FROM trace_attempt_decision d
       JOIN trace_attempt a ON a.id = d.attempt_id
       WHERE a.turn_id = $1 AND a.attempt = 1`,
      [first.work.turn.id],
    );
    assert.equal(staleRows.rows[0].n, 0);
    const turn = await pool.query(
      "SELECT status, lease_owner, attempt FROM conversation_turn WHERE id = $1",
      [first.work.turn.id],
    );
    assert.equal(turn.rows[0].status, "in_flight");
    assert.equal(turn.rows[0].lease_owner, "owner-b");
    assert.equal(turn.rows[0].attempt, 2);
  });

  it("stops processing when the lease is lost after the decision provider responded, before the outcome is recorded", async () => {
    await pool.query(
      `INSERT INTO response_pattern (id, selection_description, response_guidance, position)
       VALUES ('concise', 'd', 'g', 0)`,
    );
    await store.appendUserMessage({ content: "stale after decision response" });
    const first = await store.claimNextTurn({ owner: "owner-a", leaseSeconds: 60 });
    assert.equal(first.kind, "claimed");
    const turnId = first.work.turn.id;

    let chatCalled = 0;
    await assert.rejects(
      processTurnWork(first.work, {
        decisionModel: "decision-model",
        chatModel: "chat-model",
        callDecisions: async () => {
          // The lease is lost during the provider call: a reclaiming worker
          // takes the turn before the response can be recorded.
          await pool.query(
            `UPDATE conversation_turn
             SET lease_expires_at = now() - interval '1 second' WHERE id = $1`,
            [turnId],
          );
          const reclaim = await store.claimNextTurn({ owner: "owner-b", leaseSeconds: 60 });
          assert.equal(reclaim.kind, "claimed");
          return {
            model: "decision-model-build",
            answers: {
              response_pattern: { type: "choice", choice: "concise" },
            },
            usage: { input_tokens: 1, output_tokens: 1 },
          };
        },
        callChat: async () => {
          chatCalled += 1;
          throw new Error("chat must not be reached after a fenced outcome write");
        },
        loadIdentity: () => store.getChatIdentity(),
        loadPatterns: () => store.getEnabledResponsePatterns(),
        loadContext: (turnId) =>
          store.getThreadContext({ turnId, limit: 50 }),
        ...tracingDeps(turnId, "owner-a"),
      }),
      (error) => error instanceof TraceWriteFencedError,
    );
    assert.equal(chatCalled, 0);

    // The request boundary survives (written before the call, while the
    // lease was still held), but no outcome or selection was recorded for
    // the stale attempt, and no chat work happened.
    const report = await store.getTurnTraceReport({ turnId });
    assert.equal(report.attempts.length, 2);
    const staleAttempt = report.attempts.find((attempt) => attempt.attempt === 1);
    assert.notEqual(staleAttempt, undefined);
    assert.equal(staleAttempt.outcome, "superseded");
    assert.notEqual(staleAttempt.decision, null);
    assert.equal(staleAttempt.decision.state, "requested");
    assert.equal(staleAttempt.decision.selection, null);
    assert.equal(staleAttempt.chat, null);
    const turn = await pool.query(
      "SELECT status, lease_owner FROM conversation_turn WHERE id = $1",
      [turnId],
    );
    assert.equal(turn.rows[0].status, "in_flight");
    assert.equal(turn.rows[0].lease_owner, "owner-b");
  });

  it("stops processing when the lease is lost after the chat provider responded, before the chat outcome is recorded", async () => {
    await pool.query(
      `INSERT INTO response_pattern (id, selection_description, response_guidance, position)
       VALUES ('concise', 'd', 'g', 0)`,
    );
    await store.appendUserMessage({ content: "stale after chat response" });
    const first = await store.claimNextTurn({ owner: "owner-a", leaseSeconds: 60 });
    assert.equal(first.kind, "claimed");
    const turnId = first.work.turn.id;

    await assert.rejects(
      processTurnWork(first.work, {
        decisionModel: "decision-model",
        chatModel: "chat-model",
        callDecisions: async () => ({
          model: "decision-model-build",
          answers: {
            response_pattern: { type: "choice", choice: "concise" },
          },
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        callChat: async () => {
          // The lease is lost during the chat call: a reclaiming worker
          // takes the turn before the chat outcome can be recorded.
          await pool.query(
            `UPDATE conversation_turn
             SET lease_expires_at = now() - interval '1 second' WHERE id = $1`,
            [turnId],
          );
          const reclaim = await store.claimNextTurn({ owner: "owner-b", leaseSeconds: 60 });
          assert.equal(reclaim.kind, "claimed");
          return {
            model: "chat-model-build",
            choices: [
              { message: { role: "assistant", content: "stale reply" }, finish_reason: "stop" },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          };
        },
        loadIdentity: () => store.getChatIdentity(),
        loadPatterns: () => store.getEnabledResponsePatterns(),
        loadContext: (turnId) =>
          store.getThreadContext({ turnId, limit: 50 }),
        ...tracingDeps(turnId, "owner-a"),
      }),
      (error) => error instanceof TraceWriteFencedError,
    );

    // The chat request boundary survives in `requested` state (written
    // before the call), nothing was published, and the turn belongs to the
    // reclaiming worker.
    const report = await store.getTurnTraceReport({ turnId });
    assert.equal(report.attempts.length, 2);
    const staleAttempt = report.attempts.find((attempt) => attempt.attempt === 1);
    assert.notEqual(staleAttempt, undefined);
    assert.equal(staleAttempt.outcome, "superseded");
    assert.notEqual(staleAttempt.chat, null);
    assert.equal(staleAttempt.chat.state, "requested");
    const replies = await pool.query(
      `SELECT count(*)::int AS n FROM conversation_message
       WHERE turn_id = $1 AND role = 'assistant'`,
      [turnId],
    );
    assert.equal(replies.rows[0].n, 0);
    const turn = await pool.query(
      "SELECT status, lease_owner FROM conversation_turn WHERE id = $1",
      [turnId],
    );
    assert.equal(turn.rows[0].status, "in_flight");
    assert.equal(turn.rows[0].lease_owner, "owner-b");
  });

  it("distinguishes an absent probability distribution from a present empty one", async () => {
    await pool.query(
      `INSERT INTO response_pattern (id, selection_description, response_guidance, position)
       VALUES ('concise', 'd', 'g', 0)`,
    );
    const cases = [
      {
        name: "absent",
        answer: { type: "choice", choice: "concise" },
        expectedPresent: false,
        expectedRows: 0,
      },
      {
        name: "present-empty",
        answer: { type: "choice", choice: "concise", probabilities: {} },
        expectedPresent: true,
        expectedRows: 0,
      },
      {
        name: "present-with-rows",
        answer: {
          type: "choice",
          choice: "concise",
          probabilities: { concise: 0.9, detailed: 0.1 },
        },
        expectedPresent: true,
        expectedRows: 2,
      },
    ];
    for (const testCase of cases) {
      await store.appendUserMessage({ content: `probabilities ${testCase.name}` });
      const claim = await store.claimNextTurn({ owner: "owner-a", leaseSeconds: 60 });
      assert.equal(claim.kind, "claimed");
      const patterns = await store.getEnabledResponsePatterns();
      const request = buildPatternChoiceRequest({
        model: "decision-model",
        patterns,
        state: { conversation: [] },
      });
      await store.recordDecisionRequest({
        turnId: claim.work.turn.id,
        leaseOwner: "owner-a",
        trace: { questionId: DECISION_QUESTION_ID, request },
      });
      await store.recordDecisionOutcome({
        turnId: claim.work.turn.id,
        leaseOwner: "owner-a",
        payload: {
          trace: { questionId: DECISION_QUESTION_ID, request },
          outcome: {
            kind: "responded",
            trace: {
              questionId: DECISION_QUESTION_ID,
              request,
              response: {
                model: "decision-model-build",
                answers: { response_pattern: testCase.answer },
                usage: { input_tokens: 1, output_tokens: 1 },
              },
            },
          },
        },
      });

      const report = await store.getTurnTraceReport({ turnId: claim.work.turn.id });
      const decision = report.attempts[0].decision;
      assert.notEqual(decision, null);
      assert.equal(
        decision.probabilitiesPresent,
        testCase.expectedPresent,
        `${testCase.name}: presence marker`,
      );
      assert.equal(
        decision.probabilities.length,
        testCase.expectedRows,
        `${testCase.name}: child row count`,
      );
      // The empty-present case is the point of the marker: zero child rows
      // with the marker set must not read as absence.
      if (testCase.name === "present-empty") {
        const rows = await pool.query(
          `SELECT count(*)::int AS n
           FROM trace_attempt_decision_probability p
           JOIN trace_attempt_decision d ON d.id = p.decision_id
           WHERE d.attempt_id = $1`,
          [report.attempts[0].id],
        );
        assert.equal(rows.rows[0].n, 0);
        assert.equal(decision.probabilitiesPresent, true);
      }
      // Finalize the turn: an in-flight turn blocks new claims, so the next
      // loop iteration could not claim otherwise.
      const failed = await store.failTurn({
        turnId: claim.work.turn.id,
        leaseOwner: "owner-a",
        error: "test finalize",
      });
      assert.equal(failed, "failed");
    }
  });

  it("reads the turn trace report from one read-only consistent snapshot", async () => {
    // The report's transaction is READ ONLY, enforced by the server: a write
    // inside it fails rather than silently mutating.
    await assert.rejects(
      withTransaction(
        pool,
        async (client) => {
          await client.query(
            `INSERT INTO response_pattern (id, selection_description, response_guidance, position)
             VALUES ('w', 'd', 'g', 0)`,
          );
        },
        { readOnly: true },
      ),
      /read-only/,
    );

    await store.appendUserMessage({ content: "snapshot consistency" });
    const claim = await store.claimNextTurn({ owner: "owner-a", leaseSeconds: 60 });
    assert.equal(claim.kind, "claimed");
    const turnId = claim.work.turn.id;
    const chatOutcome = await store.recordChatOutcome({
      turnId,
      leaseOwner: "owner-a",
      payload: {
        request: buildChatRequest({
          model: "chat-model",
          identity: "Integration fixture identity: generic test text.",
          history: [],
          turnMessages: claim.work.messages,
          guidance: null,
        }),
        messageSources: [
          null,
          ...claim.work.messages.map((message) => message.id),
        ],
        messageChunks: [
          "identity",
          ...claim.work.messages.map(() => "conversation"),
        ],
        identityRevision: 1,
        outcome: {
          kind: "responded",
          response: {
            id: "chat-snap",
            model: "chat-model-build",
            choices: [
              { message: { role: "assistant", content: "snapshot reply" }, finish_reason: "stop" },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          },
          replyContent: "snapshot reply",
          applicationRejection: null,
        },
      },
    });
    assert.equal(chatOutcome, true);
    const published = await store.publishReply({
      turnId,
      leaseOwner: "owner-a",
      content: "snapshot reply",
    });
    assert.equal(published, "published");

    // A concurrent, still-uncommitted mutation of both the turn and the
    // attempt is invisible to the report: the read is one consistent
    // snapshot, so the turn and its attempt never disagree.
    const writer = await pool.connect();
    try {
      await writer.query("BEGIN");
      await writer.query(
        "UPDATE conversation_turn SET status = 'failed', error = 'interleaved' WHERE id = $1",
        [turnId],
      );
      await writer.query(
        "UPDATE trace_attempt SET outcome = 'failed' WHERE turn_id = $1 AND attempt = 1",
        [turnId],
      );
      const before = await store.getTurnTraceReport({ turnId });
      assert.equal(before.turn.status, "completed");
      assert.equal(before.attempts[0].outcome, "published");
      await writer.query("COMMIT");
    } finally {
      await writer.query("ROLLBACK").catch(() => {});
      writer.release();
    }
    const after = await store.getTurnTraceReport({ turnId });
    assert.equal(after.turn.status, "failed");
    assert.equal(after.attempts[0].outcome, "failed");
    assert.equal(after.turn.error, "interleaved");
  });
});
