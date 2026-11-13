import type { PostgresPool, PostgresPoolClient } from "@companion/postgres";
import type { MemoryLlmCaller, TaskPreset } from "../memory/llm.ts";
import { isValidTimezone } from "../memory/time.ts";
import type {
  RelationshipAnswer,
  RelationshipConfiguration,
  RelationshipExtractionItem,
  RelationshipParticipant,
  RelationshipSummary,
  RelationshipTier,
} from "./types.ts";
import { summarizeRelationship } from "./runtime.ts";

export class RelationshipConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RelationshipConfigurationError";
  }
}

interface SettingsRow {
  relationship_type: string;
  timezone: string | null;
  day_start_hour: number;
  tier_movement_enabled: boolean;
  tier_up_min_days: number | null;
  tier_up_min_active_streak: number | null;
  tier_down_missed_streak: number | null;
  answer_extraction_prompt: string;
  clarification_guidance: string;
}
interface TierRow {
  id: string;
  tier_key: string;
  position: number;
  minimum_familiarity: string | number;
  label: string;
  prompt: string;
  behavioral_guidance: string;
}
interface QuestionRow {
  id: string;
  question_key: string;
  type_key: string;
  interpretation_guidance: string;
  tier_id: string;
  tier_position: number;
  question_text: string;
  position: number;
}
interface AnswerRow {
  question_id: string;
  question_key: string;
  question_text: string;
  participant: string;
  current_answer: string;
  clarification_needed: boolean;
}
interface FirstMessageRow { effective_at: Date; }
interface BehavioralDayRow { activity_day: string; }

function nonEmpty(value: string): boolean {
  return value.trim().length > 0;
}

function validateConfiguration(
  settings: SettingsRow,
  tiers: readonly RelationshipTier[],
  questions: readonly RelationshipConfiguration["questions"][number][],
): void {
  if (!nonEmpty(settings.relationship_type)) {
    throw new RelationshipConfigurationError("relationship_settings.relationship_type is empty");
  }
  if (!nonEmpty(settings.answer_extraction_prompt)) {
    throw new RelationshipConfigurationError("relationship_settings.answer_extraction_prompt is empty");
  }
  if (!nonEmpty(settings.clarification_guidance)) {
    throw new RelationshipConfigurationError("relationship_settings.clarification_guidance is empty");
  }
  if (tiers.length === 0 || questions.length === 0) {
    throw new RelationshipConfigurationError("relationship_tier and enabled relationship_question rows are required");
  }
  if (tiers[0]!.minimumFamiliarity !== 0) {
    throw new RelationshipConfigurationError("the first relationship tier must have minimum_familiarity 0");
  }
  for (let i = 1; i < tiers.length; i += 1) {
    if (
      tiers[i]!.position <= tiers[i - 1]!.position ||
      tiers[i]!.minimumFamiliarity <= tiers[i - 1]!.minimumFamiliarity
    ) {
      throw new RelationshipConfigurationError("relationship tiers must have strictly increasing positions and familiarity thresholds");
    }
  }
  if (settings.tier_movement_enabled && (
    settings.tier_up_min_days === null ||
    settings.tier_up_min_active_streak === null ||
    settings.tier_down_missed_streak === null
  )) {
    throw new RelationshipConfigurationError("enabled tier movement requires all three positive thresholds");
  }
}

/**
 * Load personal/runtime configuration. A missing settings singleton disables
 * this domain; malformed or incomplete configuration is a safe no-op error
 * that the composition edge logs without printing config content.
 */
export async function loadRelationshipConfiguration(
  pool: PostgresPool,
  authoritativeTimezone?: string | null,
): Promise<RelationshipConfiguration | null> {
  const timezoneExpression = authoritativeTimezone === undefined ? "t.timezone" : "$1::text";
  const settingsJoin = authoritativeTimezone === undefined
    ? "CROSS JOIN companion_time_settings t"
    : "";
  const settingsPredicate = authoritativeTimezone === undefined ? " AND t.id = true" : "";
  const settingsResult = await pool.query<SettingsRow>(
    `SELECT r.relationship_type, ${timezoneExpression} AS timezone, r.day_start_hour, r.tier_movement_enabled,
            r.tier_up_min_days, r.tier_up_min_active_streak, r.tier_down_missed_streak,
            r.answer_extraction_prompt, r.clarification_guidance
     FROM relationship_settings r
     ${settingsJoin}
     WHERE r.id = true${settingsPredicate}`,
    authoritativeTimezone === undefined ? [] : [authoritativeTimezone],
  );
  const settings = settingsResult.rows[0];
  if (settings === undefined) return null;

  // Use the same ICU timezone validation and day-boundary contract as memory.
  if (settings.timezone === null || !isValidTimezone(settings.timezone)) {
    throw new RelationshipConfigurationError("authoritative timezone is not configured or is not a valid IANA timezone");
  }
  if (!Number.isInteger(settings.day_start_hour) || settings.day_start_hour < 0 || settings.day_start_hour > 23) {
    throw new RelationshipConfigurationError("relationship_settings.day_start_hour must be an integer from 0 through 23");
  }

  const [tierResult, questionResult] = await Promise.all([
    pool.query<TierRow>(
      `SELECT id, tier_key, position, minimum_familiarity, label, prompt, behavioral_guidance
       FROM relationship_tier ORDER BY position`,
    ),
    pool.query<QuestionRow>(
      `SELECT q.id, q.question_key, q.type_key, qt.interpretation_guidance,
              q.tier_id, t.position AS tier_position, q.question_text, q.position
       FROM relationship_question q
       JOIN relationship_question_type qt ON qt.type_key = q.type_key
       JOIN relationship_tier t ON t.id = q.tier_id
       WHERE q.enabled = true
       ORDER BY t.position, q.position, q.question_key`,
    ),
  ]);
  const tiers: RelationshipTier[] = tierResult.rows.map((row) => ({
    id: row.id,
    key: row.tier_key,
    position: Number(row.position),
    minimumFamiliarity: Number(row.minimum_familiarity),
    label: row.label,
    prompt: row.prompt,
    behavioralGuidance: row.behavioral_guidance,
  }));
  const questions = questionResult.rows.map((row) => ({
    id: row.id,
    key: row.question_key,
    typeKey: row.type_key,
    typeGuidance: row.interpretation_guidance,
    tierId: row.tier_id,
    tierPosition: Number(row.tier_position),
    text: row.question_text,
    position: Number(row.position),
  }));
  const config: RelationshipConfiguration = {
    relationshipType: settings.relationship_type,
    behaviorTime: { timezone: settings.timezone, dayStartHour: Number(settings.day_start_hour) },
    tierMovement: {
      enabled: settings.tier_movement_enabled,
      upMinDays: settings.tier_up_min_days,
      upMinActiveStreak: settings.tier_up_min_active_streak,
      downMissedStreak: settings.tier_down_missed_streak,
    },
    answerExtractionPrompt: settings.answer_extraction_prompt,
    clarificationGuidance: settings.clarification_guidance,
    tiers,
    questions,
  };
  validateConfiguration(settings, tiers, questions);
  return config;
}

export interface RelationshipStore {
  readonly getSummary: (now: Date) => Promise<RelationshipSummary>;
  readonly extractAnswers: (input: {
    readonly userText: string;
    readonly assistantText: string;
    readonly callLlm: MemoryLlmCaller;
    readonly taskPreset: TaskPreset;
  }) => Promise<readonly RelationshipExtractionItem[]>;
  /** Apply current interpretations inside the conversation publication transaction. */
  readonly recordAnswers: (
    client: PostgresPoolClient,
    items: readonly RelationshipExtractionItem[],
  ) => Promise<void>;
}

interface ExtractionResponse { answers?: unknown; }

export function parseRelationshipExtraction(text: string): readonly RelationshipExtractionItem[] {
  let parsed: ExtractionResponse;
  try {
    parsed = JSON.parse(text) as ExtractionResponse;
  } catch {
    throw new Error("relationship answer extraction returned invalid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || !Array.isArray(parsed.answers)) {
    throw new Error("relationship answer extraction must return an answers array");
  }
  const answers: RelationshipExtractionItem[] = [];
  for (const candidate of parsed.answers) {
    if (typeof candidate !== "object" || candidate === null) {
      throw new Error("relationship answer extraction item is invalid");
    }
    const item = candidate as Record<string, unknown>;
    if (
      typeof item.questionKey !== "string" || item.questionKey.trim().length === 0 ||
      (item.participant !== "user" && item.participant !== "assistant") ||
      typeof item.answer !== "string" || item.answer.trim().length === 0 ||
      typeof item.clarificationNeeded !== "boolean"
    ) {
      throw new Error("relationship answer extraction item has invalid fields");
    }
    answers.push({
      questionKey: item.questionKey,
      participant: item.participant,
      answer: item.answer.trim(),
      clarificationNeeded: item.clarificationNeeded,
    });
  }
  return answers;
}

function promptForExtraction(
  configuration: RelationshipConfiguration,
  userText: string,
  assistantText: string,
  currentAnswers: readonly {
    readonly questionKey: string;
    readonly participant: RelationshipParticipant;
    readonly answer: string;
    readonly clarificationNeeded: boolean;
  }[],
): string {
  return JSON.stringify({
    relationshipType: configuration.relationshipType,
    instructions: configuration.answerExtractionPrompt,
    response_contract: {
      answers: "Array of {questionKey, participant:'user'|'assistant', answer, clarificationNeeded:boolean}.",
      omission: "Omit a participant/question pair when the new turn provides no relevant evidence; never erase an existing answer by omission.",
      interpretation: "Give the best current interpretation when new-turn evidence is ambiguous or conflicts with a prior interpretation, and set clarificationNeeded=true. Do not invent facts. Attribute user answers only from the user's own statements and assistant answers only from the assistant reply. A prior interpretation is context for detecting change, not proof; omit slots without relevant new-turn evidence.",
    },
    current_interpretations: currentAnswers,
    questions: configuration.questions.map((question) => ({
      questionKey: question.key,
      type: question.typeKey,
      typeGuidance: question.typeGuidance,
      tierPosition: question.tierPosition,
      question: question.text,
    })),
    new_turn: {
      user_messages: userText,
      assistant_reply: assistantText,
    },
  });
}

export function createRelationshipStore(input: {
  readonly pool: PostgresPool;
  readonly configuration: RelationshipConfiguration;
}): RelationshipStore {
  const { pool, configuration } = input;

  async function getSummary(now: Date): Promise<RelationshipSummary> {
    const [firstMessage, activityDays, answersResult] = await Promise.all([
      pool.query<FirstMessageRow>(
        `SELECT effective_at FROM conversation_message ORDER BY seq LIMIT 1`,
      ),
      pool.query<BehavioralDayRow>(
        `SELECT DISTINCT
           to_char(
             ((effective_at AT TIME ZONE $1::text) -
               make_interval(hours => $2::integer))::date,
             'YYYY-MM-DD'
           ) AS activity_day
         FROM conversation_message
         WHERE role = 'user'
         ORDER BY activity_day`,
        [configuration.behaviorTime.timezone, configuration.behaviorTime.dayStartHour],
      ),
      pool.query<AnswerRow>(
        `SELECT a.question_id, q.question_key, q.question_text, a.participant,
                a.current_answer, a.clarification_needed
         FROM relationship_answer a
         JOIN relationship_question q ON q.id = a.question_id
         WHERE q.enabled = true
         ORDER BY q.position, q.question_key, a.participant`,
      ),
    ]);
    const first = firstMessage.rows[0];
    const userActivityDays = activityDays.rows.map((row) => row.activity_day);
    const answers: RelationshipAnswer[] = answersResult.rows.map((row) => ({
      questionId: row.question_id,
      questionKey: row.question_key,
      questionText: row.question_text,
      participant: row.participant as RelationshipParticipant,
      answer: row.current_answer,
      clarificationNeeded: row.clarification_needed,
    }));
    return summarizeRelationship({
      configuration,
      firstConversationAt: first?.effective_at ?? null,
      userActivityDays,
      now,
      answers,
    });
  }

  async function extractAnswers(params: {
    userText: string;
    assistantText: string;
    callLlm: MemoryLlmCaller;
    taskPreset: TaskPreset;
  }): Promise<readonly RelationshipExtractionItem[]> {
    const currentAnswers = await pool.query<AnswerRow>(
      `SELECT q.question_key, a.participant, a.current_answer, a.clarification_needed
       FROM relationship_answer a
       JOIN relationship_question q ON q.id = a.question_id
       WHERE q.enabled = true`,
    );
    const result = await params.callLlm({
      systemPrompt: "Extract only evidence from the supplied new conversation turn into the configured shared question slots. Follow the supplied runtime instructions and response contract.",
      userMessage: promptForExtraction(
        configuration,
        params.userText,
        params.assistantText,
        currentAnswers.rows.map((row) => ({
          questionKey: row.question_key,
          participant: row.participant as RelationshipParticipant,
          answer: row.current_answer,
          clarificationNeeded: row.clarification_needed,
        })),
      ),
      taskPreset: params.taskPreset,
      responseFormat: { type: "json_object" },
    });
    if (result.finishReason === "length") {
      throw new Error("relationship answer extraction response was truncated");
    }
    const knownQuestions = new Set(configuration.questions.map((question) => question.key));
    const deduplicated = new Map<string, RelationshipExtractionItem>();
    for (const item of parseRelationshipExtraction(result.text)) {
      if (!knownQuestions.has(item.questionKey)) continue;
      const key = `${item.questionKey}\u0000${item.participant}`;
      const previous = deduplicated.get(key);
      deduplicated.set(key, previous === undefined
        ? item
        : {
            ...item,
            // Duplicate conflicting outputs still preserve the best latest
            // interpretation while making the uncertainty explicit.
            clarificationNeeded:
              item.clarificationNeeded || previous.clarificationNeeded ||
              item.answer !== previous.answer,
          });
    }
    return [...deduplicated.values()];
  }

  async function recordAnswers(
    client: PostgresPoolClient,
    items: readonly RelationshipExtractionItem[],
  ): Promise<void> {
    const questions = new Map(configuration.questions.map((question) => [question.key, question]));
    for (const item of items) {
      const question = questions.get(item.questionKey);
      if (question === undefined) continue;
      await client.query(
        `INSERT INTO relationship_answer
           (question_id, participant, current_answer, clarification_needed)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (question_id, participant) DO UPDATE SET
           current_answer = EXCLUDED.current_answer,
           clarification_needed = EXCLUDED.clarification_needed,
           updated_at = now()`,
        [question.id, item.participant, item.answer, item.clarificationNeeded],
      );
    }
  }

  return { getSummary, extractAnswers, recordAnswers };
}