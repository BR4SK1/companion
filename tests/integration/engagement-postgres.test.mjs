// Database-backed integration tests for the engagement domain
// (apps/worker/src/engagement) and the conversation domain's ingest timing
// (apps/worker/src/conversation/timing.ts): original-timing provenance
// (valid ordered client times adopted as effective; every other status
// falling back to the actual recorded server receive time with its reason
// preserved; a monotonically tracked acceptance/order bound validating
// candidates only), per-message engagement assessments
// written atomically inside the ingest transaction (with the
// no-immediate-engagement rule), idempotent replay stability, grouped-turn
// reads of the actual last user message's assessment (or its absence), the
// effective-state semantics (inactivity measured from the LAST user
// message, floored by that message's own assessment — a single return
// message never resets the state to engaged), hooked concurrent ingest
// serialization, and assistant-message neutrality.
//
// These tests need a real PostgreSQL. They run ONLY against the
// non-production database provided via WORKER_TEST_DATABASE_URL and are
// skipped otherwise — `pnpm test:unit` stays deterministic with no
// database. No network calls are made: no provider is involved at all.
// All band values here are local test fixtures, never deployment policy.

import { describe, it, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import {
  closePostgresPool,
  createPostgresPool,
  runMigrations,
} from "../../libraries/postgres/src/index.ts";
import { conversationMigrations } from "../../apps/worker/src/conversation/migrations.ts";
import { memoryMigrations } from "../../apps/worker/src/memory/migrations.ts";
import { articleMigrations } from "../../apps/worker/src/articles/migrations.ts";
import { engagementMigrations } from "../../apps/worker/src/engagement/migrations.ts";
import { createConversationStore } from "../../apps/worker/src/conversation/store.ts";
import { createEngagementStore } from "../../apps/worker/src/engagement/store.ts";
import { loadEngagementBands } from "../../apps/worker/src/engagement/bands.ts";

const DATABASE_URL = process.env.WORKER_TEST_DATABASE_URL;
const hasDatabase =
  typeof DATABASE_URL === "string" && DATABASE_URL.length > 0;

const MINUTE = 60_000;
// Three cutoffs delimiting four bands: engaged < lull < idle < gone.
const BANDS = {
  lullMs: 3 * MINUTE,
  idleMs: 7 * MINUTE,
  goneMs: 30 * MINUTE,
};

describe("engagement domain and ingest timing (PostgreSQL)", { skip: !hasDatabase }, () => {
  /** @type {import("pg").Pool} */
  let pool;
  let plainStore;
  let wiredStore;
  let engagementStore;
  /** @type {import("apps/worker/src/engagement/types.ts").EngagementStore} */
  let noopEngagement;

  before(async () => {
    pool = createPostgresPool({ connectionString: DATABASE_URL });
    plainStore = createConversationStore(pool);
    engagementStore = createEngagementStore({ pool, bands: BANDS });
    wiredStore = createConversationStore(pool, {
      clientTimeMaxAheadMs: 10_000,
      onUserMessageInserted: (tx, inserted) =>
        engagementStore.onUserMessageInserted(tx, inserted),
    });
    noopEngagement = createEngagementStore({
      pool,
      bands: {
        lullMs: Number.MAX_SAFE_INTEGER,
        idleMs: Number.MAX_SAFE_INTEGER,
        goneMs: Number.MAX_SAFE_INTEGER,
      },
    });
    await runMigrations(pool, [
      ...conversationMigrations,
      ...memoryMigrations,
      ...articleMigrations,
      ...engagementMigrations,
    ]);
  });

  after(async () => {
    if (pool !== undefined) {
      await closePostgresPool(pool);
    }
  });

  beforeEach(async () => {
    // CASCADE: memory- and engagement-domain child tables reference
    // conversation rows; truncating them here keeps the database-backed
    // suites order-independent. The engagement bands row is deployment
    // configuration, so the bands test manages it explicitly.
    await pool.query(
      `TRUNCATE conversation_message, conversation_turn, response_pattern,
        trace_attempt, trace_attempt_context, trace_attempt_pattern,
        trace_attempt_decision, trace_attempt_decision_probability,
        trace_attempt_chat, trace_attempt_chat_message,
        trace_attempt_chat_choice,
        engagement_message_assessment, engagement_bands
        RESTART IDENTITY CASCADE`,
    );
  });

  // --- Ingest timing -----------------------------------------------------

  it("applies the timing and engagement migrations idempotently", async () => {
    const second = await runMigrations(pool, [
      ...conversationMigrations,
      ...memoryMigrations,
      ...articleMigrations,
      ...engagementMigrations,
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
      "0006_engagement_assessment",
    ]);
  });

  it("records absent client time with the server clock as effective", async () => {
    const message = await wiredStore.appendUserMessage({
      content: "no client time",
      clientKey: "t-absent",
    });
    assert.equal(message.clientSentAt, null);
    assert.equal(message.timeSource, "server");
    assert.equal(message.clientTimeStatus, "absent");
    assert.equal(message.effectiveAt, message.createdAt);
    assert.equal(message.serverReceivedAt, message.createdAt);
  });

  it("uses the original client time when valid and ordered", async () => {
    const now = Date.now();
    const sentAt = now - 5 * MINUTE;
    const message = await wiredStore.appendUserMessage({
      content: "with client time",
      clientKey: "t-valid",
      clientSentAt: sentAt,
    });
    assert.equal(message.clientTimeStatus, "valid");
    assert.equal(message.timeSource, "client");
    assert.equal(Date.parse(message.clientSentAt), sentAt);
    assert.equal(Date.parse(message.effectiveAt), sentAt);
    // The server receive time is still recorded alongside.
    assert.ok(Date.parse(message.serverReceivedAt) >= now - 60_000);
  });

  it("accepts ISO-8601 client times and preserves the raw value", async () => {
    const sentAt = new Date(Date.now() - 2 * MINUTE).toISOString();
    const message = await wiredStore.appendUserMessage({
      content: "iso client time",
      clientKey: "t-iso",
      clientSentAt: sentAt,
    });
    assert.equal(message.clientTimeStatus, "valid");
    assert.equal(message.clientSentAt, sentAt);
    assert.equal(message.effectiveAt, sentAt);
  });

  it("falls back to the server clock on future skew while preserving the raw claim", async () => {
    const skewed = Date.now() + 10 * MINUTE;
    const message = await wiredStore.appendUserMessage({
      content: "future skewed",
      clientKey: "t-skew",
      clientSentAt: skewed,
    });
    assert.equal(message.clientTimeStatus, "future_skew");
    assert.equal(message.timeSource, "server");
    assert.equal(Date.parse(message.clientSentAt), skewed);
    assert.equal(Date.parse(message.effectiveAt), Date.parse(message.createdAt));
  });

  it("falls back to the actual server receipt when the client time is below the order bound", async () => {
    const first = await wiredStore.appendUserMessage({
      content: "first",
      clientKey: "t-oo-1",
      clientSentAt: Date.now() - 4 * MINUTE,
    });
    assert.equal(first.clientTimeStatus, "valid");
    const second = await wiredStore.appendUserMessage({
      content: "second",
      clientKey: "t-oo-2",
      clientSentAt: Date.parse(first.effectiveAt) - MINUTE,
    });
    assert.equal(second.clientTimeStatus, "out_of_order");
    assert.equal(second.timeSource, "server");
    assert.equal(
      Date.parse(second.effectiveAt),
      Date.parse(second.createdAt),
    );
    assert.equal(Date.parse(second.clientSentAt), Date.parse(first.effectiveAt) - MINUTE);
  });

  it("keeps fallbacks honest: actual receipt, preserved reasons, monotone candidate bound", async () => {
    // Message 1: client time accepted 9 seconds ahead of the server clock
    // (inside the 10 s tolerance) — the effective time is the original
    // client time, and the acceptance/order bound ratchets to it.
    const before = Date.now();
    const first = await wiredStore.appendUserMessage({
      content: "ahead",
      clientKey: "t-clamp-1",
      clientSentAt: before + 9_000,
    });
    assert.equal(first.clientTimeStatus, "valid");
    assert.equal(Date.parse(first.effectiveAt), before + 9_000);

    // Message 2 arrives one second later with no client time: the fallback
    // is the ACTUAL recorded server receive time — identical to
    // server_received_at and created_at — never clamped to the bound, with
    // the `absent` reason preserved.
    const second = await wiredStore.appendUserMessage({
      content: "fallback",
      clientKey: "t-clamp-2",
    });
    assert.equal(second.clientTimeStatus, "absent");
    assert.equal(second.timeSource, "server");
    assert.equal(Date.parse(second.effectiveAt), Date.parse(second.serverReceivedAt));
    assert.equal(Date.parse(second.effectiveAt), Date.parse(second.createdAt));
    assert.ok(Date.parse(second.effectiveAt) < before + 9_000,
      "the honest fallback may sit below an accepted future client time");

    // Message 3 claims client T+5 (below the still-monotone bound T+9):
    // the candidate is rejected as out of order, the raw claim is
    // preserved, and the fallback remains the message's own actual receipt.
    const third = await wiredStore.appendUserMessage({
      content: "late claim",
      clientKey: "t-clamp-3",
      clientSentAt: before + 5_000,
    });
    assert.equal(third.clientTimeStatus, "out_of_order");
    assert.equal(Date.parse(third.clientSentAt), before + 5_000);
    assert.equal(Date.parse(third.effectiveAt), Date.parse(third.serverReceivedAt));
    assert.equal(Date.parse(third.effectiveAt), Date.parse(third.createdAt));

    // Message 4 supplies an unparseable claim: `invalid` stays
    // distinguishable from `absent` on the same honest fallback shape.
    const fourth = await wiredStore.appendUserMessage({
      content: "garbage",
      clientKey: "t-clamp-4",
      clientSentAt: "not a time",
    });
    assert.equal(fourth.clientTimeStatus, "invalid");
    assert.equal(fourth.clientSentAt, null);
    assert.equal(Date.parse(fourth.effectiveAt), Date.parse(fourth.serverReceivedAt));

    // No synthetic effective values exist anywhere: every fallback row's
    // effective time equals its own recorded receipt.
    const rows = await pool.query(
      `SELECT effective_at, server_received_at, client_time_status
       FROM conversation_message WHERE role = 'user' ORDER BY seq`,
    );
    for (const row of rows.rows) {
      if (row.client_time_status !== "valid") {
        assert.equal(
          row.effective_at.getTime(),
          row.server_received_at.getTime(),
          `status ${row.client_time_status} must fall back to the actual receipt`,
        );
      }
    }
  });

  it("records unparseable client values as invalid with no stored timestamp", async () => {
    const message = await wiredStore.appendUserMessage({
      content: "garbage time",
      clientKey: "t-invalid",
      clientSentAt: "not a time",
    });
    assert.equal(message.clientTimeStatus, "invalid");
    assert.equal(message.timeSource, "server");
    assert.equal(message.clientSentAt, null);
  });

  it("keeps timing recorded when engagement is not wired (unprovisioned no-op)", async () => {
    const message = await plainStore.appendUserMessage({
      content: "unprovisioned",
      clientKey: "t-plain",
      clientSentAt: Date.now() - MINUTE,
    });
    assert.equal(message.clientTimeStatus, "valid");
    const assessments = await pool.query(
      "SELECT count(*)::int AS n FROM engagement_message_assessment",
    );
    assert.equal(assessments.rows[0].n, 0);
  });

  it("preserves recorded timing across an idempotent replay", async () => {
    const sentAt = Date.now() - 3 * MINUTE;
    const first = await wiredStore.appendUserMessage({
      content: "same",
      clientKey: "t-replay",
      clientSentAt: sentAt,
    });
    // A later retry that would now classify differently returns the
    // originally recorded values untouched.
    const replay = await wiredStore.appendUserMessage({
      content: "same",
      clientKey: "t-replay",
      clientSentAt: sentAt,
    });
    assert.equal(replay.id, first.id);
    assert.equal(replay.clientSentAt, first.clientSentAt);
    assert.equal(replay.effectiveAt, first.effectiveAt);
    assert.equal(replay.clientTimeStatus, first.clientTimeStatus);
    assert.equal(replay.timeSource, first.timeSource);
    assert.equal(replay.serverReceivedAt, first.serverReceivedAt);
  });

  // --- Engagement assessments --------------------------------------------

  it("assesses each new user message atomically with the lull-retention rule", async () => {
    // A controlled timeline expressed through client send times, all in the
    // past relative to the server clock so classification stays `valid`.
    const base = Date.now() - 40 * MINUTE;
    const m1 = await wiredStore.appendUserMessage({
      content: "m1",
      clientKey: "e-1",
      clientSentAt: base,
    });
    const m2 = await wiredStore.appendUserMessage({
      content: "m2",
      clientKey: "e-2",
      clientSentAt: base + 5 * MINUTE,
    });
    const m3 = await wiredStore.appendUserMessage({
      content: "m3",
      clientKey: "e-3",
      clientSentAt: base + 5 * MINUTE + 30_000,
    });
    const m4 = await wiredStore.appendUserMessage({
      content: "m4",
      clientKey: "e-4",
      clientSentAt: base + 15 * MINUTE + 30_000,
    });

    const a1 = await engagementStore.getAssessmentForMessage(m1.id);
    assert.equal(a1.state, "engaged");
    assert.equal(a1.previousState, null);
    assert.equal(a1.silenceMs, null);
    assert.equal(a1.retainedLull, false);
    assert.deepEqual(a1.bands, BANDS);

    // First message after a lull: retains the lull assessment — crucially
    // NOT engaged.
    const a2 = await engagementStore.getAssessmentForMessage(m2.id);
    assert.equal(a2.state, "lull");
    assert.equal(a2.previousState, "engaged");
    assert.equal(a2.silenceMs, 5 * MINUTE);
    assert.equal(a2.retainedLull, true);

    // The subsequent immediate message becomes engaged.
    const a3 = await engagementStore.getAssessmentForMessage(m3.id);
    assert.equal(a3.state, "engaged");
    assert.equal(a3.previousState, "lull");
    assert.equal(a3.silenceMs, 30_000);
    assert.equal(a3.retainedLull, false);

    // A message after a longer silence records the deeper band.
    const a4 = await engagementStore.getAssessmentForMessage(m4.id);
    assert.equal(a4.state, "idle");
    assert.equal(a4.previousState, "engaged");
    assert.equal(a4.silenceMs, 10 * MINUTE);
    assert.equal(a4.retainedLull, false);

    // Exactly one assessment row per user message.
    const counts = await pool.query(
      "SELECT count(*)::int AS n FROM engagement_message_assessment",
    );
    assert.equal(counts.rows[0].n, 4);
  });

  it("never creates assessments for assistant messages", async () => {
    const user = await wiredStore.appendUserMessage({
      content: "u",
      clientKey: "a-1",
      clientSentAt: Date.now() - MINUTE,
    });
    await pool.query(
      `INSERT INTO conversation_message
         (role, content, turn_id, effective_at, time_source,
          client_time_status, server_received_at)
       VALUES ('assistant', 'reply', NULL, now(), 'server', 'absent', now())`,
    );
    const rows = await pool.query(
      "SELECT message_id FROM engagement_message_assessment",
    );
    assert.equal(rows.rows.length, 1);
    assert.equal(rows.rows[0].message_id, user.id);
  });

  it("keeps an idempotent replay from resetting user activity", async () => {
    const base = Date.now() - 40 * MINUTE;
    const m1 = await wiredStore.appendUserMessage({
      content: "m1",
      clientKey: "r-1",
      clientSentAt: base,
    });
    const m2 = await wiredStore.appendUserMessage({
      content: "m2",
      clientKey: "r-2",
      clientSentAt: base + 5 * MINUTE,
    });
    // Long after m2, a replay of m2's exact ingest arrives (a retried
    // request). It must not re-assess, re-anchor, or reset anything.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const replay = await wiredStore.appendUserMessage({
      content: "m2",
      clientKey: "r-2",
      clientSentAt: base + 5 * MINUTE,
    });
    assert.equal(replay.id, m2.id);
    const counts = await pool.query(
      "SELECT count(*)::int AS n FROM engagement_message_assessment",
    );
    assert.equal(counts.rows[0].n, 2);
    const summary = await engagementStore.getSummary(new Date());
    // The last-activity anchor is still m2; the replay did not move it.
    assert.equal(summary.lastUserMessageId, m2.id);
  });

  it("rolls the ingest back atomically when the assessment hook fails", async () => {
    const failing = createConversationStore(pool, {
      onUserMessageInserted: async () => {
        throw new Error("engagement write failed");
      },
    });
    await assert.rejects(
      failing.appendUserMessage({ content: "doomed", clientKey: "f-1" }),
      /engagement write failed/,
    );
    const rows = await pool.query(
      "SELECT count(*)::int AS n FROM conversation_message WHERE client_key = 'f-1'",
    );
    assert.equal(rows.rows[0].n, 0);
  });

  it("serializes concurrent hooked ingests so each assessment sees its predecessor", async () => {
    // Two ingests race for the ingest advisory lock. Both carry the SAME
    // client send time, so either lock order yields a deterministic result:
    // the first (in lock order) classifies valid, and the second sees the
    // first's effective time as its acceptance/order bound with equality
    // allowed (also valid, zero silence). Without serialization both could
    // observe "no previous message" — which these assertions would catch.
    const sentAt = Date.now() - 10 * MINUTE;
    const results = await Promise.allSettled([
      wiredStore.appendUserMessage({
        content: "c1",
        clientKey: "cc-1",
        clientSentAt: sentAt,
      }),
      wiredStore.appendUserMessage({
        content: "c2",
        clientKey: "cc-2",
        clientSentAt: sentAt,
      }),
    ]);
    const fulfilled = results.map((entry) => {
      assert.equal(entry.status, "fulfilled", `concurrent ingest failed: ${String(entry.reason)}`);
      return entry.value;
    });
    assert.equal(fulfilled.length, 2);
    const [first, second] = fulfilled[0].seq <= fulfilled[1].seq
      ? fulfilled
      : [fulfilled[1], fulfilled[0]];
    assert.ok(second.seq > first.seq, "ingest commits must follow seq order");

    const firstAssessment = await engagementStore.getAssessmentForMessage(first.id);
    assert.equal(firstAssessment.state, "engaged");
    assert.equal(firstAssessment.previousState, null);
    assert.equal(firstAssessment.silenceMs, null);

    const secondAssessment = await engagementStore.getAssessmentForMessage(second.id);
    assert.equal(secondAssessment.state, "engaged");
    assert.equal(
      secondAssessment.previousState,
      firstAssessment.state,
      "the serialized successor must observe the predecessor's assessment",
    );
    assert.equal(secondAssessment.silenceMs, 0);
    assert.equal(Date.parse(second.effectiveAt), Date.parse(first.effectiveAt));

    const counts = await pool.query(
      "SELECT count(*)::int AS n FROM engagement_message_assessment",
    );
    assert.equal(counts.rows[0].n, 2);
  });

  // --- Grouped-turn reads --------------------------------------------------

  it("lets a grouped turn read the assessment of its last user message", async () => {
    const base = Date.now() - 40 * MINUTE;
    const m1 = await wiredStore.appendUserMessage({
      content: "g1",
      clientKey: "g-1",
      clientSentAt: base,
    });
    const m2 = await wiredStore.appendUserMessage({
      content: "g2",
      clientKey: "g-2",
      clientSentAt: base + 5 * MINUTE,
    });
    const m3 = await wiredStore.appendUserMessage({
      content: "g3",
      clientKey: "g-3",
      clientSentAt: base + 5 * MINUTE + 30_000,
    });
    const turn = await pool.query(
      `INSERT INTO conversation_turn (id, status, completed_at)
       VALUES (gen_random_uuid(), 'completed', now()) RETURNING id`,
    );
    const turnId = turn.rows[0].id;
    await pool.query(
      "UPDATE conversation_message SET turn_id = $2 WHERE id = ANY($1::uuid[])",
      [[m1.id, m2.id, m3.id], turnId],
    );
    const assessment = await engagementStore.getAssessmentForTurn(turnId);
    // The LAST user message of the group, not the first.
    assert.equal(assessment.messageId, m3.id);
    assert.equal(assessment.state, "engaged");
    assert.equal(assessment.previousState, "lull");
    // Stable across re-reads (a recorded row, not a recomputation).
    const again = await engagementStore.getAssessmentForTurn(turnId);
    assert.deepEqual(again, assessment);
  });

  it("reports the actual last grouped message's absence, not an earlier assessment", async () => {
    // A mixed turn: the first user message has an assessment, the LAST one
    // does not (possible when engagement was provisioned between ingestion
    // and claim). The turn reads the LAST message — its assessment absence,
    // never an earlier message's assessment.
    const base = Date.now() - 40 * MINUTE;
    const m1 = await wiredStore.appendUserMessage({
      content: "x1",
      clientKey: "x-1",
      clientSentAt: base,
    });
    const m2 = await plainStore.appendUserMessage({
      content: "x2",
      clientKey: "x-2",
      clientSentAt: base + MINUTE,
    });
    const turn = await pool.query(
      `INSERT INTO conversation_turn (id, status, completed_at)
       VALUES (gen_random_uuid(), 'completed', now()) RETURNING id`,
    );
    const turnId = turn.rows[0].id;
    await pool.query(
      "UPDATE conversation_message SET turn_id = $2 WHERE id = ANY($1::uuid[])",
      [[m1.id, m2.id], turnId],
    );
    assert.ok(await engagementStore.getAssessmentForMessage(m1.id));
    assert.equal(await engagementStore.getAssessmentForMessage(m2.id), null);
    assert.equal(
      await engagementStore.getAssessmentForTurn(turnId),
      null,
      "the LAST grouped message's absence must be reported, not m1's assessment",
    );
  });

  it("returns null for turns whose user messages predate engagement", async () => {
    const message = await plainStore.appendUserMessage({
      content: "pre-engagement",
      clientKey: "pre-1",
    });
    const turn = await pool.query(
      `INSERT INTO conversation_turn (id, status, completed_at)
       VALUES (gen_random_uuid(), 'completed', now()) RETURNING id`,
    );
    await pool.query(
      "UPDATE conversation_message SET turn_id = $2 WHERE id = $1",
      [message.id, turn.rows[0].id],
    );
    assert.equal(await engagementStore.getAssessmentForTurn(turn.rows[0].id), null);
    assert.equal(
      await engagementStore.getAssessmentForTurn("00000000-0000-0000-0000-000000000000"),
      null,
    );
  });

  // --- Effective engagement (last-activity clock with assessment floor) ----

  it("keeps the first return message at lull and does not advance to idle at minute 7", async () => {
    // The review timeline: m1 at minute 0, first return at minute 5
    // (assessed lull). At minute 7 — 2 minutes since the LAST activity —
    // the state remains lull rather than idle; inactivity transitions
    // measure from the last user message with the assessment as floor.
    const base = Date.now() - 60 * MINUTE;
    await wiredStore.appendUserMessage({
      content: "m1",
      clientKey: "tl-1",
      clientSentAt: base,
    });
    const m2 = await wiredStore.appendUserMessage({
      content: "m2",
      clientKey: "tl-2",
      clientSentAt: base + 5 * MINUTE,
    });
    const atM2 = await engagementStore.getSummary(new Date(base + 5 * MINUTE));
    assert.equal(atM2.state, "lull", "the first return message remains lull immediately");
    assert.equal(atM2.lastUserMessageId, m2.id, "the last-activity anchor moved to m2");
    assert.equal(atM2.silenceMs, 0);

    const atMinute7 = await engagementStore.getSummary(new Date(base + 7 * MINUTE));
    assert.equal(atMinute7.state, "lull", "2 minutes since last activity: still lull, not idle");
    assert.equal(atMinute7.lastUserMessageId, m2.id);
    assert.equal(atMinute7.silenceMs, 2 * MINUTE);

    // Silence continues from m2: idle at minute 12 (7 since m2), gone at 35.
    assert.equal(
      (await engagementStore.getSummary(new Date(base + 12 * MINUTE))).state,
      "idle",
    );
    assert.equal(
      (await engagementStore.getSummary(new Date(base + 35 * MINUTE))).state,
      "gone",
    );
  });

  it("lifts the state to engaged on the second immediate message after a lull", async () => {
    // m1 at minute 0 (engaged), m2 at minute 5 (lull assessment — the state
    // stays lull), m3 thirty seconds later: its assessment lands inside the
    // engaged band and lifts the effective state.
    const base = Date.now() - 60 * MINUTE;
    await wiredStore.appendUserMessage({
      content: "m1",
      clientKey: "tl-3a",
      clientSentAt: base,
    });
    await wiredStore.appendUserMessage({
      content: "m2",
      clientKey: "tl-3b",
      clientSentAt: base + 5 * MINUTE,
    });
    const m3 = await wiredStore.appendUserMessage({
      content: "m3",
      clientKey: "tl-3c",
      clientSentAt: base + 5 * MINUTE + 30_000,
    });
    const atM3 = await engagementStore.getSummary(
      new Date(base + 5 * MINUTE + 30_000),
    );
    assert.equal(atM3.state, "engaged");
    assert.equal(atM3.lastUserMessageId, m3.id);
    assert.equal(atM3.silenceMs, 0);
    // And the state then deepens from m3's effective time.
    assert.equal(
      (await engagementStore.getSummary(new Date(base + 5 * MINUTE + 3 * MINUTE + 30_000))).state,
      "lull",
    );
  });

  it("does not overwrite the effective engagement to engaged on a single return message", async () => {
    // A message arriving after two days assesses gone; the effective state
    // stays gone right after it lands (activity band engaged, assessment
    // floor gone) and only a subsequent immediate message lifts it.
    const returnAt = Date.now() - MINUTE;
    const m1 = await wiredStore.appendUserMessage({
      content: "m1",
      clientKey: "s-1",
      clientSentAt: returnAt - 2 * 24 * 60 * MINUTE,
    });
    assert.equal(m1.clientTimeStatus, "valid");
    const m2 = await wiredStore.appendUserMessage({
      content: "m2",
      clientKey: "s-2",
      clientSentAt: returnAt,
    });
    const a2 = await engagementStore.getAssessmentForMessage(m2.id);
    assert.equal(a2.state, "gone");
    const atM2 = await engagementStore.getSummary(new Date(returnAt));
    assert.equal(atM2.state, "gone", "a single deep return does not reset the state to engaged");
    assert.equal(atM2.lastUserMessageId, m2.id);
    assert.equal(atM2.silenceMs, 0);

    // The immediate follow-up proves sustained exchange.
    const m3 = await wiredStore.appendUserMessage({
      content: "m3",
      clientKey: "s-3",
      clientSentAt: returnAt + 30_000,
    });
    const atM3 = await engagementStore.getSummary(
      new Date(returnAt + 30_000),
    );
    assert.equal(atM3.state, "engaged");
    assert.equal(atM3.lastUserMessageId, m3.id);
  });

  it("advances the effective engagement during silence from the last user message", async () => {
    const base = Date.now() - 60 * MINUTE;
    const m1 = await wiredStore.appendUserMessage({
      content: "m1",
      clientKey: "adv-1",
      clientSentAt: base,
    });
    const cases = [
      [2 * MINUTE, "engaged"],
      [3 * MINUTE, "lull"],
      [7 * MINUTE, "idle"],
      [30 * MINUTE, "gone"],
    ];
    for (const [elapsed, expected] of cases) {
      const summary = await engagementStore.getSummary(
        new Date(base + elapsed),
      );
      assert.equal(summary.state, expected, `elapsed=${String(elapsed)}`);
      assert.equal(summary.lastUserMessageId, m1.id);
      assert.equal(summary.silenceMs, elapsed);
    }
  });

  it("holds the assessment floor while silence grows, then deepens from the last message", async () => {
    const base = Date.now() - 60 * MINUTE;
    await wiredStore.appendUserMessage({
      content: "m1",
      clientKey: "fl-1",
      clientSentAt: base,
    });
    await wiredStore.appendUserMessage({
      content: "m2",
      clientKey: "fl-2",
      clientSentAt: base + 5 * MINUTE,
    });
    const m3 = await wiredStore.appendUserMessage({
      content: "m3",
      clientKey: "fl-3",
      clientSentAt: base + 5 * MINUTE + 30_000,
    });
    const m4 = await wiredStore.appendUserMessage({
      content: "m4",
      clientKey: "fl-4",
      clientSentAt: base + 15 * MINUTE + 30_000,
    });
    // m4 assessed idle; the floor holds the state at idle while the
    // activity band from m4 is shallower, then deepens to gone from m4's
    // effective time.
    const atM4 = await engagementStore.getSummary(
      new Date(base + 15 * MINUTE + 30_000),
    );
    assert.equal(atM4.state, "idle");
    assert.equal(atM4.lastUserMessageId, m4.id, "the anchor is the LAST message, not the newest engaged assessment");
    assert.equal(atM4.silenceMs, 0);
    assert.equal(
      (await engagementStore.getSummary(new Date(base + 15 * MINUTE + 4 * MINUTE + 30_000))).state,
      "idle",
      "4 minutes after m4: the idle floor holds",
    );
    assert.equal(
      (await engagementStore.getSummary(new Date(base + 15 * MINUTE + 31 * MINUTE + 30_000))).state,
      "gone",
      "31 minutes after m4: gone, measured from the last activity",
    );
  });

  it("recovers the state after a simulated restart by recomputing from durable data", async () => {
    const base = Date.now() - 60 * MINUTE;
    await wiredStore.appendUserMessage({
      content: "m1",
      clientKey: "re-1",
      clientSentAt: base,
    });
    // A fresh engagement-store instance (what a restarted process builds)
    // derives the same state from the durable last-activity anchor and
    // assessments — no in-memory state to lose, no replay to run.
    const restarted = createEngagementStore({ pool, bands: BANDS });
    const summary = await restarted.getSummary(new Date(base + 4 * MINUTE));
    assert.equal(summary.state, "lull");
    assert.equal(
      await restarted.getAssessmentForTurn(randomUUID()),
      null,
    );
  });

  it("anchors the state at the newest user message when exchange is sustained", async () => {
    const base = Date.now() - 60 * MINUTE;
    await wiredStore.appendUserMessage({
      content: "m1",
      clientKey: "fb-1",
      clientSentAt: base,
    });
    const m2 = await wiredStore.appendUserMessage({
      content: "m2",
      clientKey: "fb-2",
      clientSentAt: base + MINUTE,
    });
    // Both messages assessed engaged, so the state is engaged from the
    // newest message.
    const summary = await engagementStore.getSummary(new Date(base + MINUTE));
    assert.equal(summary.lastUserMessageId, m2.id);
    assert.equal(summary.state, "engaged");
  });

  it("falls back to the pure activity clock when no assessment exists", async () => {
    // Pre-engagement history only: no assessments at all, so the state is
    // the activity band measured from the LAST user message.
    await plainStore.appendUserMessage({
      content: "old-1",
      clientKey: "fb-old-1",
    });
    const last = await plainStore.appendUserMessage({
      content: "old-2",
      clientKey: "fb-old-2",
    });
    const summary = await engagementStore.getSummary(new Date());
    assert.equal(summary.lastUserMessageId, last.id);
    assert.equal(summary.lastUserEffectiveAt, last.effectiveAt);
    // The messages landed moments ago: the effective engagement is engaged.
    assert.equal(summary.state, "engaged");
  });

  it("returns null state when no user message has ever been ingested", async () => {
    const summary = await engagementStore.getSummary(new Date());
    assert.equal(summary.state, null);
    assert.equal(summary.lastUserMessageId, null);
    assert.equal(summary.lastUserEffectiveAt, null);
    assert.equal(summary.silenceMs, null);
  });

  it("bands-agnostic store reads use the cutoffs they were built with", async () => {
    const base = Date.now() - 60 * MINUTE;
    await wiredStore.appendUserMessage({
      content: "m1",
      clientKey: "ba-1",
      clientSentAt: base,
    });
    // A store configured with a hugely permissive cutoff set still reads the
    // recorded assessments, and classifies by its own cutoffs.
    const summary = await noopEngagement.getSummary(new Date(base + 5 * MINUTE));
    assert.equal(summary.state, "engaged");
    assert.equal(summary.bands.goneMs, Number.MAX_SAFE_INTEGER);
    assert.deepEqual(summary.bands, {
      lullMs: Number.MAX_SAFE_INTEGER,
      idleMs: Number.MAX_SAFE_INTEGER,
      goneMs: Number.MAX_SAFE_INTEGER,
    });
  });

  it("loads provisioned cutoffs and reports the unprovisioned no-op", async () => {
    const bands = await loadEngagementBands(pool);
    assert.equal(bands, null);
    await pool.query(
      `INSERT INTO engagement_bands (lull_ms, idle_ms, gone_ms)
       VALUES ($1, $2, $3)`,
      [BANDS.lullMs, BANDS.idleMs, BANDS.goneMs],
    );
    const provisioned = await loadEngagementBands(pool);
    assert.deepEqual(provisioned, BANDS);
  });
});