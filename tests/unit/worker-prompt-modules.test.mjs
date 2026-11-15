// Prompt modules execute trusted database-authored TypeScript in a killable
// child process. These tests use injected model decisions and a fake local
// service; no database, provider, or real external service is contacted.

import { createServer } from "node:http";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { OpenRouterTransportError } from "../../libraries/openrouter/src/transport.ts";
import { loadWorkerConfig } from "../../apps/worker/src/config.ts";
import { executePromptModule } from "../../apps/worker/src/prompt-modules/executor.ts";
import {
  PROMPT_MODULE_INCLUDE,
  PROMPT_MODULE_SKIP,
  promptModuleQuestionId,
} from "../../apps/worker/src/prompt-modules/decision.ts";
import {
  EXAMPLE_PROMPT_MODULE_FUNCTION,
  promptModuleMigrations,
} from "../../apps/worker/src/prompt-modules/migrations.ts";
import { runPromptModules } from "../../apps/worker/src/prompt-modules/runtime.ts";
import { PromptModuleTraceWriteError } from "../../apps/worker/src/prompt-modules/types.ts";
import {
  createConversationStore,
  TraceWriteFencedError,
} from "../../apps/worker/src/conversation/store.ts";
import { buildChatPrompt } from "../../apps/worker/src/work/chat.ts";
import { processTurnWork } from "../../apps/worker/src/work/processor.ts";

function moduleDefinition(id, overrides = {}) {
  return {
    id,
    key: `module_${id}`,
    decisionDescription: `Criterion for ${id}`,
    functionDefinition: `(context: PromptModuleContext): string => "thought ${id}"`,
    definitionHash: "a".repeat(64),
    fallbackContent: null,
    timeoutMs: 5000,
    position: 0,
    ...overrides,
  };
}

function responseFor(request, selections) {
  return {
    model: "decision-model-build",
    answers: Object.fromEntries(
      Object.keys(request.questions).map((questionId) => [
        questionId,
        {
          type: "choice",
          choice: selections[questionId.slice("prompt_module_".length)] ?? PROMPT_MODULE_SKIP,
          confidence: 0.91,
          probabilities: { [PROMPT_MODULE_INCLUDE]: 0.91, [PROMPT_MODULE_SKIP]: 0.09 },
        },
      ]),
    ),
    usage: { input_tokens: 4, output_tokens: 2 },
  };
}

function runtimeDeps(modules, overrides = {}) {
  const trace = { definitions: [], decisions: [], executions: [] };
  const deps = {
    turnId: "turn-1",
    leaseOwner: "lease-1",
    decisionModel: "decision-model",
    state: { conversation: [{ role: "user", content: "hello" }] },
    modules,
    context: { conversation: [], credentials: {} },
    callDecisions: async (request) => responseFor(request, {}),
    execute: async ({ module }) => ({
      kind: "succeeded",
      content: `thought ${module.id}`,
      durationMs: 2,
    }),
    recordDefinitions: async (input) => trace.definitions.push(input),
    recordDecision: async (input) => trace.decisions.push(input),
    recordExecution: async (input) => trace.executions.push(input),
    log: () => {},
    ...overrides,
  };
  return { deps, trace };
}

describe("generic prompt modules", () => {
  it("does nothing and makes no decision call when no enabled modules exist", async () => {
    const { deps, trace } = runtimeDeps([]);
    let calls = 0;
    deps.callDecisions = async () => {
      calls += 1;
      throw new Error("must not be called");
    };
    assert.deepEqual(await runPromptModules(deps), []);
    assert.equal(calls, 0);
    assert.deepEqual(trace, { definitions: [], decisions: [], executions: [] });
  });

  it("selects multiple independent modules, skips nonselections, and preserves configured order", async () => {
    const modules = [
      moduleDefinition("second", { position: 1 }),
      moduleDefinition("first", { position: 1 }),
      moduleDefinition("skipped", { position: 3, fallbackContent: "not applicable" }),
    ];
    const { deps, trace } = runtimeDeps(modules, {
      callDecisions: async (request) => responseFor(request, {
        first: PROMPT_MODULE_INCLUDE,
        second: PROMPT_MODULE_INCLUDE,
        skipped: PROMPT_MODULE_SKIP,
      }),
    });
    assert.deepEqual(await runPromptModules(deps), [
      { moduleId: "first", content: "thought first" },
      { moduleId: "second", content: "thought second" },
    ]);
    assert.deepEqual(trace.definitions[0].modules.map((module) => module.key), [
      "module_first", "module_second", "module_skipped",
    ]);
    assert.deepEqual(trace.decisions[0].result.selections.map((selection) => selection.selected), [
      true, true, false,
    ]);
    assert.deepEqual(trace.executions.map((record) => record.result.moduleId), ["first", "second"]);
    assert.deepEqual(trace.executions.map((record) => record.result.executionOrdinal), [0, 1]);
    assert.equal(trace.executions.some((record) => record.result.fallbackSelected), false);
  });

  it("does not execute or use fallback when the module decision call fails", async () => {
    let executions = 0;
    const { deps, trace } = runtimeDeps([
      moduleDefinition("positive-unknown", { fallbackContent: "fallback" }),
    ], {
      callDecisions: async () => {
        throw new OpenRouterTransportError("timeout", "private error content");
      },
      execute: async () => {
        executions += 1;
        return { kind: "succeeded", content: "unexpected", durationMs: 1 };
      },
    });
    assert.deepEqual(await runPromptModules(deps), []);
    assert.equal(executions, 0);
    assert.equal(trace.decisions[0].result.failureKind, "decision_transport");
    assert.equal(trace.decisions[0].result.selections[0].selected, null);
    assert.deepEqual(trace.executions, []);
  });

  it("does not use fallback when a returned module choice is not one of the offered options", async () => {
    const { deps, trace } = runtimeDeps([
      moduleDefinition("unusable", { fallbackContent: "must not appear" }),
    ], {
      callDecisions: async (request) => responseFor(request, { unusable: "unknown" }),
    });
    assert.deepEqual(await runPromptModules(deps), []);
    assert.equal(trace.decisions[0].result.failureKind, "decision_unusable");
    assert.equal(trace.decisions[0].result.selections[0].selected, null);
    assert.deepEqual(trace.executions, []);
  });

  it("uses configured fallback only after a positive selection and failed execution", async () => {
    const modules = [
      moduleDefinition("selected", { fallbackContent: "generic fallback", position: 0 }),
      moduleDefinition("skipped", { fallbackContent: "must not appear", position: 1 }),
    ];
    const { deps, trace } = runtimeDeps(modules, {
      callDecisions: async (request) => responseFor(request, {
        selected: PROMPT_MODULE_INCLUDE,
        skipped: PROMPT_MODULE_SKIP,
      }),
      execute: async () => ({ kind: "timed_out", durationMs: 20 }),
    });
    assert.deepEqual(await runPromptModules(deps), [
      { moduleId: "selected", content: "generic fallback" },
    ]);
    assert.equal(trace.executions.length, 1);
    assert.deepEqual(trace.executions[0].result, {
      moduleId: "selected",
      executionOrdinal: 0,
      state: "timed_out",
      durationMs: 20,
      outputReady: true,
      fallbackSelected: true,
    });
  });

  it("omits invalid function results and uses fallback only for that selected failure", async () => {
    const { deps, trace } = runtimeDeps([
      moduleDefinition("invalid", { fallbackContent: null }),
    ], {
      callDecisions: async (request) => responseFor(request, { invalid: PROMPT_MODULE_INCLUDE }),
      execute: async () => ({ kind: "invalid_result", durationMs: 3 }),
    });
    assert.deepEqual(await runPromptModules(deps), []);
    assert.equal(trace.executions[0].result.state, "invalid_result");
    assert.equal(trace.executions[0].result.outputReady, false);
    assert.equal(trace.executions[0].result.fallbackSelected, false);
  });

  it("seeds only the generic fixed-string example and leaves it disabled", () => {
    const migration = promptModuleMigrations.find(({ id }) => id === "0018_generic_prompt_modules");
    assert.ok(migration);
    assert.match(migration.sql, /'generic_example'[\s\S]*?false/);
    assert.ok(migration.sql.includes(EXAMPLE_PROMPT_MODULE_FUNCTION));
    assert.match(migration.sql, /CREATE TABLE trace_attempt_prompt_module/);
  });

  it("uses a typed message association and preserves old readiness separately from inclusion", () => {
    const migration = promptModuleMigrations.find(({ id }) => id === "0019_prompt_module_chat_attribution");
    assert.ok(migration);
    assert.match(migration.sql, /CREATE TABLE trace_attempt_prompt_module_chat_message/);
    assert.match(migration.sql, /ADD COLUMN output_ready boolean NOT NULL DEFAULT false/);
    assert.match(migration.sql, /ADD COLUMN fallback_selected boolean NOT NULL DEFAULT false/);
    assert.match(migration.sql, /DEFERRABLE INITIALLY DEFERRED/);
    assert.match(migration.sql, /ON DELETE CASCADE/);
    assert.match(migration.sql, /CREATE TRIGGER trace_attempt_prompt_module_chat_message_deleted/);
    assert.match(migration.sql, /complete_attempts/);
    assert.match(migration.sql, /amount = module_counts\.distinct_positions/);
    assert.match(
      migration.sql,
      /JOIN complete_attempts AS complete\s+ON complete\.attempt_id = modules\.attempt_id;/,
    );
  });

  it("runs the generic migration example through the executable TypeScript path", async () => {
    const module = moduleDefinition("example", {
      functionDefinition: EXAMPLE_PROMPT_MODULE_FUNCTION,
      timeoutMs: 5000,
    });
    const result = await executePromptModule({ module, context: {
      turnId: "turn-example",
      conversation: [],
      credentials: {},
    } });
    assert.deepEqual(result, {
      kind: "succeeded",
      content: "Example: I am ready to continue the conversation.",
      durationMs: result.durationMs,
    });
  });

  it("does not inherit unrelated worker environment variables into the child process", async () => {
    const variable = "PROMPT_MODULE_PARENT_SECRET_CANARY";
    const previous = process.env[variable];
    process.env[variable] = "must-not-be-inherited";
    try {
      const result = await executePromptModule({
        module: moduleDefinition("environment", {
          functionDefinition: `(): string => process.env.PROMPT_MODULE_PARENT_SECRET_CANARY ?? "not inherited"`,
        }),
        context: { turnId: "turn-env", conversation: [], credentials: {} },
      });
      assert.equal(result.kind, "succeeded");
      assert.equal(result.content, "not inherited");
    } finally {
      if (previous === undefined) delete process.env[variable];
      else process.env[variable] = previous;
    }
  });

  it("calls a fake external service using only an explicitly passed credential", async () => {
    let receivedAuthorization;
    const server = createServer((request, response) => {
      receivedAuthorization = request.headers.authorization;
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("service thought");
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    try {
      const module = moduleDefinition("service", {
        functionDefinition: `(context: PromptModuleContext): Promise<string> => fetch("http://127.0.0.1:${address.port}/thoughts", { headers: { authorization: context.credentials.serviceToken } }).then((response) => response.text())`,
      });
      const result = await executePromptModule({ module, context: {
        turnId: "turn-service",
        conversation: [{ role: "user", content: "hello" }],
        credentials: { serviceToken: "fake-service-token" },
      } });
      assert.equal(result.kind, "succeeded");
      assert.equal(result.content, "service thought");
      assert.equal(receivedAuthorization, "fake-service-token");
    } finally {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("kills a synchronous function that exceeds its configured timeout", async () => {
    const module = moduleDefinition("busy", {
      functionDefinition: `(): string => { while (true) {} }`,
      timeoutMs: 250,
    });
    const startedAt = Date.now();
    const result = await executePromptModule({ module, context: {
      turnId: "turn-timeout",
      conversation: [],
      credentials: {},
    } });
    assert.equal(result.kind, "timed_out");
    assert.ok(Date.now() - startedAt < 3000);
  });

  it("rejects non-string results", async () => {
    const module = moduleDefinition("wrong-type", {
      functionDefinition: `(): number => 42`,
    });
    const result = await executePromptModule({ module, context: {
      turnId: "turn-invalid",
      conversation: [],
      credentials: {},
    } });
    assert.equal(result.kind, "invalid_result");
  });

  it("assembles each module output as an authoritative additive system chunk, not background context", () => {
    const assembled = buildChatPrompt({
      model: "chat-model",
      identity: "IDENTITY",
      promptModules: [
        { moduleId: "module-one", content: "thought one" },
        { moduleId: "module-two", content: "thought two" },
      ],
      history: [],
      turnMessages: [{ id: "message-1", role: "user", content: "hello" }],
      guidance: null,
    });
    assert.deepEqual(assembled.messages.map((message) => message.chunk), [
      "identity", "prompt_module", "prompt_module", "conversation",
    ]);
    assert.equal(
      assembled.messages[1].content,
      "Authoritative additive companion thoughts and feelings (not background data):\nthought one",
    );
    assert.equal(assembled.messages[1].sourceMessageId, null);
    assert.deepEqual(
      assembled.messages.slice(1, 3).map((message) => message.promptModuleId),
      ["module-one", "module-two"],
    );
  });

  it("integrates selected output into the traced chat request while module decision failures preserve ordinary chat", async () => {
    const module = moduleDefinition("processor", { fallbackContent: "fallback should not run" });
    const chatResponse = {
      id: "chat-1",
      model: "chat-build",
      choices: [{ message: { role: "assistant", content: "reply" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    };
    const calls = { decisions: 0, chat: 0, traces: [], prompt: null, logs: [] };
    const processorDeps = {
      decisionModel: "decision-model",
      chatModel: "chat-model",
      leaseOwner: "lease-processor",
      callDecisions: async (request) => {
        calls.decisions += 1;
        return responseFor(request, { processor: PROMPT_MODULE_INCLUDE });
      },
      callChat: async () => {
        calls.chat += 1;
        return chatResponse;
      },
      loadPatterns: async () => [],
      loadIdentity: async () => ({ content: "IDENTITY", revision: 1 }),
      loadContext: async () => [],
      loadPromptModules: async () => [module],
      promptModuleCredentials: { serviceToken: "configured" },
      executePromptModule: async ({ context }) => {
        assert.equal(context.credentials.serviceToken, "configured");
        return { kind: "succeeded", content: "current thought", durationMs: 1 };
      },
      recordPromptModuleDefinitions: async () => {},
      recordPromptModuleDecision: async (trace) => calls.traces.push(trace),
      recordPromptModuleExecution: async (trace) => calls.traces.push(trace),
      recordChatRequest: async (trace) => { calls.prompt = trace; },
      log: (message) => calls.logs.push(message),
    };
    const outcome = await processTurnWork({
      turn: { id: "turn-processor", leaseOwner: "lease-processor" },
      messages: [{ id: "message-processor", role: "user", content: "hello" }],
    }, processorDeps);
    assert.equal(outcome.reply, "reply");
    assert.equal(calls.decisions, 1);
    assert.equal(calls.chat, 1);
    assert.deepEqual(calls.prompt.messageChunks, ["identity", "prompt_module", "conversation"]);
    assert.deepEqual(calls.prompt.messagePromptModuleIds, [null, "processor", null]);
    assert.match(calls.prompt.request.messages[1].content, /current thought/);
    assert.equal(calls.traces.length, 2);

    const failingCalls = { chat: 0, prompt: null };
    const failedModuleDeps = {
      ...processorDeps,
      callDecisions: async () => { throw new Error("private provider response"); },
      callChat: async () => {
        failingCalls.chat += 1;
        return chatResponse;
      },
      recordChatRequest: async (trace) => { failingCalls.prompt = trace; },
      executePromptModule: async () => { throw new Error("must not execute"); },
    };
    const degraded = await processTurnWork({
      turn: { id: "turn-module-failure", leaseOwner: "lease-processor" },
      messages: [{ id: "message-module-failure", role: "user", content: "hello" }],
    }, failedModuleDeps);
    assert.equal(degraded.reply, "reply");
    assert.equal(failingCalls.chat, 1);
    assert.deepEqual(failingCalls.prompt.messageChunks, ["identity", "conversation"]);
    assert.ok(!JSON.stringify(failingCalls.prompt.request).includes("private provider response"));
  });

  it("degrades a non-fencing module trace failure without leaking diagnostics or blocking baseline chat trace", async () => {
    const traces = [];
    const logs = [];
    let chatCalls = 0;
    const deps = {
      decisionModel: "decision-model",
      chatModel: "chat-model",
      leaseOwner: "lease-trace-failure",
      callDecisions: async () => { throw new Error("SQL password and provider body"); },
      callChat: async (request) => {
        chatCalls += 1;
        assert.equal(request.messages.some((message) => message.content.includes("thought")), false);
        return {
          id: "chat-trace-failure",
          model: "chat-build",
          choices: [{ message: { role: "assistant", content: "reply" }, finish_reason: "stop" }],
        };
      },
      loadPatterns: async () => [],
      loadIdentity: async () => ({ content: "IDENTITY", revision: 1 }),
      loadContext: async () => [],
      loadPromptModules: async () => [moduleDefinition("trace-failure")],
      executePromptModule: async () => ({ kind: "succeeded", content: "thought", durationMs: 1 }),
      recordPromptModuleDefinitions: async () => { throw new Error("SQL password and provider body"); },
      recordPromptModuleDecision: async () => {},
      recordPromptModuleExecution: async () => {},
      recordChatRequest: async (payload) => traces.push(payload),
      log: (message) => logs.push(message),
    };
    const result = await processTurnWork({
      turn: { id: "turn-trace-failure", leaseOwner: "lease-trace-failure" },
      messages: [{ id: "message-trace-failure", role: "user", content: "hello" }],
    }, deps);
    assert.equal(result.reply, "reply");
    assert.equal(chatCalls, 1);
    assert.equal(traces.length, 1);
    assert.deepEqual(traces[0].messageChunks, ["identity", "conversation"]);
    assert.ok(logs.some((line) => line.includes("trace_write_failed boundary=definitions")));
    assert.ok(!logs.some((line) => /password|provider body/.test(line)));
  });

  it("keeps lease-fencing trace failures fatal", async () => {
    let chatCalls = 0;
    await assert.rejects(
      processTurnWork({
        turn: { id: "turn-fenced-module", leaseOwner: "lease-fenced-module" },
        messages: [{ id: "message-fenced-module", role: "user", content: "hello" }],
      }, {
        decisionModel: "decision-model",
        chatModel: "chat-model",
        leaseOwner: "lease-fenced-module",
        callDecisions: async () => ({}),
        callChat: async () => {
          chatCalls += 1;
          return { choices: [{ message: { role: "assistant", content: "reply" } }] };
        },
        loadPatterns: async () => [],
        loadIdentity: async () => ({ content: "IDENTITY", revision: 1 }),
        loadContext: async () => [],
        loadPromptModules: async () => [moduleDefinition("fenced")],
        executePromptModule: async () => ({ kind: "succeeded", content: "thought", durationMs: 1 }),
        recordPromptModuleDefinitions: async () => { throw new TraceWriteFencedError("stale lease"); },
        recordPromptModuleDecision: async () => {},
        recordPromptModuleExecution: async () => {},
      }),
      TraceWriteFencedError,
    );
    assert.equal(chatCalls, 0);
  });

  it("omits ready module output if its chat-message attribution cannot be committed", async () => {
    const requestTraces = [];
    const logs = [];
    let chatRequest;
    const deps = {
      decisionModel: "decision-model",
      chatModel: "chat-model",
      leaseOwner: "lease-attribution",
      callDecisions: async (request) => responseFor(request, { attributed: PROMPT_MODULE_INCLUDE }),
      callChat: async (request) => {
        chatRequest = request;
        return {
          id: "chat-attribution",
          model: "chat-build",
          choices: [{ message: { role: "assistant", content: "reply" }, finish_reason: "stop" }],
        };
      },
      loadPatterns: async () => [],
      loadIdentity: async () => ({ content: "IDENTITY", revision: 1 }),
      loadContext: async () => [],
      loadPromptModules: async () => [moduleDefinition("attributed", { key: "attributed" })],
      executePromptModule: async () => ({ kind: "succeeded", content: "ready thought", durationMs: 1 }),
      recordPromptModuleDefinitions: async () => {},
      recordPromptModuleDecision: async () => {},
      recordPromptModuleExecution: async () => {},
      recordChatRequest: async (payload) => {
        requestTraces.push(payload);
        if (requestTraces.length === 1) {
          throw new PromptModuleTraceWriteError("chat_attribution");
        }
      },
      log: (message) => logs.push(message),
    };
    const result = await processTurnWork({
      turn: { id: "turn-attribution", leaseOwner: "lease-attribution" },
      messages: [{ id: "message-attribution", role: "user", content: "hello" }],
    }, deps);
    assert.equal(result.reply, "reply");
    assert.equal(requestTraces.length, 2);
    assert.deepEqual(requestTraces[0].messageChunks, ["identity", "prompt_module", "conversation"]);
    assert.deepEqual(requestTraces[0].messagePromptModuleIds, [null, "attributed", null]);
    assert.deepEqual(requestTraces[1].messageChunks, ["identity", "conversation"]);
    assert.deepEqual(requestTraces[1].messagePromptModuleIds, [null, null]);
    assert.deepEqual(chatRequest.messages.map((message) => message.role), ["system", "user"]);
    assert.ok(!JSON.stringify(chatRequest).includes("ready thought"));
    assert.ok(logs.some((line) => line.includes("trace_write_failed boundary=chat_attribution")));
  });

  it("records module-bearing transport and invalid-response outcomes through store alignment validation", async () => {
    for (const outcomeKind of ["failed", "invalid"]) {
      const sqlCalls = [];
      const pool = {
        connect: async () => ({
          query: async (query, values = []) => {
            const sql = String(query);
            sqlCalls.push({ sql, values });
            if (/^(BEGIN|COMMIT|ROLLBACK)/i.test(sql)) return { rows: [] };
            if (sql.includes("SELECT a.id AS attempt_id")) {
              return { rows: [{ attempt_id: "attempt-outcome" }] };
            }
            if (sql.includes("INSERT INTO trace_attempt_chat")) {
              return { rows: [{ id: "chat-outcome" }] };
            }
            if (sql.includes("SELECT position FROM trace_attempt_chat_message")) {
              return { rows: [{ position: 1 }] };
            }
            return { rows: [] };
          },
          release() {},
        }),
      };
      const store = createConversationStore(pool);
      const outcomePayloads = [];
      const turnId = `turn-module-${outcomeKind}`;
      const leaseOwner = `lease-module-${outcomeKind}`;
      await assert.rejects(
        processTurnWork({
          turn: { id: turnId, leaseOwner },
          messages: [{ id: `message-${outcomeKind}`, role: "user", content: "hello" }],
        }, {
          decisionModel: "decision-model",
          chatModel: "chat-model",
          leaseOwner,
          callDecisions: async (request) => responseFor(request, {
            outcome: PROMPT_MODULE_INCLUDE,
          }),
          callChat: async () => {
            if (outcomeKind === "failed") throw new Error("transport unavailable");
            return { invalid: "response" };
          },
          loadPatterns: async () => [],
          loadIdentity: async () => ({ content: "IDENTITY", revision: 1 }),
          loadContext: async () => [],
          loadPromptModules: async () => [moduleDefinition("outcome", { key: "outcome" })],
          executePromptModule: async () => ({ kind: "succeeded", content: "module thought", durationMs: 1 }),
          recordPromptModuleDefinitions: async () => {},
          recordPromptModuleDecision: async () => {},
          recordPromptModuleExecution: async () => {},
          recordChatRequest: async () => {},
          recordChatOutcome: async (payload) => {
            outcomePayloads.push(payload);
            const recorded = await store.recordChatOutcome({ turnId, leaseOwner, payload });
            assert.equal(recorded, true);
          },
          log: () => {},
        }),
        /transport unavailable|ChatContractError/i,
      );
      assert.equal(outcomePayloads.length, 1);
      assert.deepEqual(outcomePayloads[0].messageChunks, ["identity", "prompt_module", "conversation"]);
      assert.deepEqual(outcomePayloads[0].messagePromptModuleIds, [null, "outcome", null]);
      assert.ok(sqlCalls.some(({ sql }) => sql.includes("INSERT INTO trace_attempt_chat")));
    }
  });

  it("does not mask lease fencing from best-effort failed or invalid chat outcome traces", async () => {
    for (const outcomeKind of ["failed", "invalid"]) {
      await assert.rejects(
        processTurnWork({
          turn: { id: `turn-fenced-${outcomeKind}`, leaseOwner: `lease-fenced-${outcomeKind}` },
          messages: [{ id: `message-fenced-${outcomeKind}`, role: "user", content: "hello" }],
        }, {
          decisionModel: "decision-model",
          chatModel: "chat-model",
          leaseOwner: `lease-fenced-${outcomeKind}`,
          callDecisions: async () => ({}),
          callChat: async () => {
            if (outcomeKind === "failed") throw new Error("transport unavailable");
            return { invalid: "response" };
          },
          loadPatterns: async () => [],
          loadIdentity: async () => ({ content: "IDENTITY", revision: 1 }),
          loadContext: async () => [],
          recordChatRequest: async () => {},
          recordChatOutcome: async () => {
            throw new TraceWriteFencedError("lease lost during outcome trace");
          },
        }),
        TraceWriteFencedError,
      );
    }
  });

  it("keeps a responded chat-outcome trace failure mandatory", async () => {
    const traceFailure = new Error("mandatory chat outcome trace failed");
    await assert.rejects(
      processTurnWork({
        turn: { id: "turn-mandatory-chat-outcome", leaseOwner: "lease-mandatory-chat-outcome" },
        messages: [{ id: "message-mandatory-chat-outcome", role: "user", content: "hello" }],
      }, {
        decisionModel: "decision-model",
        chatModel: "chat-model",
        leaseOwner: "lease-mandatory-chat-outcome",
        callDecisions: async () => ({}),
        callChat: async () => ({
          id: "chat-response",
          model: "chat-build",
          choices: [{ message: { role: "assistant", content: "reply" }, finish_reason: "stop" }],
        }),
        loadPatterns: async () => [],
        loadIdentity: async () => ({ content: "IDENTITY", revision: 1 }),
        loadContext: async () => [],
        recordChatRequest: async () => {},
        recordChatOutcome: async () => { throw traceFailure; },
      }),
      (error) => error === traceFailure,
    );
  });

  it("parses only explicitly configured prompt-module credentials without echoing values", () => {
    const config = loadWorkerConfig({
      WORKER_DATABASE_URL: "postgres://db/worker",
      OPENROUTER_API_KEY: "openrouter-secret",
      WORKER_CHAT_MODEL: "chat",
      WORKER_DECISION_MODEL: "decision",
      WORKER_API_TOKEN: "api-secret",
      WORKER_PROMPT_MODULE_CREDENTIALS_JSON: JSON.stringify({ serviceToken: "module-secret" }),
    });
    assert.deepEqual(config.promptModuleCredentials, { serviceToken: "module-secret" });
    assert.throws(
      () => loadWorkerConfig({
        WORKER_DATABASE_URL: "postgres://db/worker",
        OPENROUTER_API_KEY: "openrouter-secret",
        WORKER_CHAT_MODEL: "chat",
        WORKER_DECISION_MODEL: "decision",
        WORKER_API_TOKEN: "api-secret",
        WORKER_PROMPT_MODULE_CREDENTIALS_JSON: "not-json",
      }),
      (error) => {
        assert.ok(error.message.includes("WORKER_PROMPT_MODULE_CREDENTIALS_JSON"));
        assert.ok(!error.message.includes("not-json"));
        return true;
      },
    );
  });
});
