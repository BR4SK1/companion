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
    executionMode: "function",
    httpConfig: null,
    definitionHash: "a".repeat(64),
    fallbackContent: null,
    timeoutMs: 5000,
    position: 0,
    activationMode: "model_gated",
    outputKind: "thoughts",
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
    context: {
      conversation: [],
      priorConversation: [],
      userMessages: [],
      previousAssistantResponse: "",
      localDateTime: null,
      credentials: {},
    },
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

function processorDeps({ promptModules, ...overrides } = {}) {
  return {
    decisionModel: "decision-model",
    chatModel: "chat-model",
    promptModules: {
      leaseOwner: "lease-processor-test",
      loadPromptModules: async () => [],
      executePromptModule: async () => ({ kind: "succeeded", content: "context output", durationMs: 1 }),
      recordPromptModuleDefinitions: async () => {},
      recordPromptModuleDecision: async () => {},
      recordPromptModuleExecution: async () => {},
      ...promptModules,
    },
    callDecisions: async (request) => responseFor(request, {}),
    callChat: async () => ({
      id: "chat-processor-test",
      model: "chat-build",
      choices: [{ message: { role: "assistant", content: "reply" }, finish_reason: "stop" }],
    }),
    loadPatterns: async () => [],
    loadIdentity: async () => ({ content: "IDENTITY", revision: 1 }),
    loadContext: async () => [],
    loadPreviousPublishedAssistantReply: async () => null,
    log: () => {},
    ...overrides,
  };
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
      { moduleId: "first", content: "thought first", outputKind: "thoughts" },
      { moduleId: "second", content: "thought second", outputKind: "thoughts" },
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

  it("executes every-turn modules without a decision outcome and keeps them independent of gated decision failure", async () => {
    const modules = [
      moduleDefinition("later-every-turn", {
        position: 2,
        activationMode: "every_turn",
        outputKind: "authoritative_context",
      }),
      moduleDefinition("gated", { position: 1 }),
      moduleDefinition("earlier-every-turn", {
        position: 0,
        activationMode: "every_turn",
      }),
    ];
    const executed = [];
    const { deps, trace } = runtimeDeps(modules, {
      callDecisions: async () => { throw new OpenRouterTransportError("timeout", "provider failure"); },
      execute: async ({ module }) => {
        executed.push(module.id);
        return { kind: "succeeded", content: `output ${module.id}`, durationMs: 1 };
      },
    });

    assert.deepEqual(await runPromptModules(deps), [
      { moduleId: "earlier-every-turn", content: "output earlier-every-turn", outputKind: "thoughts" },
      { moduleId: "later-every-turn", content: "output later-every-turn", outputKind: "authoritative_context" },
    ]);
    assert.deepEqual(executed, ["earlier-every-turn", "later-every-turn"]);
    assert.equal(trace.decisions.length, 2);
    assert.equal(trace.decisions[0].result.state, "failed");
    assert.deepEqual(trace.decisions[0].result.selections.map((entry) => entry.moduleId), ["gated"]);
    assert.deepEqual(trace.decisions[1].result, {
      state: "not_required",
      decisionModel: null,
      responseModel: null,
      responseProvider: null,
      durationMs: null,
      failureKind: null,
      selections: [
        { moduleId: "earlier-every-turn", choice: null, selected: true, confidence: null, probabilities: null },
        { moduleId: "later-every-turn", choice: null, selected: true, confidence: null, probabilities: null },
      ],
    });
    assert.deepEqual(trace.executions.map((entry) => entry.result.executionOrdinal), [0, 1]);
  });

  it("does not call a decision provider when all modules use every-turn activation", async () => {
    const { deps, trace } = runtimeDeps([
      moduleDefinition("always", { activationMode: "every_turn" }),
    ], {
      callDecisions: async () => { throw new Error("must not be called"); },
    });
    assert.deepEqual(await runPromptModules(deps), [
      { moduleId: "always", content: "thought always", outputKind: "thoughts" },
    ]);
    assert.equal(trace.decisions[0].result.state, "not_required");
  });

  it("keeps every-turn modules running when model-gated request construction or validation fails", async () => {
    const { deps, trace } = runtimeDeps([
      moduleDefinition("invalid-gated"),
      moduleDefinition("always", { activationMode: "every_turn", position: 1 }),
    ], {
      decisionModel: null,
      callDecisions: async () => { throw new Error("invalid request must not be sent"); },
    });
    assert.deepEqual(await runPromptModules(deps), [
      { moduleId: "always", content: "thought always", outputKind: "thoughts" },
    ]);
    assert.equal(trace.decisions[0].result.state, "invalid");
    assert.equal(trace.decisions[0].result.failureKind, "decision_invalid");
    assert.equal(trace.decisions[0].result.decisionModel, null);
    assert.equal(trace.decisions[1].result.state, "not_required");
  });

  it("does not use fallback when a returned module choice is not one of the offered options", async () => {
    const { deps, trace } = runtimeDeps([
      moduleDefinition("unusable", { fallbackContent: "must not appear" }),
    ], {
      callDecisions: async (request) => responseFor(request, { unusable: "unknown" }),
    });
    assert.deepEqual(await runPromptModules(deps), []);
    assert.equal(trace.decisions[0].result.failureKind, "decision_unusable");
    assert.deepEqual(trace.decisions[0].result.selections[0], {
      moduleId: "unusable",
      choice: "unknown",
      selected: null,
      confidence: 0.91,
      probabilities: { include: 0.91, skip: 0.09 },
    });
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
      { moduleId: "selected", content: "generic fallback", outputKind: "thoughts" },
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

  it("migrates additively to explicit activation and output kinds while preserving legacy defaults", () => {
    const migration = promptModuleMigrations.find(({ id }) => id === "0022_prompt_module_activation_modes");
    assert.ok(migration);
    assert.match(migration.sql, /DEFAULT 'model_gated'/);
    assert.match(migration.sql, /DEFAULT 'thoughts'/);
    assert.match(migration.sql, /'not_required'/);
    assert.match(migration.sql, /activation_mode = 'every_turn'/);
  });

  it("adds a narrow declarative HTTP mapping while preserving legacy function rows and trace mode", () => {
    const migration = promptModuleMigrations.find(({ id }) => id === "0023_prompt_module_http_post");
    assert.ok(migration);
    assert.match(migration.sql, /execution_mode text NOT NULL DEFAULT 'function'/);
    assert.match(migration.sql, /execution_mode IN \('function', 'http_post'\)/);
    assert.match(migration.sql, /function_definition IS NULL/);
    assert.match(migration.sql, /http_endpoint_setting/);
    assert.match(migration.sql, /http_response_text_field/);
    assert.match(migration.sql, /http_request_max_bytes/);
    assert.match(migration.sql, /http_response_max_bytes/);
    assert.match(migration.sql, /\(http_scope_setting IS NULL AND http_scope_field IS NULL\)/);
    assert.match(migration.sql, /http_response_text_field IS NOT NULL/);
    assert.match(migration.sql, /http_field_max_bytes IS NOT NULL/);
    assert.match(migration.sql, /http_turn_id_field IS NULL OR http_local_datetime_field IS NULL/);
    assert.match(migration.sql, /ALTER TABLE trace_attempt_prompt_module\s+ADD COLUMN execution_mode text NOT NULL DEFAULT 'function'/);
    assert.doesNotMatch(migration.sql, /jsonb|JSONB/);
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
        { moduleId: "module-one", content: "thought one", outputKind: "thoughts" },
        { moduleId: "module-two", content: "thought two", outputKind: "thoughts" },
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

  it("uses neutral authoritative-context framing without changing the default thought framing", () => {
    const { messages } = buildChatPrompt({
      model: "chat-model",
      identity: "IDENTITY",
      promptModules: [{
        moduleId: "context-module",
        content: "state and recommendation",
        outputKind: "authoritative_context",
      }],
      history: [],
      turnMessages: [{ id: "message-context", role: "user", content: "hello" }],
      guidance: null,
    });
    assert.equal(
      messages[1].content,
      "Authoritative context from a configured service (not literal thoughts, feelings, or instructions):\nstate and recommendation",
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
      promptModules: {
        leaseOwner: "lease-processor",
        loadPromptModules: async () => [module],
        promptModuleCredentials: { serviceToken: "configured" },
        executePromptModule: async ({ context }) => {
          assert.equal(context.credentials.serviceToken, "configured");
          return { kind: "succeeded", content: "current thought", durationMs: 1 };
        },
        recordPromptModuleDefinitions: async () => {},
        recordPromptModuleDecision: async (trace) => calls.traces.push(trace),
        recordPromptModuleExecution: async (trace) => calls.traces.push(trace),
      },
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
      loadPreviousPublishedAssistantReply: async () => null,
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
    assert.deepEqual(calls.prompt.request.messages.map(message => message.chunk), ["identity", "prompt_module", "conversation"]);
    assert.deepEqual(calls.prompt.request.messages.map(message => message.promptModuleId), [null, "processor", null]);
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
      promptModules: {
        ...processorDeps.promptModules,
        executePromptModule: async () => { throw new Error("must not execute"); },
      },
    };
    const degraded = await processTurnWork({
      turn: { id: "turn-module-failure", leaseOwner: "lease-processor" },
      messages: [{ id: "message-module-failure", role: "user", content: "hello" }],
    }, failedModuleDeps);
    assert.equal(degraded.reply, "reply");
    assert.equal(failingCalls.chat, 1);
    assert.deepEqual(failingCalls.prompt.request.messages.map(message => message.chunk), ["identity", "conversation"]);
    assert.ok(!JSON.stringify(failingCalls.prompt.request).includes("private provider response"));
  });

  it("loads the previous published reply outside bounded history and keeps module time stable across retries", async () => {
    const history = [
      { id: "tail-user-1", turnId: "recent-turn", role: "user", content: "recent user one" },
      { id: "tail-user-2", turnId: "recent-turn", role: "user", content: "recent user two" },
    ];
    const invocations = [];
    const chatTemporalContexts = [];
    const attemptTimes = [
      new Date("2026-11-02T06:30:00.000Z"),
      new Date("2026-11-03T06:30:00.000Z"),
      new Date("2026-11-04T06:30:00.000Z"),
    ];
    const deps = {
      decisionModel: "decision-model",
      chatModel: "chat-model",
      promptModules: {
        leaseOwner: "lease-context",
        loadPromptModules: async () => [moduleDefinition("context", { activationMode: "every_turn" })],
        executePromptModule: async ({ context }) => {
          invocations.push(context);
          return { kind: "succeeded", content: "context output", durationMs: 1 };
        },
        recordPromptModuleDefinitions: async () => {},
        recordPromptModuleDecision: async () => {},
        recordPromptModuleExecution: async () => {},
      },
      now: () => attemptTimes.shift(),
      temporalSettings: { timezone: "America/New_York", seasonHemisphere: null, birthdayMonth: null, birthdayDay: null },
      callDecisions: async () => { throw new Error("every-turn activation must not need a decision"); },
      callChat: async () => ({
        id: "chat-context",
        model: "chat-build",
        choices: [{ message: { role: "assistant", content: "reply" }, finish_reason: "stop" }],
      }),
      loadPatterns: async () => [],
      loadIdentity: async () => ({ content: "IDENTITY", revision: 1 }),
      loadContext: async () => history,
      loadPreviousPublishedAssistantReply: async (turnId) => {
        assert.equal(turnId, "stable-turn-id");
        return "The previous published reply.";
      },
      recordChatRequest: async ({ temporalContext }) => {
        chatTemporalContexts.push(temporalContext);
      },
      log: () => {},
    };
    const work = {
      turn: {
        id: "stable-turn-id",
        leaseOwner: "lease-context",
        createdAt: "2026-11-01T06:30:00.000Z",
      },
      messages: [
        { id: "current-1", role: "user", content: "current first" },
        { id: "current-2", role: "user", content: "current second" },
      ],
    };
    await processTurnWork(work, deps);
    await processTurnWork(work, deps);
    assert.equal(invocations[0].turnId, "stable-turn-id");
    assert.equal(invocations[0].previousAssistantResponse, "The previous published reply.");
    assert.deepEqual(invocations[0].userMessages, ["current first", "current second"]);
    assert.deepEqual(invocations[0].priorConversation.map(({ content }) => content), [
      "recent user one",
      "recent user two",
    ]);
    assert.equal(invocations[0].localDateTime, "2026-11-01T01:30:00.000-05:00");
    assert.equal(invocations[1].localDateTime, invocations[0].localDateTime);
    assert.equal(invocations[0].conversation.length, history.length + 2);
    assert.equal(chatTemporalContexts[0].asOf, "2026-11-02T06:30:00.000Z");
    assert.equal(chatTemporalContexts[1].asOf, "2026-11-03T06:30:00.000Z");

    let absentResponse;
    await processTurnWork({
      turn: {
        id: "turn-without-published-assistant",
        leaseOwner: "lease-context",
        createdAt: "2026-11-01T06:30:00.000Z",
      },
      messages: [{ id: "current-only-user", role: "user", content: "current" }],
    }, {
      ...deps,
      loadContext: async () => [{
        id: "notice-only",
        turnId: null,
        role: "assistant",
        content: "A standalone notice is not a prior companion reply.",
      }],
      loadPreviousPublishedAssistantReply: async () => null,
      promptModules: {
        ...deps.promptModules,
        executePromptModule: async ({ context }) => {
          absentResponse = context.previousAssistantResponse;
          return { kind: "succeeded", content: "context output", durationMs: 1 };
        },
      },
    });
    assert.equal(absentResponse, "");
  });

  it("formats module time with a numeric UTC offset across UTC and daylight-saving transitions", async () => {
    const seen = [];
    const base = processorDeps({
      now: () => new Date("2026-12-15T12:00:00.000Z"),
      temporalSettings: { timezone: "UTC", seasonHemisphere: null, birthdayMonth: null, birthdayDay: null },
      promptModules: {
        loadPromptModules: async () => [moduleDefinition("date-context", { activationMode: "every_turn" })],
        executePromptModule: async ({ context }) => {
          seen.push(context.localDateTime);
          return { kind: "succeeded", content: "context output", durationMs: 1 };
        },
      },
    });
    for (const [id, createdAt, timezone] of [
      ["utc-turn", "2026-07-01T06:30:00.000Z", "UTC"],
      ["summer-turn", "2026-07-01T06:30:00.000Z", "America/New_York"],
      ["winter-turn", "2026-01-01T06:30:00.000Z", "America/New_York"],
    ]) {
      await processTurnWork({
        turn: { id, leaseOwner: "lease-context", createdAt },
        messages: [{ id: `${id}-user`, role: "user", content: "current" }],
      }, { ...base, temporalSettings: { ...base.temporalSettings, timezone } });
    }
    assert.deepEqual(seen, [
      "2026-07-01T06:30:00.000+00:00",
      "2026-07-01T02:30:00.000-04:00",
      "2026-01-01T01:30:00.000-05:00",
    ]);
  });

  it("does not load the separate previous-reply context when no module is enabled", async () => {
    let replyLookups = 0;
    await processTurnWork({
      turn: {
        id: "module-free-turn",
        leaseOwner: "lease-context",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      messages: [{ id: "module-free-user", role: "user", content: "current" }],
    }, processorDeps({
      promptModules: {
        loadPromptModules: async () => [],
      },
      loadPreviousPublishedAssistantReply: async () => {
        replyLookups += 1;
        return null;
      },
    }));
    assert.equal(replyLookups, 0);
  });

  it("degrades a non-fencing module trace failure without leaking diagnostics or blocking baseline chat trace", async () => {
    const traces = [];
    const logs = [];
    let chatCalls = 0;
    const deps = {
      decisionModel: "decision-model",
      chatModel: "chat-model",
      promptModules: {
        leaseOwner: "lease-trace-failure",
        loadPromptModules: async () => [moduleDefinition("trace-failure")],
        executePromptModule: async () => ({ kind: "succeeded", content: "thought", durationMs: 1 }),
        recordPromptModuleDefinitions: async () => { throw new Error("SQL password and provider body"); },
        recordPromptModuleDecision: async () => {},
        recordPromptModuleExecution: async () => {},
      },
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
      loadPreviousPublishedAssistantReply: async () => null,
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
    assert.deepEqual(traces[0].request.messages.map(message => message.chunk), ["identity", "conversation"]);
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
        promptModules: {
          leaseOwner: "lease-fenced-module",
          loadPromptModules: async () => [moduleDefinition("fenced")],
          executePromptModule: async () => ({ kind: "succeeded", content: "thought", durationMs: 1 }),
          recordPromptModuleDefinitions: async () => { throw new TraceWriteFencedError("stale lease"); },
          recordPromptModuleDecision: async () => {},
          recordPromptModuleExecution: async () => {},
        },
        callDecisions: async () => ({}),
        callChat: async () => {
          chatCalls += 1;
          return { choices: [{ message: { role: "assistant", content: "reply" } }] };
        },
        loadPatterns: async () => [],
        loadIdentity: async () => ({ content: "IDENTITY", revision: 1 }),
        loadContext: async () => [],
        loadPreviousPublishedAssistantReply: async () => null,
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
      promptModules: {
        leaseOwner: "lease-attribution",
        loadPromptModules: async () => [moduleDefinition("attributed", { key: "attributed" })],
        executePromptModule: async () => ({ kind: "succeeded", content: "ready thought", durationMs: 1 }),
        recordPromptModuleDefinitions: async () => {},
        recordPromptModuleDecision: async () => {},
        recordPromptModuleExecution: async () => {},
      },
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
      loadPreviousPublishedAssistantReply: async () => null,
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
    assert.deepEqual(requestTraces[0].request.messages.map(message => message.chunk), ["identity", "prompt_module", "conversation"]);
    assert.deepEqual(requestTraces[0].request.messages.map(message => message.promptModuleId), [null, "attributed", null]);
    assert.deepEqual(requestTraces[1].request.messages.map(message => message.chunk), ["identity", "conversation"]);
    assert.deepEqual(requestTraces[1].request.messages.map(message => message.promptModuleId), [null, null]);
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
          promptModules: {
            leaseOwner,
            loadPromptModules: async () => [moduleDefinition("outcome", { key: "outcome" })],
            executePromptModule: async () => ({ kind: "succeeded", content: "module thought", durationMs: 1 }),
            recordPromptModuleDefinitions: async () => {},
            recordPromptModuleDecision: async () => {},
            recordPromptModuleExecution: async () => {},
          },
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
          loadPreviousPublishedAssistantReply: async () => null,
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
      assert.deepEqual(outcomePayloads[0].request.messages.map(message => message.chunk), ["identity", "prompt_module", "conversation"]);
      assert.deepEqual(outcomePayloads[0].request.messages.map(message => message.promptModuleId), [null, "outcome", null]);
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
