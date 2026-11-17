import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createConversationStore } from "../../apps/worker/src/conversation/store.ts";
import { createPromptModuleStore } from "../../apps/worker/src/prompt-modules/store.ts";

const attemptId = "00000000-0000-4000-8000-000000000001";
const moduleId = "00000000-0000-4000-8000-000000000002";
const secondModuleId = "00000000-0000-4000-8000-000000000005";
const chatId = "00000000-0000-4000-8000-000000000003";

function fakePool() {
  const statements = [];
  return {
    statements,
    connect: async () => ({
      query: async (query, values = []) => {
        const sql = String(query);
        statements.push({ sql, values });
        if (/^(BEGIN|COMMIT|ROLLBACK)/i.test(sql)) return { rows: [] };
        if (sql.includes("SELECT a.id AS attempt_id")) {
          return { rows: [{ attempt_id: attemptId }] };
        }
        if (sql.includes("INSERT INTO trace_attempt_chat")) {
          return { rows: [{ id: chatId }] };
        }
        if (sql.includes("INSERT INTO trace_attempt_prompt_module_chat_message")) {
          return { rows: [{ module_id: values[1] }] };
        }
        if (sql.includes("UPDATE trace_attempt_prompt_module")) {
          return { rows: [{ module_id: values[1] }] };
        }
        return { rows: [] };
      },
      release() {},
    }),
  };
}

describe("prompt module trace persistence", () => {
  it("loads activation and output settings with compatible defaults supplied by the schema", async () => {
    const statements = [];
    const pool = {
      query: async (sql) => {
        statements.push(String(sql));
        return { rows: [{
          id: moduleId,
          module_key: "every_turn_module",
          decision_description: "criterion",
          function_definition: "(context) => context.turnId",
          execution_mode: "function",
          http_endpoint_setting: null,
          http_scope_setting: null,
          http_scope_field: null,
          http_turn_id_field: null,
          http_local_datetime_field: null,
          http_previous_assistant_field: null,
          http_user_message_field: null,
          http_prior_conversation_field: null,
          http_response_text_field: null,
          http_field_max_bytes: null,
          http_prior_message_limit: null,
          http_request_max_bytes: null,
          http_response_max_bytes: null,
          fallback_content: null,
          timeout_ms: 5000,
          position: 2,
          activation_mode: "every_turn",
          output_kind: "authoritative_context",
        }] };
      },
    };
    const store = createPromptModuleStore(pool);
    const modules = await store.loadEnabled();
    assert.equal(modules[0].activationMode, "every_turn");
    assert.equal(modules[0].outputKind, "authoritative_context");
    assert.match(statements[0], /activation_mode, output_kind/);
  });

  it("loads typed trace rows with deterministic tie ordering and persisted message positions", async () => {
    const pool = fakePool();
    const store = createPromptModuleStore(pool);
    const clientQueries = [];
    const client = {
      query: async (sql, values = []) => {
        const text = String(sql);
        clientQueries.push({ sql: text, values });
        if (text.includes("FROM trace_attempt_prompt_module AS module")) {
          return { rows: [{
            module_id: moduleId,
            module_key: "first",
            position: 7,
            decision_description: "criterion",
            function_hash: "a".repeat(64),
            activation_mode: "model_gated",
            output_kind: "thoughts",
            execution_mode: "function",
            fallback_available: false,
            decision_state: "responded",
            decision_model: "decision-model",
            response_model: "decision-build",
            response_provider: "provider",
            decision_choice: "include",
            selected: true,
            decision_confidence: 0.9,
            decision_ms: 20,
            execution_state: "succeeded",
            execution_ordinal: 0,
            execution_ms: 5,
            failure_kind: null,
            output_ready: true,
            fallback_selected: false,
            fallback_used: false,
            included: true,
            chat_message_position: 1,
          }] };
        }
        if (text.includes("FROM trace_attempt_prompt_module_probability")) {
          return { rows: [{ option_id: "include", value: 0.9 }] };
        }
        return { rows: [] };
      },
    };
    const result = await store.loadAttemptTrace(client, attemptId);
    assert.equal(result[0].moduleId, moduleId);
    assert.equal(result[0].outputReady, true);
    assert.equal(result[0].included, true);
    assert.equal(result[0].executionMode, "function");
    assert.equal(result[0].chatMessagePosition, 1);
    assert.deepEqual(result[0].probabilities, [{ optionId: "include", value: 0.9 }]);
    const traceQuery = clientQueries.find(({ sql }) => sql.includes("FROM trace_attempt_prompt_module AS module"));
    assert.ok(traceQuery);
    assert.match(traceQuery.sql, /ORDER BY module\.position, module\.module_id/);
    assert.deepEqual(traceQuery.values, [attemptId]);
  });

  it("does not touch optional prompt-module storage for a module-free chat request, even if it would fail persistently", async () => {
    const pool = fakePool();
    let callbackCalls = 0;
    const conversation = createConversationStore(pool, {
      onPromptModuleChatMessagesRecorded: async () => {
        callbackCalls += 1;
        throw new Error("optional prompt-module storage unavailable");
      },
    });
    const recorded = await conversation.recordChatRequest({
      turnId: "turn-without-modules",
      leaseOwner: "lease-without-modules",
      payload: {
        request: {
          model: "chat-model",
          messages: [
            { role: "system", content: "identity" },
            { role: "user", content: "hello" },
          ],
        },
        messageSources: [null, "00000000-0000-4000-8000-000000000004"],
        messageChunks: ["identity", "conversation"],
        messagePromptModuleIds: [null, null],
        identityRevision: 1,
      },
    });
    assert.equal(recorded, true);
    assert.equal(callbackCalls, 0);
    assert.equal(
      pool.statements.some(({ sql }) => sql.includes("trace_attempt_prompt_module")),
      false,
    );
  });

  it("records every-turn activation without a provider result and attributes its output exactly", async () => {
    const pool = fakePool();
    const modules = createPromptModuleStore(pool);
    const module = {
      id: moduleId,
      key: "every_turn_module",
      decisionDescription: "criterion",
      functionDefinition: "(context) => context.turnId",
      executionMode: "function",
      httpConfig: null,
      definitionHash: "b".repeat(64),
      fallbackContent: null,
      timeoutMs: 5000,
      position: 0,
      activationMode: "every_turn",
      outputKind: "authoritative_context",
    };
    await modules.recordDefinitions({
      turnId: "turn-every",
      leaseOwner: "lease-every",
      decisionModel: "unused-model",
      modules: [module],
    });
    await modules.recordDecision({
      turnId: "turn-every",
      leaseOwner: "lease-every",
      result: {
        state: "not_required",
        decisionModel: null,
        responseModel: null,
        responseProvider: null,
        durationMs: null,
        failureKind: null,
        selections: [{
          moduleId,
          choice: null,
          selected: true,
          confidence: null,
          probabilities: null,
        }],
      },
    });
    await modules.recordExecution({
      turnId: "turn-every",
      leaseOwner: "lease-every",
      result: {
        moduleId,
        executionOrdinal: 0,
        state: "succeeded",
        durationMs: 2,
        outputReady: true,
        fallbackSelected: false,
      },
    });
    const conversation = createConversationStore(pool, {
      onPromptModuleChatMessagesRecorded: (client, association) =>
        modules.recordChatAttribution(client, association),
    });
    await conversation.recordChatRequest({
      turnId: "turn-every",
      leaseOwner: "lease-every",
      payload: {
        request: {
          model: "chat-model",
          messages: [
            { role: "system", content: "identity" },
            { role: "system", content: "authoritative context" },
            { role: "user", content: "hello" },
          ],
        },
        messageSources: [null, null, "00000000-0000-4000-8000-000000000004"],
        messageChunks: ["identity", "prompt_module", "conversation"],
        messagePromptModuleIds: [null, moduleId, null],
        identityRevision: 1,
      },
    });
    const decisionWrite = pool.statements.find(({ sql }) =>
      sql.includes("SET decision_state = $3"),
    );
    assert.ok(decisionWrite);
    assert.equal(decisionWrite.values[2], "not_required");
    assert.equal(decisionWrite.values[3], null);
    assert.equal(decisionWrite.values[9], null);
    const executionWrite = pool.statements.find(({ sql }) =>
      sql.includes("SET execution_state = $3"),
    );
    assert.match(executionWrite.sql, /'not_required'/);
    assert.ok(pool.statements.some(({ sql, values }) =>
      sql.includes("INSERT INTO trace_attempt_prompt_module_chat_message") && values[1] === moduleId,
    ));
  });

  it("keeps generated output ready but not included until the atomic chat request association", async () => {
    const pool = fakePool();
    const modules = createPromptModuleStore(pool);
    const recorded = await modules.recordExecution({
      turnId: "turn-1",
      leaseOwner: "lease-1",
      result: {
        moduleId,
        executionOrdinal: 0,
        state: "timed_out",
        durationMs: 5000,
        outputReady: true,
        fallbackSelected: true,
      },
    });
    assert.equal(recorded, true);
    const executionWrite = pool.statements.find(({ sql }) =>
      sql.includes("SET execution_state = $3"),
    );
    assert.ok(executionWrite);
    assert.match(executionWrite.sql, /output_ready = \$6/);
    assert.match(executionWrite.sql, /fallback_selected = \$7/);
    assert.match(executionWrite.sql, /fallback_used = false/);
    assert.match(executionWrite.sql, /included = false/);
    assert.equal(executionWrite.values[5], true);
    assert.equal(executionWrite.values[6], true);
    await modules.recordExecution({
      turnId: "turn-1",
      leaseOwner: "lease-1",
      result: {
        moduleId: secondModuleId,
        executionOrdinal: 1,
        state: "succeeded",
        durationMs: 7,
        outputReady: true,
        fallbackSelected: false,
      },
    });

    const conversation = createConversationStore(pool, {
      onPromptModuleChatMessagesRecorded: (client, association) =>
        modules.recordChatAttribution(client, association),
    });
    const recordedRequest = await conversation.recordChatRequest({
      turnId: "turn-1",
      leaseOwner: "lease-1",
      payload: {
        request: {
          model: "chat-model",
          messages: [
            { role: "system", content: "identity" },
            { role: "system", content: "module thought one" },
            { role: "system", content: "module thought two" },
            { role: "user", content: "hello" },
          ],
        },
        messageSources: [null, null, null, "00000000-0000-4000-8000-000000000004"],
        messageChunks: ["identity", "prompt_module", "prompt_module", "conversation"],
        messagePromptModuleIds: [null, moduleId, secondModuleId, null],
        identityRevision: 1,
      },
    });
    assert.equal(recordedRequest, true);

    const associationWrites = pool.statements.filter(({ sql }) =>
      sql.includes("INSERT INTO trace_attempt_prompt_module_chat_message"),
    );
    assert.equal(associationWrites.length, 2);
    assert.deepEqual(associationWrites.map(({ values }) => values), [
      [attemptId, moduleId, chatId, 1],
      [attemptId, secondModuleId, chatId, 2],
    ]);
    const includedWrites = pool.statements.filter(({ sql }) =>
      sql.includes("SET included = true"),
    );
    assert.equal(includedWrites.length, 2);
    assert.match(includedWrites[0].sql, /fallback_used = fallback_selected/);
    assert.deepEqual(includedWrites.map(({ values }) => values), [
      [attemptId, moduleId],
      [attemptId, secondModuleId],
    ]);
    const associationPosition = pool.statements.indexOf(associationWrites[0]);
    const secondBegin = pool.statements.findIndex(
      ({ sql }, index) => index > pool.statements.findIndex(({ sql: statement }) => statement === "COMMIT") && sql === "BEGIN",
    );
    const finalCommit = pool.statements.map(({ sql }) => sql).lastIndexOf("COMMIT");
    assert.ok(secondBegin < associationPosition);
    assert.ok(pool.statements.indexOf(includedWrites[1]) < finalCommit);
  });
});
