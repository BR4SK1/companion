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
  SelectedInitiativeQuestion,
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
 * 250 tokens at the first tier (ordinal 0, also the value when relationship
 * is disabled) plus 50 tokens per successive tier. The ordinal is the tier's
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
export const MAIN_REPLY_MAX_TOKENS_BASE = 250;
export const MAIN_REPLY_MAX_TOKENS_PER_TIER = 50;

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

export const DEFAULT_INITIATIVE_QUESTION_LIMIT = 4;
export const DEFAULT_OLD_ANSWER_REVISIT_DAYS = 30;

const QUESTION_STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "been", "but", "by", "can", "could",
  "did", "do", "does", "for", "from", "had", "has", "have", "he", "her", "here",
  "hers", "him", "his", "how", "i", "if", "in", "into", "is", "it", "its", "just",
  "like", "me", "more", "most", "my", "no", "not", "now", "of", "on", "one", "or",
  "our", "out", "really", "she", "so", "some", "still", "than", "that", "the",
  "their", "them", "then", "there", "these", "they", "thing", "things", "this",
  "those", "to", "too", "up", "us", "user", "users", "very", "was", "we", "were",
  "what", "whats", "when", "where", "which", "who", "why", "will", "with", "would",
  "yeah", "yes", "you", "your", "yours",
]);

function tokenizeForMatching(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const raw of text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/)) {
    if (raw.length < 3 || QUESTION_STOP_WORDS.has(raw)) continue;
    tokens.add(raw);
  }
  return tokens;
}

function tokenOverlapScore(recentTokens: ReadonlySet<string>, questionText: string): number {
  if (recentTokens.size === 0) return 0;
  const questionTokens = tokenizeForMatching(questionText);
  let score = 0;
  for (const token of questionTokens) {
    if (recentTokens.has(token)) {
      score += 1;
    } else if (token.length >= 3) {
      for (const recent of recentTokens) {
        if (
          recent.length >= 3 &&
          Math.abs(recent.length - token.length) <= 3 &&
          (recent.startsWith(token) || token.startsWith(recent))
        ) {
          score += 0.5;
          break;
        }
      }
    }
  }
  return score;
}

function shuffleInPlace<T>(items: T[], random: () => number): T[] {
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    const tmp = items[i]!;
    items[i] = items[j]!;
    items[j] = tmp;
  }
  return items;
}

/**
 * Curated small question selector for dynamic initiative turns.
 *
 * Priority order (capped at `limit`, default 4, no duplicates):
 * 1. Conversation-relevant questions matched against recent context (up to 2).
 * 2. Random subset of unanswered user questions (preferring current-or-lower tiers).
 * 3. User questions needing clarification (0–1 reserved when available).
 * 4. Old settled user answers past `oldAnswerMinAgeDays` for natural revisit (0–1 reserved when available).
 */
export function selectInitiativeQuestions(input: {
  readonly configuration: RelationshipConfiguration;
  readonly summary: RelationshipSummary;
  readonly recentText: string;
  readonly now: Date;
  readonly limit?: number;
  readonly oldAnswerMinAgeDays?: number;
  readonly random?: () => number;
}): readonly SelectedInitiativeQuestion[] {
  const limit = input.limit ?? DEFAULT_INITIATIVE_QUESTION_LIMIT;
  if (!Number.isInteger(limit) || limit < 0) {
    throw new RangeError(`initiative question limit must be a non-negative integer, got ${String(limit)}`);
  }
  if (limit === 0 || input.configuration.questions.length === 0) return [];

  const oldAnswerMinAgeDays = input.oldAnswerMinAgeDays ?? DEFAULT_OLD_ANSWER_REVISIT_DAYS;
  const minOldAgeMs = Math.max(0, oldAnswerMinAgeDays) * 86_400_000;
  const random = input.random ?? Math.random;
  const maxCurrentTierPos = Math.max(
    input.summary.baseTier.position,
    input.summary.effectiveTier.position,
  );

  const userAnswerByKey = new Map<string, RelationshipAnswer>();
  for (const answer of input.summary.answers) {
    if (answer.participant === "user") {
      userAnswerByKey.set(answer.questionKey, answer);
    }
  }

  interface CandidateEntry {
    readonly question: RelationshipQuestion;
    readonly status: "unanswered" | "clarification" | "revisit";
    readonly answer?: RelationshipAnswer;
    readonly ageDays?: number;
  }

  const unansweredCurrent: CandidateEntry[] = [];
  const unansweredHigher: CandidateEntry[] = [];
  const clarifications: CandidateEntry[] = [];
  const revisits: CandidateEntry[] = [];
  const allEligible: CandidateEntry[] = [];

  for (const question of input.configuration.questions) {
    const answer = userAnswerByKey.get(question.key);
    if (answer === undefined) {
      const entry: CandidateEntry = { question, status: "unanswered" };
      allEligible.push(entry);
      if (question.tierPosition <= maxCurrentTierPos) {
        unansweredCurrent.push(entry);
      } else {
        unansweredHigher.push(entry);
      }
    } else if (answer.clarificationNeeded) {
      const entry: CandidateEntry = { question, status: "clarification", answer };
      allEligible.push(entry);
      clarifications.push(entry);
    } else if (answer.updatedAt !== undefined) {
      const ageMs = input.now.getTime() - answer.updatedAt.getTime();
      if (ageMs >= minOldAgeMs) {
        const ageDays = Math.max(1, Math.floor(ageMs / 86_400_000));
        const entry: CandidateEntry = { question, status: "revisit", answer, ageDays };
        allEligible.push(entry);
        revisits.push(entry);
      }
    }
  }

  const picked: SelectedInitiativeQuestion[] = [];
  const pickedKeys = new Set<string>();
  const toSelected = (
    entry: CandidateEntry,
    overrideReason?: SelectedInitiativeQuestion["reason"],
  ): SelectedInitiativeQuestion => ({
    questionKey: entry.question.key,
    questionText: entry.question.text,
    reason: overrideReason ?? entry.status,
    ...(entry.answer !== undefined ? { priorAnswer: entry.answer.answer } : {}),
    ...(entry.ageDays !== undefined ? { priorAnswerAgeDays: entry.ageDays } : {}),
  });
  const add = (
    entry: CandidateEntry,
    overrideReason?: SelectedInitiativeQuestion["reason"],
  ): boolean => {
    if (picked.length >= limit || pickedKeys.has(entry.question.key)) return false;
    pickedKeys.add(entry.question.key);
    picked.push(toSelected(entry, overrideReason));
    return true;
  };

  // 1. Conversation-relevant questions (up to 2).
  const recentTokens = tokenizeForMatching(input.recentText);
  if (recentTokens.size > 0) {
    const statusPriority = { unanswered: 0, clarification: 1, revisit: 2 } as const;
    const relevant = allEligible
      .map((entry) => ({
        entry,
        score: tokenOverlapScore(recentTokens, entry.question.text),
      }))
      .filter((item) => item.score > 0)
      .sort(
        (a, b) =>
          b.score - a.score ||
          statusPriority[a.entry.status] - statusPriority[b.entry.status] ||
          a.entry.question.tierPosition - b.entry.question.tierPosition ||
          a.entry.question.key.localeCompare(b.entry.question.key),
      );
    const maxRelevant = Math.min(2, limit);
    for (const item of relevant) {
      if (picked.length >= maxRelevant) break;
      add(
        item.entry,
        item.entry.status === "unanswered" ? "relevant" : item.entry.status,
      );
    }
  }

  // Remaining candidates after relevance pass.
  const remainingUnansweredCurrent = unansweredCurrent.filter(
    (entry) => !pickedKeys.has(entry.question.key),
  );
  const remainingUnansweredHigher = unansweredHigher.filter(
    (entry) => !pickedKeys.has(entry.question.key),
  );
  const remainingClarifications = clarifications.filter(
    (entry) => !pickedKeys.has(entry.question.key),
  );
  const remainingRevisits = revisits.filter(
    (entry) => !pickedKeys.has(entry.question.key),
  );

  // Reserve at most 1 slot for clarification and 1 for old-answer revisit when
  // available, while keeping random unanswered questions the primary fill.
  const slotsLeftAfterRelevant = limit - picked.length;
  const reserveClarification =
    remainingClarifications.length > 0 && slotsLeftAfterRelevant >= 2 ? 1 : 0;
  const reserveRevisit =
    remainingRevisits.length > 0 &&
    slotsLeftAfterRelevant - reserveClarification >= 2
      ? 1
      : 0;
  const unansweredTarget = Math.max(
    0,
    slotsLeftAfterRelevant - reserveClarification - reserveRevisit,
  );

  // 2. Random subset of unanswered questions (preferring current-or-lower tiers).
  shuffleInPlace(remainingUnansweredCurrent, random);
  shuffleInPlace(remainingUnansweredHigher, random);
  const unansweredPool = [...remainingUnansweredCurrent, ...remainingUnansweredHigher];
  let addedUnanswered = 0;
  for (const entry of unansweredPool) {
    if (addedUnanswered >= unansweredTarget || picked.length >= limit) break;
    if (add(entry)) addedUnanswered += 1;
  }

  // 3. Questions needing clarification (0–1 normally; more if unanswered exhausted).
  shuffleInPlace(remainingClarifications, random);
  const maxClarifications =
    unansweredPool.length > addedUnanswered
      ? 1
      : Math.max(1, limit - picked.length - (remainingRevisits.length > 0 ? 1 : 0));
  let addedClarifications = 0;
  for (const entry of remainingClarifications) {
    if (addedClarifications >= maxClarifications || picked.length >= limit) break;
    if (add(entry)) addedClarifications += 1;
  }

  // 4. Old settled answers to check if still true (oldest/random, capped to avoid spam).
  // Sort oldest first with random tie-break among similarly aged answers by shuffling first.
  shuffleInPlace(remainingRevisits, random);
  remainingRevisits.sort((a, b) => (b.ageDays ?? 0) - (a.ageDays ?? 0));
  const maxRevisits = unansweredPool.length > addedUnanswered ? 1 : 2;
  let addedRevisits = 0;
  for (const entry of remainingRevisits) {
    if (addedRevisits >= maxRevisits || picked.length >= limit) break;
    if (add(entry)) addedRevisits += 1;
  }

  // If reserved slots went unfilled and unanswered questions remain, top up.
  for (const entry of unansweredPool) {
    if (picked.length >= limit) break;
    add(entry);
  }

  return picked;
}

/**
 * Slim familiarity context: stage/tier, time known, streaks, and reply budget.
 * Settled and clarification-needed answers stay out of this chunk so every turn
 * stays lean; curated questions are surfaced dynamically only on initiative turns.
 */
export function renderRelationshipContext(summary: RelationshipSummary): string {
  const lines = [
    `Relationship type: ${summary.relationshipType}.`,
    `Time known: ${summary.timeKnownDays} day(s) (first recorded: ${summary.firstConversationDate ?? "not yet recorded"}); active day streak: ${summary.activeDayStreak}; missed day streak: ${summary.missedDayStreak}.`,
    `Stage: ${summary.effectiveTier.label} (base: ${summary.baseTier.label}, movement: ${summary.tierMovement}; familiarity ${(summary.familiarity * 100).toFixed(1)}%).`,
    summary.effectiveTier.prompt,
    summary.effectiveTier.behavioralGuidance,
    `Reply length: before replying, think carefully through who said or did what in the recent conversation and how it connects to your memories and live state; keep this reply concise and natural for texting (1–2 short paragraphs unless the topic genuinely calls for more, aiming for at most about ${String(mainReplyMaxTokensForSummary(summary))} output tokens).`,
  ];
  return lines.join("\n");
}