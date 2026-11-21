import { createServer } from "node:http";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createPromptModuleStore } from "../../apps/worker/src/prompt-modules/store.ts";
import { executePromptModule } from "../../apps/worker/src/prompt-modules/executor.ts";
import { processTurnWork } from "../../apps/worker/src/work/processor.ts";

const config = {
  endpointSetting: "moduleEndpoint",
  scopeSetting: "moduleScope",
  scopeField: "scope",
  turnIdField: "turn",
  localDateTimeField: "localTime",
  previousAssistantResponseField: "previousReply",
  userMessageField: "currentInput",
  priorConversationField: "history",
  responseTextField: "answerText",
  fieldMaxBytes: 8192,
  priorMessageLimit: 2,
  requestMaxBytes: 81920,
  responseMaxBytes: 65536,
};

function httpRow(overrides = {}) {
  return {
    id: "00000000-0000-4000-8000-000000000101",
    module_key: "generic_http_module",
    decision_description: "Generic integration-test criterion.",
    function_definition: null,
    execution_mode: "http_post",
    http_endpoint_setting: config.endpointSetting,
    http_scope_setting: config.scopeSetting,
    http_scope_field: config.scopeField,
    http_turn_id_field: config.turnIdField,
    http_local_datetime_field: config.localDateTimeField,
    http_previous_assistant_field: config.previousAssistantResponseField,
    http_user_message_field: config.userMessageField,
    http_prior_conversation_field: config.priorConversationField,
    http_response_text_field: config.responseTextField,
    http_field_max_bytes: config.fieldMaxBytes,
    http_prior_message_limit: config.priorMessageLimit,
    http_request_max_bytes: config.requestMaxBytes,
    http_response_max_bytes: config.responseMaxBytes,
    fallback_content: "Configured generic fallback.",
    enabled: true,
    timeout_ms: 5000,
    position: 0,
    activation_mode: "every_turn",
    output_kind: "authoritative_context",
    ...overrides,
  };
}

function testPool(rows) {
  const statements = [];
  const respond = async (sql, values = []) => {
    const text = String(sql);
    statements.push({ sql: text, values });
    if (text.includes("FROM prompt_module") && text.includes("WHERE enabled = true")) {
      return { rows };
    }
    if (text.includes("SELECT a.id AS attempt_id")) {
      return { rows: [{ attempt_id: "00000000-0000-4000-8000-000000000201" }] };
    }
    if (text.includes("UPDATE trace_attempt_prompt_module") && text.includes("RETURNING module_id")) {
      return { rows: [{ module_id: values[1] }] };
    }
    return { rows: [] };
  };
  return {
    statements,
    query: respond,
    connect: async () => ({ query: respond, release() {} }),
  };
}

async function listen(handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    server,
    endpoint: `http://127.0.0.1:${address.port}/module`,
    close: () => new Promise((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()),
    ),
  };
}

async function requestJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function httpContext(endpoint, overrides = {}) {
  return {
    turnId: "stable-turn-key",
    conversation: [],
    priorConversation: [
      { role: "assistant", content: "older reply" },
      { role: "user", content: "older input" },
      { role: "assistant", content: "newest prior reply" },
    ],
    userMessages: ["current first", "current second"],
    previousAssistantResponse: "",
    localDateTime: "2026-04-05T06:07:08.000+00:00",
    credentials: {
      [config.endpointSetting]: endpoint,
      [config.scopeSetting]: "synthetic-opaque-scope",
      unrelatedSetting: "must-not-be-forwarded",
    },
    ...overrides,
  };
}

describe("declarative HTTP prompt modules", () => {
  it("loads a typed definition, maps only approved inputs, and records successful execution through the worker path", async () => {
    let received;
    const mock = await listen(async (request, response) => {
      received = {
        method: request.method,
        path: request.url,
        contentType: request.headers["content-type"],
        authorization: request.headers.authorization,
        body: await requestJson(request),
      };
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ answerText: "Synthetic authoritative result." }));
    });
    const pool = testPool([httpRow()]);
    const store = createPromptModuleStore(pool);
    const traces = { definitions: [], decisions: [], executions: [] };
    const chatTraces = [];
    const logs = [];
    try {
      const deps = {
        decisionModel: "unused-for-every-turn",
        chatModel: "synthetic-chat-model",
        leaseOwner: "synthetic-lease",
        temporalSettings: { timezone: "UTC", seasonHemisphere: null, birthdayMonth: null, birthdayDay: null },
        promptModuleCredentials: httpContext(mock.endpoint).credentials,
        callDecisions: async () => { throw new Error("every-turn module must not call a provider"); },
        callChat: async () => ({
          id: "synthetic-chat-id",
          model: "synthetic-chat-build",
          choices: [{ message: { role: "assistant", content: "ordinary chat reply" }, finish_reason: "stop" }],
        }),
        loadPatterns: async () => [],
        loadIdentity: async () => ({ content: "Synthetic identity.", revision: 1 }),
        loadContext: async () => [
          { id: "old-assistant", turnId: "older-turn-1", role: "assistant", content: "older reply" },
          { id: "old-user", turnId: "older-turn-2", role: "user", content: "older input" },
          { id: "newest-assistant", turnId: "older-turn-3", role: "assistant", content: "newest prior reply" },
        ],
        loadPreviousPublishedAssistantReply: async () => "",
        loadPromptModules: () => store.loadEnabled(),
        executePromptModule,
        recordPromptModuleDefinitions: async (input) => {
          traces.definitions.push(input.modules.map(({ executionMode, definitionHash }) => ({ executionMode, definitionHash })));
          assert.equal(await store.recordDefinitions(input), true);
        },
        recordPromptModuleDecision: async (input) => {
          traces.decisions.push(input.result);
          assert.equal(await store.recordDecision(input), true);
        },
        recordPromptModuleExecution: async (input) => {
          traces.executions.push(input.result);
          assert.equal(await store.recordExecution(input), true);
        },
        recordChatRequest: async (trace) => chatTraces.push(trace),
        log: (message) => logs.push(message),
      };
      const outcome = await processTurnWork({
        turn: {
          id: "stable-turn-key",
          leaseOwner: "synthetic-lease",
          createdAt: "2026-04-05T06:07:08.000Z",
        },
        messages: [
          { id: "current-user-1", role: "user", content: "current first" },
          { id: "current-user-2", role: "user", content: "current second" },
        ],
      }, deps);

      assert.equal(outcome.reply, "ordinary chat reply");
      assert.deepEqual(received, {
        method: "POST",
        path: "/module",
        contentType: "application/json",
        authorization: undefined,
        body: {
          scope: "synthetic-opaque-scope",
          turn: "stable-turn-key",
          localTime: "2026-04-05T06:07:08.000+00:00",
          previousReply: "",
          currentInput: "current first\ncurrent second",
          history: [
            { role: "user", content: "older input" },
            { role: "assistant", content: "newest prior reply" },
          ],
        },
      });
      assert.equal(traces.definitions[0][0].executionMode, "http_post");
      assert.match(traces.definitions[0][0].definitionHash, /^[0-9a-f]{64}$/);
      assert.equal(traces.decisions[0].state, "not_required");
      assert.equal(traces.executions[0].state, "succeeded");
      assert.equal(traces.executions[0].outputReady, true);
      assert.deepEqual(chatTraces[0].messagePromptModuleIds, [
        null,
        null,
        "00000000-0000-4000-8000-000000000101",
        null,
        null,
        null,
        null,
        null,
      ]);
      assert.ok(chatTraces[0].request.messages.some((message) => message.content.includes("Synthetic authoritative result.")));

      const definitionWrite = pool.statements.find(({ sql }) => sql.includes("INSERT INTO trace_attempt_prompt_module"));
      assert.ok(definitionWrite);
      assert.equal(definitionWrite.values[9], "http_post");
      assert.equal(JSON.stringify(definitionWrite.values).includes(mock.endpoint), false);
      assert.equal(JSON.stringify(definitionWrite.values).includes("synthetic-opaque-scope"), false);
      assert.equal(JSON.stringify(traces).includes("Synthetic authoritative result."), false);
      assert.equal(logs.join("\n").includes(mock.endpoint), false);
      assert.equal(logs.join("\n").includes("synthetic-opaque-scope"), false);
      assert.equal(received.body.unrelatedSetting, undefined);
    } finally {
      await mock.close();
    }
  });

  it("sends only mapped fields and accepts null or absent context for unmapped inputs", async () => {
    let received;
    const mock = await listen(async (request, response) => {
      received = await requestJson(request);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ answerText: "Minimal mapping result." }));
    });
    const row = httpRow({
      http_scope_setting: null,
      http_scope_field: null,
      http_turn_id_field: "turn",
      http_local_datetime_field: null,
      http_previous_assistant_field: null,
      http_user_message_field: null,
      http_prior_conversation_field: null,
    });
    const module = (await createPromptModuleStore(testPool([row])).loadEnabled())[0];
    try {
      const result = await executePromptModule({
        module,
        context: {
          turnId: "minimal-turn",
          conversation: [],
          priorConversation: null,
          userMessages: null,
          previousAssistantResponse: null,
          localDateTime: null,
          credentials: { [config.endpointSetting]: mock.endpoint },
        },
      });
      assert.deepEqual(received, { turn: "minimal-turn" });
      assert.deepEqual(module.httpConfig, {
        ...config,
        scopeSetting: null,
        scopeField: null,
        turnIdField: "turn",
        localDateTimeField: null,
        previousAssistantResponseField: null,
        userMessageField: null,
        priorConversationField: null,
      });
      assert.equal(result.kind, "succeeded");
      assert.equal(result.content, "Minimal mapping result.");
    } finally {
      await mock.close();
    }
  });

  it("rejects duplicate destination names within the configured subset", async () => {
    let requests = 0;
    const mock = await listen((_request, response) => {
      requests += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ answerText: "unexpected" }));
    });
    const row = httpRow({
      http_scope_setting: null,
      http_scope_field: null,
      http_turn_id_field: "shared",
      http_local_datetime_field: null,
      http_previous_assistant_field: "shared",
      http_user_message_field: null,
      http_prior_conversation_field: null,
    });
    const module = (await createPromptModuleStore(testPool([row])).loadEnabled())[0];
    try {
      const result = await executePromptModule({
        module,
        context: httpContext(mock.endpoint),
      });
      assert.equal(result.kind, "failed");
      assert.equal(requests, 0);
    } finally {
      await mock.close();
    }
  });

  it("fails softly on HTTP errors and uses the configured fallback while another module still runs", async () => {
    const mock = await listen((_request, response) => {
      response.writeHead(503, { "content-type": "application/json" });
      response.end(JSON.stringify({ secretDetail: "must not be logged" }));
    });
    const functionRow = {
      ...httpRow({
        id: "00000000-0000-4000-8000-000000000102",
        module_key: "generic_function_module",
        function_definition: '(context: PromptModuleContext): string => "second module output"',
        execution_mode: "function",
        activation_mode: "every_turn",
        position: 1,
      }),
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
    };
    const pool = testPool([httpRow(), functionRow]);
    const store = createPromptModuleStore(pool);
    const traces = [];
    const logs = [];
    let chatRequest;
    try {
      const outcome = await processTurnWork({
        turn: {
          id: "fallback-turn",
          leaseOwner: "lease-fallback",
          createdAt: "2026-04-05T06:07:08.000Z",
        },
        messages: [{ id: "fallback-user", role: "user", content: "input" }],
      }, {
        decisionModel: "unused-model",
        chatModel: "test-chat-model",
        leaseOwner: "lease-fallback",
        temporalSettings: { timezone: "UTC", seasonHemisphere: null, birthdayMonth: null, birthdayDay: null },
        promptModuleCredentials: httpContext(mock.endpoint).credentials,
        callDecisions: async () => { throw new Error("must not call"); },
        callChat: async () => ({
          id: "synthetic-chat-id-fallback",
          model: "synthetic-chat-build",
          choices: [{ message: { role: "assistant", content: "reply" }, finish_reason: "stop" }],
        }),
        loadPatterns: async () => [],
        loadIdentity: async () => ({ content: "identity", revision: 1 }),
        loadContext: async () => [],
        loadPreviousPublishedAssistantReply: async () => null,
        loadPromptModules: () => store.loadEnabled(),
        executePromptModule,
        recordPromptModuleDefinitions: (input) => store.recordDefinitions(input),
        recordPromptModuleDecision: (input) => store.recordDecision(input),
        recordPromptModuleExecution: async (input) => {
          traces.push(input.result);
          assert.equal(await store.recordExecution(input), true);
        },
        recordChatRequest: async ({ request, messagePromptModuleIds }) => {
          chatRequest = { request, messagePromptModuleIds };
        },
        log: (message) => logs.push(message),
      });
      assert.equal(outcome.reply, "reply");
      assert.deepEqual(traces.map(({ state }) => state), ["failed", "succeeded"]);
      assert.deepEqual(chatRequest.messagePromptModuleIds, [
        null,
        null,
        "00000000-0000-4000-8000-000000000101",
        "00000000-0000-4000-8000-000000000102",
        null,
      ]);
      assert.ok(chatRequest.request.messages.some((message) => message.content.includes("Configured generic fallback.")));
      assert.ok(chatRequest.request.messages.some((message) => message.content.includes("second module output")));
      assert.equal(logs.join("\n").includes("must not be logged"), false);
    } finally {
      await mock.close();
    }
  });

  it("rejects redirects without following them and times out while reading a streamed response", async () => {
    let targetRequests = 0;
    const redirect = await listen((_request, response) => {
      response.writeHead(302, { location: "/target" });
      response.end();
    });
    const redirectTarget = new URL(redirect.endpoint);
    redirectTarget.pathname = "/target";
    const redirectServer = redirect.server;
    redirectServer.removeAllListeners("request");
    redirectServer.on("request", (request, response) => {
      if (request.url === "/target") {
        targetRequests += 1;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ answerText: "not followed" }));
      } else {
        response.writeHead(302, { location: "/target" });
        response.end();
      }
    });
    const redirectPool = testPool([httpRow()]);
    const redirectDefinition = (await createPromptModuleStore(redirectPool).loadEnabled())[0];
    try {
      const redirectResult = await executePromptModule({
        module: redirectDefinition,
        context: httpContext(redirect.endpoint),
      });
      assert.equal(redirectResult.kind, "failed");
      assert.equal(targetRequests, 0);
    } finally {
      await redirect.close();
    }

    const stalled = await listen((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.write('{"answerText":"partial');
    });
    const stalledDefinition = {
      ...(await createPromptModuleStore(testPool([httpRow({ timeout_ms: 150 })])).loadEnabled())[0],
      timeoutMs: 150,
    };
    try {
      const timeoutResult = await executePromptModule({
        module: stalledDefinition,
        context: httpContext(stalled.endpoint),
      });
      assert.equal(timeoutResult.kind, "timed_out");
    } finally {
      stalled.server.closeAllConnections();
      await stalled.close();
    }
  });

  it("rejects relative, non-HTTP, embedded-credential, and whitespace-padded endpoints", async () => {
    let requests = 0;
    const mock = await listen((_request, response) => {
      requests += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ answerText: "unexpected" }));
    });
    const module = (await createPromptModuleStore(testPool([httpRow()])).loadEnabled())[0];
    try {
      const endpoint = new URL(mock.endpoint);
      const invalidEndpoints = [
        "/relative",
        "ftp://127.0.0.1/module",
        `http://user:secret@127.0.0.1:${endpoint.port}/module`,
        `${mock.endpoint} `,
      ];
      for (const value of invalidEndpoints) {
        const result = await executePromptModule({
          module,
          context: httpContext(value),
        });
        assert.equal(result.kind, "failed");
      }
      assert.equal(requests, 0);
    } finally {
      await mock.close();
    }
  });

  it("rejects non-JSON, malformed, empty, and over-budget response values", async () => {
    const responses = new Map([
      ["/wrong-type", { contentType: "text/plain", body: '{"answerText":"no"}' }],
      ["/malformed", { contentType: "application/json", body: "{" }],
      ["/empty", { contentType: "application/json", body: JSON.stringify({ answerText: "  " }) }],
      ["/oversized", { contentType: "application/json", body: JSON.stringify({ answerText: "x".repeat(200) }) }],
    ]);
    const mock = await listen(async (request, response) => {
      const result = responses.get(request.url);
      response.writeHead(200, { "content-type": result.contentType });
      response.end(result.body);
    });
    const module = (await createPromptModuleStore(testPool([httpRow({
      http_response_max_bytes: 128,
    })])).loadEnabled())[0];
    try {
      for (const path of responses.keys()) {
        const endpoint = new URL(mock.endpoint);
        endpoint.pathname = path;
        const result = await executePromptModule({
          module,
          context: httpContext(endpoint.toString()),
        });
        assert.equal(result.kind, "invalid_result", path);
      }
    } finally {
      await mock.close();
    }
  });

  it("omits oversized optional history but rejects oversized required mapped fields", async () => {
    let body;
    const mock = await listen(async (request, response) => {
      body = await requestJson(request);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ answerText: "accepted" }));
    });
    const module = (await createPromptModuleStore(testPool([httpRow({
      http_field_max_bytes: 32,
      http_prior_message_limit: 3,
      http_request_max_bytes: 256,
    })])).loadEnabled())[0];
    try {
      const baseContext = httpContext(mock.endpoint, {
        turnId: "turn",
        localDateTime: "2026-04-05T06:07:08+00:00",
        previousAssistantResponse: "",
        userMessages: ["small"],
        priorConversation: [
          { role: "user", content: "x".repeat(40) },
          { role: "assistant", content: "small old" },
          { role: "user", content: "small recent" },
        ],
      });
      const result = await executePromptModule({ module, context: baseContext });
      assert.equal(result.kind, "succeeded");
      assert.deepEqual(body.history, [
        { role: "assistant", content: "small old" },
        { role: "user", content: "small recent" },
      ]);
      const invalidRequired = await executePromptModule({
        module,
        context: httpContext(mock.endpoint, {
          turnId: "turn",
          localDateTime: "2026-04-05T06:07:08+00:00",
          previousAssistantResponse: "x".repeat(33),
          userMessages: ["small"],
        }),
      });
      assert.equal(invalidRequired.kind, "invalid_result");
    } finally {
      await mock.close();
    }
  });
});
