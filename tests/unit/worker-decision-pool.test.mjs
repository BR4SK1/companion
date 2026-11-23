/**
 * Unit tests for decision model pool configuration, round-robin load
 * distribution, automatic failover on retryable transport errors, and single
 * backoff retry pass across both turn decisions and model-gated prompt modules.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { OpenRouterTransportError } from "../../libraries/openrouter/src/transport.ts";
import { loadWorkerConfig, WorkerConfigError } from "../../apps/worker/src/config.ts";
import {
  createDecisionModelPool,
  decisionErrorCategory,
  isRetryableDecisionTransportError,
} from "../../apps/worker/src/work/decision-pool.ts";
import { processTurnWork } from "../../apps/worker/src/work/processor.ts";
import { TraceWriteFencedError } from "../../apps/worker/src/conversation/store.ts";
import { runPromptModules } from "../../apps/worker/src/prompt-modules/runtime.ts";
import {
  PROMPT_MODULE_INCLUDE,
  promptModuleQuestionId,
} from "../../apps/worker/src/prompt-modules/decision.ts";

const VALID_ENV = {
  WORKER_DATABASE_URL: "postgres://localhost:1/companion_test",
  OPENROUTER_API_KEY: "test-key",
  WORKER_CHAT_MODEL: "chat-model",
  WORKER_DECISION_MODEL: "typesafe/jev-1.14",
  WORKER_API_TOKEN: "service-token",
};

const PATTERNS = [
  {
    id: "concise",
    name: "Concise",
    selectionDescription: "Brief reply",
    guidance: "Keep it brief.",
    position: 1,
    enabled: true,
    includeInitiativeContext: false,
  },
];

const IDENTITY = { content: "You are a helpful companion.", revision: 1 };

function sampleWork(turnId = "turn-1") {
  return {
    turn: {
      id: turnId,
      status: "in_flight",
      attempt: 1,
      createdAt: "2026-11-23T14:00:00.000Z",
    },
    messages: [
      {
        id: "msg-1",
        seq: 1,
        role: "user",
        content: "hello",
        turnId,
        createdAt: "2026-11-23T14:00:00.000Z",
        effectiveAt: "2026-11-23T14:00:00.000Z",
      },
    ],
  };
}

function decisionResponse(model, choice = "concise") {
  return {
    id: `dec-${model}`,
    model,
    provider: "TestProvider",
    answers: {
      response_pattern: {
        type: "choice",
        choice,
        confidence: 0.9,
        probabilities: { [choice]: 0.9 },
      },
    },
    usage: { input_tokens: 10, output_tokens: 0 },
  };
}

function chatResponse(text = "Hello!") {
  return {
    id: "chat-1",
    model: "chat-model",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: text },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
  };
}

describe("WORKER_DECISION_MODEL pool parsing", () => {
  it("parses single and comma-separated model lists with trimming", () => {
    const single = loadWorkerConfig(VALID_ENV);
    assert.equal(single.openrouter.decisionModel, "typesafe/jev-1.14");
    assert.deepEqual(single.openrouter.decisionModels, ["typesafe/jev-1.14"]);

    const multi = loadWorkerConfig({
      ...VALID_ENV,
      WORKER_DECISION_MODEL: " typesafe/jev-1.14 , cloudflare/clef-flash ",
    });
    assert.equal(multi.openrouter.decisionModel, "typesafe/jev-1.14");
    assert.deepEqual(multi.openrouter.decisionModels, [
      "typesafe/jev-1.14",
      "cloudflare/clef-flash",
    ]);
  });

  it("rejects empty entries and duplicates in WORKER_DECISION_MODEL", () => {
    for (const bad of [
      "",
      "   ",
      "typesafe/jev-1.14,",
      ",cloudflare/clef-flash",
      "typesafe/jev-1.14,,cloudflare/clef-flash",
      "typesafe/jev-1.14, typesafe/jev-1.14",
    ]) {
      assert.throws(
        () => loadWorkerConfig({ ...VALID_ENV, WORKER_DECISION_MODEL: bad }),
        (error) => {
          assert.ok(error instanceof WorkerConfigError);
          assert.ok(error.message.includes("WORKER_DECISION_MODEL"));
          return true;
        },
        `expected rejection for ${JSON.stringify(bad)}`,
      );
    }
  });
});

describe("decision model pool helpers", () => {
  it("rotates round-robin order on every call", () => {
    const pool = createDecisionModelPool(["m1", "m2", "m3"]);
    assert.deepEqual(pool.nextOrder(), ["m1", "m2", "m3"]);
    assert.deepEqual(pool.nextOrder(), ["m2", "m3", "m1"]);
    assert.deepEqual(pool.nextOrder(), ["m3", "m1", "m2"]);
    assert.deepEqual(pool.nextOrder(), ["m1", "m2", "m3"]);
  });

  it("classifies retryable vs non-retryable transport errors", () => {
    assert.equal(
      isRetryableDecisionTransportError(
        new OpenRouterTransportError("http_status", "429", { status: 429 }),
      ),
      true,
    );
    assert.equal(
      isRetryableDecisionTransportError(
        new OpenRouterTransportError("http_status", "408", { status: 408 }),
      ),
      true,
    );
    assert.equal(
      isRetryableDecisionTransportError(
        new OpenRouterTransportError("http_status", "503", { status: 503 }),
      ),
      true,
    );
    assert.equal(
      isRetryableDecisionTransportError(
        new OpenRouterTransportError("timeout", "timed out"),
      ),
      true,
    );
    assert.equal(
      isRetryableDecisionTransportError(
        new OpenRouterTransportError("network", "ECONNRESET"),
      ),
      true,
    );
    assert.equal(
      isRetryableDecisionTransportError(
        new OpenRouterTransportError("invalid_json", "not json"),
      ),
      true,
    );

    for (const status of [400, 401, 402, 403, 404, 422]) {
      assert.equal(
        isRetryableDecisionTransportError(
          new OpenRouterTransportError("http_status", String(status), { status }),
        ),
        false,
        `HTTP ${String(status)} should not be retryable`,
      );
    }
    assert.equal(isRetryableDecisionTransportError(new Error("boom")), false);
    assert.equal(
      decisionErrorCategory(
        new OpenRouterTransportError("http_status", "429", { status: 429 }),
      ),
      "http_429",
    );
  });
});

describe("processTurnWork decision pool routing and failover", () => {
  it("round-robins starting models across consecutive turns", async () => {
    const pool = createDecisionModelPool(
      ["typesafe/jev-1.14", "cloudflare/clef-flash"],
      { sleep: async () => {} },
    );
    const calledModels = [];

    for (const turnId of ["turn-1", "turn-2", "turn-3"]) {
      const outcome = await processTurnWork(sampleWork(turnId), {
        decisionModel: "typesafe/jev-1.14",
        decisionModelPool: pool,
        chatModel: "chat-model",
        callDecisions: async (req) => {
          calledModels.push(req.model);
          return decisionResponse(req.model);
        },
        callChat: async () => chatResponse(),
        loadPatterns: async () => PATTERNS,
        loadIdentity: async () => IDENTITY,
        loadContext: async () => [],
        loadPreviousPublishedAssistantReply: async () => null,
      });
      assert.equal(outcome.selectedPatternId, "concise");
    }

    assert.deepEqual(calledModels, [
      "typesafe/jev-1.14",
      "cloudflare/clef-flash",
      "typesafe/jev-1.14",
    ]);
  });

  it("immediately fails over on HTTP 429, records the winning model, and logs sanitized failover", async () => {
    const sleeps = [];
    const logs = [];
    const recordedRequests = [];
    const recordedOutcomes = [];
    const pool = createDecisionModelPool(
      ["typesafe/jev-1.14", "cloudflare/clef-flash"],
      {
        retryBackoffMs: 1500,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      },
    );

    const outcome = await processTurnWork(sampleWork("turn-failover"), {
      decisionModel: "typesafe/jev-1.14",
      decisionModelPool: pool,
      chatModel: "chat-model",
      log: (msg) => logs.push(msg),
      recordDecisionRequest: async ({ trace }) => {
        recordedRequests.push(trace.request.model);
      },
      recordDecisionOutcome: async (payload) => {
        recordedOutcomes.push(payload);
      },
      callDecisions: async (req) => {
        if (req.model === "typesafe/jev-1.14") {
          throw new OpenRouterTransportError("http_status", "HTTP 429", {
            status: 429,
            body: "SECRET_RAW_PROVIDER_BODY",
          });
        }
        return decisionResponse(req.model);
      },
      callChat: async () => chatResponse("Recovered!"),
      loadPatterns: async () => PATTERNS,
      loadIdentity: async () => IDENTITY,
      loadContext: async () => [],
      loadPreviousPublishedAssistantReply: async () => null,
    });

    assert.equal(outcome.reply, "Recovered!");
    assert.deepEqual(sleeps, []);
    assert.deepEqual(recordedRequests, [
      "typesafe/jev-1.14",
      "cloudflare/clef-flash",
    ]);
    assert.equal(recordedOutcomes.length, 1);
    assert.equal(recordedOutcomes[0].outcome.kind, "responded");
    assert.equal(recordedOutcomes[0].trace.request.model, "cloudflare/clef-flash");
    assert.equal(
      recordedOutcomes[0].outcome.trace.response.model,
      "cloudflare/clef-flash",
    );
    assert.ok(
      logs.some(
        (line) =>
          line.includes("[DECISION]") &&
          line.includes("typesafe/jev-1.14") &&
          line.includes("cloudflare/clef-flash") &&
          line.includes("http_429"),
      ),
    );
    assert.ok(logs.every((line) => !line.includes("SECRET_RAW_PROVIDER_BODY")));
  });

  it("performs one backoff pass when every model returns 429 on pass 1", async () => {
    const sleeps = [];
    const attempts = [];
    const pool = createDecisionModelPool(
      ["typesafe/jev-1.14", "cloudflare/clef-flash"],
      {
        retryPasses: 1,
        retryBackoffMs: 1200,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      },
    );

    const outcome = await processTurnWork(sampleWork("turn-backoff"), {
      decisionModel: "typesafe/jev-1.14",
      decisionModelPool: pool,
      chatModel: "chat-model",
      log: () => {},
      callDecisions: async (req) => {
        attempts.push(req.model);
        if (attempts.length <= 2) {
          throw new OpenRouterTransportError("http_status", "HTTP 429", {
            status: 429,
          });
        }
        return decisionResponse(req.model);
      },
      callChat: async () => chatResponse("Pass 2 worked"),
      loadPatterns: async () => PATTERNS,
      loadIdentity: async () => IDENTITY,
      loadContext: async () => [],
      loadPreviousPublishedAssistantReply: async () => null,
    });

    assert.equal(outcome.reply, "Pass 2 worked");
    assert.deepEqual(sleeps, [1200]);
    assert.deepEqual(attempts, [
      "typesafe/jev-1.14",
      "cloudflare/clef-flash",
      "typesafe/jev-1.14",
    ]);
  });

  it("records the final failure after exhausting both passes", async () => {
    const sleeps = [];
    const attempts = [];
    const recordedOutcomes = [];
    const pool = createDecisionModelPool(
      ["typesafe/jev-1.14", "cloudflare/clef-flash"],
      {
        retryPasses: 1,
        retryBackoffMs: 750,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      },
    );

    await assert.rejects(
      () =>
        processTurnWork(sampleWork("turn-exhausted"), {
          decisionModel: "typesafe/jev-1.14",
          decisionModelPool: pool,
          chatModel: "chat-model",
          log: () => {},
          recordDecisionOutcome: async (payload) => {
            recordedOutcomes.push(payload);
          },
          callDecisions: async (req) => {
            attempts.push(req.model);
            throw new OpenRouterTransportError("http_status", `429 from ${req.model}`, {
              status: 429,
            });
          },
          callChat: async () => chatResponse(),
          loadPatterns: async () => PATTERNS,
          loadIdentity: async () => IDENTITY,
          loadContext: async () => [],
          loadPreviousPublishedAssistantReply: async () => null,
        }),
      /429 from cloudflare\/clef-flash/,
    );

    assert.deepEqual(sleeps, [750]);
    assert.deepEqual(attempts, [
      "typesafe/jev-1.14",
      "cloudflare/clef-flash",
      "typesafe/jev-1.14",
      "cloudflare/clef-flash",
    ]);
    assert.equal(recordedOutcomes.length, 1);
    assert.equal(recordedOutcomes[0].outcome.kind, "failed");
    assert.equal(recordedOutcomes[0].trace.request.model, "cloudflare/clef-flash");
  });

  it("does not fail over on non-retryable 401 or contract validation errors", async () => {
    const attempts = [];
    const pool = createDecisionModelPool(
      ["typesafe/jev-1.14", "cloudflare/clef-flash"],
      { sleep: async () => {} },
    );

    await assert.rejects(
      () =>
        processTurnWork(sampleWork("turn-401"), {
          decisionModel: "typesafe/jev-1.14",
          decisionModelPool: pool,
          chatModel: "chat-model",
          log: () => {},
          callDecisions: async (req) => {
            attempts.push(req.model);
            throw new OpenRouterTransportError("http_status", "HTTP 401", {
              status: 401,
            });
          },
          callChat: async () => chatResponse(),
          loadPatterns: async () => PATTERNS,
          loadIdentity: async () => IDENTITY,
          loadContext: async () => [],
          loadPreviousPublishedAssistantReply: async () => null,
        }),
      /HTTP 401/,
    );
    assert.deepEqual(attempts, ["typesafe/jev-1.14"]);
  });

  it("propagates TraceWriteFencedError from recordDecisionRequest without failing over", async () => {
    const attempts = [];
    const pool = createDecisionModelPool(
      ["typesafe/jev-1.14", "cloudflare/clef-flash"],
      { sleep: async () => {} },
    );

    await assert.rejects(
      () =>
        processTurnWork(sampleWork("turn-fenced"), {
          decisionModel: "typesafe/jev-1.14",
          decisionModelPool: pool,
          chatModel: "chat-model",
          recordDecisionRequest: async () => {
            throw new TraceWriteFencedError("lost lease");
          },
          callDecisions: async (req) => {
            attempts.push(req.model);
            return decisionResponse(req.model);
          },
          callChat: async () => chatResponse(),
          loadPatterns: async () => PATTERNS,
          loadIdentity: async () => IDENTITY,
          loadContext: async () => [],
          loadPreviousPublishedAssistantReply: async () => null,
        }),
      TraceWriteFencedError,
    );
    assert.deepEqual(attempts, []);
  });
});

describe("runPromptModules decision pool failover", () => {
  it("fails over model-gated prompt module decisions and records the winning model", async () => {
    const pool = createDecisionModelPool(
      ["typesafe/jev-1.14", "cloudflare/clef-flash"],
      { sleep: async () => {} },
    );
    const calledModels = [];
    const recordedDecisions = [];

    const outputs = await runPromptModules({
      turnId: "turn-pm-1",
      leaseOwner: "worker:1",
      decisionModel: "typesafe/jev-1.14",
      decisionModelPool: pool,
      state: { conversation: [{ role: "user", content: "hello" }] },
      modules: [
        {
          id: "mod-1",
          key: "test_mod",
          decisionDescription: "Use when greeted",
          definitionHash: "hash-1",
          executionMode: "function",
          functionDefinition: "() => 'extra'",
          httpConfig: null,
          fallbackContent: null,
          timeoutMs: 1000,
          position: 1,
          activationMode: "model_gated",
          outputKind: "context",
        },
      ],
      context: {
        credentials: {},
        conversation: [{ role: "user", content: "hello" }],
        priorConversation: [],
        userMessages: ["hello"],
        previousAssistantResponse: null,
        localDateTime: null,
        engagementState: null,
        publishedRoutineMessageKey: null,
        patternId: "concise",
      },
      callDecisions: async (req) => {
        calledModels.push(req.model);
        if (req.model === "typesafe/jev-1.14") {
          throw new OpenRouterTransportError("http_status", "HTTP 429", {
            status: 429,
          });
        }
        return {
          id: "dec-pm",
          model: req.model,
          provider: "DeepInfra",
          answers: {
            [promptModuleQuestionId("mod-1")]: {
              type: "choice",
              choice: PROMPT_MODULE_INCLUDE,
              confidence: 0.85,
              probabilities: { [PROMPT_MODULE_INCLUDE]: 0.85 },
            },
          },
          usage: { input_tokens: 10, output_tokens: 0 },
        };
      },
      execute: async () => ({
        kind: "succeeded",
        content: "module output",
        durationMs: 5,
      }),
      recordDefinitions: async () => {},
      recordDecision: async (input) => {
        recordedDecisions.push(input.result);
      },
      recordExecution: async () => {},
      log: () => {},
    });

    assert.deepEqual(calledModels, [
      "typesafe/jev-1.14",
      "cloudflare/clef-flash",
    ]);
    assert.equal(outputs.length, 1);
    assert.equal(outputs[0].content, "module output");
    assert.equal(recordedDecisions.length, 1);
    assert.equal(recordedDecisions[0].state, "responded");
    assert.equal(recordedDecisions[0].decisionModel, "cloudflare/clef-flash");
    assert.equal(recordedDecisions[0].responseModel, "cloudflare/clef-flash");
  });
});
