// Session scoping of model history to the engagement `gone` boundary.
// Hermetic: fake pool + fake assessment loader, no database. The
// processor trusts the session-scoped `loadContext` /
// `loadPreviousPublishedAssistantReply` from the conversation store, so
// decision state, chat prompt, snapshot, and prompt-module context all
// inherit the same slice; the processor case below proves that
// propagation with the scoped values as its inputs.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createConversationStore } from "../../apps/worker/src/conversation/store.ts";
import { processTurnWork } from "../../apps/worker/src/work/processor.ts";

const NOW = new Date("2026-01-01T00:00:00.000Z");

function messageRow(id, seq, role, content) {
  return {
    id,
    seq: String(seq),
    role,
    content,
    turn_id: `turn-${id}`,
    client_key: null,
    created_at: NOW,
    client_sent_at: null,
    effective_at: NOW,
    time_source: "server",
    client_time_status: "absent",
    server_received_at: NOW,
  };
}

// Rows as returned by getThreadContext's SQL: newest first (DESC).
const threadRows = [
  messageRow("new-assistant-2", 6, "assistant", "new reply two"),
  messageRow("followup-user", 5, "user", "follow-up in new conversation"),
  messageRow("new-assistant-1", 4, "assistant", "new reply one"),
  messageRow("gone-user", 3, "user", "return after gone silence"),
  messageRow("old-assistant-1", 2, "assistant", "old reply"),
  messageRow("old-user-1", 1, "user", "old conversation"),
];

function loaderFor(states) {
  return {
    getAssessmentStatesForMessages: async (ids) =>
      new Map(ids.filter((id) => id in states).map((id) => [id, states[id]])),
  };
}

function storeWith({ rows = threadRows, currentIds = [], afterIds = [], prevRow = null, states = {}, useLoader = true } = {}) {
  const pool = {
    query: async (sql, values) => {
      const text = String(sql);
      if (text.includes("prior_context")) return { rows };
      if (text.includes("WHERE turn_id = $1 AND role = 'user'")) {
        return { rows: currentIds.map((id) => ({ id })) };
      }
      if (text.includes("prior_thread_order")) {
        return { rows: prevRow === null ? [] : [prevRow] };
      }
      if (text.includes("t.thread_order > $2")) {
        return { rows: afterIds.map((id) => ({ id })) };
      }
      // Unscoped previous-reply query (no loader).
      if (text.includes("SELECT reply.content")) {
        return { rows: prevRow === null ? [] : [{ content: prevRow.content }] };
      }
      throw new Error(`unexpected query: ${text.slice(0, 80)}`);
    },
  };
  return createConversationStore(pool, useLoader ? { sessionAssessmentLoader: loaderFor(states) } : {});
}

describe("getThreadContext session scoping", () => {
  it("slices prior history from the recorded gone return message", async () => {
    const store = storeWith({
      states: { "old-user-1": "engaged", "gone-user": "gone", "followup-user": "engaged" },
    });
    const context = await store.getThreadContext({ turnId: "current", limit: 40 });
    assert.deepEqual(
      context.map((m) => m.id),
      ["gone-user", "new-assistant-1", "followup-user", "new-assistant-2"],
    );
  });

  it("includes the new conversation's own prior messages on follow-up turns", async () => {
    // Follow-up turn: the bounded window already starts inside the new
    // conversation (gone message aged out of the window, or window
    // starts at it) — history must keep those messages, not reset again.
    const store = storeWith({
      rows: threadRows.slice(0, 3), // new-assistant-2, followup, new-assistant-1
      states: { "followup-user": "engaged" },
    });
    const context = await store.getThreadContext({ turnId: "current", limit: 40 });
    assert.deepEqual(
      context.map((m) => m.id),
      ["new-assistant-1", "followup-user", "new-assistant-2"],
    );
  });

  it("empties prior history when the current grouped turn contains a gone return", async () => {
    const store = storeWith({
      currentIds: ["current-a", "gone-user"],
      states: { "gone-user": "gone" },
    });
    assert.deepEqual(
      await store.getThreadContext({ turnId: "current", limit: 40 }),
      [],
    );
  });

  it("keeps existing behavior when unprovisioned or pre-existing (no assessment rows)", async () => {
    const store = storeWith({ states: {} });
    const context = await store.getThreadContext({ turnId: "current", limit: 40 });
    assert.equal(context.length, threadRows.length);
    assert.equal(context[0].id, "old-user-1");
  });

  it("keeps existing behavior when no loader is wired", async () => {
    const store = storeWith({ useLoader: false });
    const context = await store.getThreadContext({ turnId: "current", limit: 40 });
    assert.equal(context.length, threadRows.length);
  });

  it("ignores stale/non-gone recorded states (idle/lull never slice)", async () => {
    const store = storeWith({
      states: { "old-user-1": "idle", "gone-user": "lull", "followup-user": "idle" },
    });
    const context = await store.getThreadContext({ turnId: "current", limit: 40 });
    assert.equal(context.length, threadRows.length);
  });
});

describe("getPreviousPublishedAssistantReply session scoping", () => {
  const prevRow = { content: "previous published reply", prior_thread_order: "7" };

  it("returns the previous reply when no gone boundary exists", async () => {
    const store = storeWith({ prevRow, states: {} });
    assert.equal(
      await store.getPreviousPublishedAssistantReply("current"),
      "previous published reply",
    );
  });

  it("returns null when the current grouped turn contains a gone return", async () => {
    const store = storeWith({
      prevRow,
      currentIds: ["gone-user"],
      states: { "gone-user": "gone" },
    });
    assert.equal(await store.getPreviousPublishedAssistantReply("current"), null);
  });

  it("returns null when a gone turn sits after the reply's turn (including a failed turn)", async () => {
    const store = storeWith({
      prevRow,
      afterIds: ["failed-gone-user"],
      states: { "failed-gone-user": "gone" },
    });
    assert.equal(await store.getPreviousPublishedAssistantReply("current"), null);
  });

  it("returns the reply when the gone return is the reply's own turn (reply is in the new session)", async () => {
    // Gone user message belongs to the prior completed turn itself, so
    // it is neither in the current turn nor after the reply's turn.
    const store = storeWith({ prevRow, states: { "gone-user": "gone" } });
    assert.equal(
      await store.getPreviousPublishedAssistantReply("current"),
      "previous published reply",
    );
  });

  it("keeps existing behavior when no loader is wired", async () => {
    const store = storeWith({ prevRow, useLoader: false });
    assert.equal(
      await store.getPreviousPublishedAssistantReply("current"),
      "previous published reply",
    );
  });
});

describe("processor propagation of session-scoped history", () => {
  it("sends only the new conversation to snapshot, decision, chat, and prompt modules", async () => {
    const scopedHistory = [
      { id: "gone-user", role: "user", content: "return after gone silence" },
      { id: "new-assistant-1", role: "assistant", content: "new reply one" },
    ];
    const snapshots = [];
    const decisionRequests = [];
    const chatRequests = [];
    const moduleContexts = [];
    const work = {
      turn: { id: "turn-session", status: "in_flight", attempt: 1, leaseOwner: "lease-1", createdAt: "2026-01-01T00:00:00.000Z" },
      messages: [{ id: "current-user", role: "user", content: "hello again" }],
    };
    await processTurnWork(work, {
      decisionModel: "decision-model",
      chatModel: "chat-model",
      leaseOwner: "lease-1",
      callDecisions: async (request) => {
        decisionRequests.push(request);
        return {
          model: "decision-model-build",
          answers: Object.fromEntries(
            Object.keys(request.questions).map((questionId) => [
              questionId,
              questionId.startsWith("prompt_module_")
                ? { type: "choice", choice: "skip" }
                : { type: "choice", choice: "p1" },
            ]),
          ),
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      },
      callChat: async (request) => {
        chatRequests.push(request);
        return {
          id: "chat-1",
          model: "chat-model",
          choices: [{ message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
        };
      },
      loadPatterns: async () => [
        { id: "p1", selectionDescription: "desc", responseGuidance: "guide", position: 0 },
      ],
      loadIdentity: async () => ({ content: "IDENTITY", revision: 1 }),
      loadContext: async () => scopedHistory,
      loadPreviousPublishedAssistantReply: async () => null,
      loadPromptModules: async () => [
        {
          id: "mod-1",
          key: "module_mod_1",
          decisionDescription: "criterion",
          functionDefinition: "() => 'thought'",
          executionMode: "function",
          httpConfig: null,
          definitionHash: "a".repeat(64),
          fallbackContent: null,
          timeoutMs: 5000,
          position: 0,
          activationMode: "every_turn",
          outputKind: "thoughts",
        },
      ],
      executePromptModule: async ({ context }) => {
        moduleContexts.push(context);
        return { kind: "succeeded", content: "module thought", durationMs: 1 };
      },
      recordSnapshot: async (payload) => { snapshots.push(payload); },
      recordPromptModuleDefinitions: async () => {},
      recordPromptModuleDecision: async () => {},
      recordPromptModuleExecution: async () => {},
      recordChatRequest: async () => {},
      recordChatOutcome: async () => {},
      recordDecisionRequest: async () => {},
      recordDecisionOutcome: async () => {},
      recordDecisionSelection: async () => {},
    });

    const expectedConversation = [
      { role: "user", content: "return after gone silence" },
      { role: "assistant", content: "new reply one" },
      { role: "user", content: "hello again" },
    ];
    assert.deepEqual(
      snapshots[0].context.map((m) => m.content),
      ["return after gone silence", "new reply one", "hello again"],
    );
    assert.deepEqual(decisionRequests[0].state.conversation, expectedConversation);
    const chatConversation = chatRequests[0].messages.filter((m) => m.role !== "system");
    assert.deepEqual(
      chatConversation.map((m) => ({ role: m.role, content: m.content })),
      expectedConversation,
    );
    assert.equal(moduleContexts.length, 1);
    assert.deepEqual(moduleContexts[0].conversation, expectedConversation);
    assert.deepEqual(
      moduleContexts[0].priorConversation.map((m) => m.content),
      ["return after gone silence", "new reply one"],
    );
    assert.equal(moduleContexts[0].previousAssistantResponse, "");
    assert.ok(!JSON.stringify({ snapshots, decisionRequests, chatRequests, moduleContexts }).includes("old conversation"));
  });
});

describe("engagement batch assessment loader", () => {
  it("returns recorded states only, deduped, absent for unassessed ids", async () => {
    const { createEngagementStore } = await import(
      "../../apps/worker/src/engagement/store.ts"
    );
    const seen = [];
    const store = createEngagementStore({
      pool: {
        query: async (sql, values) => {
          seen.push({ sql: String(sql), values });
          assert.match(String(sql), /engagement_message_assessment/);
          assert.match(String(sql), /ANY\(\$1::uuid\[\]\)/);
          return {
            rows: [
              { message_id: "a", state: "gone" },
              { message_id: "b", state: "engaged" },
            ],
          };
        },
      },
      bands: { lullMs: 1, idleMs: 2, goneMs: 3 },
    });
    const states = await store.getAssessmentStatesForMessages(["a", "a", "b", "missing"]);
    assert.deepEqual([...states.entries()], [["a", "gone"], ["b", "engaged"]]);
    assert.deepEqual(seen[0].values[0], ["a", "b", "missing"]);
    assert.deepEqual(await store.getAssessmentStatesForMessages([]), new Map());
    assert.equal(seen.length, 1, "empty batch must not query");
  });
});

describe("claimNextTurn session batching", () => {
  function pendingRow(id, seq) {
    return { ...messageRow(id, seq, "user", `content ${id}`), turn_id: null };
  }
  function claimStore({ pending, states = {}, useLoader = true } = {}) {
    const assignedSeqs = [];
    const client = {
      release: () => {},
      query: async (sql, values) => {
        const text = String(sql);
        if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") return { rows: [] };
        if (text.includes("pg_advisory_xact_lock")) return { rows: [] };
        if (text.includes("lease_expires_at <= now()")) return { rows: [] };
        if (text.includes("SELECT 1 FROM conversation_turn WHERE status = 'in_flight'")) return { rows: [] };
        if (text.includes("WHERE turn_id IS NULL AND role = 'user'")) return { rows: pending };
        if (text.includes("INSERT INTO conversation_turn")) {
          return {
            rows: [{
              id: values[0],
              status: "in_flight",
              attempt: 1,
              lease_owner: values[1],
              lease_expires_at: new Date(Date.now() + 60000),
              selected_pattern_id: null,
              decision: null,
              error: null,
              created_at: NOW,
              completed_at: null,
            }],
          };
        }
        if (text.includes("INSERT INTO trace_attempt")) return { rows: [] };
        if (text.includes("UPDATE conversation_message")) {
          assignedSeqs.push(values[1]);
          return { rows: [] };
        }
        throw new Error(`unexpected claim query: ${text.slice(0, 100)}`);
      },
    };
    const pool = { query: client.query, connect: async () => client };
    const store = createConversationStore(
      pool,
      useLoader ? { sessionAssessmentLoader: loaderFor(states) } : {},
    );
    return { store, assignedSeqs };
  }
  const claimParams = { owner: "owner-1", leaseSeconds: 60 };

  it("claims only pre-gone messages from a pre-gone + return + follow-up backlog", async () => {
    const pending = [
      pendingRow("pre-1", 1),
      pendingRow("pre-2", 2),
      pendingRow("gone-return", 3),
      pendingRow("follow-1", 4),
      pendingRow("follow-2", 5),
    ];
    const { store, assignedSeqs } = claimStore({
      pending,
      states: { "pre-1": "engaged", "gone-return": "gone", "follow-1": "engaged" },
    });
    const outcome = await store.claimNextTurn(claimParams);
    assert.equal(outcome.kind, "claimed");
    assert.deepEqual(outcome.work.messages.map((m) => m.id), ["pre-1", "pre-2"]);
    assert.deepEqual(assignedSeqs, [[1, 2]], "only the session batch is assigned; the rest stay unassigned");
  });

  it("claims a gone-headed session up to the next gone", async () => {
    const pending = [
      pendingRow("gone-return", 1),
      pendingRow("follow-1", 2),
      pendingRow("follow-2", 3),
      pendingRow("gone-return-2", 4),
      pendingRow("follow-3", 5),
    ];
    const { store, assignedSeqs } = claimStore({
      pending,
      states: { "gone-return": "gone", "gone-return-2": "gone" },
    });
    const outcome = await store.claimNextTurn(claimParams);
    assert.deepEqual(
      outcome.work.messages.map((m) => m.id),
      ["gone-return", "follow-1", "follow-2"],
    );
    assert.deepEqual(assignedSeqs, [[1, 2, 3]]);
  });

  it("claims the whole backlog with no gone, empty assessments, or no loader", async () => {
    const pending = [pendingRow("a", 1), pendingRow("b", 2), pendingRow("c", 3)];
    for (const useLoader of [true, false]) {
      const { store, assignedSeqs } = claimStore({
        pending,
        states: useLoader ? {} : { b: "gone" },
        useLoader,
      });
      const outcome = await store.claimNextTurn(claimParams);
      assert.deepEqual(outcome.work.messages.map((m) => m.id), ["a", "b", "c"]);
      assert.deepEqual(assignedSeqs, [[1, 2, 3]]);
    }
  });
});

describe("processor temporal retention across a session boundary", () => {
  it("keeps fresh temporal context in chat while history is session-scoped", async () => {
    const chatRequests = [];
    const work = {
      turn: { id: "turn-temporal", status: "in_flight", attempt: 1, leaseOwner: "lease-1", createdAt: "2026-01-01T00:00:00.000Z" },
      messages: [{ id: "gone-return", role: "user", content: "return after gone silence" }],
    };
    await processTurnWork(work, {
      decisionModel: "decision-model",
      chatModel: "chat-model",
      leaseOwner: "lease-1",
      callDecisions: async () => { throw new Error("no patterns, no decision expected"); },
      callChat: async (request) => {
        chatRequests.push(request);
        return { id: "chat-1", model: "chat-model", choices: [{ message: { role: "assistant", content: "hi" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
      },
      loadPatterns: async () => [],
      loadIdentity: async () => ({ content: "IDENTITY", revision: 1 }),
      loadContext: async () => [],
      loadPreviousPublishedAssistantReply: async () => null,
      loadMemoryContext: async () => ({
        profileSection: null,
        temporalContext: "FRESH TEMPORAL MEMORY: yesterday we discussed the garden.",
        memoryContext: null,
        recallFactKeys: [],
      }),
      recordChatRequest: async () => {},
      recordChatOutcome: async () => {},
    });
    assert.equal(chatRequests.length, 1);
    assert.ok(
      chatRequests[0].messages.some((m) => m.content.includes("FRESH TEMPORAL MEMORY")),
      "temporal chunk must be retained across the session boundary",
    );
    assert.deepEqual(
      chatRequests[0].messages.filter((m) => m.role !== "system").map((m) => m.content),
      ["return after gone silence"],
    );
  });
});
