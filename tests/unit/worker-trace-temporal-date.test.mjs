import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createConversationStore } from "../../apps/worker/src/conversation/store.ts";

const asOf = new Date("2026-03-11T17:30:00.000Z");
const pgDateValue = new Date("2026-03-11T00:00:00.000Z");

function tracePool() {
  const queries = [];
  return {
    queries,
    connect: async () => ({
      query: async (sql) => {
        const text = String(sql);
        queries.push(text);
        if (/^(BEGIN|COMMIT|ROLLBACK)/i.test(text)) return { rows: [] };
        if (text.includes("FROM conversation_turn WHERE id")) {
          return { rows: [{
            id: "turn-temporal-date",
            status: "in_flight",
            attempt: 1,
            lease_owner: "synthetic-owner",
            lease_expires_at: null,
            selected_pattern_id: null,
            decision: null,
            error: null,
            created_at: asOf,
            completed_at: null,
          }] };
        }
        if (text.includes("FROM trace_attempt WHERE turn_id")) {
          const hasTextCast = /temporal_local_date::text AS temporal_local_date/.test(text);
          return { rows: [{
            id: "attempt-temporal-date",
            attempt: 1,
            lease_owner: "synthetic-owner",
            claimed_at: asOf,
            finished_at: null,
            outcome: null,
            snapshot_recorded_at: null,
            temporal_timezone: "America/New_York",
            temporal_as_of: asOf,
            // Model the pg driver’s non-text DATE result unless SQL explicitly casts it.
            temporal_local_date: hasTextCast ? "2026-03-11" : pgDateValue,
            temporal_local_time: "13:30:00",
            temporal_season: "spring",
            temporal_occasion_keys: [],
            temporal_occasion_context: null,
          }] };
        }
        if (
          text.includes("FROM trace_attempt_context") ||
          text.includes("FROM trace_attempt_pattern") ||
          text.includes("FROM trace_attempt_decision") ||
          text.includes("FROM trace_attempt_chat WHERE attempt_id")
        ) return { rows: [] };
        throw new Error(`unexpected trace report query: ${text}`);
      },
      release: () => {},
    }),
  };
}

describe("temporal trace date decoding", () => {
  it("casts PostgreSQL DATE to text and preserves the ISO civil date in the report", async () => {
    const pool = tracePool();
    const report = await createConversationStore(pool).getTurnTraceReport({
      turnId: "turn-temporal-date",
    });
    const attemptQuery = pool.queries.find((query) => query.includes("FROM trace_attempt WHERE turn_id"));
    assert.match(attemptQuery, /temporal_local_date::text AS temporal_local_date/);
    assert.equal(report.attempts[0].temporalContext.localDate, "2026-03-11");
    assert.equal(typeof report.attempts[0].temporalContext.localDate, "string");
  });
});
