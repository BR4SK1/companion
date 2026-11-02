// Hermetic unit tests for the worker's read-only trace-report CLI rendering
// (apps/worker/src/cli.ts). No database, no network: the render functions are
// pure functions over the trace report types, so these tests cover exactly
// the states a report can present — including the newly traced boundaries
// (decision selection/rejection, chat requested/failed/invalid states) and
// the attempt outcomes (superseded, in-flight) — without fabricating data.
//
// These tests run as part of the hermetic `pnpm test:unit` suite.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  renderAttempt,
  renderChat,
  renderDecision,
  renderReport,
} from "../../apps/worker/src/cli.ts";

const baseDecision = {
  questionId: "response_pattern",
  questionType: "choice",
  requestModel: "decision-model",
  instructions: "pick a pattern",
  choice: "concise",
  confidence: null,
  probabilitiesPresent: false,
  selection: null,
  rejectionReason: null,
  state: null,
  responseModel: "decision-model-build",
  responseProvider: null,
  responseId: null,
  usageInputTokens: null,
  usageOutputTokens: null,
  usageCost: null,
  errorKind: null,
  errorMessage: null,
  errorBody: null,
  probabilities: [],
  recordedAt: "2026-01-01T00:00:00.000Z",
};

const baseChat = {
  requestModel: "chat-model",
  temperature: null,
  maxTokens: null,
  identityRevision: null,
  responseId: null,
  state: null,
  responseModel: null,
  replyContent: null,
  applicationRejection: null,
  errorKind: null,
  errorMessage: null,
  errorBody: null,
  usagePromptTokens: null,
  usageCompletionTokens: null,
  usageTotalTokens: null,
  messages: [],
  choices: [],
  recordedAt: "2026-01-01T00:00:00.000Z",
};

const baseAttempt = {
  id: "attempt-1",
  turnId: "turn-1",
  attempt: 1,
  leaseOwner: "owner-a",
  claimedAt: "2026-01-01T00:00:00.000Z",
  finishedAt: null,
  outcome: null,
  snapshotRecordedAt: null,
  context: [],
  patterns: [],
  decision: null,
  chat: null,
};

const baseTurn = {
  id: "turn-1",
  threadId: "thread-1",
  status: "in_flight",
  attempt: 1,
  selectedPatternId: null,
  decision: null,
  error: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  completedAt: null,
  leaseExpiresAt: null,
  leaseOwner: null,
};

const baseReport = {
  turn: baseTurn,
  attempts: [],
};

describe("worker trace CLI rendering", () => {
  it("renders a decision boundary with the selection outcome recorded separately", () => {
    const lines = renderDecision({
      ...baseDecision,
      confidence: 0.9,
      selection: "selected",
      responseProvider: "openrouter",
      responseId: "dec-1",
      usageInputTokens: 4,
      usageOutputTokens: 2,
      usageCost: 0.001,
      probabilities: [{ optionId: "concise", value: 0.9 }],
    });
    assert.ok(lines.some((line) => line.includes("decision (choice, question response_pattern):")));
    assert.ok(lines.some((line) => line.includes("choice: concise")));
    assert.ok(lines.some((line) => line.includes("confidence: 0.9")));
    assert.ok(
      lines.some((line) => line.includes("selection: selected")),
      `expected the selection outcome in the output, got:\n${lines.join("\n")}`,
    );
    assert.ok(
      !lines.some((line) => line.includes("rejection reason:")),
      "a selected decision must not render a rejection reason",
    );
    assert.ok(lines.some((line) => line.includes("response provider: openrouter")));
    assert.ok(lines.some((line) => line.includes("response id: dec-1")));
    assert.ok(lines.some((line) => line.includes("usage: input 4, output 2, cost 0.001")));
    assert.ok(lines.some((line) => line.includes("concise: 0.9")));
  });

  it("renders a rejected selection with its reason and no confidence", () => {
    const lines = renderDecision({
      ...baseDecision,
      choice: null,
      confidence: null,
      selection: "rejected",
      rejectionReason: "no offered pattern matched the returned choice",
      probabilities: [],
    });
    assert.ok(lines.some((line) => line.includes("choice: (none returned)")));
    assert.ok(lines.some((line) => line.includes("confidence: (not returned)")));
    assert.ok(
      lines.some((line) => line.includes("selection: rejected")),
      `expected the rejected selection in the output, got:\n${lines.join("\n")}`,
    );
    assert.ok(
      lines.some((line) =>
        line.includes('rejection reason: "no offered pattern matched the returned choice"'),
      ),
      `expected the rejection reason in the output, got:\n${lines.join("\n")}`,
    );
    assert.ok(
      lines.some((line) => line.includes("probabilities: (none returned)")),
      `a decision with no probabilities must render the none-returned marker, got:\n${lines.join("\n")}`,
    );
  });

  it("renders a decision whose selection step has not been recorded yet", () => {
    const lines = renderDecision({ ...baseDecision });
    assert.ok(lines.some((line) => line.includes("selection: (not recorded)")));
    assert.ok(!lines.some((line) => line.includes("rejection reason:")));
  });

  it("renders a present-but-empty probability distribution distinctly from an absent one", () => {
    const absent = renderDecision({ ...baseDecision, probabilities: [] });
    assert.ok(
      absent.some((line) => line.includes("probabilities: (none returned)")),
      `an absent distribution renders as none returned, got:\n${absent.join("\n")}`,
    );
    const presentEmpty = renderDecision({
      ...baseDecision,
      probabilities: [],
      probabilitiesPresent: true,
    });
    assert.ok(
      presentEmpty.some((line) =>
        line.includes("probabilities: (empty distribution returned)"),
      ),
      `a present-empty distribution must not read as absent, got:\n${presentEmpty.join("\n")}`,
    );
    assert.ok(
      !presentEmpty.some((line) => line.includes("probabilities: (none returned)")),
    );
  });

  it("renders a chat boundary in the requested state before the provider call", () => {
    const lines = renderChat({
      ...baseChat,
      state: "requested",
      requestModel: "chat-model",
      temperature: 0.5,
      maxTokens: 256,
      messages: [
        { position: 0, role: "system", content: "guidance", sourceMessageId: null, chunk: "guidance" },
        {
          position: 1,
          role: "user",
          content: "hello",
          sourceMessageId: "11111111-1111-1111-1111-111111111111",
          chunk: "conversation",
        },
      ],
    });
    assert.ok(lines.some((line) => line.includes("state: requested")));
    assert.ok(lines.some((line) => line.includes("temperature: 0.5")));
    assert.ok(lines.some((line) => line.includes("max_tokens: 256")));
    assert.ok(
      lines.some((line) => line.includes("identity revision: (not recorded)")),
      `expected the identity-revision marker, got:\n${lines.join("\n")}`,
    );
    assert.ok(
      lines.some((line) => line.includes("0: system: \"guidance\" (synthetic guidance)")),
      `expected the synthetic guidance marker, got:\n${lines.join("\n")}`,
    );
    assert.ok(
      lines.some((line) =>
        line.includes("[message 11111111-1111-1111-1111-111111111111]"),
      ),
      `expected the source message linkage, got:\n${lines.join("\n")}`,
    );
    assert.ok(lines.some((line) => line.includes("choices returned:")));
    assert.ok(
      lines.some((line) =>
        line.includes("generated reply: (none — response unusable or not returned)"),
      ),
      `a requested chat has no generated reply yet, got:\n${lines.join("\n")}`,
    );
    assert.ok(
      !lines.some((line) => line.includes("error kind:")),
      `a requested chat must not render an error block, got:\n${lines.join("\n")}`,
    );
  });

  it("renders a chat boundary in the responded state with its reply and usage", () => {
    const lines = renderChat({
      ...baseChat,
      state: "responded",
      responseId: "chat-1",
      responseModel: "chat-model-build",
      replyContent: "here is the answer",
      usagePromptTokens: 9,
      usageCompletionTokens: 4,
      usageTotalTokens: 13,
      choices: [
        { position: 0, finishReason: "stop", content: "here is the answer" },
      ],
    });
    assert.ok(lines.some((line) => line.includes("state: responded")));
    assert.ok(
      lines.some((line) => line.includes('generated reply: "here is the answer"')),
      `expected the generated reply label, got:\n${lines.join("\n")}`,
    );
    assert.ok(
      !lines.some((line) => line.includes("reply published:")),
      "renderChat must never claim publication; publication is reported from the turn outcome",
    );
    assert.ok(lines.some((line) => line.includes("response id: chat-1")));
    assert.ok(lines.some((line) => line.includes("response model: chat-model-build")));
    assert.ok(lines.some((line) => line.includes("0: finish_reason stop: \"here is the answer\"")));
    assert.ok(lines.some((line) => line.includes("usage: prompt 9, completion 4, total 13")));
  });

  it("renders a chat boundary in the failed state with the actual transport error", () => {
    const lines = renderChat({
      ...baseChat,
      state: "failed",
      errorKind: "http_5xx",
      errorMessage: "chat endpoint exploded",
      errorBody: "{\"error\":\"upstream unavailable\"}",
    });
    assert.ok(lines.some((line) => line.includes("state: failed")));
    assert.ok(lines.some((line) => line.includes("error kind: http_5xx")));
    assert.ok(lines.some((line) => line.includes('error message: "chat endpoint exploded"')));
    assert.ok(
      lines.some((line) => line.includes('error body: "{\\"error\\":\\"upstream unavailable\\"}"')),
      `expected the retained error body, got:\n${lines.join("\n")}`,
    );
    assert.ok(
      lines.some((line) =>
        line.includes("generated reply: (none — response unusable or not returned)"),
      ),
      `a failed chat has no generated reply, got:\n${lines.join("\n")}`,
    );
    assert.ok(lines.some((line) => line.includes("response id: (n/a)")));
  });

  it("renders a chat boundary in the invalid state without an error body", () => {
    const lines = renderChat({
      ...baseChat,
      state: "invalid",
      errorKind: "invalid",
      errorMessage: "chat response did not validate",
    });
    assert.ok(lines.some((line) => line.includes("state: invalid")));
    assert.ok(lines.some((line) => line.includes("error kind: invalid")));
    assert.ok(lines.some((line) => line.includes('error message: "chat response did not validate"')));
    assert.ok(
      !lines.some((line) => line.includes("error body:")),
      `an invalid chat has no body; the renderer must not invent one, got:\n${lines.join("\n")}`,
    );
  });

  it("renders a chat boundary whose state was never recorded", () => {
    const lines = renderChat({ ...baseChat });
    assert.ok(lines.some((line) => line.includes("state: (not recorded)")));
    assert.ok(lines.some((line) => line.includes("temperature: (not set)")));
    assert.ok(lines.some((line) => line.includes("max_tokens: (not set)")));
    assert.ok(
      lines.some((line) =>
        line.includes("generated reply: (none — response unusable or not returned)"),
      ),
      `an unrecorded chat has no generated reply, got:\n${lines.join("\n")}`,
    );
    assert.ok(lines.some((line) => line.includes("response id: (n/a)")));
  });

  it("renders an in-flight attempt whose trace boundaries are absent", () => {
    const lines = renderAttempt({ ...baseAttempt });
    const text = lines.join("\n");
    assert.ok(text.includes("attempt 1 [attempt-1]"));
    assert.ok(text.includes("outcome: in flight (never finalized)"));
    assert.ok(text.includes("finished: (not finished)"));
    assert.ok(text.includes("snapshot recorded: (not recorded)"));
    assert.ok(text.includes("decision: (not recorded)"));
    assert.ok(text.includes("chat: (not recorded)"));
    assert.ok(text.includes("(empty — no prior context, no grouped messages)"));
    assert.ok(text.includes("(none offered)"));
  });

  it("renders a superseded attempt with its finished state", () => {
    const lines = renderAttempt({
      ...baseAttempt,
      finishedAt: "2026-01-01T00:00:01.000Z",
      outcome: "superseded",
      snapshotRecordedAt: "2026-01-01T00:00:00.500Z",
    });
    const text = lines.join("\n");
    assert.ok(text.includes("outcome: superseded"));
    assert.ok(text.includes(`finished: 2026-01-01T00:00:01.000Z`));
    assert.ok(text.includes(`snapshot recorded: 2026-01-01T00:00:00.500Z`));
  });

  it("renders a published attempt with a rejected decision selection and a failed chat", () => {
    const lines = renderAttempt({
      ...baseAttempt,
      finishedAt: "2026-01-01T00:00:02.000Z",
      outcome: "published",
      decision: {
        ...baseDecision,
        choice: "concise",
        selection: "rejected",
        rejectionReason: "returned choice is not among the offered patterns",
      },
      chat: {
        ...baseChat,
        state: "failed",
        errorKind: "network",
        errorMessage: "provider unreachable",
      },
    });
    const text = lines.join("\n");
    assert.ok(text.includes("outcome: published"));
    assert.ok(text.includes("selection: rejected"));
    assert.ok(
      text.includes('"returned choice is not among the offered patterns"'),
      `expected the rejection reason, got:\n${text}`,
    );
    assert.ok(text.includes("state: failed"));
    assert.ok(text.includes("error kind: network"));
  });

  it("renders a legacy turn report with no recorded attempts", () => {
    const legacyReport = {
      ...baseReport,
      turn: {
        ...baseTurn,
        status: "completed",
        selectedPatternId: "concise",
        decision: { choice: "concise", confidence: 0.9, model: "legacy-model" },
        completedAt: "2026-01-01T00:00:03.000Z",
      },
    };
    const text = renderReport(legacyReport);
    assert.ok(text.includes("Turn turn-1"));
    assert.ok(text.includes("status: completed"));
    assert.ok(text.includes("selected pattern: concise"));
    assert.ok(
      text.includes("(no recorded attempts — legacy turn recorded before tracing)"),
      `expected the legacy-turn marker, got:\n${text}`,
    );
    assert.ok(
      text.includes('legacy decision JSONB: {"choice":"concise","confidence":0.9,"model":"legacy-model"}'),
      `expected the legacy decision JSONB, got:\n${text}`,
    );
  });

  it("renders a report with attempts, a failed turn error, and boundary records", () => {
    const text = renderReport({
      ...baseReport,
      turn: {
        ...baseTurn,
        status: "failed",
        error: "provider unavailable",
        selectedPatternId: "concise",
      },
      attempts: [
        {
          ...baseAttempt,
          outcome: "failed",
          finishedAt: "2026-01-01T00:00:04.000Z",
          decision: {
            ...baseDecision,
            selection: "selected",
          },
          chat: {
            ...baseChat,
            state: "invalid",
            errorKind: "invalid",
            errorMessage: "bad contract",
          },
        },
      ],
    });
    assert.ok(text.includes("status: failed"));
    assert.ok(text.includes('error: "provider unavailable"'));
    assert.ok(text.includes("attempt 1 [attempt-1]"));
    assert.ok(text.includes("outcome: failed"));
    assert.ok(text.includes("selection: selected"));
    assert.ok(text.includes("state: invalid"));
    assert.ok(text.includes('error message: "bad contract"'));
  });
});
