// Focused PostgreSQL coverage for relationship configuration and the atomic
// answer-write publication hook. Uses synthetic configuration only and no
// provider/network calls. This suite is skipped without an explicitly supplied
// isolated disposable WORKER_TEST_DATABASE_URL.

import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  closePostgresPool,
  createPostgresPool,
  runMigrations,
} from "../../libraries/postgres/src/index.ts";
import { conversationMigrations } from "../../apps/worker/src/conversation/migrations.ts";
import { memoryMigrations } from "../../apps/worker/src/memory/migrations.ts";
import { engagementMigrations } from "../../apps/worker/src/engagement/migrations.ts";
import { articleMigrations } from "../../apps/worker/src/articles/migrations.ts";
import { relationshipMigrations } from "../../apps/worker/src/relationship/migrations.ts";
import { temporalMigrations } from "../../apps/worker/src/temporal/migrations.ts";
import { behavioralDay } from "../../apps/worker/src/memory/time.ts";
import {
  createConversationStore,
} from "../../apps/worker/src/conversation/store.ts";
import {
  createRelationshipStore,
  loadRelationshipConfiguration,
  RelationshipConfigurationError,
} from "../../apps/worker/src/relationship/store.ts";

const DATABASE_URL = process.env.WORKER_TEST_DATABASE_URL;
const hasDatabase = typeof DATABASE_URL === "string" && DATABASE_URL.length > 0;
const TIER_ID = "10000000-0000-4000-8000-000000000001";
const QUESTION_ID = "10000000-0000-4000-8000-000000000002";
const COMPOSED_MIGRATIONS = [
  ...conversationMigrations,
  ...memoryMigrations,
  ...engagementMigrations,
  ...articleMigrations,
  ...relationshipMigrations,
  ...temporalMigrations,
];

describe("relationship familiarity (PostgreSQL)", { skip: !hasDatabase }, () => {
  let pool;
  let conversationStore;
  let relationshipStore;

  before(async () => {
    pool = createPostgresPool({ connectionString: DATABASE_URL });
    await runMigrations(pool, COMPOSED_MIGRATIONS);
    await pool.query(
      `UPDATE companion_time_settings SET timezone = 'UTC' WHERE id = true`,
    );
    await pool.query(
      `INSERT INTO relationship_settings
         (id, relationship_type, timezone, day_start_hour, tier_movement_enabled,
          answer_extraction_prompt, clarification_guidance)
       VALUES (true, 'synthetic relationship', 'UTC', 4, false,
               'Synthetic extraction instruction.', 'Synthetic clarification guidance.')
       ON CONFLICT (id) DO UPDATE SET
         relationship_type = EXCLUDED.relationship_type,
         timezone = EXCLUDED.timezone,
         day_start_hour = EXCLUDED.day_start_hour,
         tier_movement_enabled = EXCLUDED.tier_movement_enabled,
         tier_up_min_days = NULL,
         tier_up_min_active_streak = NULL,
         tier_down_missed_streak = NULL,
         answer_extraction_prompt = EXCLUDED.answer_extraction_prompt,
         clarification_guidance = EXCLUDED.clarification_guidance`,
    );
    await pool.query(
      `INSERT INTO relationship_tier
         (id, tier_key, position, minimum_familiarity, label, prompt, behavioral_guidance)
       VALUES ($1, 'synthetic-tier', 0, 0, 'Synthetic tier', 'Synthetic prompt', 'Synthetic behavior')
       ON CONFLICT (id) DO NOTHING`,
      [TIER_ID],
    );
    await pool.query(
      `INSERT INTO relationship_question_type (type_key, interpretation_guidance)
       VALUES ('synthetic-type', 'Synthetic type guidance')
       ON CONFLICT (type_key) DO UPDATE SET interpretation_guidance = EXCLUDED.interpretation_guidance`,
    );
    await pool.query(
      `INSERT INTO relationship_question
         (id, question_key, type_key, tier_id, question_text, enabled, position)
       VALUES ($1, 'synthetic-question', 'synthetic-type', $2,
               'Synthetic question?', true, 0)
       ON CONFLICT (id) DO NOTHING`,
      [QUESTION_ID, TIER_ID],
    );
    conversationStore = createConversationStore(pool);
    const configuration = await loadRelationshipConfiguration(pool);
    assert.ok(configuration);
    relationshipStore = createRelationshipStore({ pool, configuration });
  });

  after(async () => {
    if (pool !== undefined) await closePostgresPool(pool);
  });

  beforeEach(async () => {
    await pool.query(
      `TRUNCATE relationship_answer, conversation_message, conversation_turn,
        response_pattern, trace_attempt, trace_attempt_context,
        trace_attempt_pattern, trace_attempt_decision,
        trace_attempt_decision_probability, trace_attempt_chat,
        trace_attempt_chat_message, trace_attempt_chat_choice
       RESTART IDENTITY CASCADE`,
    );
    // Exercise configuration reset too: no answer content or conversation
    // history survives between tests.
    await pool.query(
      `UPDATE companion_time_settings SET timezone = 'UTC' WHERE id = true`,
    );
    await pool.query(
      `UPDATE relationship_settings SET timezone = 'UTC', day_start_hour = 4,
       tier_movement_enabled = false, tier_up_min_days = NULL,
       tier_up_min_active_streak = NULL, tier_down_missed_streak = NULL
       WHERE id = true`,
    );
  });

  it("applies migrations idempotently and validates runtime configuration", async () => {
    const result = await runMigrations(pool, COMPOSED_MIGRATIONS);
    assert.deepEqual(result.applied, []);
    const tableResult = await pool.query(
      `SELECT to_regclass('relationship_settings') AS settings,
              to_regclass('relationship_question_type') AS question_type,
              to_regclass('relationship_question') AS question,
              to_regclass('relationship_answer') AS answer`,
    );
    assert.deepEqual(tableResult.rows[0], {
      settings: "relationship_settings",
      question_type: "relationship_question_type",
      question: "relationship_question",
      answer: "relationship_answer",
    });
    const constraint = await pool.query(
      `SELECT pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
       WHERE conrelid = 'trace_attempt_chat_message'::regclass
         AND conname = 'trace_attempt_chat_message_chunk_check'`,
    );
    assert.match(constraint.rows[0].definition, /relationship/);

    const behaviorTime = { timezone: "America/New_York", dayStartHour: 4 };
    const instants = [
      new Date("2026-03-08T06:59:59.000Z"),
      new Date("2026-03-08T07:00:00.000Z"),
      new Date("2026-03-08T08:00:00.000Z"),
      new Date("2026-11-01T05:30:00.000Z"),
      new Date("2026-11-01T06:30:00.000Z"),
      new Date("2026-11-01T09:00:00.000Z"),
    ];
    const dayExpressions = instants.map((_, index) => `($${index + 3}::timestamptz)`).join(", ");
    const postgresDays = await pool.query(
      `SELECT to_char(
                ((instant AT TIME ZONE $1::text) -
                  make_interval(hours => $2::integer))::date,
                'YYYY-MM-DD'
              ) AS activity_day
       FROM (VALUES ${dayExpressions}) AS timestamps(instant)
       ORDER BY instant`,
      [behaviorTime.timezone, behaviorTime.dayStartHour, ...instants],
    );
    assert.deepEqual(
      postgresDays.rows.map((row) => row.activity_day),
      instants.map((instant) => behavioralDay(instant, behaviorTime)),
      "PostgreSQL local-civil-date aggregation must match the existing ICU DST/day-boundary semantics",
    );

    await pool.query(`UPDATE companion_time_settings SET timezone = 'Invalid/Zone' WHERE id = true`);
    await assert.rejects(loadRelationshipConfiguration(pool), RelationshipConfigurationError);
  });

  it("summarizes first-recorded date, user-only dates, future activity, and persisted participant answers", async () => {
    await pool.query(
      `UPDATE companion_time_settings SET timezone = 'America/New_York' WHERE id = true`,
    );
    await pool.query(
      `UPDATE relationship_settings SET timezone = 'America/New_York', day_start_hour = 4 WHERE id = true`,
    );
    const configuration = await loadRelationshipConfiguration(pool);
    assert.ok(configuration);
    const summaryStore = createRelationshipStore({ pool, configuration });

    const first = await conversationStore.appendUserMessage({
      content: "synthetic first user message",
      clientSentAt: "2026-03-06T12:00:00.000Z",
    });
    await conversationStore.appendUserMessage({
      content: "synthetic next user message",
      clientSentAt: "2026-03-07T12:00:00.000Z",
    });
    const future = await conversationStore.appendUserMessage({
      content: "synthetic future user message",
      clientSentAt: "2026-03-08T12:00:00.000Z",
    });
    await pool.query(
      `UPDATE conversation_message SET effective_at = $2::timestamptz WHERE id = $1`,
      [future.id, "2026-03-10T12:00:00.000Z"],
    );
    const claim = await conversationStore.claimNextTurn({ owner: "relationship-summary-owner", leaseSeconds: 60 });
    assert.equal(claim.kind, "claimed");
    assert.equal(await conversationStore.publishReply({
      turnId: claim.work.turn.id,
      leaseOwner: "relationship-summary-owner",
      content: "synthetic assistant response",
    }), "published");
    // Place the assistant row inside the summary's current behavioral date so
    // this test proves assistant activity is excluded independently of the
    // future-user-date filter.
    await pool.query(
      `UPDATE conversation_message SET effective_at = $2::timestamptz
       WHERE turn_id = $1 AND role = 'assistant'`,
      [claim.work.turn.id, "2026-03-09T08:00:00.000Z"],
    );

    await pool.query(
      `INSERT INTO relationship_answer
         (question_id, participant, current_answer, clarification_needed)
       VALUES ($1, 'user', 'synthetic persisted answer', true)`,
      [QUESTION_ID],
    );
    const summary = await summaryStore.getSummary(new Date("2026-03-09T08:00:00.000Z"));
    assert.equal(first.effectiveAt, "2026-03-06T12:00:00.000Z");
    assert.equal(summary.firstConversationDate, "2026-03-06");
    assert.equal(summary.timeKnownDays, 3);
    assert.equal(summary.activeDayStreak, 2);
    assert.equal(summary.missedDayStreak, 2);
    assert.equal(summary.userAnsweredSlots, 1);
    assert.equal(summary.assistantAnsweredSlots, 0);
    assert.equal(summary.familiarity, 0.5);
    assert.deepEqual(summary.answers.map((answer) => [
      answer.participant, answer.answer, answer.clarificationNeeded,
    ]), [["user", "synthetic persisted answer", true]]);
  });

  it("fences answer writes, commits them with publication, and makes duplicate publication a no-op", async () => {
    await conversationStore.appendUserMessage({ content: "synthetic user input" });
    const claim = await conversationStore.claimNextTurn({ owner: "relationship-owner-1", leaseSeconds: 60 });
    assert.equal(claim.kind, "claimed");
    let hookCalls = 0;
    const updates = [{
      questionKey: "synthetic-question",
      participant: "user",
      answer: "synthetic interpreted answer",
      clarificationNeeded: true,
    }];
    const publishArgs = {
      turnId: claim.work.turn.id,
      leaseOwner: "relationship-owner-1",
      content: "synthetic assistant reply",
      onPublicationTransaction: async (client) => {
        hookCalls += 1;
        await relationshipStore.recordAnswers(client, updates);
      },
    };

    const fenced = await conversationStore.publishReply({
      ...publishArgs,
      leaseOwner: "not-the-owner",
    });
    assert.equal(fenced, "fenced");
    assert.equal(hookCalls, 0);
    assert.equal((await pool.query(`SELECT count(*)::int AS count FROM relationship_answer`)).rows[0].count, 0);

    assert.equal(await conversationStore.publishReply(publishArgs), "published");
    assert.equal(hookCalls, 1);
    const saved = await pool.query(
      `SELECT participant, current_answer, clarification_needed
       FROM relationship_answer WHERE question_id = $1`,
      [QUESTION_ID],
    );
    assert.deepEqual(saved.rows, [{
      participant: "user",
      current_answer: "synthetic interpreted answer",
      clarification_needed: true,
    }]);

    assert.equal(await conversationStore.publishReply(publishArgs), "already_published");
    assert.equal(hookCalls, 1, "duplicate publication must not replay the answer hook");
    assert.equal((await pool.query(`SELECT count(*)::int AS count FROM relationship_answer`)).rows[0].count, 1);
  });

  it("rolls back partial optional answer writes to a savepoint without blocking reply publication", async () => {
    await conversationStore.appendUserMessage({ content: "second synthetic user input" });
    const claim = await conversationStore.claimNextTurn({ owner: "relationship-owner-2", leaseSeconds: 60 });
    assert.equal(claim.kind, "claimed");
    const previousAnswer = await pool.query(
      `INSERT INTO relationship_answer (question_id, participant, current_answer)
       VALUES ($1, 'user', 'previous answer') RETURNING current_answer`,
      [QUESTION_ID],
    );
    assert.equal(previousAnswer.rows[0].current_answer, "previous answer");

    const oldWarn = console.warn;
    const warnings = [];
    console.warn = (...args) => warnings.push(args.join(" "));
    try {
      const outcome = await conversationStore.publishReply({
        turnId: claim.work.turn.id,
        leaseOwner: "relationship-owner-2",
        content: "second synthetic assistant reply",
        onPublicationTransaction: async (client) => {
          await relationshipStore.recordAnswers(client, [{
            questionKey: "synthetic-question",
            participant: "user",
            answer: "partial replacement",
            clarificationNeeded: false,
          }]);
          // Deliberately violate the participant CHECK after a valid write.
          await client.query(
            `INSERT INTO relationship_answer (question_id, participant, current_answer)
             VALUES ($1, 'invalid-participant', 'invalid')`,
            [QUESTION_ID],
          );
        },
      });
      assert.equal(outcome, "published");
      assert.equal(warnings.length, 1);
    } finally {
      console.warn = oldWarn;
    }
    const answer = await pool.query(
      `SELECT current_answer FROM relationship_answer WHERE question_id = $1 AND participant = 'user'`,
      [QUESTION_ID],
    );
    assert.equal(answer.rows[0].current_answer, "previous answer");
    const reply = await pool.query(
      `SELECT content FROM conversation_message WHERE turn_id = $1 AND role = 'assistant'`,
      [claim.work.turn.id],
    );
    assert.deepEqual(reply.rows, [{ content: "second synthetic assistant reply" }]);
  });
});
