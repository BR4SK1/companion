// PostgreSQL coverage for generic routine reconciliation and availability-aware
// grouped conversation work. Uses only synthetic schedule/configuration data.
// Skipped unless an explicitly isolated WORKER_TEST_DATABASE_URL is supplied.

import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import { closePostgresPool, createPostgresPool, runMigrations, withTransaction } from "../../libraries/postgres/src/index.ts";
import { conversationMigrations } from "../../apps/worker/src/conversation/migrations.ts";
import { memoryMigrations } from "../../apps/worker/src/memory/migrations.ts";
import { engagementMigrations } from "../../apps/worker/src/engagement/migrations.ts";
import { articleMigrations } from "../../apps/worker/src/articles/migrations.ts";
import { relationshipMigrations } from "../../apps/worker/src/relationship/migrations.ts";
import { routineMigrations } from "../../apps/worker/src/routine/migrations.ts";
import { temporalMigrations } from "../../apps/worker/src/temporal/migrations.ts";
import { createConversationStore } from "../../apps/worker/src/conversation/store.ts";
import { createRoutineStore, loadRoutineConfiguration } from "../../apps/worker/src/routine/store.ts";

const DATABASE_URL = process.env.WORKER_TEST_DATABASE_URL;
const hasDatabase = typeof DATABASE_URL === "string" && DATABASE_URL.length > 0;
const MIGRATIONS = [
  ...conversationMigrations,
  ...memoryMigrations,
  ...engagementMigrations,
  ...articleMigrations,
  ...relationshipMigrations,
  ...routineMigrations,
  ...temporalMigrations,
];

function poolWithClock(pool, getNow, onQuery = () => {}) {
  return {
    query: (sql, values) => pool.query(sql, values),
    connect: async () => {
      const client = await pool.connect();
      return {
        query: async (sql, values) => {
          onQuery(String(sql));
          return /^\s*SELECT clock_timestamp\(\) AS now\s*$/i.test(String(sql))
            ? { rows: [{ now: new Date(getNow()) }] }
            : client.query(sql, values);
        },
        release: () => client.release(),
      };
    },
  };
}

function prepareRoutineAnnouncement(routine) {
  return async (client) => {
    const draft = await routine.prepareAnnouncement(client);
    if (draft === null) return null;
    return {
      content: draft.content,
      validUntil: draft.validUntil,
      cancel: (transaction, cancelledAt) =>
        routine.cancelAnnouncement(transaction, draft, cancelledAt),
      recordPublication: (transaction, messageId, publishedAt) =>
        routine.recordAnnouncementPublication(
          transaction,
          draft,
          messageId,
          publishedAt,
        ),
    };
  };
}

async function provisionRoutine(pool, available) {
  await pool.query(
    `UPDATE companion_time_settings SET timezone = 'UTC' WHERE id = true`,
  );
  await pool.query(
    `INSERT INTO routine_settings (id, timezone, departure_context)
     VALUES (true, 'UTC', 'Synthetic configured departure details')
     ON CONFLICT (id) DO UPDATE SET timezone = EXCLUDED.timezone,
       departure_context = EXCLUDED.departure_context`,
  );
  await pool.query(`DELETE FROM routine_transition`);
  for (let weekday = 1; weekday <= 7; weekday += 1) {
    await pool.query(
      `INSERT INTO routine_transition
         (transition_key, weekday, local_minute, location, activity, available, interaction_context)
       VALUES ($1, $2, 0, 'synthetic location', 'synthetic activity', $3,
               'synthetic optional interaction context')`,
      [`state-${String(weekday)}`, weekday, available],
    );
  }
  const configuration = await loadRoutineConfiguration(pool);
  assert.ok(configuration);
  return createRoutineStore({ pool });
}

describe("routine schedule (PostgreSQL)", { skip: !hasDatabase }, () => {
  let pool;
  let migratedLegacyEvent;

  before(async () => {
    pool = createPostgresPool({ connectionString: DATABASE_URL });
    await runMigrations(
      pool,
      MIGRATIONS.filter((migration) => migration.id !== "0015_routine_announcement_period_id"),
    );
    await pool.query(`TRUNCATE routine_announcement`);
    await pool.query(
      `INSERT INTO routine_announcement
         (transition_id, transition_key, local_date, scheduled_at, timezone, status)
       VALUES (gen_random_uuid(), 'legacy-transition', '2026-11-09',
               '2026-11-09T09:00:00Z', 'UTC', 'pending')`,
    );
    const periodMigration = routineMigrations.at(-1);
    assert.ok(periodMigration);
    await runMigrations(pool, [periodMigration]);
    migratedLegacyEvent = (await pool.query(
      `SELECT id, transition_key, local_date::text AS local_date, status
       FROM routine_announcement`,
    )).rows[0];
    await runMigrations(pool, MIGRATIONS);
  });

  after(async () => {
    if (pool !== undefined) await closePostgresPool(pool);
  });

  beforeEach(async () => {
    await pool.query(
      `TRUNCATE routine_announcement, routine_applied_transition, routine_applied_state,
        routine_transition, routine_settings, conversation_message, conversation_turn, response_pattern,
        trace_attempt, trace_attempt_context, trace_attempt_pattern, trace_attempt_decision,
        trace_attempt_decision_probability, trace_attempt_chat, trace_attempt_chat_message,
        trace_attempt_chat_choice RESTART IDENTITY CASCADE`,
    );
  });

  it("upgrades an existing transition/date outbox row to a fresh period identity", () => {
    assert.match(migratedLegacyEvent.id, /^[0-9a-f-]{36}$/i);
    assert.equal(migratedLegacyEvent.transition_key, "legacy-transition");
    assert.equal(migratedLegacyEvent.local_date, "2026-11-09");
    assert.equal(migratedLegacyEvent.status, "pending");
  });

  it("applies schema idempotently, leaves content unseeded, and loads missing config as a no-op", async () => {
    assert.deepEqual((await runMigrations(pool, MIGRATIONS)).applied, []);
    const configuration = await loadRoutineConfiguration(pool);
    assert.equal(configuration, null);
    const counts = await pool.query(
      `SELECT (SELECT count(*)::int FROM routine_settings) AS settings,
              (SELECT count(*)::int FROM routine_transition) AS transitions,
              (SELECT count(*)::int FROM routine_applied_transition) AS applied`,
    );
    assert.deepEqual(counts.rows[0], { settings: 0, transitions: 0, applied: 0 });
  });

  it("retries a failed publication and remains idempotent across concurrent workers and restart", async () => {
    await provisionRoutine(pool, true);
    await pool.query(
      `INSERT INTO routine_transition
         (transition_key, weekday, local_minute, location, activity, available, interaction_context)
       VALUES ('monday-departure', 1, 540, 'synthetic away location', 'synthetic away activity', false, NULL),
              ('monday-return', 1, 1020, 'synthetic home location', 'synthetic home activity', true, NULL)`,
    );
    let clock = new Date("2026-11-09T10:00:00.000Z");
    const clockedPool = poolWithClock(pool, () => clock);
    const routine = createRoutineStore({ pool: clockedPool });
    await routine.reconcile(clock);
    clock = new Date("2026-11-09T12:00:00.000Z");

    const conversation = createConversationStore(clockedPool);
    const queued = await conversation.appendUserMessage({ content: "synthetic queued while unavailable" });
    const held = await conversation.claimNextTurn({
      owner: "routine-notice-gate",
      leaseSeconds: 60,
      canStartNewTurn: routine.canStartNewTurn,
    });
    assert.equal(held.kind, "idle");

    await assert.rejects(
      conversation.publishScheduledAssistantMessage({
        prepare: async (client) => {
          const prepared = await prepareRoutineAnnouncement(routine)(client);
          if (prepared === null) return null;
          return {
            ...prepared,
            recordPublication: async () => { throw new Error("synthetic publication failure"); },
          };
        },
      }),
      /synthetic publication failure/,
    );
    assert.equal((await pool.query(
      `SELECT status FROM routine_announcement`,
    )).rows[0].status, "pending", "a rolled-back publication remains retryable");
    assert.equal((await pool.query(
      `SELECT count(*)::int AS count FROM conversation_message WHERE role = 'assistant'`,
    )).rows[0].count, 0, "message and outbox state roll back atomically");

    const publish = (conversationStore, routineStore) =>
      conversationStore.publishScheduledAssistantMessage({
        prepare: prepareRoutineAnnouncement(routineStore),
      });
    const first = createConversationStore(clockedPool);
    const second = createConversationStore(clockedPool);
    const firstRoutine = createRoutineStore({ pool: clockedPool });
    const secondRoutine = createRoutineStore({ pool: clockedPool });
    const concurrent = await Promise.all([
      publish(first, firstRoutine),
      publish(second, secondRoutine),
    ]);
    assert.deepEqual(concurrent.sort(), [false, true], "the serialized concurrent retry publishes once");
    assert.equal(
      await publish(createConversationStore(clockedPool), createRoutineStore({ pool: clockedPool })),
      false,
      "a fresh runtime after restart observes the durable publication and does not replay it",
    );

    const page = await first.getThreadPage({ limit: 10 });
    assert.deepEqual(page.messages.map((message) => message.role), ["user", "assistant"]);
    assert.equal(page.messages[0].id, queued.id);
    assert.equal(page.messages[1].turnId, null, "the schedule notice is not a claimed user turn");
    assert.match(page.messages[1].content, /currently has me unavailable/);
    assert.match(page.messages[1].content, /Monday, November 9 at 9:00 AM/,
      "recovery reports the configured start rather than inventing a new one");
    assert.match(page.messages[1].content, /Monday, November 9 at 5:00 PM/);
    assert.match(page.messages[1].content, /Synthetic configured departure details/);
    assert.equal((await first.getThreadStatus()).queuedUserMessages, 1);
    const event = await pool.query(`SELECT id, status, message_id FROM routine_announcement`);
    assert.equal(event.rows.length, 1);
    assert.equal(event.rows[0].status, "published");
    assert.equal(event.rows[0].message_id, page.messages[1].id);
  });

  it("cancels an obsolete pending notice and does not replay an ended absence", async () => {
    await provisionRoutine(pool, true);
    await pool.query(
      `INSERT INTO routine_transition
         (transition_key, weekday, local_minute, location, activity, available, interaction_context)
       VALUES ('monday-departure', 1, 540, 'synthetic away location', 'synthetic away activity', false, NULL),
              ('monday-return', 1, 1020, 'synthetic home location', 'synthetic home activity', true, NULL)`,
    );
    let clock = new Date("2026-11-09T10:00:00.000Z");
    const clockedPool = poolWithClock(pool, () => clock);
    const routine = createRoutineStore({ pool: clockedPool });
    await routine.reconcile(clock);
    await pool.query(
      `UPDATE routine_transition SET available = true WHERE transition_key = 'monday-departure'`,
    );
    clock = new Date("2026-11-09T18:00:00.000Z");

    const conversation = createConversationStore(clockedPool);
    const published = await conversation.publishScheduledAssistantMessage({
      prepare: prepareRoutineAnnouncement(routine),
    });
    assert.equal(published, false);
    const event = await pool.query(`SELECT status, message_id FROM routine_announcement`);
    assert.equal(event.rows[0].status, "cancelled");
    assert.equal(event.rows[0].message_id, null);
    const messages = await pool.query(
      `SELECT count(*)::int AS count FROM conversation_message WHERE role = 'assistant'`,
    );
    assert.equal(messages.rows[0].count, 0);
  });

  it("does not announce a second time when an already-announced unavailable start is edited forward", async () => {
    await provisionRoutine(pool, true);
    await pool.query(
      `INSERT INTO routine_transition
         (transition_key, weekday, local_minute, location, activity, available, interaction_context)
       VALUES ('monday-departure', 1, 540, 'synthetic away location', 'synthetic away activity', false, NULL),
              ('monday-return', 1, 1020, 'synthetic home location', 'synthetic home activity', true, NULL)`,
    );
    let clock = new Date("2026-11-09T10:00:00.000Z");
    const clockedPool = poolWithClock(pool, () => clock);
    const routine = createRoutineStore({ pool: clockedPool });
    await routine.reconcile(clock);
    const conversation = createConversationStore(clockedPool);
    assert.equal(await conversation.publishScheduledAssistantMessage({
      prepare: prepareRoutineAnnouncement(routine),
    }), true);
    const original = (await pool.query(
      `SELECT id, status FROM routine_announcement WHERE status = 'published'`,
    )).rows[0];
    assert.ok(original);

    clock = new Date("2026-11-09T12:00:00.000Z");
    await pool.query(
      `UPDATE routine_transition SET local_minute = 660
       WHERE transition_key = 'monday-departure'`,
    );
    await routine.reconcile(clock);
    assert.equal(await conversation.publishScheduledAssistantMessage({
      prepare: prepareRoutineAnnouncement(routine),
    }), false, "editing the active start later does not fabricate an intervening available period");
    const events = await pool.query(
      `SELECT id, status FROM routine_announcement ORDER BY created_at, id`,
    );
    assert.deepEqual(events.rows, [original]);
    assert.equal((await pool.query(
      `SELECT count(*)::int AS count FROM conversation_message WHERE role = 'assistant'`,
    )).rows[0].count, 1);
  });

  it("keeps one notice when the moved-forward start stays before the saved return despite downtime", async () => {
    await provisionRoutine(pool, true);
    await pool.query(
      `INSERT INTO routine_transition
         (transition_key, weekday, local_minute, location, activity, available, interaction_context)
       VALUES ('monday-departure', 1, 540, 'synthetic away location', 'synthetic away activity', false, NULL),
              ('monday-return', 1, 1020, 'synthetic home location', 'synthetic home activity', true, NULL)`,
    );
    let clock = new Date("2026-11-09T09:30:00.000Z");
    const clockedPool = poolWithClock(pool, () => clock);
    const routine = createRoutineStore({ pool: clockedPool });
    await routine.reconcile(clock);
    const conversation = createConversationStore(clockedPool);
    assert.equal(await conversation.publishScheduledAssistantMessage({
      prepare: prepareRoutineAnnouncement(routine),
    }), true);
    const original = (await pool.query(
      `SELECT id, status, resumes_at FROM routine_announcement WHERE status = 'published'`,
    )).rows[0];
    assert.ok(original);
    assert.equal(original.resumes_at.toISOString(), "2026-11-09T17:00:00.000Z");

    // At noon, move the same departure to 11:00 and extend its return to 19:00.
    // The worker next runs at 18:00, after the old saved return but within the
    // uninterrupted edited absence.
    clock = new Date("2026-11-09T12:00:00.000Z");
    await pool.query(
      `UPDATE routine_transition SET local_minute = 660
       WHERE transition_key = 'monday-departure'`,
    );
    await pool.query(
      `UPDATE routine_transition SET local_minute = 1140
       WHERE transition_key = 'monday-return'`,
    );
    clock = new Date("2026-11-09T18:00:00.000Z");
    await routine.reconcile(clock);
    assert.equal(await conversation.publishScheduledAssistantMessage({
      prepare: prepareRoutineAnnouncement(routine),
    }), false, "the edited start precedes the original return, so passing the old boundary is not re-entry");

    const events = await pool.query(
      `SELECT id, status FROM routine_announcement ORDER BY created_at, id`,
    );
    assert.deepEqual(events.rows, [{ id: original.id, status: "published" }]);
    assert.equal((await pool.query(
      `SELECT count(*)::int AS count FROM conversation_message WHERE role = 'assistant'`,
    )).rows[0].count, 1);
  });

  it("creates a new notice when a missed return boundary precedes a moved-forward departure", async () => {
    await provisionRoutine(pool, true);
    await pool.query(
      `INSERT INTO routine_transition
         (transition_key, weekday, local_minute, location, activity, available, interaction_context)
       VALUES ('monday-departure', 1, 540, 'synthetic away location', 'synthetic away activity', false, NULL),
              ('monday-return', 1, 600, 'synthetic home location', 'synthetic home activity', true, NULL)`,
    );
    let clock = new Date("2026-11-09T09:30:00.000Z");
    const clockedPool = poolWithClock(pool, () => clock);
    const routine = createRoutineStore({ pool: clockedPool });
    await routine.reconcile(clock);
    const conversation = createConversationStore(clockedPool);
    assert.equal(await conversation.publishScheduledAssistantMessage({
      prepare: prepareRoutineAnnouncement(routine),
    }), true);
    const original = (await pool.query(
      `SELECT id, status, resumes_at FROM routine_announcement WHERE status = 'published'`,
    )).rows[0];
    assert.ok(original);
    assert.equal(original.resumes_at.toISOString(), "2026-11-09T10:00:00.000Z");

    // No reconciliation observes the original available return at 10:00.
    // While the worker is down the same departure transition is moved to 11:00,
    // creating a real 10:00-11:00 available gap before a new absence.
    clock = new Date("2026-11-09T10:30:00.000Z");
    await pool.query(
      `UPDATE routine_transition SET local_minute = 660
       WHERE transition_key = 'monday-departure'`,
    );
    clock = new Date("2026-11-09T12:00:00.000Z");
    await routine.reconcile(clock);

    const events = await pool.query(
      `SELECT id, status, scheduled_at FROM routine_announcement ORDER BY created_at, id`,
    );
    assert.equal(events.rows.length, 2);
    assert.equal(events.rows[0].id, original.id);
    assert.equal(events.rows[0].status, "ended",
      "the persisted original return boundary closes the first absence despite downtime");
    assert.equal(events.rows[1].status, "pending",
      "the moved-forward departure starts a distinct ongoing absence");
    assert.equal(await conversation.publishScheduledAssistantMessage({
      prepare: prepareRoutineAnnouncement(createRoutineStore({ pool: clockedPool })),
    }), true, "the still-ongoing re-entry gets its own notice");
    assert.equal((await pool.query(
      `SELECT count(*)::int AS count FROM conversation_message WHERE role = 'assistant'`,
    )).rows[0].count, 2);
  });

  it("creates a new event identity when the same transition re-enters unavailability on the same day", async () => {
    await provisionRoutine(pool, true);
    await pool.query(
      `INSERT INTO routine_transition
         (transition_key, weekday, local_minute, location, activity, available, interaction_context)
       VALUES ('monday-departure', 1, 540, 'synthetic away location', 'synthetic away activity', false, NULL),
              ('monday-return', 1, 1020, 'synthetic home location', 'synthetic home activity', true, NULL)`,
    );
    let clock = new Date("2026-11-09T10:00:00.000Z");
    const clockedPool = poolWithClock(pool, () => clock);
    const routine = createRoutineStore({ pool: clockedPool });
    await routine.reconcile(clock);
    const conversation = createConversationStore(clockedPool);
    assert.equal(await conversation.publishScheduledAssistantMessage({
      prepare: prepareRoutineAnnouncement(routine),
    }), true);
    const first = (await pool.query(
      `SELECT id, status FROM routine_announcement WHERE status = 'published'`,
    )).rows[0];
    assert.ok(first);

    clock = new Date("2026-11-09T12:00:00.000Z");
    await pool.query(
      `UPDATE routine_transition SET available = true WHERE transition_key = 'monday-departure'`,
    );
    await routine.reconcile(clock);
    assert.equal((await pool.query(
      `SELECT status FROM routine_announcement WHERE id = $1`, [first.id],
    )).rows[0].status, "ended", "observed availability closes the published period");

    clock = new Date("2026-11-09T13:00:00.000Z");
    await pool.query(
      `UPDATE routine_transition SET available = false WHERE transition_key = 'monday-departure'`,
    );
    await routine.reconcile(clock);
    const events = await pool.query(
      `SELECT id, transition_id, local_date::text AS local_date, status
       FROM routine_announcement ORDER BY created_at, id`,
    );
    assert.equal(events.rows.length, 2);
    assert.notEqual(events.rows[0].id, events.rows[1].id,
      "a transition/date occurrence is not reused as the period identity");
    assert.equal(events.rows[0].transition_id, events.rows[1].transition_id);
    assert.equal(events.rows[0].local_date, events.rows[1].local_date);
    assert.deepEqual(events.rows.map((event) => event.status), ["ended", "pending"]);
    assert.equal(await conversation.publishScheduledAssistantMessage({
      prepare: prepareRoutineAnnouncement(createRoutineStore({ pool: clockedPool })),
    }), true, "the new still-ongoing period publishes once");
    assert.equal((await pool.query(
      `SELECT count(*)::int AS count FROM conversation_message WHERE role = 'assistant'`,
    )).rows[0].count, 2);
  });

  it("rechecks the actual time after waiting on the pending event row lock", async () => {
    await provisionRoutine(pool, true);
    await pool.query(
      `INSERT INTO routine_transition
         (transition_key, weekday, local_minute, location, activity, available, interaction_context)
       VALUES ('monday-departure', 1, 540, 'synthetic away location', 'synthetic away activity', false, NULL),
              ('monday-return', 1, 1020, 'synthetic home location', 'synthetic home activity', true, NULL)`,
    );
    let clock = new Date("2026-11-09T16:59:59.999Z");
    const setupPool = poolWithClock(pool, () => clock);
    const setupRoutine = createRoutineStore({ pool: setupPool });
    await setupRoutine.reconcile(clock);

    const blocker = await pool.connect();
    let releaseWaiter;
    const pendingLockRequested = new Promise((resolve) => { releaseWaiter = resolve; });
    let signaled = false;
    try {
      await blocker.query("BEGIN");
      await blocker.query(
        `SELECT id FROM routine_announcement WHERE status = 'pending' FOR UPDATE`,
      );

      const timedPool = poolWithClock(pool, () => clock, (sql) => {
        if (!signaled && /routine_announcement/i.test(sql) && /status = 'pending'/i.test(sql) && /FOR UPDATE/i.test(sql)) {
          signaled = true;
          releaseWaiter();
        }
      });
      const routine = createRoutineStore({ pool: timedPool });
      const conversation = createConversationStore(timedPool);
      const publish = conversation.publishScheduledAssistantMessage({
        prepare: prepareRoutineAnnouncement(routine),
      });
      await pendingLockRequested;
      let blocked = false;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const waiting = await pool.query(
          `SELECT EXISTS (
             SELECT 1 FROM pg_stat_activity
             WHERE datname = current_database() AND pid <> pg_backend_pid()
               AND state = 'active' AND wait_event_type = 'Lock'
               AND query ILIKE '%routine_announcement%FOR UPDATE%'
           ) AS waiting`,
        );
        if (waiting.rows[0].waiting) { blocked = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.equal(blocked, true, "the publisher reached and waited on the locked pending event row");
      clock = new Date("2026-11-09T17:00:00.001Z");
      await blocker.query("COMMIT");
      assert.equal(await publish, false, "the final database clock is past the configured resumption time");
    } finally {
      await blocker.query("ROLLBACK").catch(() => {});
      blocker.release();
    }

    const event = await pool.query(`SELECT status, message_id FROM routine_announcement`);
    assert.equal(event.rows[0].status, "cancelled");
    assert.equal(event.rows[0].message_id, null);
    assert.equal((await pool.query(
      `SELECT count(*)::int AS count FROM conversation_message WHERE role = 'assistant'`,
    )).rows[0].count, 0, "no stale notice message was inserted after the absence ended");
  });

  it("rechecks claim availability after waiting on pending message locks", async () => {
    await provisionRoutine(pool, true);
    await pool.query(
      `INSERT INTO routine_transition
         (transition_key, weekday, local_minute, location, activity, available, interaction_context)
       VALUES ('monday-departure', 1, 540, 'synthetic away location', 'synthetic away activity', false, NULL),
              ('monday-return', 1, 1020, 'synthetic home location', 'synthetic home activity', true, NULL)`,
    );
    let clock = new Date("2026-11-09T08:59:59.999Z");
    let pendingLockRequested;
    const lockRequested = new Promise((resolve) => { pendingLockRequested = resolve; });
    let signaled = false;
    const clockedPool = poolWithClock(pool, () => clock, (sql) => {
      if (!signaled && /FROM conversation_message/i.test(sql) && /turn_id IS NULL/i.test(sql) && /FOR UPDATE/i.test(sql)) {
        signaled = true;
        pendingLockRequested();
      }
    });
    const routine = createRoutineStore({ pool: clockedPool });
    const conversation = createConversationStore(clockedPool);
    const queued = await conversation.appendUserMessage({ content: "synthetic queued before departure" });

    const blocker = await pool.connect();
    let claim;
    try {
      await blocker.query("BEGIN");
      await blocker.query(
        `SELECT id FROM conversation_message WHERE id = $1 FOR UPDATE`, [queued.id],
      );
      claim = conversation.claimNextTurn({
        owner: "routine-boundary-wait",
        leaseSeconds: 60,
        canStartNewTurn: routine.canStartNewTurn,
      });
      await lockRequested;
      let blocked = false;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const waiting = await pool.query(
          `SELECT EXISTS (
             SELECT 1 FROM pg_stat_activity
             WHERE datname = current_database() AND pid <> pg_backend_pid()
               AND state = 'active' AND wait_event_type = 'Lock'
               AND query ILIKE '%FROM conversation_message%FOR UPDATE%'
           ) AS waiting`,
        );
        if (waiting.rows[0].waiting) { blocked = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.equal(blocked, true, "the claimant is blocked on the pending-message row lock");
      clock = new Date("2026-11-09T09:00:00.001Z");
      await blocker.query("COMMIT");
      const result = await claim;
      assert.equal(result.kind, "idle", "the post-wait schedule sample sees the departure boundary");
    } finally {
      await blocker.query("ROLLBACK").catch(() => {});
      blocker.release();
      await claim?.catch(() => {});
    }

    const state = await pool.query(
      `SELECT (SELECT count(*)::int FROM conversation_turn) AS turns,
              (SELECT count(*)::int FROM conversation_message WHERE id = $1 AND turn_id IS NULL) AS queued`,
      [queued.id],
    );
    assert.deepEqual(state.rows[0], { turns: 0, queued: 1 },
      "in-flight recovery remains separate and no new turn is created across departure");
  });

  it("keeps claim admission on one configuration revision across a concurrent edit", async () => {
    const routine = await provisionRoutine(pool, false);
    const writer = createPostgresPool({ connectionString: DATABASE_URL });
    let changed = false;
    const racingClient = {
      query: async (sql, values) => {
        const result = await pool.query(sql, values);
        if (!changed && String(sql).includes("routine_settings")) {
          changed = true;
          await withTransaction(writer, async (client) => {
            await client.query(
              `UPDATE companion_time_settings SET timezone = 'America/Los_Angeles' WHERE id = true`,
            );
            await client.query(
              `UPDATE routine_settings SET timezone = 'America/Los_Angeles' WHERE id = true`,
            );
            await client.query(
              `UPDATE routine_transition
               SET local_minute = 60, available = true, activity = 'next revision'`,
            );
          });
        }
        return result;
      },
    };
    try {
      assert.equal(await routine.canStartNewTurn(racingClient), false,
        "the decision must use the old coherent revision read before the concurrent commit");
      assert.equal(changed, true);
      assert.equal(await routine.canStartNewTurn({ query: pool.query.bind(pool) }), true,
        "a subsequent call observes the complete new revision");
    } finally {
      await closePostgresPool(writer);
    }
  });

  it("persists reconciliation from one configuration revision when an edit commits after its read", async () => {
    await provisionRoutine(pool, false);
    const writer = createPostgresPool({ connectionString: DATABASE_URL });
    let changed = false;
    const racingPool = {
      connect: async () => {
        const client = await pool.connect();
        return {
          query: async (sql, values) => {
            const result = await client.query(sql, values);
            if (!changed && String(sql).includes("routine_settings")) {
              changed = true;
              await withTransaction(writer, async (writerClient) => {
                await writerClient.query(
                  `UPDATE companion_time_settings SET timezone = 'America/Los_Angeles' WHERE id = true`,
                );
                await writerClient.query(
                  `UPDATE routine_settings SET timezone = 'America/Los_Angeles' WHERE id = true`,
                );
                await writerClient.query(
                  `UPDATE routine_transition
                   SET local_minute = 60, available = true, activity = 'next revision'`,
                );
              });
            }
            return result;
          },
          release: () => client.release(),
        };
      },
    };
    try {
      const routine = createRoutineStore({ pool: racingPool });
      const applied = await routine.reconcile(new Date("2026-11-08T12:00:00.000Z"));
      assert.equal(changed, true);
      assert.equal(applied.available, false);
      assert.equal(applied.activity, "synthetic activity");
      assert.equal(applied.scheduledAt.toISOString(), "2026-11-08T00:00:00.000Z");
      const events = await pool.query(
        `SELECT timezone FROM routine_settings WHERE id = true`,
      );
      assert.equal(events.rows[0].timezone, "America/Los_Angeles", "the concurrent revision committed");
      const persisted = await pool.query(
        `SELECT transition_key, scheduled_at, available, activity
         FROM routine_applied_transition`,
      );
      assert.deepEqual(persisted.rows, [{
        transition_key: "state-7",
        scheduled_at: new Date("2026-11-08T00:00:00.000Z"),
        available: false,
        activity: "synthetic activity",
      }]);
    } finally {
      await closePostgresPool(writer);
    }
  });

  it("applies an edit to live admission without rewriting the prior applied occurrence, including after restart", async () => {
    const routine = await provisionRoutine(pool, true);
    const evaluationTime = new Date("2026-11-08T12:00:00.000Z");
    const clientAtEvaluationTime = {
      query: async (sql, values) => String(sql).includes("clock_timestamp")
        ? { rows: [{ now: evaluationTime }] }
        : pool.query(sql, values),
    };
    const original = await routine.reconcile(evaluationTime);
    assert.equal(original.transitionKey, "state-7");
    assert.equal(await routine.canStartNewTurn(clientAtEvaluationTime), true,
      "the initial live schedule admits at the evaluation time");
    await pool.query(
      `UPDATE routine_transition
       SET local_minute = 60, available = false, location = 'edited location',
           activity = 'edited activity', interaction_context = 'edited context'
       WHERE transition_key = 'state-7'`,
    );
    assert.equal(await routine.canStartNewTurn(clientAtEvaluationTime), false,
      "the coherent live configuration edit changes admission immediately");

    const restarted = createRoutineStore({ pool });
    const afterEdit = await restarted.reconcile(new Date("2026-11-08T12:00:00.000Z"));
    assert.deepEqual(afterEdit, original,
      "the unique transition/day occurrence keeps its original time and content");
    const rows = await pool.query(
      `SELECT a.transition_key, a.local_date::text AS local_date, a.scheduled_at,
              a.available, a.location, a.activity, a.interaction_context,
              s.transition_key AS state_transition_key, s.scheduled_at AS state_scheduled_at,
              s.available AS state_available, s.location AS state_location,
              s.activity AS state_activity, s.interaction_context AS state_interaction_context
       FROM routine_applied_transition AS a
       JOIN routine_applied_state AS s ON s.id = true
       WHERE a.transition_id = s.transition_id AND a.local_date = s.local_date`,
    );
    assert.equal(rows.rows.length, 1);
    assert.deepEqual(rows.rows[0], {
      transition_key: "state-7",
      local_date: "2026-11-08",
      scheduled_at: new Date("2026-11-08T00:00:00.000Z"),
      available: true,
      location: "synthetic location",
      activity: "synthetic activity",
      interaction_context: "synthetic optional interaction context",
      state_transition_key: "state-7",
      state_scheduled_at: new Date("2026-11-08T00:00:00.000Z"),
      state_available: true,
      state_location: "synthetic location",
      state_activity: "synthetic activity",
      state_interaction_context: "synthetic optional interaction context",
    });
  });

  it("recovers missed transitions on restart and serializes concurrent reconciliation", async () => {
    const routine = await provisionRoutine(pool, true);
    const base = new Date("2026-11-08T00:00:00.000Z");
    const first = await routine.reconcile(base);
    assert.equal(first.localDate, "2026-11-08");
    assert.equal(first.available, true);

    const restarted = createRoutineStore({ pool });
    const afterDowntime = new Date("2026-11-10T00:00:00.000Z");
    const [a, b] = await Promise.all([
      restarted.reconcile(afterDowntime),
      restarted.reconcile(afterDowntime),
    ]);
    assert.equal(a.localDate, "2026-11-10");
    assert.equal(b.localDate, "2026-11-10");
    const events = await pool.query(
      `SELECT local_date::text AS local_date, transition_key
       FROM routine_applied_transition ORDER BY scheduled_at, transition_key`,
    );
    assert.deepEqual(events.rows.map((row) => row.local_date), ["2026-11-08", "2026-11-09", "2026-11-10"]);
    const state = await pool.query(
      `SELECT local_date::text AS local_date, available, location, activity
       FROM routine_applied_state WHERE id = true`,
    );
    assert.deepEqual(state.rows[0], {
      local_date: "2026-11-10",
      available: true,
      location: "synthetic location",
      activity: "synthetic activity",
    });
  });

  it("releases accumulated ordered messages at the exact unavailable-to-available schedule boundary", async () => {
    const conversation = createConversationStore(pool);
    const routine = await provisionRoutine(pool, true);
    await pool.query(
      `INSERT INTO routine_transition
         (transition_key, weekday, local_minute, location, activity, available, interaction_context)
       VALUES ('monday-departure', 1, 540, 'synthetic away location', 'synthetic away activity', false, NULL),
              ('monday-return', 1, 1020, 'synthetic home location', 'synthetic home activity', true, NULL)`,
    );
    const gateAt = (instant) => (client) => routine.canStartNewTurn({
      query: async (sql, values) => String(sql).includes("clock_timestamp")
        ? { rows: [{ now: new Date(instant) }] }
        : client.query(sql, values),
    });

    const departure = await conversation.claimNextTurn({
      owner: "routine-exact-departure",
      leaseSeconds: 60,
      canStartNewTurn: gateAt("2026-11-09T09:00:00.000Z"),
    });
    assert.equal(departure.kind, "idle", "the configured unavailable boundary is inclusive");
    await conversation.appendUserMessage({ content: "synthetic accumulated one" });
    await conversation.appendUserMessage({ content: "synthetic accumulated two" });
    const stillUnavailable = await conversation.claimNextTurn({
      owner: "routine-before-return",
      leaseSeconds: 60,
      canStartNewTurn: gateAt("2026-11-09T16:59:59.999Z"),
    });
    assert.equal(stillUnavailable.kind, "idle");
    assert.equal((await conversation.getThreadStatus()).queuedUserMessages, 2);

    const returned = await conversation.claimNextTurn({
      owner: "routine-exact-return",
      leaseSeconds: 60,
      canStartNewTurn: gateAt("2026-11-09T17:00:00.000Z"),
    });
    assert.equal(returned.kind, "claimed", "the available boundary is inclusive");
    assert.deepEqual(returned.work.messages.map((message) => message.content), [
      "synthetic accumulated one",
      "synthetic accumulated two",
    ]);
  });

  it("waits for a healthy turn reply before publishing while later messages remain gated", async () => {
    const conversation = createConversationStore(pool);
    const routine = await provisionRoutine(pool, true);
    await conversation.appendUserMessage({ content: "synthetic claimed before departure" });
    const claimed = await conversation.claimNextTurn({
      owner: "routine-healthy",
      leaseSeconds: 60,
      canStartNewTurn: routine.canStartNewTurn,
    });
    assert.equal(claimed.kind, "claimed");
    await conversation.appendUserMessage({ content: "synthetic queued one" });
    await conversation.appendUserMessage({ content: "synthetic queued two" });

    await pool.query(`UPDATE routine_transition SET available = false`);
    await routine.reconcile();
    const publish = () => conversation.publishScheduledAssistantMessage({
      prepare: prepareRoutineAnnouncement(routine),
    });
    assert.equal(await publish(), false, "an in-flight turn delays the schedule notice");
    assert.equal((await pool.query(
      `SELECT status FROM conversation_turn WHERE id = $1`, [claimed.work.turn.id],
    )).rows[0].status, "in_flight");
    assert.equal((await pool.query(
      `SELECT status FROM routine_announcement`,
    )).rows[0].status, "pending", "the pending notice remains durable while publication waits");
    assert.equal((await pool.query(
      `SELECT count(*)::int AS count FROM conversation_message WHERE role = 'assistant'`,
    )).rows[0].count, 0, "no notice becomes visible before the active reply completes");

    assert.equal(await conversation.publishReply({
      turnId: claimed.work.turn.id,
      leaseOwner: "routine-healthy",
      content: "synthetic reply completed across departure",
    }), "published");
    assert.equal(await publish(), true, "the pending notice publishes after the reply commits");
    const thread = await conversation.getThreadPage({ limit: 10 });
    assert.equal(thread.messages[3].content, "synthetic reply completed across departure");
    assert.match(thread.messages[4].content, /currently has me unavailable/,
      "the visible thread orders the completed reply before the notice");

    const held = await conversation.claimNextTurn({
      owner: "routine-unavailable",
      leaseSeconds: 60,
      canStartNewTurn: routine.canStartNewTurn,
    });
    assert.equal(held.kind, "idle");
    assert.equal((await conversation.getThreadStatus()).queuedUserMessages, 2);

    const available = await provisionRoutine(pool, true);
    const released = await conversation.claimNextTurn({
      owner: "routine-boundary-release",
      leaseSeconds: 60,
      canStartNewTurn: available.canStartNewTurn,
    });
    assert.equal(released.kind, "claimed");
    assert.deepEqual(released.work.messages.map((message) => message.content), [
      "synthetic queued one",
      "synthetic queued two",
    ]);
    const prior = await conversation.getThreadContext({ turnId: released.work.turn.id, limit: 20 });
    assert.deepEqual(prior.map((message) => message.role), ["user", "assistant", "assistant"]);
    assert.equal(prior[1].content, "synthetic reply completed across departure");
    assert.match(prior[2].content, /currently has me unavailable/,
      "the notice follows the in-flight reply in later-turn context too");
  });

  it("does not admit new work when a hot-edited schedule is malformed", async () => {
    const conversation = createConversationStore(pool);
    const routine = await provisionRoutine(pool, true);
    await conversation.appendUserMessage({ content: "synthetic pending behind invalid config" });
    await pool.query(`UPDATE companion_time_settings SET timezone = 'Not/AZone' WHERE id = true`);

    await assert.rejects(
      conversation.claimNextTurn({
        owner: "routine-invalid-config",
        leaseSeconds: 60,
        canStartNewTurn: routine.canStartNewTurn,
      }),
      /not a valid IANA timezone/,
    );
    assert.equal((await conversation.getThreadStatus()).queuedUserMessages, 1);
    const turns = await pool.query(`SELECT count(*)::int AS count FROM conversation_turn`);
    assert.equal(turns.rows[0].count, 0);
  });

  it("recovers an already-claimed turn while unavailable, holds subsequent groups, and releases them in order", async () => {
    const conversation = createConversationStore(pool);
    const routineUnavailable = await provisionRoutine(pool, false);
    const first = await conversation.appendUserMessage({ content: "synthetic in-flight message" });
    const initial = await conversation.claimNextTurn({ owner: "routine-initial", leaseSeconds: 60 });
    assert.equal(initial.kind, "claimed");
    await conversation.appendUserMessage({ content: "synthetic queued one" });
    await conversation.appendUserMessage({ content: "synthetic queued two" });
    await pool.query(
      `UPDATE conversation_turn SET lease_expires_at = now() - interval '1 second'
       WHERE id = $1`,
      [initial.work.turn.id],
    );

    // Reclaiming an existing turn remains allowed during unavailability; it
    // still has its original grouped snapshot and is not regenerated from the
    // trailing messages.
    const reclaimed = await conversation.claimNextTurn({
      owner: "routine-reclaimer",
      leaseSeconds: 60,
      canStartNewTurn: routineUnavailable.canStartNewTurn,
    });
    assert.equal(reclaimed.kind, "claimed");
    assert.equal(reclaimed.work.turn.id, initial.work.turn.id);
    assert.deepEqual(reclaimed.work.messages.map((message) => message.id), [first.id]);
    assert.equal(await conversation.publishReply({
      turnId: reclaimed.work.turn.id,
      leaseOwner: "routine-reclaimer",
      content: "synthetic current reply",
    }), "published");

    const held = await conversation.claimNextTurn({
      owner: "routine-held",
      leaseSeconds: 60,
      canStartNewTurn: routineUnavailable.canStartNewTurn,
    });
    assert.equal(held.kind, "idle");
    assert.equal((await conversation.getThreadStatus()).queuedUserMessages, 2);

    // A runtime schedule edit to available is observed without a worker
    // restart; accumulated messages stay in persisted order.
    const routineAvailable = await provisionRoutine(pool, true);
    const released = await conversation.claimNextTurn({
      owner: "routine-released",
      leaseSeconds: 60,
      canStartNewTurn: routineAvailable.canStartNewTurn,
    });
    assert.equal(released.kind, "claimed");
    assert.deepEqual(released.work.messages.map((message) => message.content), [
      "synthetic queued one",
      "synthetic queued two",
    ]);
  });
});
