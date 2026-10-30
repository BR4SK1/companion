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
import { setTimeout as sleep } from "node:timers/promises";

import { closePostgresPool, createPostgresPool, runMigrations } from "../../libraries/postgres/src/index.ts";
import { conversationMigrations } from "../../apps/worker/src/conversation/migrations.ts";
import {
  CLAIM_ADVISORY_LOCK_KEY,
  createConversationStore,
} from "../../apps/worker/src/conversation/store.ts";
import { processTurnWork } from "../../apps/worker/src/work/processor.ts";
import { runEngineOnce } from "../../apps/worker/src/work/engine.ts";

const DATABASE_URL = process.env.WORKER_TEST_DATABASE_URL;
const hasDatabase =
  typeof DATABASE_URL === "string" && DATABASE_URL.length > 0;

describe("worker durable conversation work (PostgreSQL)", { skip: !hasDatabase }, () => {
  /** @type {import("pg").Pool} */
  let pool;
  let store;

  before(async () => {
    pool = createPostgresPool({ connectionString: DATABASE_URL });
    store = createConversationStore(pool);
    // Fresh application against the provided non-production database; every
    // test below assumes the domain schema exists.
    await runMigrations(pool, conversationMigrations);
  });

  after(async () => {
    if (pool !== undefined) {
      await closePostgresPool(pool);
    }
  });

  beforeEach(async () => {
    await pool.query(
      "TRUNCATE conversation_message, conversation_turn, response_pattern RESTART IDENTITY",
    );
  });

  it("re-applies migrations idempotently with the domain tables present", async () => {
    const second = await runMigrations(pool, conversationMigrations);
    assert.deepEqual(second.applied, []);
    assert.deepEqual(second.alreadyApplied, ["0001_conversation_work"]);
    const tables = await pool.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name IN ('conversation_message', 'conversation_turn', 'response_pattern')
       ORDER BY table_name`,
    );
    assert.deepEqual(
      tables.rows.map((row) => row.table_name),
      ["conversation_message", "conversation_turn", "response_pattern"],
    );
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
        "INSERT INTO conversation_message (role, content, client_key) VALUES ('user', 'slow', 'key-slow')",
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
    const staleDecision = await store.recordTurnDecision({
      turnId: first.work.turn.id,
      leaseOwner: "stale-owner",
      selectedPatternId: "concise",
      decision: { choice: "concise" },
    });
    assert.equal(staleDecision, false);
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
      processTurn: (work) =>
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
          loadPatterns: () => store.getEnabledResponsePatterns(),
          loadContext: (turnId) =>
            store.getThreadContext({ turnId, limit: 50 }),
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

    // The chat request carries the guidance as a system message plus both grouped messages.
    const roles = chatCalls[0].messages.map((message) => message.role);
    assert.deepEqual(roles, ["system", "user", "user"]);
    assert.equal(chatCalls[0].messages[0].content, "Explain step by step.");

    const turn = await pool.query(
      "SELECT status, selected_pattern_id, decision, error FROM conversation_turn",
    );
    assert.equal(turn.rows[0].status, "completed");
    assert.equal(turn.rows[0].selected_pattern_id, "detailed");
    assert.equal(turn.rows[0].error, null);
    assert.equal(turn.rows[0].decision.choice, "detailed");
    assert.deepEqual(turn.rows[0].decision.probabilities, {
      concise: 0.25,
      detailed: 0.75,
    });

    const replies = await pool.query(
      "SELECT content FROM conversation_message WHERE role = 'assistant'",
    );
    assert.deepEqual(
      replies.rows.map((row) => row.content),
      ["here is the answer"],
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
      ["system:Answer in one short paragraph.", "user:first question"],
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
      ["user"],
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
});
