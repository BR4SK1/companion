import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  relationshipDayStreaks,
  relationshipDayStreaksForDays,
  summarizeRelationship,
  renderRelationshipContext,
} from "../../apps/worker/src/relationship/runtime.ts";
import {
  createRelationshipStore,
  loadRelationshipConfiguration,
  parseRelationshipExtraction,
} from "../../apps/worker/src/relationship/store.ts";
import { relationshipMigrations } from "../../apps/worker/src/relationship/migrations.ts";
import { buildChatPrompt } from "../../apps/worker/src/work/chat.ts";
import { processTurnWork } from "../../apps/worker/src/work/processor.ts";
import { runEngineOnce } from "../../apps/worker/src/work/engine.ts";

const behaviorTime = { timezone: "UTC", dayStartHour: 4 };
const tiers = [
  { id: "t0", key: "tier-a", position: 0, minimumFamiliarity: 0, label: "A", prompt: "Prompt A", behavioralGuidance: "Guide A" },
  { id: "t1", key: "tier-b", position: 1, minimumFamiliarity: 0.5, label: "B", prompt: "Prompt B", behavioralGuidance: "Guide B" },
  { id: "t2", key: "tier-c", position: 2, minimumFamiliarity: 0.9, label: "C", prompt: "Prompt C", behavioralGuidance: "Guide C" },
];
const configuration = {
  relationshipType: "configured type",
  behaviorTime,
  tierMovement: {
    enabled: true,
    upMinDays: 2,
    upMinActiveStreak: 2,
    downMissedStreak: 3,
  },
  answerExtractionPrompt: "Use only the supplied evidence.",
  clarificationGuidance: "Ask gently when relevant.",
  tiers,
  questions: [
    { id: "q1", key: "question-a", typeKey: "kind-a", typeGuidance: "Type guidance A", tierId: "t0", tierPosition: 0, text: "Question A?", position: 0 },
    { id: "q2", key: "question-b", typeKey: "kind-b", typeGuidance: "Type guidance B", tierId: "t1", tierPosition: 1, text: "Question B?", position: 1 },
  ],
};

function message(id, role, content) {
  return {
    id,
    seq: Number(id),
    role,
    content,
    turnId: null,
    clientKey: null,
    createdAt: "2026-01-10T12:00:00.000Z",
  };
}

function chatResponse(content) {
  return {
    id: "chat-test",
    model: "fake-chat",
    choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

describe("relationship familiarity semantics", () => {
  it("adds one answer-recording table and seeds no personal configuration", async () => {
    const schema = relationshipMigrations[0].sql;
    assert.equal((schema.match(/CREATE TABLE relationship_answer/g) ?? []).length, 1);
    assert.match(schema, /PRIMARY KEY \(question_id, participant\)/);
    assert.match(schema, /clarification_needed boolean NOT NULL/);
    assert.doesNotMatch(schema, /INSERT INTO/);
    assert.equal(relationshipMigrations[1].id, "0011_relationship_chat_chunk");

    let queryCount = 0;
    const absent = await loadRelationshipConfiguration({
      query: async () => { queryCount += 1; return { rows: [] }; },
    });
    assert.equal(absent, null);
    assert.equal(queryCount, 1, "missing config remains a no-op without guessing defaults");
  });

  it("rejects invalid timezone and incomplete tier configuration with actionable safe errors", async () => {
    const settings = {
      relationship_type: "synthetic type",
      timezone: "UTC",
      day_start_hour: 4,
      tier_movement_enabled: false,
      tier_up_min_days: null,
      tier_up_min_active_streak: null,
      tier_down_missed_streak: null,
      answer_extraction_prompt: "Synthetic extraction instruction.",
      clarification_guidance: "Synthetic clarification guidance.",
    };
    const tierRows = [{
      id: "tier-0", tier_key: "tier-a", position: 0, minimum_familiarity: "0.1",
      label: "A", prompt: "Prompt A", behavioral_guidance: "Guidance A",
    }];
    const questionRows = [{
      id: "question-0", question_key: "question-a", type_key: "kind-a",
      interpretation_guidance: "Type guidance", tier_id: "tier-0", tier_position: 0,
      question_text: "Question?", position: 0,
    }];
    const poolFor = (settingsRow, tiers = tierRows, questions = questionRows) => ({
      query: async (sql) => ({
        rows: sql.includes("FROM relationship_settings") ? [settingsRow]
          : sql.includes("FROM relationship_tier") ? tiers
          : questions,
      }),
    });

    await assert.rejects(
      loadRelationshipConfiguration(poolFor({ ...settings, timezone: "Not/A_Zone" })),
      /valid IANA timezone/,
    );
    await assert.rejects(
      loadRelationshipConfiguration(poolFor(settings)),
      /first relationship tier must have minimum_familiarity 0/,
    );
    await assert.rejects(
      loadRelationshipConfiguration(poolFor(settings, [
        { ...tierRows[0], minimum_familiarity: "0" },
      ], [])),
      /enabled relationship_question rows are required/,
    );
  });

  it("uses the worker startup timezone snapshot instead of rereading the singleton", async () => {
    const calls = [];
    const pool = {
      query: async (sql, values = []) => {
        const text = String(sql);
        calls.push({ text, values });
        if (text.includes("FROM relationship_settings")) {
          return { rows: [{
            relationship_type: "synthetic type",
            timezone: values[0] ?? "UTC",
            day_start_hour: 4,
            tier_movement_enabled: false,
            tier_up_min_days: null,
            tier_up_min_active_streak: null,
            tier_down_missed_streak: null,
            answer_extraction_prompt: "Synthetic extraction instruction.",
            clarification_guidance: "Synthetic clarification guidance.",
          }] };
        }
        if (text.includes("FROM relationship_tier")) {
          return { rows: [{
            id: "tier-0", tier_key: "tier-a", position: 0, minimum_familiarity: "0",
            label: "A", prompt: "Prompt A", behavioral_guidance: "Guidance A",
          }] };
        }
        return { rows: [{
          id: "question-0", question_key: "question-a", type_key: "kind-a",
          interpretation_guidance: "Type guidance", tier_id: "tier-0", tier_position: 0,
          question_text: "Question?", position: 0,
        }] };
      },
    };
    const loaded = await loadRelationshipConfiguration(pool, "Australia/Sydney");
    assert.equal(loaded.behaviorTime.timezone, "Australia/Sydney");
    assert.deepEqual(calls[0].values, ["Australia/Sydney"]);
    assert.doesNotMatch(calls[0].text, /companion_time_settings/);
  });

  it("uses the existing behavioral timezone/day-start semantics for streaks", () => {
    const stats = relationshipDayStreaks({
      now: new Date("2026-01-10T03:59:00.000Z"),
      behaviorTime,
      userActivityAt: [
        new Date("2026-01-07T10:00:00.000Z"),
        new Date("2026-01-08T10:00:00.000Z"),
        new Date("2026-01-09T10:00:00.000Z"),
      ],
    });
    assert.deepEqual(stats, { activeDayStreak: 3, missedDayStreak: 0 });

    const missed = relationshipDayStreaks({
      now: new Date("2026-01-12T10:00:00.000Z"),
      behaviorTime,
      userActivityAt: [
        new Date("2026-01-07T10:00:00.000Z"),
        new Date("2026-01-08T10:00:00.000Z"),
        new Date("2026-01-09T10:00:00.000Z"),
      ],
    });
    assert.deepEqual(missed, { activeDayStreak: 3, missedDayStreak: 3 });
  });

  it("matches pre-aggregated behavioral dates through a DST boundary", () => {
    const behavior = { timezone: "America/New_York", dayStartHour: 4 };
    const userActivityAt = [
      new Date("2026-03-08T07:30:00.000Z"), // 03:30 EDT -> prior behavioral date
      new Date("2026-03-08T08:00:00.000Z"), // 04:00 EDT -> new behavioral date
    ];
    const now = new Date("2026-03-09T08:00:00.000Z");
    const fromInstants = relationshipDayStreaks({ userActivityAt, now, behaviorTime: behavior });
    const fromAggregatedDays = relationshipDayStreaksForDays({
      userActivityDays: ["2026-03-07", "2026-03-08"],
      now,
      behaviorTime: behavior,
    });
    assert.deepEqual(fromAggregatedDays, fromInstants);
    assert.deepEqual(fromAggregatedDays, { activeDayStreak: 2, missedDayStreak: 1 });
  });

  it("loads only a first-message anchor and distinct SQL-derived behavioral dates", async () => {
    const queries = [];
    const pool = {
      query: async (sql, params) => {
        queries.push({ sql, params });
        if (sql.includes("ORDER BY seq LIMIT 1")) {
          return { rows: [{ effective_at: new Date("2026-03-01T12:00:00.000Z") }] };
        }
        if (sql.includes("SELECT DISTINCT")) {
          return { rows: [{ activity_day: "2026-03-07" }, { activity_day: "2026-03-08" }] };
        }
        return { rows: [] };
      },
    };
    const store = createRelationshipStore({
      pool,
      configuration: { ...configuration, behaviorTime: { timezone: "America/New_York", dayStartHour: 4 } },
    });
    const summary = await store.getSummary(new Date("2026-03-09T08:00:00.000Z"));
    assert.equal(queries.length, 3);
    assert.match(queries[0].sql, /ORDER BY seq LIMIT 1/);
    assert.match(queries[1].sql, /SELECT DISTINCT/);
    assert.match(queries[1].sql, /AT TIME ZONE/);
    assert.match(queries[1].sql, /make_interval\(hours => \$2::integer\)/);
    assert.match(queries[1].sql, /to_char[\s\S]*YYYY-MM-DD/);
    assert.deepEqual(queries[1].params, ["America/New_York", 4]);
    assert.deepEqual(summary && [summary.activeDayStreak, summary.missedDayStreak], [2, 1]);
  });

  it("counts separately tracked participant slots and bounds effective movement to one tier", () => {
    const summary = summarizeRelationship({
      configuration,
      firstConversationAt: new Date("2026-01-07T12:00:00.000Z"),
      userActivityAt: [
        new Date("2026-01-08T10:00:00.000Z"),
        new Date("2026-01-09T10:00:00.000Z"),
        new Date("2026-01-10T10:00:00.000Z"),
      ],
      now: new Date("2026-01-10T12:00:00.000Z"),
      answers: [
        { questionId: "q1", questionKey: "question-a", questionText: "Question A?", participant: "user", answer: "A", clarificationNeeded: false },
        { questionId: "q1", questionKey: "question-a", questionText: "Question A?", participant: "assistant", answer: "B", clarificationNeeded: true },
        { questionId: "q2", questionKey: "question-b", questionText: "Question B?", participant: "user", answer: "C", clarificationNeeded: false },
      ],
    });
    assert.equal(summary.firstConversationDate, "2026-01-07");
    assert.equal(summary.timeKnownDays, 3);
    assert.equal(summary.answeredSlots, 3);
    assert.equal(summary.userAnsweredSlots, 2);
    assert.equal(summary.assistantAnsweredSlots, 1);
    assert.equal(summary.eligibleSlots, 4);
    assert.equal(summary.eligibleSlotsPerParticipant, 2);
    assert.equal(summary.familiarity, 0.75);
    assert.equal(summary.baseTier.key, "tier-b");
    assert.equal(summary.effectiveTier.key, "tier-c");
    assert.equal(summary.tierMovement, "up");
    assert.match(renderRelationshipContext(summary), /Clarification-needed interpretations/);
    assert.match(renderRelationshipContext(summary), /Ask gently when relevant/);
  });

  it("moves down at most one tier after a configured missed-day signal", () => {
    const summary = summarizeRelationship({
      configuration,
      firstConversationAt: new Date("2026-01-01T12:00:00.000Z"),
      userActivityAt: [
        new Date("2026-01-06T10:00:00.000Z"),
        new Date("2026-01-07T10:00:00.000Z"),
      ],
      now: new Date("2026-01-10T12:00:00.000Z"),
      answers: Array.from({ length: 4 }, (_, index) => ({
        questionId: index < 2 ? "q1" : "q2",
        questionKey: index < 2 ? "question-a" : "question-b",
        questionText: "Question?",
        participant: index % 2 === 0 ? "user" : "assistant",
        answer: `answer-${index}`,
        clarificationNeeded: false,
      })),
    });
    assert.equal(summary.baseTier.key, "tier-c");
    assert.equal(summary.effectiveTier.key, "tier-b");
    assert.equal(summary.tierMovement, "down");
  });

  it("keeps a downward signal at the lowest base tier clamped instead of falling through upward", () => {
    const summary = summarizeRelationship({
      configuration,
      firstConversationAt: new Date("2026-01-01T12:00:00.000Z"),
      userActivityAt: [
        new Date("2026-01-08T10:00:00.000Z"),
        new Date("2026-01-09T10:00:00.000Z"),
      ],
      now: new Date("2026-01-12T12:00:00.000Z"),
      answers: [],
    });
    assert.equal(summary.baseTier.key, "tier-a");
    assert.equal(summary.activeDayStreak, 2);
    assert.equal(summary.missedDayStreak, 3);
    assert.equal(summary.effectiveTier.key, "tier-a");
    assert.equal(summary.tierMovement, "locked");
  });

  it("accepts only well-shaped answer interpretations", () => {
    assert.deepEqual(parseRelationshipExtraction(JSON.stringify({ answers: [
      { questionKey: "question-a", participant: "user", answer: " interpreted ", clarificationNeeded: true },
    ] })), [{
      questionKey: "question-a", participant: "user", answer: "interpreted", clarificationNeeded: true,
    }]);
    assert.throws(() => parseRelationshipExtraction("not-json"), /invalid JSON/);
    assert.throws(() => parseRelationshipExtraction(JSON.stringify({ answers: [
      { questionKey: "question-a", participant: "assistant", answer: "", clarificationNeeded: false },
    ] })), /invalid fields/);
  });

  it("extracts against current interpretations, then writes one updatable row per participant slot", async () => {
    let prompt;
    const pool = {
      query: async () => ({ rows: [
        { question_key: "question-a", participant: "user", current_answer: "prior", clarification_needed: false },
      ] }),
    };
    const store = createRelationshipStore({ pool, configuration });
    const updates = await store.extractAnswers({
      userText: "new user statement",
      assistantText: "new assistant reply",
      callLlm: async (input) => {
        prompt = JSON.parse(input.userMessage);
        return {
          text: JSON.stringify({ answers: [
            { questionKey: "question-a", participant: "user", answer: "updated", clarificationNeeded: true },
            { questionKey: "question-a", participant: "assistant", answer: "assistant answer", clarificationNeeded: false },
            { questionKey: "unconfigured", participant: "user", answer: "ignored", clarificationNeeded: false },
          ] }),
          finishReason: "stop",
        };
      },
      taskPreset: { maxTokens: 100 },
    });
    assert.equal(prompt.current_interpretations[0].answer, "prior");
    assert.equal(prompt.new_turn.user_messages, "new user statement");
    assert.equal(updates.length, 2);
    assert.equal(updates[0].clarificationNeeded, true);

    const statements = [];
    await store.recordAnswers({
      query: async (sql, values) => { statements.push({ sql, values }); return { rows: [] }; },
    }, updates);
    assert.equal(statements.length, 2);
    assert.ok(statements.every(({ sql }) => sql.includes("INSERT INTO relationship_answer") && sql.includes("ON CONFLICT (question_id, participant) DO UPDATE")));
    assert.deepEqual(statements.map(({ values }) => values.slice(0, 2)), [["q1", "user"], ["q1", "assistant"]]);
  });
});

describe("relationship conversation integration", () => {
  it("classifies relationship as a separate system chunk", () => {
    const built = buildChatPrompt({
      model: "fake-chat",
      identity: "IDENTITY",
      relationship: "RELATIONSHIP",
      history: [],
      turnMessages: [message("1", "user", "hello")],
      guidance: null,
    });
    assert.deepEqual(built.messages.map((item) => item.chunk), ["identity", "relationship", "conversation"]);
    assert.equal(built.request.messages[1].content, "RELATIONSHIP");
  });

  it("degrades to ordinary chat when relationship context and extraction fail", async () => {
    const previousWarn = console.warn;
    const warnings = [];
    console.warn = (...args) => warnings.push(args.join(" "));
    try {
      const result = await processTurnWork({
        turn: { id: "turn-degrade", status: "in_flight", attempt: 1 },
        messages: [message("1", "user", "ordinary message")],
      }, {
        decisionModel: "fake-decision",
        chatModel: "fake-chat",
        callDecisions: async () => { throw new Error("not expected"); },
        callChat: async () => chatResponse("ordinary reply"),
        loadPatterns: async () => [],
        loadIdentity: async () => ({ content: "IDENTITY", revision: 1 }),
        loadContext: async () => [],
        loadRelationshipContext: async () => { throw new Error("synthetic failure"); },
        extractRelationshipAnswers: async () => { throw new Error("synthetic extraction failure"); },
      });
      assert.equal(result.reply, "ordinary reply");
      assert.equal(result.relationshipAnswers, undefined);
      assert.equal(warnings.length, 2);
      assert.ok(warnings.every((warning) => !warning.includes("synthetic")), "logs do not expose raw failure text");
    } finally {
      console.warn = previousWarn;
    }
  });

  it("passes answer updates only through a successful publication transaction", async () => {
    const persisted = [];
    const updates = [{ questionKey: "question-a", participant: "assistant", answer: "reply-derived", clarificationNeeded: false }];
    const claimedWork = {
      turn: { id: "turn-publish", status: "in_flight", attempt: 1 },
      messages: [message("1", "user", "hello")],
    };
    const store = {
      claimNextTurn: async () => ({ kind: "claimed", work: claimedWork }),
      publishReply: async (params) => {
        assert.equal(params.content, "published reply");
        await params.onPublicationTransaction({ query: async () => ({ rows: [] }) });
        return "published";
      },
    };
    await runEngineOnce({
      store,
      processTurn: async () => ({ reply: "published reply", selectedPatternId: null, relationshipAnswers: updates }),
      recordRelationshipAnswers: async (client, answers) => {
        persisted.push(...answers);
        await client.query("relationship answer write");
      },
      leaseSeconds: 3,
      pollSeconds: 1,
    });
    assert.deepEqual(persisted, updates);
  });

  it("learns only the current grouped user messages after the assistant reply", async () => {
    const events = [];
    const work = {
      turn: { id: "turn-a", status: "in_flight", attempt: 1, leaseOwner: "owner", leaseExpiresAt: new Date().toISOString(), selectedPatternId: null, decision: null, error: null, createdAt: new Date().toISOString(), completedAt: null },
      messages: [message("1", "user", "first part"), message("2", "user", "second part")],
    };
    const result = await processTurnWork(work, {
      decisionModel: "fake-decision",
      chatModel: "fake-chat",
      callDecisions: async () => { throw new Error("not expected"); },
      callChat: async () => { events.push("chat"); return chatResponse("assistant reply"); },
      loadPatterns: async () => [],
      loadIdentity: async () => ({ content: "IDENTITY", revision: 1 }),
      loadContext: async () => [],
      loadRelationshipContext: async () => "relationship context",
      extractRelationshipAnswers: async (input) => {
        events.push("extract");
        assert.equal(input.userText, "first part\nsecond part");
        assert.equal(input.assistantText, "assistant reply");
        assert.equal(input.turnId, "turn-a");
        return [{ questionKey: "question-a", participant: "user", answer: "answer", clarificationNeeded: false }];
      },
    });
    assert.deepEqual(events, ["chat", "extract"]);
    assert.equal(result.reply, "assistant reply");
    assert.equal(result.relationshipAnswers.length, 1);
  });
});
