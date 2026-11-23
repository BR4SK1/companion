// Deterministic unit tests for the structured, privacy-safe main-chat
// diagnostics ([CHAT_DIAGNOSTIC] lines emitted by the turn processor, built
// by apps/worker/src/work/chat-diagnostics.ts).
//
// No network and no database: the processor is transport-injected and the
// raw provider bodies are inline fakes. The malformed-response cases mirror
// the production incident (HTTP-success valid JSON whose
// choices.0.message.content is not a string): the turn must still fail with
// the strict contract error, publish nothing, and emit one diagnostic line
// that preserves the individually-valid finish reason and usage counts
// while leaking no prompt, reply, provider message text, or error text.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { processTurnWork } from "../../apps/worker/src/work/processor.ts";
import { ChatContractError } from "../../libraries/openrouter/src/chat.ts";
import { OpenRouterTransportError } from "../../libraries/openrouter/src/transport.ts";
import {
  buildChatDiagnostics,
  formatChatDiagnostics,
} from "../../apps/worker/src/work/chat-diagnostics.ts";

const PREFIX = "[CHAT_DIAGNOSTIC] ";

function message(seq, role, content) {
  return {
    id: `id-${String(seq)}`,
    seq,
    role,
    content,
    turnId: null,
    clientKey: null,
    createdAt: "2026-10-30T00:00:00.000Z",
    clientSentAt: null,
    effectiveAt: "2026-10-30T00:00:00.000Z",
    timeSource: "server",
    clientTimeStatus: "absent",
    serverReceivedAt: "2026-10-30T00:00:00.000Z",
  };
}

const USER_TEXT = "USER_SENTINEL_PROMPT_TEXT";

const work = {
  turn: {
    id: "turn-diag-1",
    status: "in_flight",
    attempt: 2,
    leaseOwner: "owner",
    leaseExpiresAt: new Date().toISOString(),
    selectedPatternId: null,
    decision: null,
    error: null,
    createdAt: new Date().toISOString(),
    completedAt: null,
  },
  messages: [message(1, "user", USER_TEXT)],
};

function harness(overrides = {}) {
  const calls = { chat: 0, chatRequest: 0 };
  const outcomes = [];
  const logs = [];
  const sent = [];
  const deps = {
    decisionModel: "decision-model",
    chatModel: "chat-model-diag",
    callDecisions: async () => {
      throw new Error("decision call must not happen without patterns");
    },
    callChat: async (request) => {
      calls.chat += 1;
      sent.push(request);
      return overrides.rawChatResponse;
    },
    loadIdentity: async () => ({ content: "IDENTITY", revision: 5 }),
    loadPatterns: async () => [],
    loadContext: async () => [],
    recordChatRequest: async () => {
      calls.chatRequest += 1;
    },
    recordChatOutcome: async (payload) => {
      outcomes.push(payload);
      if (overrides.recordChatOutcomeThrows !== undefined) {
        throw overrides.recordChatOutcomeThrows;
      }
    },
    log: (line) => logs.push(line),
  };
  if (overrides.chatReasoningEffort !== undefined) {
    deps.chatReasoningEffort = overrides.chatReasoningEffort;
  }
  if (overrides.maxTokens !== undefined) deps.maxTokens = overrides.maxTokens;
  return { deps, calls, outcomes, logs, sent };
}

function diagnostics(logs) {
  const lines = logs.filter((line) => line.startsWith(PREFIX));
  return lines.map((line) => JSON.parse(line.slice(PREFIX.length)));
}

function assertNoLeakage(logs, outcomes, secrets) {
  // Only the diagnostic log lines must be leakage-free. The recorded
  // outcome payloads are the existing trace contract (exact request
  // messages and the actual transport error) and legitimately carry them.
  void outcomes;
  const rendered = logs.join("\n");
  for (const secret of secrets) {
    assert.ok(
      !rendered.includes(secret),
      `diagnostics must not contain ${JSON.stringify(secret)}`,
    );
  }
}

describe("chat diagnostics: malformed non-string content", () => {
  it("rejects null content but preserves length finish reason and usage", async () => {
    const raw = {
      id: "resp-null-content",
      model: "resp-model-diag",
      choices: [
        {
          message: { role: "assistant", content: null },
          finish_reason: "length",
        },
      ],
      usage: {
        prompt_tokens: 120,
        completion_tokens: 500,
        total_tokens: 620,
        completion_tokens_details: { reasoning_tokens: 450 },
      },
    };
    const { deps, outcomes, logs } = harness({
      rawChatResponse: raw,
      maxTokens: 500,
    });
    await assert.rejects(processTurnWork(work, deps), ChatContractError);
    // Strict behavior unchanged: outcome recorded as invalid, no reply.
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0].outcome.kind, "invalid");
    const records = diagnostics(logs);
    assert.equal(records.length, 1);
    const [record] = records;
    assert.equal(record.event, "chat_diagnostics");
    assert.equal(record.turnId, "turn-diag-1");
    assert.equal(record.attempt, 2);
    assert.equal(record.identityRevision, 5);
    assert.equal(record.requestModel, "chat-model-diag");
    assert.equal(record.maxTokens, 500);
    assert.equal(record.maxTokensSet, true);
    assert.equal(record.reasoningEffort, "unset");
    assert.equal(record.reasoningExclude, "unset");
    assert.equal(record.outcome, "invalid");
    assert.equal(record.errorKind, "invalid");
    assert.equal(record.validationPath, "choices.0.message.content");
    assert.equal(record.responseModelPresent, true);
    assert.equal(record.responseModelMatchesRequest, false);
    assert.equal(record.responseIdPresent, true);
    // Raw provider model/id strings are never recorded.
    assert.ok(!("responseModel" in record));
    assert.ok(!("responseId" in record));
    assert.ok(!logs.join("\n").includes("resp-model-diag"));
    assert.ok(!logs.join("\n").includes("resp-null-content"));
    assert.equal(record.choiceCount, 1);
    assert.equal(record.contentShape, "null");
    assert.equal(record.contentPresent, true);
    assert.equal(record.finishReason, "length");
    assert.equal(record.finishReasonRecognized, true);
    assert.equal(record.usagePresent, true);
    assert.equal(record.usageInputTokens, 120);
    assert.equal(record.usageOutputTokens, 500);
    assert.equal(record.usageTotalTokens, 620);
    assert.equal(record.usageReasoningTokens, 450);
    assertNoLeakage(logs, outcomes, [USER_TEXT]);
  });

  it("rejects object content and leaks neither the content nor extra fields", async () => {
    const REPLY_SECRET = "REPLY_SECRET_XYZ_123";
    const EXTRA_SECRET = "EXTRA_PROVIDER_SECRET_456";
    const raw = {
      id: "resp-object-content",
      model: "resp-model-diag",
      choices: [
        {
          message: {
            role: "assistant",
            content: { text: REPLY_SECRET, reasoning: "REASONING_SECRET_789" },
          },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      provider_note: EXTRA_SECRET,
    };
    const { deps, outcomes, logs } = harness({ rawChatResponse: raw });
    await assert.rejects(processTurnWork(work, deps), ChatContractError);
    assert.equal(outcomes[0].outcome.kind, "invalid");
    const [record] = diagnostics(logs);
    assert.equal(record.contentShape, "non_string");
    assert.equal(record.finishReason, "stop");
    assert.equal(record.usageInputTokens, 10);
    assertNoLeakage(logs, outcomes, [
      USER_TEXT,
      REPLY_SECRET,
      "REASONING_SECRET_789",
      EXTRA_SECRET,
    ]);
  });

  it("distinguishes missing content from null/non-string", async () => {
    const raw = {
      model: "resp-model-diag",
      choices: [{ message: { role: "assistant" }, finish_reason: "stop" }],
    };
    const { deps, logs } = harness({ rawChatResponse: raw });
    await assert.rejects(processTurnWork(work, deps), ChatContractError);
    const [record] = diagnostics(logs);
    assert.equal(record.contentShape, "missing");
    assert.equal(record.contentPresent, false);
    assert.equal(record.finishReason, "stop");
    assert.equal(record.usagePresent, false);
    assert.equal(record.usageInputTokens, null);
    assert.equal(record.usageOutputTokens, null);
    assert.equal(record.usageTotalTokens, null);
    assert.equal(record.usageReasoningTokens, null);
    assert.equal(record.maxTokensSet, false);
    assert.equal(record.maxTokens, null);
  });
});

describe("chat diagnostics: individually-valid metadata preservation", () => {
  it("preserves valid usage fields when another usage field is malformed", async () => {
    const raw = {
      model: "resp-model-diag",
      choices: [
        {
          message: { role: "assistant", content: "fine" },
          finish_reason: "length",
        },
      ],
      usage: {
        prompt_tokens: "many",
        completion_tokens: 5,
        completion_tokens_details: { reasoning_tokens: 3 },
      },
    };
    const { deps, logs } = harness({ rawChatResponse: raw });
    await assert.rejects(processTurnWork(work, deps), (error) => {
      assert.ok(error instanceof ChatContractError);
      assert.ok(error.path.includes("usage.prompt_tokens"));
      return true;
    });
    const [record] = diagnostics(logs);
    assert.equal(record.validationPath, "usage.prompt_tokens");
    assert.equal(record.contentShape, "string_nonblank");
    assert.equal(record.usageInputTokens, null);
    assert.equal(record.usageOutputTokens, 5);
    assert.equal(record.usageTotalTokens, null);
    assert.equal(record.usageReasoningTokens, 3);
    assert.equal(record.finishReason, "length");
  });

  it("sanitizes unsafe and unrecognized finish reasons without leaking them", () => {
    const raw = {
      model: "resp-model-diag",
      choices: [
        {
          message: { role: "assistant", content: "fine" },
          finish_reason: "not a valid reason with SECRET_FINISH_TEXT",
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    };
    const record = buildChatDiagnostics({
      turnId: "turn-diag-1",
      attempt: 2,
      identityRevision: 5,
      request: {
        model: "chat-model-diag",
        messages: [{ role: "user", content: "x" }],
      },
      rawResponse: raw,
      outcome: "invalid",
      error: new ChatContractError(
        "choices.0.finish_reason",
        "expected a string",
      ),
    });
    assert.equal(record.finishReason, null);
    assert.equal(record.finishReasonPresent, true);
    assert.equal(record.finishReasonRecognized, false);
    assert.ok(!formatChatDiagnostics(record).includes("SECRET_FINISH_TEXT"));

    const unknownButSafe = buildChatDiagnostics({
      turnId: "turn-diag-1",
      attempt: 2,
      identityRevision: 5,
      request: {
        model: "chat-model-diag",
        messages: [{ role: "user", content: "x" }],
      },
      rawResponse: {
        model: "resp-model-diag",
        choices: [
          {
            message: { role: "assistant", content: "fine" },
            finish_reason: "future_reason",
          },
        ],
      },
      outcome: "invalid",
      error: new ChatContractError(
        "choices.0.message.content",
        "expected a string",
      ),
    });
    // Even identifier-shaped, whitespace-free values outside the exact
    // allowlist are flagged unrecognized and never echoed.
    assert.equal(unknownButSafe.finishReason, null);
    assert.equal(unknownButSafe.finishReasonRecognized, false);
    assert.ok(!formatChatDiagnostics(unknownButSafe).includes("future_reason"));
  });
});

describe("chat diagnostics: provider metadata slots never echoed", () => {
  it("leaves whitespace-free secrets in model/id/finish_reason out of the captured line", async () => {
    const SECRET_MODEL = "SECRET_MODEL_TOKEN_999";
    const SECRET_ID = "SECRET_ID_TOKEN_888";
    const SECRET_REASON = "SECRET_REASON_TOKEN";
    const raw = {
      id: SECRET_ID,
      model: SECRET_MODEL,
      choices: [
        {
          message: { role: "assistant", content: "ok" },
          finish_reason: SECRET_REASON,
        },
      ],
      usage: { prompt_tokens: 3, completion_tokens: 2 },
    };
    const { deps, logs } = harness({ rawChatResponse: raw });
    const outcome = await processTurnWork(work, deps);
    assert.equal(outcome.reply, "ok");
    const [record] = diagnostics(logs);
    assert.equal(record.responseModelPresent, true);
    assert.equal(record.responseModelMatchesRequest, false);
    assert.equal(record.responseIdPresent, true);
    assert.equal(record.finishReason, null);
    assert.equal(record.finishReasonPresent, true);
    assert.equal(record.finishReasonRecognized, false);
    const serialized = logs.join("\n");
    for (const secret of [SECRET_MODEL, SECRET_ID, SECRET_REASON]) {
      assert.ok(
        !serialized.includes(secret),
        `diagnostics must not contain ${JSON.stringify(secret)}`,
      );
    }
    assert.ok(!("responseModel" in record));
    assert.ok(!("responseId" in record));
  });

  it("flags a response model equal to the request and allowlists OpenRouter error", () => {
    const record = buildChatDiagnostics({
      turnId: "turn-diag-1",
      attempt: 2,
      identityRevision: 5,
      request: {
        model: "chat-model-diag",
        messages: [{ role: "user", content: "x" }],
      },
      rawResponse: {
        model: "chat-model-diag",
        choices: [
          {
            message: { role: "assistant", content: "fine" },
            finish_reason: "error",
          },
        ],
      },
      outcome: "responded",
    });
    assert.equal(record.responseModelMatchesRequest, true);
    assert.equal(record.finishReason, "error");
    assert.equal(record.finishReasonRecognized, true);
    // The matching value is the locally configured request model, emitted
    // only as requestModel — never as a provider response string.
    assert.ok(!("responseModel" in record));
    assert.equal(
      formatChatDiagnostics(record).match(/chat-model-diag/g).length,
      1,
    );
  });
});

describe("chat diagnostics: transport failure and request correlation", () => {
  it("records a failed outcome with the fixed transport kind and no response data", async () => {
    const { deps, outcomes, logs } = harness({
      rawChatResponse: undefined,
    });
    deps.callChat = async () => {
      throw new OpenRouterTransportError(
        "network",
        "socket blew up SECRET_TRANSPORT",
        {
          cause: new Error("inner"),
        },
      );
    };
    await assert.rejects(processTurnWork(work, deps), OpenRouterTransportError);
    assert.equal(outcomes[0].outcome.kind, "failed");
    const [record] = diagnostics(logs);
    assert.equal(record.outcome, "failed");
    assert.equal(record.errorKind, "network");
    assert.equal(record.httpStatus, null);
    assert.equal(record.validationPath, null);
    assert.equal(record.contentShape, "no_response");
    assert.equal(record.responseModelPresent, false);
    assert.equal(record.usagePresent, false);
    assertNoLeakage(logs, outcomes, ["SECRET_TRANSPORT", USER_TEXT]);
  });

  it("records HTTP status and requested reasoning effort with unset kept distinct", async () => {
    const { deps, logs, sent } = harness({
      chatReasoningEffort: "high",
      maxTokens: 777,
    });
    deps.callChat = async (request) => {
      sent.push(request);
      throw new OpenRouterTransportError(
        "http_status",
        "request failed with SECRET_HTTP_BODY",
        { status: 429, body: "rate limited SECRET_HTTP_BODY_DETAIL" },
      );
    };
    await assert.rejects(processTurnWork(work, deps), OpenRouterTransportError);
    assert.deepEqual(sent[0].reasoning, { effort: "high", exclude: true });
    const [record] = diagnostics(logs);
    assert.equal(record.errorKind, "http_status");
    assert.equal(record.httpStatus, 429);
    assert.equal(record.reasoningEffort, "high");
    assert.equal(record.reasoningExclude, true);
    assert.equal(record.maxTokens, 777);
    assert.equal(record.maxTokensSet, true);
    assertNoLeakage(logs, [], ["SECRET_HTTP_BODY", "SECRET_HTTP_BODY_DETAIL"]);
  });
});

describe("chat diagnostics: diagnostics survive trace-write failure", () => {
  it("emits diagnostics before the best-effort invalid trace write fails", async () => {
    const raw = {
      model: "resp-model-diag",
      choices: [
        {
          message: { role: "assistant", content: null },
          finish_reason: "length",
        },
      ],
      usage: { prompt_tokens: 2, completion_tokens: 3 },
    };
    const { deps, logs } = harness({
      rawChatResponse: raw,
      recordChatOutcomeThrows: new Error("db trace write failed SECRET_DB"),
    });
    // The original contract error still propagates (not the trace error).
    await assert.rejects(processTurnWork(work, deps), ChatContractError);
    const records = diagnostics(logs);
    assert.equal(records.length, 1);
    assert.equal(records[0].outcome, "invalid");
    assert.equal(records[0].finishReason, "length");
  });

  it("emits responded diagnostics before the deliberate outcome trace write", async () => {
    const raw = {
      model: "resp-model-diag",
      choices: [
        {
          message: { role: "assistant", content: "hello" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
    };
    const { deps, logs } = harness({
      rawChatResponse: raw,
      recordChatOutcomeThrows: new Error("db trace write failed"),
    });
    await assert.rejects(processTurnWork(work, deps), /db trace write failed/);
    const [record] = diagnostics(logs);
    assert.equal(record.outcome, "responded");
    assert.equal(record.errorKind, "none");
    assert.equal(record.contentShape, "string_nonblank");
  });
});

describe("chat diagnostics: successful reply unchanged", () => {
  it("returns the reply and records the responded outcome as before", async () => {
    const raw = {
      id: "resp-ok",
      model: "resp-model-diag",
      choices: [
        {
          message: { role: "assistant", content: "A fine reply." },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
    };
    const { deps, outcomes, logs } = harness({ rawChatResponse: raw });
    const outcome = await processTurnWork(work, deps);
    assert.equal(outcome.reply, "A fine reply.");
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0].outcome.kind, "responded");
    assert.equal(outcomes[0].outcome.replyContent, "A fine reply.");
    const [record] = diagnostics(logs);
    assert.equal(record.outcome, "responded");
    assert.equal(record.errorKind, "none");
    assert.equal(record.validationPath, null);
    assert.equal(record.contentShape, "string_nonblank");
    assert.equal(record.finishReason, "stop");
    assert.equal(record.usageTotalTokens, 18);
    assertNoLeakage(logs, outcomes, [USER_TEXT]);
  });

  it("records the native blank response and rejects it for publication", async () => {
    const raw = {
      model: "resp-model-diag",
      choices: [
        {
          message: { role: "assistant", content: "   " },
          finish_reason: "stop",
        },
      ],
    };
    const { deps, logs, outcomes } = harness({ rawChatResponse: raw });
    await assert.rejects(processTurnWork(work, deps), /blank reply/);
    assert.equal(outcomes[0].outcome.applicationRejection, "chat response contains a blank reply");
    assert.deepEqual(outcomes[0].outcome.response.choices, raw.choices);
    const [record] = diagnostics(logs);
    assert.equal(record.outcome, "responded");
    assert.equal(record.contentShape, "string_blank");
  });
});
