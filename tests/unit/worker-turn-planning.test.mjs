// Deterministic unit tests for the worker's turn logic that is independent
// of the database and network: response-pattern decision building/selection,
// chat request assembly, and configuration parsing.
//
// Sources under apps/worker/src are imported directly (Node type stripping);
// no network calls and no database are involved.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  DECISION_QUESTION_ID,
  UnusableDecisionError,
  buildPatternChoiceRequest,
  recordFromSelection,
  selectResponsePattern,
} from "../../apps/worker/src/work/decision.ts";
import { buildChatRequest } from "../../apps/worker/src/work/chat.ts";
import {
  WorkerConfigError,
  loadWorkerConfig,
} from "../../apps/worker/src/config.ts";
import {
  heartbeatIntervalMs,
  MIN_LEASE_SECONDS,
} from "../../apps/worker/src/work/timing.ts";
import { runEngineOnce } from "../../apps/worker/src/work/engine.ts";
import { parseDecisionsExchange } from "../../libraries/openrouter/src/decisions.ts";

const patterns = [
  {
    id: "concise",
    selectionDescription: "Short factual replies fit here.",
    responseGuidance: "Answer in one short paragraph.",
    position: 0,
  },
  {
    id: "detailed",
    selectionDescription: "Longer structured explanations fit here.",
    responseGuidance: "Explain step by step.",
    position: 1,
  },
];

function message(seq, role, content) {
  return {
    id: `id-${String(seq)}`,
    seq,
    role,
    content,
    turnId: null,
    clientKey: null,
    createdAt: "2026-10-30T00:00:00.000Z",
  };
}

describe("pattern choice request building", () => {
  it("builds one choice question with one option per pattern", () => {
    const request = buildPatternChoiceRequest({
      model: "decision-model",
      patterns,
      state: { conversation: [] },
    });
    assert.equal(request.model, "decision-model");
    const questionIds = Object.keys(request.questions);
    assert.deepEqual(questionIds, [DECISION_QUESTION_ID]);
    const question = request.questions[DECISION_QUESTION_ID];
    assert.equal(question.type, "choice");
    assert.equal(typeof question.instructions, "string");
    assert.deepEqual(Object.keys(question.criteria), [
      "concise",
      "detailed",
    ]);
    assert.equal(question.criteria.concise, patterns[0].selectionDescription);
    assert.equal(question.criteria.detailed, patterns[1].selectionDescription);
  });

  it("keeps selection descriptions separate from response guidance", () => {
    const request = buildPatternChoiceRequest({
      model: "decision-model",
      patterns,
      state: { conversation: [] },
    });
    const serialized = JSON.stringify(request);
    // Guidance must not leak into the decision request.
    assert.ok(!serialized.includes("Answer in one short paragraph."));
    assert.ok(!serialized.includes("Explain step by step."));
  });

  it("refuses to build with no enabled patterns", () => {
    assert.throws(
      () =>
        buildPatternChoiceRequest({
          model: "decision-model",
          patterns: [],
          state: { conversation: [] },
        }),
      UnusableDecisionError,
    );
  });
});

describe("pattern id key safety", () => {
  // Ids that ordinary assignment would treat as prototype manipulation
  // instead of own keys, plus an inherited name and an ordinary id.
  const adversarialPatterns = [
    {
      id: "__proto__",
      selectionDescription: "Prototype-named pattern description.",
      responseGuidance: "Prototype-nattern guidance.",
      position: 0,
    },
    {
      id: "constructor",
      selectionDescription: "Constructor-named pattern description.",
      responseGuidance: "Constructor-named guidance.",
      position: 1,
    },
    {
      id: "concise",
      selectionDescription: "Short factual replies fit here.",
      responseGuidance: "Answer in one short paragraph.",
      position: 2,
    },
  ];

  it("keeps ids like __proto__ as own criteria keys", () => {
    const request = buildPatternChoiceRequest({
      model: "decision-model",
      patterns: adversarialPatterns,
      state: { conversation: [] },
    });
    const criteria = request.questions[DECISION_QUESTION_ID].criteria;
    for (const pattern of adversarialPatterns) {
      assert.ok(
        Object.hasOwn(criteria, pattern.id),
        `${pattern.id} must be an own criteria key`,
      );
      assert.equal(criteria[pattern.id], pattern.selectionDescription);
    }
    assert.deepEqual(Object.keys(criteria).sort(), [
      "__proto__",
      "concise",
      "constructor",
    ]);
    // The criteria must survive serialization to the wire format with every
    // id intact.
    const parsed = JSON.parse(JSON.stringify(request));
    const parsedCriteria = parsed.questions[DECISION_QUESTION_ID].criteria;
    for (const pattern of adversarialPatterns) {
      assert.ok(Object.hasOwn(parsedCriteria, pattern.id));
      assert.equal(parsedCriteria[pattern.id], pattern.selectionDescription);
    }
  });

  it("accepts a returned choice naming a __proto__-offered pattern", () => {
    const request = buildPatternChoiceRequest({
      model: "decision-model",
      patterns: adversarialPatterns,
      state: { conversation: [] },
    });
    const response = parseDecisionsExchange(request, {
      model: "decision-model-build",
      answers: {
        [DECISION_QUESTION_ID]: { type: "choice", choice: "__proto__" },
      },
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const selection = selectResponsePattern(response, adversarialPatterns);
    assert.equal(selection.patternId, "__proto__");
    const recorded = recordFromSelection(response, selection);
    assert.equal(recorded.choice, "__proto__");
  });
});

describe("pattern selection from a validated exchange", () => {
  const request = buildPatternChoiceRequest({
    model: "decision-model",
    patterns,
    state: { conversation: [] },
  });

  function exchange(answerBody) {
    const rawResponse = {
      model: "decision-model-build",
      answers: { [DECISION_QUESTION_ID]: answerBody },
      usage: { input_tokens: 1, output_tokens: 1 },
    };
    return parseDecisionsExchange(request, rawResponse);
  }

  it("selects the returned choice as the top choice", () => {
    const response = exchange({
      type: "choice",
      choice: "detailed",
      probabilities: { concise: 0.2, detailed: 0.8 },
      confidence: 0.9,
    });
    const selection = selectResponsePattern(response, patterns);
    assert.equal(selection.patternId, "detailed");
    assert.equal(selection.answer.choice, "detailed");
    const recorded = recordFromSelection(response, selection);
    assert.equal(recorded.model, "decision-model-build");
    assert.equal(recorded.choice, "detailed");
    assert.deepEqual(recorded.probabilities, { concise: 0.2, detailed: 0.8 });
    assert.equal(recorded.confidence, 0.9);
  });

  it("keeps optional diagnostics optional", () => {
    const response = exchange({ type: "choice", choice: "concise" });
    const recorded = recordFromSelection(
      response,
      selectResponsePattern(response, patterns),
    );
    assert.equal(recorded.probabilities, undefined);
    assert.equal(recorded.confidence, undefined);
  });

  it("rejects a choice that names no offered pattern — no silent fallback", () => {
    const response = exchange({ type: "choice", choice: "nonexistent" });
    assert.throws(
      () => selectResponsePattern(response, patterns),
      (error) => {
        assert.ok(error instanceof UnusableDecisionError);
        assert.ok(error.message.includes("nonexistent"));
        return true;
      },
    );
  });
});

describe("chat request assembly", () => {
  it("sends history then the turn's messages, oldest first", () => {
    const request = buildChatRequest({
      model: "chat-model",
      history: [message(1, "user", "earlier"), message(2, "assistant", "reply")],
      turnMessages: [message(3, "user", "new one"), message(4, "user", "and another")],
      guidance: null,
    });
    assert.equal(request.model, "chat-model");
    assert.deepEqual(
      request.messages.map((m) => `${m.role}:${m.content}`),
      [
        "user:earlier",
        "assistant:reply",
        "user:new one",
        "user:and another",
      ],
    );
  });

  it("puts the selected pattern's guidance in a leading system message", () => {
    const request = buildChatRequest({
      model: "chat-model",
      history: [],
      turnMessages: [message(1, "user", "hi")],
      guidance: "Answer in one short paragraph.",
    });
    assert.equal(request.messages.length, 2);
    assert.equal(request.messages[0].role, "system");
    assert.equal(request.messages[0].content, "Answer in one short paragraph.");
    assert.equal(request.messages[1].role, "user");
  });

  it("sends no system message when no pattern was selected", () => {
    const request = buildChatRequest({
      model: "chat-model",
      history: [],
      turnMessages: [message(1, "user", "hi")],
      guidance: null,
    });
    assert.deepEqual(
      request.messages.map((m) => m.role),
      ["user"],
    );
  });
});

describe("worker configuration", () => {
  const validEnv = {
    WORKER_DATABASE_URL: "postgres://localhost:1/companion_test",
    OPENROUTER_API_KEY: "test-key",
    WORKER_CHAT_MODEL: "chat-model",
    WORKER_DECISION_MODEL: "decision-model",
  };

  it("applies provisional defaults for numeric and URL settings", () => {
    const config = loadWorkerConfig(validEnv);
    assert.equal(config.leaseSeconds, 60);
    assert.equal(config.pollSeconds, 1);
    assert.equal(config.contextMessageLimit, 50);
    assert.equal(config.openrouter.chatTimeoutMs, 120000);
    assert.equal(config.openrouter.decisionTimeoutMs, 30000);
    assert.ok(config.openrouter.chatUrl.startsWith("https://"));
    assert.ok(config.openrouter.decisionsUrl.includes("decisions"));
  });

  it("reports the offending variable for missing required values", () => {
    assert.throws(
      () => loadWorkerConfig({ ...validEnv, WORKER_DATABASE_URL: undefined }),
      (error) => {
        assert.ok(error instanceof WorkerConfigError);
        assert.ok(error.message.includes("WORKER_DATABASE_URL"));
        return true;
      },
    );
    assert.throws(() => loadWorkerConfig({ ...validEnv, OPENROUTER_API_KEY: "" }));
    assert.throws(() => loadWorkerConfig({ ...validEnv, WORKER_CHAT_MODEL: "" }));
  });

  it("rejects malformed numbers and URLs", () => {
    assert.throws(
      () => loadWorkerConfig({ ...validEnv, WORKER_LEASE_SECONDS: "abc" }),
      WorkerConfigError,
    );
    assert.throws(
      () => loadWorkerConfig({ ...validEnv, WORKER_LEASE_SECONDS: "0" }),
      WorkerConfigError,
    );
    assert.throws(
      () => loadWorkerConfig({ ...validEnv, WORKER_CONTEXT_MESSAGE_LIMIT: "2.5" }),
      WorkerConfigError,
    );
    assert.throws(
      () => loadWorkerConfig({ ...validEnv, WORKER_OPENROUTER_CHAT_URL: "not a url" }),
      WorkerConfigError,
    );
    assert.throws(
      () =>
        loadWorkerConfig({ ...validEnv, WORKER_OPENROUTER_CHAT_URL: "ftp://x" }),
      WorkerConfigError,
    );
  });

  it("rejects leases too short for the engine heartbeat cadence", () => {
    for (const tooShort of ["0", "1", "2", "2.9", "-5"]) {
      assert.throws(
        () =>
          loadWorkerConfig({ ...validEnv, WORKER_LEASE_SECONDS: tooShort }),
        (error) => {
          assert.ok(error instanceof WorkerConfigError);
          assert.ok(error.message.includes("WORKER_LEASE_SECONDS"));
          // "0" and "-5" are rejected as non-positive; the positive-but-short
          // values are rejected by the heartbeat-alignment minimum.
          assert.ok(
            error.message.includes(`at least ${String(MIN_LEASE_SECONDS)}`) ||
              error.message.includes("must be positive"),
          );
          return true;
        },
        `expected rejection for WORKER_LEASE_SECONDS=${tooShort}`,
      );
    }
    // The minimum itself is accepted.
    const config = loadWorkerConfig({ ...validEnv, WORKER_LEASE_SECONDS: "3" });
    assert.equal(config.leaseSeconds, 3);
  });

  it("accepts explicit overrides", () => {
    const config = loadWorkerConfig({
      ...validEnv,
      WORKER_LEASE_SECONDS: "30",
      WORKER_POLL_SECONDS: "2",
      WORKER_CONTEXT_MESSAGE_LIMIT: "10",
    });
    assert.equal(config.leaseSeconds, 30);
    assert.equal(config.pollSeconds, 2);
    assert.equal(config.contextMessageLimit, 10);
  });
});

describe("lease/heartbeat timing alignment", () => {
  it("derives a heartbeat cadence that renews before lease expiry", () => {
    // Clamp boundary: at the minimum lease the cadence is exactly 1000ms.
    assert.equal(heartbeatIntervalMs(MIN_LEASE_SECONDS), 1000);
    assert.equal(heartbeatIntervalMs(60), 20000);
    // For every valid lease, at least two heartbeats fit before expiry, so a
    // missed renewal never immediately loses the lease.
    for (let leaseSeconds = MIN_LEASE_SECONDS; leaseSeconds <= 120; leaseSeconds += 1) {
      const heartbeat = heartbeatIntervalMs(leaseSeconds);
      assert.ok(
        2 * heartbeat < leaseSeconds * 1000,
        `heartbeat ${String(heartbeat)}ms must leave room for two renewals inside a ${String(leaseSeconds)}s lease`,
      );
    }
  });

  it("runEngineOnce refuses a lease too short for its heartbeat before claiming", async () => {
    let storeTouched = false;
    await assert.rejects(
      runEngineOnce({
        store: {
          claimNextTurn: async () => {
            storeTouched = true;
            return { kind: "idle" };
          },
        },
        processTurn: async () => {
          throw new Error("must not run");
        },
        leaseSeconds: MIN_LEASE_SECONDS - 1,
        pollSeconds: 1,
      }),
      /leaseSeconds must be at least 3/,
    );
    assert.equal(storeTouched, false, "no claim may be attempted with an unusable lease");
  });
});
