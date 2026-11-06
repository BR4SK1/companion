// Hermetic unit tests for the per-turn article-memory share decision's
// recorded selection semantics in the turn processor: a legitimate `none`
// answer is the question's successful no-action outcome (never recorded as a
// rejection), a chosen candidate is recorded as selected-article, and an
// unusable answer stays a rejection. Deterministic — no database, no network;
// every dependency is injected.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { processTurnWork } from "../../apps/worker/src/work/processor.ts";
import {
  ARTICLE_SHARE_NONE_CHOICE,
  ARTICLE_SHARE_QUESTION_ID,
} from "../../apps/worker/src/articles/share.ts";

const CANDIDATE = {
  reactionId: "9e3d1f5e-1111-4222-8333-444455556666",
  itemId: "8a2c0e4d-0000-4111-7222-333344445555",
  url: "https://example.com/local-first",
  title: "A local-first piece",
  feedId: "feed-a",
  reaction: "The assistant found this piece interesting.",
  factKey: "article:00000000-0000-4000-8000-000000000001",
  publishedAt: "2026-11-01T00:00:00.000Z",
  generatedAt: "2026-11-05T10:00:00.000Z",
};

function deps(overrides = {}) {
  const chatRequests = [];
  const selections = [];
  const inclusions = [];
  const decisionRequests = [];
  return {
    chatRequests,
    selections,
    inclusions,
    decisionRequests,
    deps: {
      decisionModel: "decision-model",
      chatModel: "chat-model",
      callDecisions: async (request) => {
        decisionRequests.push(request);
        return {
          model: "decision-model-build",
          answers: {
            [ARTICLE_SHARE_QUESTION_ID]: { type: "choice", choice: ARTICLE_SHARE_NONE_CHOICE },
          },
          usage: { input_tokens: 5, output_tokens: 2 },
        };
      },
      callChat: async (request) => {
        chatRequests.push(request);
        return {
          id: "chat-1",
          model: "chat-model-build",
          choices: [
            { message: { role: "assistant", content: "reply" }, finish_reason: "stop" },
          ],
          usage: { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 },
        };
      },
      loadPatterns: async () => [],
      loadIdentity: async () => ({ content: "FIXTURE IDENTITY", revision: 1 }),
      loadContext: async () => [],
      loadArticleShareCandidates: async () => [CANDIDATE],
      recordDecisionSelection: async (payload) => {
        selections.push(payload);
      },
      recordArticleShareInclusion: async (input) => {
        inclusions.push(input);
      },
      ...overrides,
    },
  };
}

function work() {
  return {
    turn: {
      id: "turn-1",
      status: "in_flight",
      attempt: 1,
      leaseOwner: "owner",
      leaseExpiresAt: null,
      selectedPatternId: null,
      decision: null,
      error: null,
      createdAt: "2026-11-06T12:00:00.000Z",
      completedAt: null,
    },
    messages: [
      {
        id: "m-1",
        seq: 1,
        role: "user",
        content: "hello there",
        turnId: "turn-1",
        clientKey: null,
        createdAt: "2026-11-06T12:00:00.000Z",
        clientSentAt: null,
        effectiveAt: "2026-11-06T12:00:00.000Z",
        timeSource: "server",
        clientTimeStatus: "absent",
        serverReceivedAt: "2026-11-06T12:00:00.000Z",
      },
    ],
  };
}

describe("processor: article-share selection trace semantics", () => {
  it("records a legitimate none as selected-none, never as a rejection", async () => {
    const { deps: processorDeps, selections, inclusions, chatRequests } = deps();
    const outcome = await processTurnWork(work(), processorDeps);
    assert.equal(outcome.reply, "reply");
    assert.deepEqual(selections, [
      { questionId: ARTICLE_SHARE_QUESTION_ID, selection: { kind: "selected-none" } },
    ]);
    // No-action: no article chunk, and no inclusion record.
    assert.equal(inclusions.length, 0);
    const chunks = chatRequests[0].messages.map((message) => message.chunk ?? message.role);
    assert.ok(!chatRequests[0].messages.some((message) => message.content.includes("local-first")));
    assert.ok(!chunks.includes("article"));
  });

  it("records a chosen candidate as selected-article with its reaction id", async () => {
    const { deps: processorDeps, selections, inclusions, chatRequests } = deps({
      callDecisions: async (request) => ({
        model: "decision-model-build",
        answers: {
          [ARTICLE_SHARE_QUESTION_ID]: { type: "choice", choice: CANDIDATE.reactionId },
        },
        usage: { input_tokens: 5, output_tokens: 2 },
      }),
    });
    const outcome = await processTurnWork(work(), processorDeps);
    assert.equal(outcome.reply, "reply");
    assert.deepEqual(selections, [
      {
        questionId: ARTICLE_SHARE_QUESTION_ID,
        selection: { kind: "selected-article", reactionId: CANDIDATE.reactionId },
      },
    ]);
    assert.deepEqual(inclusions, [{ turnId: "turn-1", reactionId: CANDIDATE.reactionId }]);
    assert.ok(
      chatRequests[0].messages.some((message) => message.content.includes("local-first")),
      "the chosen candidate's context chunk must be part of the prompt",
    );
  });

  it("records an unusable answer as a rejection with its reason, and fails the turn", async () => {
    const { deps: processorDeps, selections } = deps({
      callDecisions: async () => ({
        model: "decision-model-build",
        answers: {
          [ARTICLE_SHARE_QUESTION_ID]: { type: "choice", choice: "not-offered" },
        },
        usage: { input_tokens: 5, output_tokens: 2 },
      }),
    });
    await assert.rejects(
      () => processTurnWork(work(), processorDeps),
      /not an offered option/,
    );
    assert.equal(selections.length, 1);
    assert.equal(selections[0].questionId, ARTICLE_SHARE_QUESTION_ID);
    assert.equal(selections[0].selection.kind, "rejected");
    assert.match(selections[0].selection.reason, /not an offered option/);
  });

  it("asks only the article question when no patterns are enabled", async () => {
    const { deps: processorDeps, decisionRequests } = deps();
    await processTurnWork(work(), processorDeps);
    assert.deepEqual(Object.keys(decisionRequests[0].questions), [ARTICLE_SHARE_QUESTION_ID]);
  });
});
