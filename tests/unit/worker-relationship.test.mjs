import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  relationshipDayStreaks,
  relationshipDayStreaksForDays,
  selectInitiativeQuestions,
  selectUnansweredQuestionsForExtraction,
  summarizeRelationship,
  renderRelationshipContext,
  mainReplyMaxTokensForBaseTierOrdinal,
  mainReplyMaxTokensForSummary,
  mainReplyProviderMaxTokensForBaseTierOrdinal,
  mainReplyReasoningHeadroomTokens,
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
    const rendered = renderRelationshipContext(summary);
    assert.match(rendered, /Stage: C \(base: B, movement: up; familiarity 75\.0%\)/);
    assert.match(rendered, /Prompt C/);
    assert.match(rendered, /Guide C/);
    assert.ok(!rendered.includes("Clarification-needed interpretations"), "clarification answer dump stays out of familiarity chunk");
    assert.ok(!rendered.includes("Current interpreted shared answers"), "answer bank dump stays out of familiarity chunk");
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

describe("relationship extraction question bound", () => {
  function syntheticQuestion(key, tierPosition, position) {
    return {
      id: `id-${key}`,
      key,
      typeKey: "kind",
      typeGuidance: "guidance",
      tierId: "t0",
      tierPosition,
      text: `${key}?`,
      position,
    };
  }

  function bankOf(...questions) {
    return { ...configuration, questions };
  }

  function largeBank(count) {
    return bankOf(...Array.from({ length: count }, (_, index) =>
      syntheticQuestion(`question-${index}`, 0, index),
    ));
  }

  it("bounds a large bank to the first five by configured rank order", () => {
    const selected = selectUnansweredQuestionsForExtraction({
      configuration: largeBank(200),
      answers: [],
    });
    assert.equal(selected.length, 5);
    assert.deepEqual(
      selected.map((question) => question.key),
      ["question-0", "question-1", "question-2", "question-3", "question-4"],
    );
  });

  it("ranks by tier position, then question position, then question key", () => {
    const selected = selectUnansweredQuestionsForExtraction({
      configuration: bankOf(
        syntheticQuestion("question-b", 1, 0),
        syntheticQuestion("question-a", 0, 5),
        syntheticQuestion("question-d", 0, 3),
        syntheticQuestion("question-c", 0, 3),
      ),
      answers: [],
      limit: 4,
    });
    assert.deepEqual(
      selected.map((question) => question.key),
      ["question-c", "question-d", "question-a", "question-b"],
    );
  });

  it("excludes fully answered questions but keeps partially answered ones", () => {
    const selected = selectUnansweredQuestionsForExtraction({
      configuration: largeBank(6),
      answers: [
        { questionKey: "question-0", participant: "user" },
        { questionKey: "question-0", participant: "assistant" },
        { questionKey: "question-1", participant: "user" },
        { questionKey: "question-1", participant: "assistant" },
        { questionKey: "question-2", participant: "user" },
        { questionKey: "question-3", participant: "assistant" },
      ],
    });
    assert.deepEqual(
      selected.map((question) => question.key),
      ["question-2", "question-3", "question-4", "question-5"],
    );
  });

  it("handles small, empty, and fully answered banks, and honors the limit", () => {
    assert.deepEqual(
      selectUnansweredQuestionsForExtraction({ configuration: bankOf(), answers: [] }),
      [],
    );
    assert.deepEqual(
      selectUnansweredQuestionsForExtraction({
        configuration: bankOf(syntheticQuestion("question-only", 0, 0)),
        answers: [],
      }).map((question) => question.key),
      ["question-only"],
    );
    assert.deepEqual(
      selectUnansweredQuestionsForExtraction({
        configuration: bankOf(syntheticQuestion("question-only", 0, 0)),
        answers: [
          { questionKey: "question-only", participant: "user" },
          { questionKey: "question-only", participant: "assistant" },
        ],
      }),
      [],
    );
    assert.deepEqual(
      selectUnansweredQuestionsForExtraction({
        configuration: bankOf(
          syntheticQuestion("question-a", 0, 0),
          syntheticQuestion("question-b", 0, 1),
        ),
        answers: [],
        limit: 1,
      }).map((question) => question.key),
      ["question-a"],
    );
    assert.deepEqual(
      selectUnansweredQuestionsForExtraction({
        configuration: bankOf(syntheticQuestion("question-a", 0, 0)),
        answers: [],
        limit: 0,
      }),
      [],
    );
    assert.throws(
      () => selectUnansweredQuestionsForExtraction({
        configuration: bankOf(syntheticQuestion("question-a", 0, 0)),
        answers: [],
        limit: -1,
      }),
      RangeError,
    );
  });

  it("bounds the actual extraction prompt and filters prior interpretations to it", async () => {
    let prompt;
    const pool = {
      query: async () => ({ rows: [
        { question_key: "question-0", participant: "user", current_answer: "answered zero user", clarification_needed: false },
        { question_key: "question-0", participant: "assistant", current_answer: "answered zero assistant", clarification_needed: false },
        { question_key: "question-1", participant: "user", current_answer: "prior one", clarification_needed: true },
      ] }),
    };
    const store = createRelationshipStore({ pool, configuration: largeBank(200) });
    const updates = await store.extractAnswers({
      userText: "hello",
      assistantText: "reply",
      callLlm: async (input) => {
        prompt = JSON.parse(input.userMessage);
        return { text: JSON.stringify({ answers: [] }), finishReason: "stop" };
      },
      taskPreset: { maxTokens: 100 },
    });
    assert.deepEqual(
      prompt.questions.map((question) => question.questionKey),
      ["question-1", "question-2", "question-3", "question-4", "question-5"],
    );
    assert.deepEqual(prompt.current_interpretations, [
      { questionKey: "question-1", participant: "user", answer: "prior one", clarificationNeeded: true },
    ]);
    assert.deepEqual(updates, []);
  });

  it("still accepts returned keys from the full bank", async () => {
    const pool = {
      query: async () => ({ rows: [] }),
    };
    const store = createRelationshipStore({ pool, configuration: largeBank(200) });
    const updates = await store.extractAnswers({
      userText: "hello",
      assistantText: "reply",
      callLlm: async () => ({
        text: JSON.stringify({ answers: [
          { questionKey: "question-100", participant: "user", answer: "accepted", clarificationNeeded: false },
          { questionKey: "unconfigured", participant: "user", answer: "ignored", clarificationNeeded: false },
        ] }),
        finishReason: "stop",
      }),
      taskPreset: { maxTokens: 100 },
    });
    assert.deepEqual(updates.map((item) => item.questionKey), ["question-100"]);
  });

  it("keeps both answered and unanswered questions out of the slim familiarity context", () => {
    const summary = summarizeRelationship({
      configuration,
      firstConversationAt: new Date("2026-01-07T12:00:00.000Z"),
      userActivityAt: [],
      now: new Date("2026-01-10T12:00:00.000Z"),
      answers: [
        { questionId: "q1", questionKey: "question-a", questionText: "Question A?", participant: "user", answer: "A", clarificationNeeded: false },
      ],
    });
    const rendered = renderRelationshipContext(summary);
    assert.ok(!rendered.includes("Question A?"), "answer bank dump is decoupled from familiarity context");
    assert.ok(!rendered.includes("Question B?"), "unanswered bank questions are not injected into ordinary chat context");
    assert.match(rendered, /familiarity 25\.0%/);
  });
});

describe("curated initiative question selector", () => {
  const now = new Date("2026-06-15T12:00:00.000Z");
  const richConfig = {
    ...configuration,
    questions: [
      { id: "q1", key: "fav-music", typeKey: "k", typeGuidance: "g", tierId: "t0", tierPosition: 0, text: "What is your favorite band or music?", position: 0 },
      { id: "q2", key: "fav-color", typeKey: "k", typeGuidance: "g", tierId: "t0", tierPosition: 0, text: "What is your favorite color?", position: 1 },
      { id: "q3", key: "pets", typeKey: "k", typeGuidance: "g", tierId: "t0", tierPosition: 0, text: "Do you have any pets or dogs?", position: 2 },
      { id: "q4", key: "coffee", typeKey: "k", typeGuidance: "g", tierId: "t0", tierPosition: 0, text: "How do you take your coffee?", position: 3 },
      { id: "q5", key: "hometown", typeKey: "k", typeGuidance: "g", tierId: "t0", tierPosition: 0, text: "Where did you grow up?", position: 4 },
      { id: "q6", key: "cooking", typeKey: "k", typeGuidance: "g", tierId: "t0", tierPosition: 0, text: "Do you enjoy cooking dinner?", position: 5 },
      { id: "q7", key: "deep-goal", typeKey: "k", typeGuidance: "g", tierId: "t2", tierPosition: 2, text: "What is your biggest life goal?", position: 6 },
    ],
  };

  it("prioritizes topic-relevant, random unanswered, clarification, and old revisits within limit", () => {
    const answers = [
      // Clarification-needed answer
      {
        questionId: "q4",
        questionKey: "coffee",
        questionText: "How do you take your coffee?",
        participant: "user",
        answer: "maybe black",
        clarificationNeeded: true,
        updatedAt: new Date("2026-06-10T12:00:00.000Z"),
      },
      // Old settled answer (> 30 days ago) -> eligible for revisit
      {
        questionId: "q1",
        questionKey: "fav-music",
        questionText: "What is your favorite band or music?",
        participant: "user",
        answer: "Radiohead",
        clarificationNeeded: false,
        updatedAt: new Date("2026-04-01T12:00:00.000Z"),
      },
      // Recent settled answer (5 days ago) -> must NOT be asked
      {
        questionId: "q5",
        questionKey: "hometown",
        questionText: "Where did you grow up?",
        participant: "user",
        answer: "Portland",
        clarificationNeeded: false,
        updatedAt: new Date("2026-06-10T12:00:00.000Z"),
      },
    ];
    const summary = summarizeRelationship({
      configuration: richConfig,
      firstConversationAt: new Date("2026-01-01T12:00:00.000Z"),
      userActivityAt: [],
      now,
      answers,
    });
    const picked = selectInitiativeQuestions({
      configuration: richConfig,
      summary,
      recentText: "I walked my dog at the park and started cooking pasta.",
      now,
      limit: 4,
      random: () => 0,
    });
    assert.equal(picked.length, 4);
    assert.equal(new Set(picked.map((q) => q.questionKey)).size, 4, "no duplicates");
    // Relevant questions matched ("dogs" -> pets, "cooking" -> cooking) come first.
    assert.deepEqual(
      picked.slice(0, 2).map((q) => q.questionKey).sort(),
      ["cooking", "pets"],
    );
    assert.ok(picked.slice(0, 2).every((q) => q.reason === "relevant"));
    // Unanswered + clarification fill the remaining slots; recent settled hometown is excluded.
    assert.ok(!picked.some((q) => q.questionKey === "hometown"));
    assert.ok(picked.some((q) => q.questionKey === "fav-color" && q.reason === "unanswered"));
    assert.ok(picked.some((q) => q.questionKey === "coffee" && q.reason === "clarification" && q.priorAnswer === "maybe black"));
  });

  it("includes an old settled answer revisit when room allows", () => {
    const answers = [
      {
        questionId: "q1",
        questionKey: "fav-music",
        questionText: "What is your favorite band or music?",
        participant: "user",
        answer: "Radiohead",
        clarificationNeeded: false,
        updatedAt: new Date("2026-04-01T12:00:00.000Z"),
      },
    ];
    const summary = summarizeRelationship({
      configuration: richConfig,
      firstConversationAt: new Date("2026-01-01T12:00:00.000Z"),
      userActivityAt: [],
      now,
      answers,
    });
    const picked = selectInitiativeQuestions({
      configuration: richConfig,
      summary,
      recentText: "just chilling",
      now,
      limit: 4,
      random: () => 0.4,
    });
    assert.equal(picked.length, 4);
    const revisit = picked.find((q) => q.questionKey === "fav-music");
    assert.ok(revisit, "old settled answer should be eligible for revisit");
    assert.equal(revisit.reason, "revisit");
    assert.equal(revisit.priorAnswer, "Radiohead");
    assert.equal(revisit.priorAnswerAgeDays, 75);
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

describe("main reply output budget by base familiarity tier", () => {
  it("is 500 at the first tier and adds 100 per successive tier", () => {
    assert.equal(mainReplyMaxTokensForBaseTierOrdinal(0), 500);
    assert.equal(mainReplyMaxTokensForBaseTierOrdinal(1), 600);
    assert.equal(mainReplyMaxTokensForBaseTierOrdinal(2), 700);
    assert.equal(mainReplyMaxTokensForBaseTierOrdinal(5), 1000);
    assert.throws(() => mainReplyMaxTokensForBaseTierOrdinal(-1), RangeError);
    assert.throws(() => mainReplyMaxTokensForBaseTierOrdinal(0.5), RangeError);
  });

  it("tracks the base tier ordinal, not the transient effective tier", () => {
    // Familiarity 3/4 -> base tier-b (ordinal 1) with an active streak
    // moving the effective tier up to tier-c; the budget must stay at
    // the base-derived 600, not the effective-tier 700.
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
    assert.equal(summary.baseTier.key, "tier-b");
    assert.equal(summary.baseTierOrdinal, 1);
    assert.equal(summary.effectiveTier.key, "tier-c");
    assert.equal(mainReplyMaxTokensForSummary(summary), 600);
    assert.match(renderRelationshipContext(summary), /at most about 600 output tokens/);
    assert.match(renderRelationshipContext(summary), /keep this reply concise/);
  });

  it("sends the tier-derived max_tokens on the actual chat request and traces it", async () => {
    const requests = [];
    const work = {
      turn: { id: "turn-budget", status: "in_flight", attempt: 1 },
      messages: [message("1", "user", "hello")],
    };
    const result = await processTurnWork(work, {
      decisionModel: "fake-decision",
      chatModel: "fake-chat",
      callDecisions: async () => { throw new Error("not expected"); },
      callChat: async (request) => { requests.push(request); return chatResponse("short reply"); },
      loadPatterns: async () => [],
      loadIdentity: async () => ({ content: "IDENTITY", revision: 1 }),
      loadContext: async () => [],
      loadRelationshipContext: async () => ({ context: "RELATIONSHIP", baseTierOrdinal: 2 }),
      recordChatRequest: async () => {},
      recordChatOutcome: async () => {},
    });
    assert.equal(result.reply, "short reply");
    assert.equal(requests.length, 1);
    assert.equal(requests[0].max_tokens, 700);
  });

  it("uses 500 when relationship is disabled (first tier) and keeps an explicit static override when no ordinal is supplied", async () => {
    const work = {
      turn: { id: "turn-budget-disabled", status: "in_flight", attempt: 1 },
      messages: [message("1", "user", "hello")],
    };
    const base = {
      decisionModel: "fake-decision",
      chatModel: "fake-chat",
      callDecisions: async () => { throw new Error("not expected"); },
      loadPatterns: async () => [],
      loadIdentity: async () => ({ content: "IDENTITY", revision: 1 }),
      loadContext: async () => [],
    };
    let disabledRequest;
    await processTurnWork(work, {
      ...base,
      callChat: async (request) => { disabledRequest = request; return chatResponse("reply"); },
      loadRelationshipContext: async () => ({ context: null, baseTierOrdinal: 0 }),
    });
    assert.equal(disabledRequest.max_tokens, 500);

    let overrideRequest;
    await processTurnWork(work, {
      ...base,
      maxTokens: 1234,
      callChat: async (request) => { overrideRequest = request; return chatResponse("reply"); },
      loadRelationshipContext: async () => "legacy string context",
    });
    assert.equal(overrideRequest.max_tokens, 1234);
  });

  it("adds effort-scaled reasoning headroom to tier-derived provider max_tokens without changing visible prompt target", async () => {
    assert.equal(mainReplyReasoningHeadroomTokens(undefined), 0);
    assert.equal(mainReplyReasoningHeadroomTokens("none"), 0);
    assert.equal(mainReplyReasoningHeadroomTokens("minimal"), 500);
    assert.equal(mainReplyReasoningHeadroomTokens("low"), 1000);
    assert.equal(mainReplyReasoningHeadroomTokens("medium"), 2000);
    assert.equal(mainReplyReasoningHeadroomTokens("high"), 3500);
    assert.equal(mainReplyReasoningHeadroomTokens("xhigh"), 5000);
    assert.equal(mainReplyReasoningHeadroomTokens("max"), 8000);

    assert.equal(mainReplyProviderMaxTokensForBaseTierOrdinal(1, undefined), 600);
    assert.equal(mainReplyProviderMaxTokensForBaseTierOrdinal(1, "none"), 600);
    assert.equal(mainReplyProviderMaxTokensForBaseTierOrdinal(1, "high"), 4100);
    assert.equal(mainReplyProviderMaxTokensForBaseTierOrdinal(0, "high"), 4000);

    const work = {
      turn: { id: "turn-reasoning-headroom", status: "in_flight", attempt: 1 },
      messages: [message("1", "user", "hello")],
    };
    const base = {
      decisionModel: "fake-decision",
      chatModel: "fake-chat",
      callDecisions: async () => { throw new Error("not expected"); },
      loadPatterns: async () => [],
      loadIdentity: async () => ({ content: "IDENTITY", revision: 1 }),
      loadContext: async () => [],
    };

    let highRequest;
    await processTurnWork(work, {
      ...base,
      chatReasoningEffort: "high",
      callChat: async (request) => { highRequest = request; return chatResponse("reply"); },
      loadRelationshipContext: async () => ({ context: "RELATIONSHIP", baseTierOrdinal: 1 }),
    });
    assert.equal(highRequest.max_tokens, 4100);
    assert.deepEqual(highRequest.reasoning, { effort: "high", exclude: true });

    let noneRequest;
    await processTurnWork(work, {
      ...base,
      chatReasoningEffort: "none",
      callChat: async (request) => { noneRequest = request; return chatResponse("reply"); },
      loadRelationshipContext: async () => ({ context: "RELATIONSHIP", baseTierOrdinal: 1 }),
    });
    assert.equal(noneRequest.max_tokens, 600);

    // Explicit static maxTokens override without a tier ordinal stays verbatim.
    let staticRequest;
    await processTurnWork(work, {
      ...base,
      chatReasoningEffort: "high",
      maxTokens: 1234,
      callChat: async (request) => { staticRequest = request; return chatResponse("reply"); },
      loadRelationshipContext: async () => "legacy string context",
    });
    assert.equal(staticRequest.max_tokens, 1234);
  });
});
