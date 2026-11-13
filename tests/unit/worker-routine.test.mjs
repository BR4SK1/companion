import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  currentRoutineUnavailablePeriod,
  nextRoutineTransition,
  renderRoutineAnnouncement,
  renderRoutineContext,
  routineTransitionsAfter,
  scheduledRoutineStateAt,
} from "../../apps/worker/src/routine/runtime.ts";
import {
  createRoutineStore,
  loadRoutineConfiguration,
  RoutineConfigurationError,
} from "../../apps/worker/src/routine/store.ts";
import { routineMigrations } from "../../apps/worker/src/routine/migrations.ts";
import { buildChatPrompt } from "../../apps/worker/src/work/chat.ts";
import { runEngineOnce } from "../../apps/worker/src/work/engine.ts";

function transition(key, weekday, localMinute, overrides = {}) {
  return {
    id: `id-${key}`,
    key,
    weekday,
    localMinute,
    location: null,
    activity: null,
    available: true,
    interactionContext: null,
    ...overrides,
  };
}

const weekly = {
  timezone: "UTC",
  departureContext: "Configured departure details.",
  transitions: [
    transition("sunday", 7, 0, { location: "configured place", activity: "configured activity" }),
    transition("monday-unavailable", 1, 540, {
      available: false,
      location: "elsewhere",
      interactionContext: "Configured reactive interaction context.",
    }),
    transition("monday-available", 1, 1020, { available: true }),
  ],
};

describe("routine schedule semantics", () => {
  it("keeps weekly schedule state distinct at exact boundaries and resolves next transitions", () => {
    const before = scheduledRoutineStateAt(new Date("2026-11-09T08:59:59.999Z"), weekly);
    const unavailable = scheduledRoutineStateAt(new Date("2026-11-09T09:00:00.000Z"), weekly);
    const available = scheduledRoutineStateAt(new Date("2026-11-09T17:00:00.000Z"), weekly);
    assert.equal(before.transitionKey, "sunday");
    assert.equal(unavailable.transitionKey, "monday-unavailable");
    assert.equal(unavailable.available, false);
    assert.equal(available.transitionKey, "monday-available");
    assert.equal(nextRoutineTransition(new Date("2026-11-09T09:00:00.000Z"), weekly).transitionKey, "monday-available");
  });

  it("identifies one continuous unavailable interval and renders only configured schedule facts", () => {
    const period = currentRoutineUnavailablePeriod(new Date("2026-11-09T12:00:00.000Z"), weekly);
    assert.equal(period.current.transitionKey, "monday-unavailable");
    assert.equal(period.start.transitionKey, "monday-unavailable");
    assert.equal(period.start.scheduledAt.toISOString(), "2026-11-09T09:00:00.000Z");
    assert.equal(period.resumes.transitionKey, "monday-available");
    assert.equal(period.resumes.scheduledAt.toISOString(), "2026-11-09T17:00:00.000Z");
    const notice = renderRoutineAnnouncement({
      period,
      timezone: "UTC",
      departureContext: "Configured context.",
    });
    assert.match(notice, /currently has me unavailable/);
    assert.match(notice, /Monday, November 9 at 9:00 AM/);
    assert.match(notice, /Monday, November 9 at 5:00 PM/);
    assert.match(notice, /Configured context/);
    assert.doesNotMatch(notice, /photo|media|romance/i);
  });

  it("uses the configured IANA local weekday/minute across DST gaps and folds", () => {
    const spring = {
      timezone: "America/New_York",
      departureContext: null,
      transitions: [transition("sun-0230", 7, 150, { available: false })],
    };
    assert.notEqual(
      scheduledRoutineStateAt(new Date("2026-03-08T07:29:59.999Z"), spring).localDate,
      "2026-03-08",
    );
    const afterGap = scheduledRoutineStateAt(new Date("2026-03-08T07:30:00.000Z"), spring);
    assert.equal(afterGap.localDate, "2026-03-08");
    assert.equal(afterGap.scheduledAt.toISOString(), "2026-03-08T07:30:00.000Z", "02:30 shifts by the one-hour spring gap to 03:30");

    const halfHourGap = {
      timezone: "Australia/Lord_Howe",
      departureContext: null,
      transitions: [transition("sun-0215", 7, 135, { available: false })],
    };
    assert.equal(
      scheduledRoutineStateAt(new Date("2026-10-03T15:45:00.000Z"), halfHourGap).scheduledAt.toISOString(),
      "2026-10-03T15:45:00.000Z",
      "a 02:15 schedule minute shifts by Lord Howe's thirty-minute gap to 02:45",
    );

    const fall = {
      timezone: "America/New_York",
      departureContext: null,
      transitions: [transition("sun-0130", 7, 90, { available: false })],
    };
    assert.notEqual(scheduledRoutineStateAt(new Date("2026-11-01T05:29:59.999Z"), fall).localDate, "2026-11-01");
    assert.equal(scheduledRoutineStateAt(new Date("2026-11-01T05:30:00.000Z"), fall).scheduledAt.toISOString(), "2026-11-01T05:30:00.000Z", "ambiguous wall time uses its first occurrence");
    assert.equal(scheduledRoutineStateAt(new Date("2026-11-01T06:30:00.000Z"), fall).scheduledAt.toISOString(), "2026-11-01T05:30:00.000Z");
  });

  it("reconciles every missed occurrence in chronological order after downtime", () => {
    const due = routineTransitionsAfter(
      new Date("2026-11-07T23:59:59.999Z"),
      new Date("2026-11-09T17:00:00.000Z"),
      weekly,
    );
    assert.deepEqual(due.map((item) => item.transitionKey), [
      "sunday",
      "monday-unavailable",
      "monday-available",
    ]);
    assert.deepEqual(due.map((item) => item.localDate), [
      "2026-11-08",
      "2026-11-09",
      "2026-11-09",
    ]);
  });

  it("projects routine context at an old attempt instant without mutating live lifecycle state", async () => {
    const attemptedAt = new Date("2026-11-09T10:00:00.000Z");
    const queries = [];
    const priorApplied = {
      transition_id: "id-sunday",
      transition_key: "sunday",
      local_date: "2026-11-08",
      scheduled_at: new Date("2026-11-08T00:00:00.000Z"),
      applied_at: new Date("2026-11-08T00:00:01.000Z"),
      location: "home",
      activity: "resting",
      available: true,
      interaction_context: null,
    };
    const pool = {
      connect: async () => ({
        query: async (sql, values = []) => {
          const text = String(sql);
          queries.push({ text, values });
          if (/^BEGIN/i.test(text) || /^COMMIT$/i.test(text)) return { rows: [] };
          if (text.includes("FROM routine_settings AS s")) {
            const common = {
              timezone: "UTC",
              departure_context: null,
            };
            return { rows: [
              { ...common, id: "id-sunday", transition_key: "sunday", weekday: 7, local_minute: 0,
                location: "home", activity: "resting", available: true, interaction_context: null },
              { ...common, id: "id-monday-away", transition_key: "monday-away", weekday: 1, local_minute: 540,
                location: "away", activity: "busy", available: false, interaction_context: null },
              { ...common, id: "id-monday-home", transition_key: "monday-home", weekday: 1, local_minute: 1020,
                location: "home", activity: "available", available: true, interaction_context: null },
            ] };
          }
          if (text.includes("FROM routine_applied_transition")) return { rows: [priorApplied] };
          if (/\\b(INSERT|UPDATE|DELETE)\\b/i.test(text)) {
            throw new Error(`historical snapshot attempted lifecycle mutation: ${text}`);
          }
          throw new Error(`unexpected routine snapshot query: ${text}`);
        },
        release: () => {},
      }),
    };

    const snapshot = await createRoutineStore({ pool, timezone: "UTC" }).getSnapshot(attemptedAt);
    assert.equal(snapshot.scheduled.transitionKey, "monday-away");
    assert.equal(snapshot.scheduled.available, false);
    assert.equal(snapshot.applied.transitionKey, "sunday");
    assert.deepEqual(
      queries.find(({ text }) => text.includes("FROM routine_applied_transition")).values,
      [attemptedAt],
    );
    assert.match(queries[0].text, /READ ONLY/);
    assert.ok(queries.some(({ text }) => text.includes("applied_at <= $1")));
    assert.ok(!queries.some(({ text }) => /\\b(INSERT|UPDATE|DELETE)\\b/i.test(text)));
  });

  it("keeps in-flight routine context separate from the scheduled announcement", () => {
    const scheduled = scheduledRoutineStateAt(new Date("2026-11-09T09:00:00.000Z"), weekly);
    const prior = scheduledRoutineStateAt(new Date("2026-11-09T08:59:00.000Z"), weekly);
    const context = renderRoutineContext({
      scheduled,
      applied: { ...prior, appliedAt: new Date("2026-11-09T08:59:00.000Z") },
      next: nextRoutineTransition(new Date("2026-11-09T09:00:00.000Z"), weekly),
      departureContext: weekly.departureContext,
    });
    assert.match(context, /Scheduled now: availability=unavailable/);
    assert.match(context, /Currently applied: availability=available/);
    assert.match(context, /transition=sunday/);
    assert.match(context, /applied_at=2026-11-09T08:59:00.000Z/);
    assert.match(context, /separate schedule notice communicates this unavailable period/i);
    assert.match(context, /Configured reactive interaction context/);
    assert.doesNotMatch(context, /Configured departure details/);
    assert.match(context, /do not repeat the schedule notice/);
    assert.doesNotMatch(context, /romance|photo|media/i);
  });

  it("classifies routine context as a separate optional chat chunk", () => {
    const built = buildChatPrompt({
      model: "synthetic-model",
      identity: "synthetic identity",
      routine: "synthetic scheduled/applied routine context",
      history: [],
      turnMessages: [{ id: "message-1", role: "user", content: "synthetic input" }],
      guidance: null,
    });
    assert.deepEqual(built.messages.map((message) => message.chunk), [
      "identity",
      "routine",
      "conversation",
    ]);
    assert.equal(built.request.messages[1].content, "synthetic scheduled/applied routine context");
  });

  it("does not process or claim new work when the transactional availability gate is closed", async () => {
    let passedGate;
    let processed = false;
    const result = await runEngineOnce({
      store: {
        claimNextTurn: async (params) => {
          passedGate = await params.canStartNewTurn({ marker: "claim transaction" });
          return { kind: "idle" };
        },
      },
      canStartNewTurn: async (client) => client.marker === "claim transaction" && false,
      processTurn: async () => { processed = true; throw new Error("must not process"); },
      leaseSeconds: 3,
      pollSeconds: 1,
    });
    assert.equal(result, "idle");
    assert.equal(passedGate, false);
    assert.equal(processed, false);
  });

  it("keeps migrations structural and degrades cleanly with no settings row", async () => {
    assert.deepEqual(routineMigrations.map((migration) => migration.id), [
      "0012_routine_schedule",
      "0013_routine_chat_chunk",
      "0014_routine_announcement",
      "0015_routine_announcement_period_id",
    ]);
    assert.doesNotMatch(routineMigrations[0].sql, /INSERT INTO/i);
    assert.match(routineMigrations[0].sql, /routine_applied_transition/);
    assert.match(routineMigrations[0].sql, /routine_applied_state/);
    assert.match(routineMigrations[2].sql, /routine_announcement/);
    assert.match(routineMigrations[3].sql, /PRIMARY KEY \(id\)/i);
    assert.match(routineMigrations[3].sql, /status = 'ended'/);
    let queries = 0;
    const pool = { query: async () => { queries += 1; return { rows: [] }; } };
    assert.equal(await loadRoutineConfiguration(pool), null);
    assert.equal(queries, 1);
    const routineStore = createRoutineStore({ pool });
    let gateQueries = 0;
    assert.equal(await routineStore.canStartNewTurn({
      query: async () => { gateQueries += 1; return { rows: [] }; },
    }), true);
    assert.equal(gateQueries, 1, "unprovisioned schedules do not block ordinary chat");
  });

  it("rejects invalid configured timezones and incomplete schedules", async () => {
    const poolFor = (settings, transitions) => ({
      query: async () => ({
        rows: transitions.length === 0
          ? [{ ...settings, id: null }]
          : transitions.map((item) => ({
            ...settings,
            id: item.id,
            transition_key: item.key,
            weekday: item.weekday,
            local_minute: item.localMinute,
            location: item.location,
            activity: item.activity,
            available: item.available,
            interaction_context: item.interactionContext,
          })),
      }),
    });
    await assert.rejects(
      loadRoutineConfiguration(poolFor({ timezone: "Not/AZone", departure_context: null }, [transition("x", 1, 0)])),
      RoutineConfigurationError,
    );
    await assert.rejects(
      loadRoutineConfiguration(poolFor({ timezone: "UTC", departure_context: null }, [])),
      /at least one enabled routine_transition/,
    );
  });
});
