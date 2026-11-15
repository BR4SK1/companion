import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createTraceReportStore } from "../../apps/worker/src/cli.ts";
import { createConversationStore } from "../../apps/worker/src/conversation/store.ts";

const asOf = new Date("2026-03-11T17:30:00.000Z");
const pgDateValue = new Date("2026-03-11T00:00:00.000Z");

function tracePool({ promptModules = [] } = {}) {
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
        if (text.includes("FROM trace_attempt_prompt_module_probability")) {
          return { rows: [{ option_id: "include", value: 0.8 }] };
        }
        if (text.includes("FROM trace_attempt_prompt_module")) {
          return { rows: promptModules };
        }
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

  it("reports ready output separately from exact chat-message inclusion", async () => {
    const included = {
      module_id: "module-id",
      module_key: "generic_example",
      position: 3,
      decision_description: "Use when appropriate.",
      function_hash: "a".repeat(64),
      fallback_available: true,
      decision_state: "responded",
      decision_model: "decision-model",
      response_model: "decision-build",
      response_provider: "provider",
      decision_choice: "include",
      selected: true,
      decision_confidence: 0.8,
      decision_ms: 25,
      execution_state: "timed_out",
      execution_ordinal: 0,
      execution_ms: 5000,
      failure_kind: "execution_timeout",
      output_ready: true,
      fallback_selected: true,
      fallback_used: true,
      included: true,
      chat_message_position: 4,
    };
    const interrupted = {
      ...included,
      module_id: "module-interrupted",
      module_key: "interrupted_module",
      position: 4,
      execution_state: "succeeded",
      execution_ordinal: 1,
      execution_ms: 8,
      failure_kind: null,
      fallback_selected: false,
      fallback_used: false,
      included: false,
      chat_message_position: null,
    };
    const pool = tracePool({ promptModules: [included, interrupted] });
    const report = await createTraceReportStore(pool).getTurnTraceReport({
      turnId: "turn-temporal-date",
    });
    const moduleTraceQuery = pool.queries.find((query) =>
      query.includes("FROM trace_attempt_prompt_module AS module"),
    );
    assert.ok(moduleTraceQuery, "CLI-composed report store must load feature-owned module trace rows");
    assert.match(moduleTraceQuery, /ORDER BY module\.position, module\.module_id/);
    assert.equal(report.attempts[0].promptModules[0].moduleId, "module-id");
    assert.equal(report.attempts[0].promptModules[0].outputReady, true);
    assert.equal(report.attempts[0].promptModules[0].included, true);
    assert.equal(report.attempts[0].promptModules[0].chatMessagePosition, 4);
    assert.equal(report.attempts[0].promptModules[0].fallbackUsed, true);
    assert.deepEqual(report.attempts[0].promptModules[1], {
      moduleId: "module-interrupted",
      moduleKey: "interrupted_module",
      position: 4,
      decisionDescription: "Use when appropriate.",
      definitionHash: "a".repeat(64),
      fallbackAvailable: true,
      decisionState: "responded",
      decisionModel: "decision-model",
      responseModel: "decision-build",
      responseProvider: "provider",
      decisionChoice: "include",
      selected: true,
      confidence: 0.8,
      probabilities: [{ optionId: "include", value: 0.8 }],
      decisionMs: 25,
      executionState: "succeeded",
      executionOrdinal: 1,
      executionMs: 8,
      failureKind: null,
      outputReady: true,
      fallbackSelected: false,
      fallbackUsed: false,
      included: false,
      chatMessagePosition: null,
    });
  });
});
