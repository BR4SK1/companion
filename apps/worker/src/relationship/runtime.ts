/** Pure relationship-day, familiarity, tier, and prompt rendering semantics. */

import { behavioralDay } from "../memory/time.ts";
import type { BehaviorTime } from "../memory/time.ts";
import type {
  RelationshipAnswer,
  RelationshipConfiguration,
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

export function selectRelationshipTiers(input: {
  readonly familiarity: number;
  readonly timeKnownDays: number;
  readonly activeDayStreak: number;
  readonly missedDayStreak: number;
  readonly configuration: RelationshipConfiguration;
}): Pick<RelationshipSummary, "baseTier" | "effectiveTier" | "tierMovement"> {
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