// Hermetic tests for article fetch scheduling and random round-robin feed
// selection. No database, network, provider, or runtime timers are used.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  ARTICLE_INGEST_INTERVAL_MS,
  ArticleFeedShuffleCycle,
  articleIngestionRetryAfterMs,
  reserveArticleIngestionSlot,
} from "../../apps/worker/src/articles/schedule.ts";
import {
  runIngestionAttempt,
  startArticleRuntime,
  MAX_FEEDS_PER_RUN,
} from "../../apps/worker/src/articles/runner.ts";

const startInput = {
  reason: "unit-test",
  model: "test-model",
  promptVersion: "article-reaction-v1",
};

class FakeSlotDatabase {
  now = new Date("2026-11-17T00:00:00.000Z");
  lastStartedAt = null;
  nextId = 1;
  lockTail = Promise.resolve();

  async connect() {
    const database = this;
    let releaseLock;
    let holdsLock = false;
    return {
      async query(sql) {
        if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
          if ((sql === "COMMIT" || sql === "ROLLBACK") && holdsLock) {
            holdsLock = false;
            releaseLock();
          }
          return { rows: [] };
        }
        if (sql.includes("pg_advisory_xact_lock")) {
          const previous = database.lockTail;
          database.lockTail = new Promise((resolve) => {
            releaseLock = resolve;
          });
          await previous;
          holdsLock = true;
          return { rows: [] };
        }
        if (sql.includes("max(started_at) AS last_started_at")) {
          return {
            rows: [{ database_now: new Date(database.now), last_started_at: database.lastStartedAt }],
          };
        }
        if (sql.includes("INSERT INTO memory_operation")) {
          const row = { id: `trace-${database.nextId++}`, started_at: new Date(database.now) };
          database.lastStartedAt = row.started_at;
          return { rows: [row] };
        }
        throw new Error(`unexpected fake SQL: ${sql}`);
      },
      release() {},
    };
  }
}

function feed(id) {
  return { id, url: `https://${id}.example/feed`, enabled: true, position: 0 };
}

describe("article ingestion cadence", () => {
  it("uses a hard-coded 12-hour interval and the exact due boundary", () => {
    assert.equal(ARTICLE_INGEST_INTERVAL_MS, 12 * 60 * 60 * 1000);
    const last = new Date("2026-11-17T00:00:00.000Z");
    assert.equal(articleIngestionRetryAfterMs(last, new Date(last.getTime() + 1)), ARTICLE_INGEST_INTERVAL_MS - 1);
    assert.equal(articleIngestionRetryAfterMs(last, new Date(last.getTime() + ARTICLE_INGEST_INTERVAL_MS)), 0);
    assert.equal(articleIngestionRetryAfterMs(null, last), 0);
  });

  it("does not reserve another fetch after restart within the 12-hour window", async () => {
    const db = new FakeSlotDatabase();
    const first = await reserveArticleIngestionSlot(db, startInput);
    assert.equal(first.status, "reserved");

    // A second call models a fresh worker process: only durable database
    // state, not process-local scheduler memory, enforces this wait.
    db.now = new Date(db.now.getTime() + 11 * 60 * 60 * 1000);
    const afterRestart = await reserveArticleIngestionSlot(db, startInput);
    assert.deepEqual(afterRestart, {
      status: "rate_limited",
      retryAfterMs: 60 * 60 * 1000,
    });
  });

  it("reserves a new fetch after twelve hours have elapsed", async () => {
    const db = new FakeSlotDatabase();
    const first = await reserveArticleIngestionSlot(db, startInput);
    assert.equal(first.status, "reserved");

    db.now = new Date(db.now.getTime() + ARTICLE_INGEST_INTERVAL_MS);
    const next = await reserveArticleIngestionSlot(db, startInput);
    assert.equal(next.status, "reserved");
    assert.notEqual(next.reservation.traceId, first.reservation.traceId);
  });

  it("serializes replica reservations so concurrent workers cannot both reserve a slot", async () => {
    const db = new FakeSlotDatabase();
    const [first, second] = await Promise.all([
      reserveArticleIngestionSlot(db, startInput),
      reserveArticleIngestionSlot(db, startInput),
    ]);
    assert.equal([first, second].filter((entry) => entry.status === "reserved").length, 1);
    assert.equal([first, second].filter((entry) => entry.status === "rate_limited").length, 1);
  });

  it("keeps the manual runOnce path behind the same durable cadence gate", async () => {
    const db = new FakeSlotDatabase();
    db.lastStartedAt = new Date(db.now);
    let fetches = 0;
    let llmCalls = 0;
    const pool = {
      connect: () => db.connect(),
      async query(sql, values = []) {
        if (sql.includes("FROM article_behavior")) {
          return { rows: [{
            enabled: true,
            model: "test-model",
            max_generations_per_run: 1,
            max_reaction_attempts: 1,
            max_article_age_days: 30,
            max_reaction_chars: 1000,
            max_excerpt_chars: 1000,
            share_cooldown_minutes: 60,
            decision_max_candidates: 1,
          }] };
        }
        if (sql.includes("FROM article_feed")) {
          return { rows: [{ id: "source", url: "https://source.example/feed", position: 0 }] };
        }
        if (sql.includes("FROM article_prompt")) {
          return { rows: [
            { kind: "reaction_generation", version: values[0], system_prompt: "generate" },
            { kind: "reaction_review", version: values[1], system_prompt: "review" },
          ] };
        }
        if (sql.includes("FROM memory_subject")) return { rows: [{ id: "assistant" }] };
        throw new Error(`unexpected config SQL: ${sql}`);
      },
    };
    const runtime = startArticleRuntime({
      pool,
      callLlm: async () => { llmCalls += 1; throw new Error("must not call LLM"); },
      transport: async () => { fetches += 1; throw new Error("must not fetch"); },
      log() {},
    });
    try {
      const manual = await runtime.runOnce();
      assert.equal(manual.status, "rate_limited");
      assert.equal(fetches, 0);
      assert.equal(llmCalls, 0);
    } finally {
      await runtime.close();
    }
  });
});

describe("article random round-robin feed cycle", () => {
  it("visits every feed once before reshuffling, with a single feed supported", () => {
    const cycle = new ArticleFeedShuffleCycle(() => 0.37);
    const feeds = [feed("a"), feed("b"), feed("c"), feed("d")];
    const firstCycle = feeds.map(() => cycle.next(feeds).id);
    assert.equal(new Set(firstCycle).size, feeds.length);
    assert.deepEqual(new Set(firstCycle), new Set(feeds.map(({ id }) => id)));

    const firstOfNextCycle = cycle.next(feeds);
    assert.ok(feeds.some(({ id }) => id === firstOfNextCycle.id));

    const single = new ArticleFeedShuffleCycle();
    assert.equal(single.next([feed("solo")]).id, "solo");
    assert.equal(single.next([feed("solo")]).id, "solo");
  });

  it("incorporates added feeds and drops removed or disabled feeds without repeats", () => {
    const cycle = new ArticleFeedShuffleCycle(() => 0.5);
    const initial = [feed("a"), feed("b"), feed("c")];
    const first = cycle.next(initial);
    const changed = [
      ...initial.filter(({ id }) => id !== first.id && id !== "b"),
      feed("new"),
      { ...feed("disabled"), enabled: false },
    ];
    const visited = [first.id];
    for (let index = 0; index < changed.filter(({ enabled }) => enabled).length; index += 1) {
      visited.push(cycle.next(changed).id);
    }

    const expected = new Set(changed.filter(({ enabled }) => enabled).map(({ id }) => id));
    const currentCycle = visited.filter((id) => expected.has(id));
    assert.equal(new Set(currentCycle).size, expected.size);
    assert.deepEqual(new Set(currentCycle), expected);
    assert.ok(!visited.includes("b"));
    assert.ok(!visited.includes("disabled"));
  });

  it("handles an empty enabled list and preserves the unconfigured response", async () => {
    const cycle = new ArticleFeedShuffleCycle();
    assert.equal(cycle.next([]), undefined);

    let fetches = 0;
    const pool = {
      async query(sql) {
        if (sql.includes("FROM article_behavior")) {
          return {
            rows: [{
              enabled: true,
              model: "test-model",
              max_generations_per_run: 1,
              max_reaction_attempts: 1,
              max_article_age_days: 30,
              max_reaction_chars: 1000,
              max_excerpt_chars: 1000,
              share_cooldown_minutes: 60,
              decision_max_candidates: 1,
            }],
          };
        }
        if (sql.includes("FROM article_feed")) return { rows: [] };
        throw new Error(`unexpected fake SQL: ${sql}`);
      },
    };
    const summary = await runIngestionAttempt({
      pool,
      callLlm: async () => { throw new Error("must not call LLM"); },
      transport: async () => { fetches += 1; throw new Error("must not fetch"); },
      log() {},
    }, "unit-test");
    assert.equal(summary.status, "not_configured");
    assert.equal(summary.result.feedsAttempted, 0);
    assert.equal(fetches, 0);
  });

  it("keeps the per-run fetch cap at one", () => {
    assert.equal(MAX_FEEDS_PER_RUN, 1);
  });
});
