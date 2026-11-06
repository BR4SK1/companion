// Database-backed integration tests for the turn trace report's multi-decision
// exposure and the article-share selection semantics: one attempt can carry
// two decision questions (the response-pattern choice and the per-turn
// article-memory share choice), the report must expose every recorded
// decision with its own boundary and selection outcome, the legacy
// `decision` field stays the response-pattern row, and a legitimate `none`
// article answer is a successful no-action selection — never a rejection.
//
// These tests need a real PostgreSQL. They run ONLY against the
// non-production database provided via WORKER_TEST_DATABASE_URL and are
// skipped otherwise. No network calls are made: provider calls are fake.

import { describe, it, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";

import {
  closePostgresPool,
  createPostgresPool,
  runMigrations,
} from "../../libraries/postgres/src/index.ts";
import { conversationMigrations } from "../../apps/worker/src/conversation/migrations.ts";
import { memoryMigrations } from "../../apps/worker/src/memory/migrations.ts";
import { articleMigrations } from "../../apps/worker/src/articles/migrations.ts";
import { createConversationStore } from "../../apps/worker/src/conversation/store.ts";
import { processTurnWork } from "../../apps/worker/src/work/processor.ts";
import { renderReport } from "../../apps/worker/src/cli.ts";
import {
  DECISION_QUESTION_ID,
  buildPatternChoiceRequest,
} from "../../apps/worker/src/work/decision.ts";
import {
  ARTICLE_SHARE_NONE_CHOICE,
  ARTICLE_SHARE_QUESTION_ID,
  buildArticleShareQuestion,
} from "../../apps/worker/src/articles/share.ts";

const DATABASE_URL = process.env.WORKER_TEST_DATABASE_URL;
const hasDatabase =
  typeof DATABASE_URL === "string" && DATABASE_URL.length > 0;

const CANDIDATE = {
  reactionId: "9e3d1f5e-1111-4222-8333-444455556666",
  itemId: "8a2c0e4d-0000-4111-7222-333344445555",
  url: "https://example.com/local-first",
  title: "A local-first piece",
  feedId: "feed-a",
  reaction: "The assistant found this piece interesting.",
  factKey: "article:00000000-0000-4000-8000-000000000001",
  publishedAt: null,
  generatedAt: "2026-11-05T10:00:00.000Z",
};

describe("turn trace report: every decision question (PostgreSQL)", { skip: !hasDatabase }, () => {
  /** @type {import("pg").Pool} */
  let pool;
  let store;

  before(async () => {
    pool = createPostgresPool({ connectionString: DATABASE_URL });
    store = createConversationStore(pool);
    await runMigrations(pool, [
      ...conversationMigrations,
      ...memoryMigrations,
      ...articleMigrations,
    ]);
    await pool.query(
      `INSERT INTO chat_identity (id, content, revision)
       VALUES ('identity', 'Trace decisions fixture identity: generic test text.', 1)
       ON CONFLICT (id) DO UPDATE SET
         content = EXCLUDED.content, revision = EXCLUDED.revision`,
    );
  });

  after(async () => {
    if (pool !== undefined) {
      await closePostgresPool(pool);
    }
  });

  beforeEach(async () => {
    await pool.query(
      `TRUNCATE conversation_message, conversation_turn, response_pattern,
        trace_attempt, trace_attempt_context, trace_attempt_pattern,
        trace_attempt_decision, trace_attempt_decision_probability,
        trace_attempt_chat, trace_attempt_chat_message,
        trace_attempt_chat_choice,
        article_feed, article_item, article_reaction, article_share,
        memory_fact, memory_run, memory_observation,
        memory_canonical_observation RESTART IDENTITY CASCADE`,
    );
  });

  it("records a legitimate article none as a successful no-action selection, not a rejection", async () => {
    await pool.query(
      `INSERT INTO response_pattern (id, selection_description, response_guidance, position)
       VALUES ('concise', 'Short factual replies fit here.', 'Answer in one short paragraph.', 0)`,
    );
    await store.appendUserMessage({ content: "trace me" });
    const claim = await store.claimNextTurn({ owner: "owner-trace", leaseSeconds: 300 });
    assert.equal(claim.kind, "claimed");
    const turnId = claim.work.turn.id;

    const patterns = await store.getEnabledResponsePatterns();
    const articleQuestion = buildArticleShareQuestion([CANDIDATE]);
    const baseRequest = buildPatternChoiceRequest({
      model: "decision-model",
      patterns,
      state: {
        conversation: claim.work.messages.map((message) => ({
          role: message.role,
          content: message.content,
        })),
      },
    });
    const request = {
      model: baseRequest.model,
      state: baseRequest.state,
      questions: {
        ...baseRequest.questions,
        [articleQuestion.questionId]: articleQuestion.question,
      },
    };
    const response = {
      model: "decision-model-build",
      answers: {
        [DECISION_QUESTION_ID]: { type: "choice", choice: "concise", confidence: 0.9 },
        [ARTICLE_SHARE_QUESTION_ID]: { type: "choice", choice: ARTICLE_SHARE_NONE_CHOICE },
      },
      usage: { input_tokens: 6, output_tokens: 3 },
    };
    for (const questionId of [DECISION_QUESTION_ID, ARTICLE_SHARE_QUESTION_ID]) {
      assert.equal(
        await store.recordDecisionRequest({
          turnId,
          leaseOwner: "owner-trace",
          trace: { questionId, request },
        }),
        true,
      );
      assert.equal(
        await store.recordDecisionOutcome({
          turnId,
          leaseOwner: "owner-trace",
          payload: {
            trace: { questionId, request },
            outcome: { kind: "responded", trace: { questionId, request, response } },
          },
        }),
        true,
      );
    }
    // The pattern selection writes the turn state; the article none is the
    // question's own successful no-action outcome.
    assert.equal(
      await store.recordDecisionSelection({
        turnId,
        leaseOwner: "owner-trace",
        questionId: DECISION_QUESTION_ID,
        selection: { kind: "selected", patternId: "concise" },
      }),
      true,
    );
    assert.equal(
      await store.recordDecisionSelection({
        turnId,
        leaseOwner: "owner-trace",
        questionId: ARTICLE_SHARE_QUESTION_ID,
        selection: { kind: "selected-none" },
      }),
      true,
    );

    const report = await store.getTurnTraceReport({ turnId });
    const attempt = report.attempts[0];
    // Every recorded decision question is exposed, in question-id order.
    assert.deepEqual(
      attempt.decisions.map((decision) => decision.questionId),
      [ARTICLE_SHARE_QUESTION_ID, DECISION_QUESTION_ID],
    );
    const article = attempt.decisions[0];
    assert.equal(article.state, "responded");
    assert.equal(article.choice, ARTICLE_SHARE_NONE_CHOICE);
    // The legitimate no-action outcome: selected, no rejection reason.
    assert.equal(article.selection, "selected");
    assert.equal(article.rejectionReason, null);

    const pattern = attempt.decisions[1];
    assert.equal(pattern.choice, "concise");
    assert.equal(pattern.selection, "selected");
    assert.equal(pattern.rejectionReason, null);

    // The legacy shape stays the response-pattern row.
    assert.equal(attempt.decision.questionId, DECISION_QUESTION_ID);
    assert.equal(report.turn.selectedPatternId, "concise");
  });

  it("records a chosen article candidate as selected with its reaction id as the choice", async () => {
    await store.appendUserMessage({ content: "trace article" });
    const claim = await store.claimNextTurn({ owner: "owner-trace", leaseSeconds: 300 });
    const turnId = claim.work.turn.id;
    const articleQuestion = buildArticleShareQuestion([CANDIDATE]);
    const request = {
      model: "decision-model",
      state: { conversation: [] },
      questions: { [articleQuestion.questionId]: articleQuestion.question },
    };
    const response = {
      model: "decision-model-build",
      answers: {
        [ARTICLE_SHARE_QUESTION_ID]: { type: "choice", choice: CANDIDATE.reactionId },
      },
      usage: { input_tokens: 4, output_tokens: 2 },
    };
    await store.recordDecisionRequest({
      turnId,
      leaseOwner: "owner-trace",
      trace: { questionId: ARTICLE_SHARE_QUESTION_ID, request },
    });
    await store.recordDecisionOutcome({
      turnId,
      leaseOwner: "owner-trace",
      payload: {
        trace: { questionId: ARTICLE_SHARE_QUESTION_ID, request },
        outcome: { kind: "responded", trace: { questionId: ARTICLE_SHARE_QUESTION_ID, request, response } },
      },
    });
    assert.equal(
      await store.recordDecisionSelection({
        turnId,
        leaseOwner: "owner-trace",
        questionId: ARTICLE_SHARE_QUESTION_ID,
        selection: { kind: "selected-article", reactionId: CANDIDATE.reactionId },
      }),
      true,
    );
    // An article selection writes no turn state.
    const articleReport = await store.getTurnTraceReport({ turnId });
    assert.equal(articleReport.turn.selectedPatternId, null);

    const attempt = articleReport.attempts[0];
    assert.equal(attempt.decisions.length, 1);
    assert.equal(attempt.decisions[0].choice, CANDIDATE.reactionId);
    assert.equal(attempt.decisions[0].selection, "selected");
    assert.equal(attempt.decisions[0].rejectionReason, null);
    // The legacy decision falls back to the only recorded row.
    assert.equal(attempt.decision.questionId, ARTICLE_SHARE_QUESTION_ID);
  });

  it("keeps recording an unusable answer as a rejection with its reason", async () => {
    await store.appendUserMessage({ content: "trace rejection" });
    const claim = await store.claimNextTurn({ owner: "owner-trace", leaseSeconds: 300 });
    const turnId = claim.work.turn.id;
    const articleQuestion = buildArticleShareQuestion([CANDIDATE]);
    const request = {
      model: "decision-model",
      state: { conversation: [] },
      questions: { [articleQuestion.questionId]: articleQuestion.question },
    };
    const response = {
      model: "decision-model-build",
      answers: {
        [ARTICLE_SHARE_QUESTION_ID]: { type: "choice", choice: "not-offered" },
      },
      usage: { input_tokens: 4, output_tokens: 2 },
    };
    await store.recordDecisionRequest({
      turnId,
      leaseOwner: "owner-trace",
      trace: { questionId: ARTICLE_SHARE_QUESTION_ID, request },
    });
    await store.recordDecisionOutcome({
      turnId,
      leaseOwner: "owner-trace",
      payload: {
        trace: { questionId: ARTICLE_SHARE_QUESTION_ID, request },
        outcome: { kind: "responded", trace: { questionId: ARTICLE_SHARE_QUESTION_ID, request, response } },
      },
    });
    await store.recordDecisionSelection({
      turnId,
      leaseOwner: "owner-trace",
      questionId: ARTICLE_SHARE_QUESTION_ID,
      selection: { kind: "rejected", reason: "not an offered option" },
    });
    const attempt = (await store.getTurnTraceReport({ turnId })).attempts[0];
    assert.equal(attempt.decisions.length, 1);
    assert.equal(attempt.decisions[0].choice, "not-offered");
    assert.equal(attempt.decisions[0].selection, "rejected");
    assert.equal(attempt.decisions[0].rejectionReason, "not an offered option");
  });

  it("reports both decisions end-to-end through the processor's trace writes", async () => {
    await pool.query(
      `INSERT INTO response_pattern (id, selection_description, response_guidance, position)
       VALUES ('concise', 'Short factual replies fit here.', 'Answer in one short paragraph.', 0)`,
    );
    await store.appendUserMessage({ content: "cycle me" });
    const claim = await store.claimNextTurn({ owner: "owner-cycle", leaseSeconds: 300 });
    assert.equal(claim.kind, "claimed");
    const turnId = claim.work.turn.id;

    const outcome = await processTurnWork(claim.work, {
      decisionModel: "decision-model",
      chatModel: "chat-model",
      callDecisions: async () => ({
        model: "decision-model-build",
        answers: {
          [DECISION_QUESTION_ID]: { type: "choice", choice: "concise" },
          [ARTICLE_SHARE_QUESTION_ID]: { type: "choice", choice: ARTICLE_SHARE_NONE_CHOICE },
        },
        usage: { input_tokens: 6, output_tokens: 3 },
      }),
      callChat: async () => ({
        id: "chat-cycle",
        model: "chat-model-build",
        choices: [
          { message: { role: "assistant", content: "cycle reply" }, finish_reason: "stop" },
        ],
        usage: { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 },
      }),
      loadPatterns: () => store.getEnabledResponsePatterns(),
      loadIdentity: () => store.getChatIdentity(),
      loadContext: (id) => store.getThreadContext({ turnId: id, limit: 50 }),
      loadArticleShareCandidates: async () => [CANDIDATE],
      recordSnapshot: async (payload) => {
        await store.recordAttemptSnapshot({
          turnId,
          leaseOwner: "owner-cycle",
          snapshot: payload,
        });
      },
      recordDecisionRequest: async (payload) => {
        await store.recordDecisionRequest({
          turnId,
          leaseOwner: "owner-cycle",
          trace: payload.trace,
        });
      },
      recordDecisionOutcome: async (payload) => {
        await store.recordDecisionOutcome({
          turnId,
          leaseOwner: "owner-cycle",
          payload,
        });
      },
      recordDecisionSelection: async (payload) => {
        await store.recordDecisionSelection({
          turnId,
          leaseOwner: "owner-cycle",
          questionId: payload.questionId,
          selection: payload.selection,
        });
      },
      recordChatRequest: async (payload) => {
        await store.recordChatRequest({ turnId, leaseOwner: "owner-cycle", payload });
      },
      recordChatOutcome: async (payload) => {
        await store.recordChatOutcome({ turnId, leaseOwner: "owner-cycle", payload });
      },
    });
    assert.equal(outcome.reply, "cycle reply");
    assert.equal(outcome.selectedPatternId, "concise");

    const report = await store.getTurnTraceReport({ turnId });
    const attempt = report.attempts[0];
    assert.deepEqual(
      attempt.decisions.map((decision) => [decision.questionId, decision.choice, decision.selection]),
      [
        [ARTICLE_SHARE_QUESTION_ID, ARTICLE_SHARE_NONE_CHOICE, "selected"],
        [DECISION_QUESTION_ID, "concise", "selected"],
      ],
    );
    // The article none is not a rejection anywhere in the report.
    assert.ok(attempt.decisions.every((decision) => decision.rejectionReason === null));
    assert.equal(attempt.decision.questionId, DECISION_QUESTION_ID);
    assert.equal(report.turn.selectedPatternId, "concise");

    // The CLI presents both decisions with the article action annotated as
    // prompt inclusion only — never a share claim.
    const text = renderReport(report);
    assert.ok(text.includes("decisions (2 recorded questions):"), `got:\n${text}`);
    assert.ok(text.includes("question article_memory_share"));
    assert.ok(text.includes("question response_pattern"));
    assert.ok(
      text.includes(
        "article action: context-inclusion decision — prompt inclusion only, never a share claim",
      ),
      `got:\n${text}`,
    );
    // The none choice includes nothing: no article chunk in the sent request.
    assert.ok(
      text.includes("article context in the sent chat request: absent"),
      `got:\n${text}`,
    );
    assert.ok(
      !/\bshared\b/.test(text),
      `the trace must never claim a memory was shared, got:\n${text}`,
    );
  });

  it("reports the included article context end-to-end when a candidate is selected", async () => {
    await pool.query(
      `INSERT INTO response_pattern (id, selection_description, response_guidance, position)
       VALUES ('concise', 'Short factual replies fit here.', 'Answer in one short paragraph.', 0)`,
    );
    await store.appendUserMessage({ content: "share me" });
    const claim = await store.claimNextTurn({ owner: "owner-cycle", leaseSeconds: 300 });
    assert.equal(claim.kind, "claimed");
    const turnId = claim.work.turn.id;

    const inclusions = [];
    const outcome = await processTurnWork(claim.work, {
      decisionModel: "decision-model",
      chatModel: "chat-model",
      callDecisions: async () => ({
        model: "decision-model-build",
        answers: {
          [DECISION_QUESTION_ID]: { type: "choice", choice: "concise" },
          [ARTICLE_SHARE_QUESTION_ID]: { type: "choice", choice: CANDIDATE.reactionId },
        },
        usage: { input_tokens: 6, output_tokens: 3 },
      }),
      callChat: async () => ({
        id: "chat-included",
        model: "chat-model-build",
        choices: [
          { message: { role: "assistant", content: "cycle reply" }, finish_reason: "stop" },
        ],
        usage: { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 },
      }),
      loadPatterns: () => store.getEnabledResponsePatterns(),
      loadIdentity: () => store.getChatIdentity(),
      loadContext: (id) => store.getThreadContext({ turnId: id, limit: 50 }),
      loadArticleShareCandidates: async () => [CANDIDATE],
      recordDecisionRequest: async (payload) => {
        await store.recordDecisionRequest({
          turnId,
          leaseOwner: "owner-cycle",
          trace: payload.trace,
        });
      },
      recordDecisionOutcome: async (payload) => {
        await store.recordDecisionOutcome({
          turnId,
          leaseOwner: "owner-cycle",
          payload,
        });
      },
      recordDecisionSelection: async (payload) => {
        await store.recordDecisionSelection({
          turnId,
          leaseOwner: "owner-cycle",
          questionId: payload.questionId,
          selection: payload.selection,
        });
      },
      recordChatRequest: async (payload) => {
        await store.recordChatRequest({ turnId, leaseOwner: "owner-cycle", payload });
      },
      recordChatOutcome: async (payload) => {
        await store.recordChatOutcome({ turnId, leaseOwner: "owner-cycle", payload });
      },
      recordArticleShareInclusion: async (input) => {
        inclusions.push(input);
      },
    });
    assert.equal(outcome.reply, "cycle reply");
    assert.deepEqual(inclusions, [{ turnId, reactionId: CANDIDATE.reactionId }]);

    const report = await store.getTurnTraceReport({ turnId });
    const attempt = report.attempts[0];
    assert.equal(attempt.decisions.length, 2);
    const article = attempt.decisions.find(
      (decision) => decision.questionId === ARTICLE_SHARE_QUESTION_ID,
    );
    assert.equal(article.choice, CANDIDATE.reactionId);
    assert.equal(article.selection, "selected");
    assert.equal(article.rejectionReason, null);
    // The chosen candidate's context was actually sent: the chat request
    // carries the article chunk.
    assert.ok(
      attempt.chat.messages.some((message) => message.chunk === "article"),
      `expected the article chunk in the recorded chat request, got:\n${
        JSON.stringify(attempt.chat.messages.map((message) => message.chunk))
      }`,
    );

    const text = renderReport(report);
    assert.ok(
      text.includes("article context in the sent chat request: present"),
      `got:\n${text}`,
    );
    assert.ok(
      text.includes(
        "article action: context-inclusion decision — prompt inclusion only, never a share claim",
      ),
      `got:\n${text}`,
    );
    assert.ok(
      !/\bshared\b/.test(text),
      `the trace must never claim a memory was shared, got:\n${text}`,
    );
  });
});
