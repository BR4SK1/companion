/** Pure relationship-day, familiarity, tier, and prompt rendering semantics. */

import type { ChatReasoningEffort } from "@companion/openrouter/chat";
import { behavioralDay } from "../memory/time.ts";
import type { BehaviorTime } from "../memory/time.ts";
import type {
  RelationshipAnswer,
  RelationshipConfiguration,
  RelationshipParticipant,
  RelationshipQuestion,
  RelationshipSummary,
} from "./types.ts";

function dayOrdinal(day: string): number {
  const [year, month, date] = day.split("-").map(Number);
  return Math.floor(Date.UTC(year!, month! - 1, date!) / 86_400_000);
}

/**
 * Active days are consecutive user-activity behavioral dates ending on the
 * latest activity date (which can be yesterday); missed days are full
 * behavioral-day boundaries since that latest date. Assistant-only messages
 * do not count as activity. A future-dated effective event is ignored until
 * its behavioral date arrives. The boundary/timezone implementation is the
 * same `behavioralDay` used by memory.
 */
export function relationshipDayStreaksForDays(input: {
  /** Behavioral-calendar dates already derived by the persistence query. */
  readonly userActivityDays: readonly string[];
  readonly now: Date;
  readonly behaviorTime: BehaviorTime;
}): { readonly activeDayStreak: number; readonly missedDayStreak: number } {
  const today = behavioralDay(input.now, input.behaviorTime);
  const todayOrdinal = dayOrdinal(today);
  const dates = new Set(
    input.userActivityDays.filter((date) => dayOrdinal(date) <= todayOrdinal),
  );
  if (dates.size === 0) return { activeDayStreak: 0, missedDayStreak: 0 };

  const latest = [...dates].sort().at(-1)!;
  let activeDayStreak = 0;
  for (let offset = 0; dates.has(new Date((dayOrdinal(latest) - offset) * 86_400_000).toISOString().slice(0, 10)); offset += 1) {
    activeDayStreak += 1;
  }
  return {
    activeDayStreak,
    missedDayStreak: Math.max(0, todayOrdinal - dayOrdinal(latest)),
  };
}

/** Derive behavioral dates from raw instants when no database aggregation is available. */
export function relationshipDayStreaks(input: {
  readonly userActivityAt: readonly Date[];
  readonly now: Date;
  readonly behaviorTime: BehaviorTime;
}): { readonly activeDayStreak: number; readonly missedDayStreak: number } {
  return relationshipDayStreaksForDays({
    userActivityDays: input.userActivityAt.map((date) => behavioralDay(date, input.behaviorTime)),
    now: input.now,
    behaviorTime: input.behaviorTime,
  });
}

/**
 * Main reply output budget by configured base familiarity tier ordinal:
 * 500 tokens at the first tier (ordinal 0, also the value when relationship
 * is disabled) plus 100 tokens per successive tier. The ordinal is the tier's
 * index in the configured ordered tier list — not the transient effective
 * tier, which can move one tier up or down on streak/missed-day signals — so
 * the budget tracks familiarity specifically.
 *
 * This value is the visible-reply length target named in the relationship
 * prompt chunk. Because OpenRouter counts hidden reasoning tokens against the
 * same `max_tokens` cap, `mainReplyProviderMaxTokensForBaseTierOrdinal` adds
 * effort-scaled reasoning headroom when a non-`none` reasoning effort is
 * configured so reasoning cannot starve or truncate the visible reply.
 * Other LLM tasks (memory, articles, decisions) keep their own presets and
 * are unaffected.
 */
export const MAIN_REPLY_MAX_TOKENS_BASE = 500;
export const MAIN_REPLY_MAX_TOKENS_PER_TIER = 100;

export const MAIN_REPLY_REASONING_HEADROOM_TOKENS: Readonly<
  Record<ChatReasoningEffort, number>
> = {
  none: 0,
  minimal: 500,
  low: 1000,
  medium: 2000,
  high: 3500,
  xhigh: 5000,
  max: 8000,
};

export function mainReplyReasoningHeadroomTokens(
  effort?: ChatReasoningEffort,
): number {
  if (effort === undefined) return 0;
  return MAIN_REPLY_REASONING_HEADROOM_TOKENS[effort];
}

export function mainReplyMaxTokensForBaseTierOrdinal(ordinal: number): number {
  if (!Number.isInteger(ordinal) || ordinal < 0) {
    throw new RangeError(
      `base tier ordinal must be a non-negative integer, got ${String(ordinal)}`,
    );
  }
  return MAIN_REPLY_MAX_TOKENS_BASE + ordinal * MAIN_REPLY_MAX_TOKENS_PER_TIER;
}

export function mainReplyProviderMaxTokensForBaseTierOrdinal(
  ordinal: number,
  reasoningEffort?: ChatReasoningEffort,
): number {
  return (
    mainReplyMaxTokensForBaseTierOrdinal(ordinal) +
    mainReplyReasoningHeadroomTokens(reasoningEffort)
  );
}

export function mainReplyMaxTokensForSummary(
  summary: Pick<RelationshipSummary, "baseTierOrdinal">,
): number {
  return mainReplyMaxTokensForBaseTierOrdinal(summary.baseTierOrdinal);
}

export function selectRelationshipTiers(input: {
  readonly familiarity: number;
  readonly timeKnownDays: number;
  readonly activeDayStreak: number;
  readonly missedDayStreak: number;
  readonly configuration: RelationshipConfiguration;
}): Pick<
  RelationshipSummary,
  "baseTier" | "baseTierOrdinal" | "effectiveTier" | "tierMovement"
> {
  const tiers = input.configuration.tiers;
  let baseIndex = 0;
  for (let i = 0; i < tiers.length; i += 1) {
    if (tiers[i]!.minimumFamiliarity <= input.familiarity) baseIndex = i;
  }
  const baseTier = tiers[baseIndex]!;
  let effectiveIndex = baseIndex;
  const movement = input.configuration.tierMovement;
  if (movement.enabled) {
    const downSignal = input.missedDayStreak >= movement.downMissedStreak!;
    const upSignal =
      input.timeKnownDays >= movement.upMinDays! &&
      input.activeDayStreak >= movement.upMinActiveStreak!;
    // Decide signal precedence before applying tier bounds. A down signal at
    // the lowest tier clamps in place; it must not fall through to an up move.
    if (downSignal) {
      if (baseIndex > 0) effectiveIndex -= 1;
    } else if (upSignal && baseIndex < tiers.length - 1) {
      effectiveIndex += 1;
    }
  }
  const effectiveTier = tiers[effectiveIndex]!;
  return {
    baseTier,
    baseTierOrdinal: baseIndex,
    effectiveTier,
    tierMovement: effectiveIndex < baseIndex
      ? "down"
      : effectiveIndex > baseIndex
      ? "up"
      : "locked",
  };
}

export function summarizeRelationship(input: {
  readonly configuration: RelationshipConfiguration;
  readonly firstConversationAt: Date | null;
  /** Supply behavioral dates from the aggregate query, or raw instants in pure callers. */
  readonly userActivityAt?: readonly Date[];
  readonly userActivityDays?: readonly string[];
  readonly now: Date;
  readonly answers: readonly RelationshipAnswer[];
}): RelationshipSummary {
  const today = behavioralDay(input.now, input.configuration.behaviorTime);
  const firstConversationDate = input.firstConversationAt === null
    ? null
    : behavioralDay(input.firstConversationAt, input.configuration.behaviorTime);
  const timeKnownDays = firstConversationDate === null
    ? 0
    : Math.max(0, dayOrdinal(today) - dayOrdinal(firstConversationDate));
  const streaks = input.userActivityDays !== undefined
    ? relationshipDayStreaksForDays({
        userActivityDays: input.userActivityDays,
        now: input.now,
        behaviorTime: input.configuration.behaviorTime,
      })
    : relationshipDayStreaks({
        userActivityAt: input.userActivityAt ?? [],
        now: input.now,
        behaviorTime: input.configuration.behaviorTime,
      });
  const answeredSlots = input.answers.length;
  const userAnsweredSlots = input.answers.filter((answer) => answer.participant === "user").length;
  const assistantAnsweredSlots = input.answers.filter((answer) => answer.participant === "assistant").length;
  const eligibleSlotsPerParticipant = input.configuration.questions.length;
  const eligibleSlots = eligibleSlotsPerParticipant * 2;
  const familiarity = eligibleSlots === 0 ? 0 : answeredSlots / eligibleSlots;
  const tiers = selectRelationshipTiers({
    familiarity,
    timeKnownDays,
    ...streaks,
    configuration: input.configuration,
  });
  return {
    relationshipType: input.configuration.relationshipType,
    clarificationGuidance: input.configuration.clarificationGuidance,
    firstConversationDate,
    timeKnownDays,
    ...streaks,
    answeredSlots,
    userAnsweredSlots,
    assistantAnsweredSlots,
    eligibleSlots,
    eligibleSlotsPerParticipant,
    familiarity,
    ...tiers,
    answers: input.answers,
  };
}

/**
 * How many not-yet-fully-answered shared-bank questions one answer
 * extraction considers. The bank itself is unchanged: slot eligibility,
 * familiarity, and answer acceptance always use the full enabled bank;
 * only the extraction prompt is bounded, so a large bank does not fill
 * every turn's extraction request.
 */
export const RELATIONSHIP_EXTRACTION_QUESTION_LIMIT = 5;

/** Each enabled question contributes one slot per participant. */
const PARTICIPANT_SLOTS_PER_QUESTION = 2;

/**
 * Select the not-yet-fully-answered questions one extraction pass may
 * consider, in configured rank order (tier position, question position,
 * then question key — the order the configuration loader returns).
 * A question is still eligible while either participant slot has no
 * recorded answer; a question with both slots answered drops out, so the
 * bank is consumed progressively rather than re-shown every turn.
 */
export function selectUnansweredQuestionsForExtraction(input: {
  readonly configuration: RelationshipConfiguration;
  /** Recorded answers by question key and participant; repeats collapse per slot. */
  readonly answers: readonly {
    readonly questionKey: string;
    readonly participant: RelationshipParticipant;
  }[];
  readonly limit?: number;
}): readonly RelationshipQuestion[] {
  const limit = input.limit ?? RELATIONSHIP_EXTRACTION_QUESTION_LIMIT;
  if (!Number.isInteger(limit) || limit < 0) {
    throw new RangeError(
      `extraction question limit must be a non-negative integer, got ${String(limit)}`,
    );
  }
  const answeredSlotsByKey = new Map<string, Set<RelationshipParticipant>>();
  for (const answer of input.answers) {
    let slots = answeredSlotsByKey.get(answer.questionKey);
    if (slots === undefined) {
      slots = new Set();
      answeredSlotsByKey.set(answer.questionKey, slots);
    }
    slots.add(answer.participant);
  }
  return [...input.configuration.questions]
    .sort(
      (left, right) =>
        left.tierPosition - right.tierPosition ||
        left.position - right.position ||
        (left.key < right.key ? -1 : left.key > right.key ? 1 : 0),
    )
    .filter(
      (question) =>
        (answeredSlotsByKey.get(question.key)?.size ?? 0) <
        PARTICIPANT_SLOTS_PER_QUESTION,
    )
    .slice(0, limit);
}

/** A separate system chunk; all personal wording comes from runtime config. */
export function renderRelationshipContext(summary: RelationshipSummary): string {
  const lines = [
    `Relationship configuration: ${summary.relationshipType}.`,
    `First recorded conversation date: ${summary.firstConversationDate ?? "not yet recorded"}.`,
    `Time known: ${summary.timeKnownDays} behavioral day(s); active day streak: ${summary.activeDayStreak}; missed day streak: ${summary.missedDayStreak}.`,
    `Familiarity: ${summary.answeredSlots}/${summary.eligibleSlots} participant-question slots (${(summary.familiarity * 100).toFixed(1)}%); user ${summary.userAnsweredSlots}/${summary.eligibleSlotsPerParticipant}, assistant ${summary.assistantAnsweredSlots}/${summary.eligibleSlotsPerParticipant}.`,
    `Base tier: ${summary.baseTier.label}. Effective tier: ${summary.effectiveTier.label} (${summary.tierMovement}).`,
    `Tier prompt: ${summary.effectiveTier.prompt}`,
    `Behavioral guidance: ${summary.effectiveTier.behavioralGuidance}`,
    `Reply length: keep this reply concise, aiming for at most about ${String(mainReplyMaxTokensForSummary(summary))} output tokens.`,
    `Clarification guidance: ${summary.clarificationGuidance}`,
  ];
  const clarificationAnswers = summary.answers.filter((answer) => answer.clarificationNeeded);
  if (clarificationAnswers.length > 0) {
    lines.push(
      `Clarification-needed interpretations (ask naturally when relevant; do not claim certainty): ${clarificationAnswers.map((answer) => `${answer.participant} — ${answer.questionText}: ${answer.answer}`).join("; ")}`,
    );
  }
  const learnedAnswers = summary.answers.filter((answer) => !answer.clarificationNeeded);
  if (learnedAnswers.length > 0) {
    lines.push(
      `Current interpreted shared answers: ${learnedAnswers.map((answer) => `${answer.participant} — ${answer.questionText}: ${answer.answer}`).join("; ")}`,
    );
  }
  return lines.join("\n");
}