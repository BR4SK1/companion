/**
 * Temporal expression detection for canonical recall. The recognized
 * grammar is the memory pipeline's date-parser semantics, with the calendar
 * fixed to the CONFIGURED behavioral timezone (never a hardcoded zone).
 *
 * Pattern priority (first match wins):
 *   1. explicit range   `between <date> and <date>` / `from <date> to <date>`
 *   2. weekday phrases  `last|this|next <weekday> [morning|afternoon|night]`
 *   3. simple days      `today|yesterday|tomorrow [morning|afternoon|night]`
 *   4. day parts        `last|this morning|afternoon|night`
 *   5. periods          `last|this week|month` (Monday-based week start)
 *   6. absolute tokens  `YYYY-MM-DD` or `<month name> <d>[, <yyyy>]`
 *   7. date-like phrase (bare weekday, bare `may`, …) → unsupported
 *
 * Deliberate non-features: NO bare month, NO bare
 * year, NO `YYYY-MM` month token (the word "may" alone stays a keyword), and
 * NO preposition stripping in the remaining query — only the matched span is
 * removed (replaced by a single space, whitespace collapsed, punctuation
 * kept attached to the preceding word).
 *
 * All calendar math is civil/local math in the given timezone (Intl via
 * `time.ts`, DST-safe): day bounds are local midnight, day parts use the
 * pipeline's local hours (morning 04–12, afternoon 12–17, night 17–04 next
 * day), and weekday numbering is Monday=1..Sunday=7.
 *
 * Failure behavior is lenient by design (the worker's recall is
 * a best-effort context step): an expression that matches a pattern but
 * resolves to an invalid date or an over-long range, and any unsupported or
 * ambiguous date-like phrase, degrade to keyword mode (null window) instead
 * of rejecting the request.
 *
 * When no timezone is supplied, temporal detection is DISABLED entirely
 * (keyword mode, unchanged behavior): recall's calendar semantics are
 * personal behavioral configuration, never hardcoded.
 */

import { fromZoneTime, toZoneTime, isValidTimezone } from "./time.ts";

export type RecallMode = "keyword" | "hybrid" | "timeline";

export interface RecallTimeRange {
  /** Inclusive UTC start of the named window. */
  readonly start: Date;
  /** Exclusive UTC end of the named window. */
  readonly end: Date;
  /** The query with the temporal expression removed (hybrid keywords). */
  readonly remainingQuery: string;
  /** Human-readable window description for diagnostics. */
  readonly description: string;
}

/** Hard bound on an explicit range length. */
export const MAX_DATE_RANGE_MS = 2 * 365 * 24 * 60 * 60 * 1000;

const WEEKDAYS = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
] as const;

const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
] as const;

type DayPart = "morning" | "afternoon" | "night";

const WEEKDAY_PATTERN = WEEKDAYS.join("|");
const MONTH_PATTERN =
  "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const DATE_TOKEN_PATTERN =
  `(?:\\d{4}-\\d{2}-\\d{2}|${MONTH_PATTERN}\\s+\\d{1,2}(?:,\\s*\\d{4})?)`;

/** Month token (full or 3-letter abbreviation) to
 *  zero-based month index. */
const MONTH_TOKENS = new Map<string, number>(
  MONTHS.flatMap((month, index) => [
    [month, index] as const,
    [month.slice(0, 3), index] as const,
  ]),
);

interface CivilDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

/** Civil (local) parts of an instant in the zone. */
function civilParts(date: Date, timezone: string): CivilDate & { hour: number } {
  const parts = toZoneTime(date, timezone);
  return { year: parts.year, month: parts.month, day: parts.day, hour: parts.hour };
}

function civilDateNumber(civil: CivilDate): number {
  return Date.UTC(civil.year, civil.month - 1, civil.day);
}

/** Weekday number of a civil date, Monday=1..Sunday=7 (ISO weekday numbering). */
function weekdayNumberOf(civil: CivilDate): number {
  const utcDay = new Date(civilDateNumber(civil)).getUTCDay(); // 0=Sunday
  return ((utcDay + 6) % 7) + 1;
}

/** Civil day shifted by N days (Date.UTC normalizes month/year overflow). */
function addCivilDays(civil: CivilDate, days: number): CivilDate {
  const shifted = new Date(civilDateNumber(civil) + days * 86_400_000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

function localStartOfDay(civil: CivilDate, timezone: string): Date {
  return fromZoneTime(
    { year: civil.year, month: civil.month, day: civil.day, hour: 0 },
    timezone,
  );
}

function localHourOfDay(civil: CivilDate, hour: number, timezone: string): Date {
  return fromZoneTime(
    { year: civil.year, month: civil.month, day: civil.day, hour },
    timezone,
  );
}

function dayRange(civil: CivilDate, timezone: string): { start: Date; end: Date } {
  const start = localStartOfDay(civil, timezone);
  const end = localStartOfDay(addCivilDays(civil, 1), timezone);
  return { start, end };
}

function dayPartRange(
  civil: CivilDate,
  part: DayPart,
  timezone: string,
): { start: Date; end: Date } {
  const start = part === "morning"
    ? localHourOfDay(civil, 4, timezone)
    : part === "afternoon"
      ? localHourOfDay(civil, 12, timezone)
      : localHourOfDay(civil, 17, timezone);
  const end = part === "morning"
    ? localHourOfDay(civil, 12, timezone)
    : part === "afternoon"
      ? localHourOfDay(civil, 17, timezone)
      : localHourOfDay(addCivilDays(civil, 1), 4, timezone);
  return { start, end };
}

const DAY_PARTS: ReadonlyArray<DayPart> = ["morning", "afternoon", "night"];

function isDayPart(value: string): value is DayPart {
  return (DAY_PARTS as ReadonlyArray<string>).includes(value);
}

function parseWeekdayNumber(value: string): number {
  const index = WEEKDAYS.indexOf(value.toLowerCase() as (typeof WEEKDAYS)[number]);
  if (index < 0) return -1;
  return index + 1;
}

/** Last/this/next weekday resolution, in civil days. */
function resolveWeekday(
  reference: CivilDate,
  direction: "last" | "this" | "next",
  weekdayName: string,
): CivilDate {
  const target = parseWeekdayNumber(weekdayName);
  const currentWeekday = weekdayNumberOf(reference);
  if (direction === "last") {
    const daysBack = ((currentWeekday - target + 7) % 7) || 7;
    return addCivilDays(reference, -daysBack);
  }
  if (direction === "next") {
    const daysForward = ((target - currentWeekday + 7) % 7) || 7;
    return addCivilDays(reference, daysForward);
  }
  return addCivilDays(reference, target - currentWeekday);
}

/** Validate a civil date actually exists (no Date.UTC overflow normalization). */
function civilDateExists(civil: CivilDate): boolean {
  if (!Number.isInteger(civil.year) || !Number.isInteger(civil.month) ||
    !Number.isInteger(civil.day) || civil.month < 1 || civil.month > 12 ||
    civil.day < 1 || civil.day > 31
  ) {
    return false;
  }
  const probe = new Date(civilDateNumber(civil));
  return probe.getUTCFullYear() === civil.year &&
    probe.getUTCMonth() === civil.month - 1 &&
    probe.getUTCDate() === civil.day;
}

/**
 * Parse an absolute date token: `YYYY-MM-DD`, or `<month name> <d>` with an
 * optional `, <yyyy>` (year defaults to the reference year). Returns null
 * when the token is not a real civil date.
 */
function parseAbsoluteToken(
  token: string,
  reference: CivilDate,
): CivilDate | null {
  const normalized = token.trim().replace(/\s+/g, " ").toLowerCase();
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(normalized);
  if (iso !== null) {
    const civil = {
      year: Number(iso[1]),
      month: Number(iso[2]),
      day: Number(iso[3]),
    };
    return civilDateExists(civil) ? civil : null;
  }
  const monthDay = /^([a-z]+)\s+(\d{1,2})(?:,\s*(\d{4}))?$/.exec(normalized);
  if (monthDay === null) return null;
  const monthIndex = MONTH_TOKENS.get(monthDay[1] ?? "");
  if (monthIndex === undefined) return null;
  const year = monthDay[3] !== undefined ? Number(monthDay[3]) : reference.year;
  const civil = { year, month: monthIndex + 1, day: Number(monthDay[2]) };
  return civilDateExists(civil) ? civil : null;
}

/** Remove the matched span: collapse whitespace, keep
 *  punctuation attached to the preceding word, trim. No preposition work. */
function removeMatch(query: string, index: number, length: number): string {
  return `${query.slice(0, index)} ${query.slice(index + length)}`
    .replace(/\s+/g, " ")
    .replace(/\s+([,.!?])/g, "$1")
    .trim();
}

/** Date-like phrase detection: anything that LOOKS like a date but
 *  matched no supported pattern stays out of keyword searches. */
function dateLikePhraseExists(query: string): boolean {
  return (
    /\b(?:today|yesterday|tomorrow)\b/i.test(query) ||
    new RegExp(
      `\\b(?:last|this|next)\\s+(?:${WEEKDAY_PATTERN}|morning|afternoon|night|week|month)\\b`,
      "i",
    ).test(query) ||
    new RegExp(`\\b(?:${WEEKDAY_PATTERN})\\b`, "i").test(query)
  );
}

interface WindowMatch {
  readonly index: number;
  readonly length: number;
  readonly start: Date;
  readonly end: Date;
  readonly description: string;
}

/**
 * Detect an explicit time range in a recall query, in the given timezone.
 * Returns null when no timezone is supplied (detection disabled), when the
 * query has no supported temporal expression, or when a date-like phrase
 * fails to resolve (keyword mode stays unchanged).
 */
export function detectRecallTimeRange(
  query: string,
  referenceTime: Date,
  timezone?: string,
): RecallTimeRange | null {
  if (timezone === undefined) return null;
  if (!isValidTimezone(timezone)) return null;
  if (!Number.isFinite(referenceTime.getTime())) return null;

  const reference = civilParts(referenceTime, timezone);

  // 1. Explicit range: `between <date> and <date>` / `from <date> to <date>`.
  const rangePattern = new RegExp(
    `\\b(?:between|from)\\s+(${DATE_TOKEN_PATTERN})\\s+(?:and|to)\\s+(${DATE_TOKEN_PATTERN})\\b`,
    "i",
  );
  const rangeMatch = rangePattern.exec(query);
  if (rangeMatch !== null && rangeMatch.index !== undefined) {
    const startCivil = parseAbsoluteToken(rangeMatch[1] ?? "", reference);
    const endCivil = parseAbsoluteToken(rangeMatch[2] ?? "", reference);
    if (startCivil !== null && endCivil !== null) {
      const start = localStartOfDay(startCivil, timezone);
      const end = localStartOfDay(addCivilDays(endCivil, 1), timezone);
      if (end.getTime() - start.getTime() <= MAX_DATE_RANGE_MS && start < end) {
        return {
          start,
          end,
          remainingQuery: removeMatch(query, rangeMatch.index, rangeMatch[0].length),
          description: `${rangeMatch[0]} (local range)`,
        };
      }
      return null;
    }
    return null;
  }

  // 2. Weekday phrases: last|this|next <weekday> [morning|afternoon|night].
  const weekdayPattern = new RegExp(
    `\\b(last|this|next)\\s+(${WEEKDAY_PATTERN})(?:\\s+(morning|afternoon|night))?\\b`,
    "i",
  );
  const weekdayMatch = weekdayPattern.exec(query);
  if (weekdayMatch !== null && weekdayMatch.index !== undefined) {
    const direction = (weekdayMatch[1] ?? "this").toLowerCase() as "last" | "this" | "next";
    const day = resolveWeekday(reference, direction, weekdayMatch[2] ?? "");
    const rawPart = weekdayMatch[3];
    const part = rawPart !== undefined && isDayPart(rawPart.toLowerCase())
      ? (rawPart.toLowerCase() as DayPart)
      : undefined;
    const window = part !== undefined
      ? dayPartRange(day, part, timezone)
      : dayRange(day, timezone);
    return {
      ...window,
      remainingQuery: removeMatch(query, weekdayMatch.index, weekdayMatch[0].length),
      description: `${weekdayMatch[0]} (local ${part ?? "day"})`,
    };
  }

  // 3. Simple days: today|yesterday|tomorrow [morning|afternoon|night].
  const simpleDayPattern =
    /\b(today|yesterday|tomorrow)(?:\s+(morning|afternoon|night))?\b/i;
  const simpleDayMatch = simpleDayPattern.exec(query);
  if (simpleDayMatch !== null && simpleDayMatch.index !== undefined) {
    const word = (simpleDayMatch[1] ?? "today").toLowerCase();
    const offset = word === "yesterday" ? -1 : word === "tomorrow" ? 1 : 0;
    const day = addCivilDays(reference, offset);
    const rawPart = simpleDayMatch[2];
    const part = rawPart !== undefined && isDayPart(rawPart.toLowerCase())
      ? (rawPart.toLowerCase() as DayPart)
      : undefined;
    const window = part !== undefined
      ? dayPartRange(day, part, timezone)
      : dayRange(day, timezone);
    return {
      ...window,
      remainingQuery: removeMatch(query, simpleDayMatch.index, simpleDayMatch[0].length),
      description: `${simpleDayMatch[0]} (local ${part ?? "day"})`,
    };
  }

  // 4. Day parts: last|this morning|afternoon|night.
  const dayPartMatch = /\b(last|this)\s+(morning|afternoon|night)\b/i.exec(query);
  if (dayPartMatch !== null && dayPartMatch.index !== undefined) {
    const direction = (dayPartMatch[1] ?? "this").toLowerCase();
    const day = direction === "last" ? addCivilDays(reference, -1) : reference;
    const part = (dayPartMatch[2] ?? "morning").toLowerCase();
    if (!isDayPart(part)) return null;
    return {
      ...dayPartRange(day, part, timezone),
      remainingQuery: removeMatch(query, dayPartMatch.index, dayPartMatch[0].length),
      description: `${dayPartMatch[0]} (local ${part})`,
    };
  }

  // 5. Periods: last|this week|month (Monday-based week start).
  const periodMatch = /\b(last|this)\s+(week|month)\b/i.exec(query);
  if (periodMatch !== null && periodMatch.index !== undefined) {
    const isLast = (periodMatch[1] ?? "this").toLowerCase() === "last";
    const unit = (periodMatch[2] ?? "week").toLowerCase();
    if (unit === "week") {
      // Monday-based local week: back to Monday of the reference's week.
      const weekday = weekdayNumberOf(reference);
      const weekStart = addCivilDays(reference, -(weekday - 1));
      const lastWeekStart = addCivilDays(weekStart, -7);
      const nextWeekStart = addCivilDays(weekStart, 7);
      const window = isLast
        ? { start: localStartOfDay(lastWeekStart, timezone), end: localStartOfDay(weekStart, timezone) }
        : { start: localStartOfDay(weekStart, timezone), end: localStartOfDay(nextWeekStart, timezone) };
      return {
        ...window,
        remainingQuery: removeMatch(query, periodMatch.index, periodMatch[0].length),
        description: `${periodMatch[0]} (local week, Monday-based)`,
      };
    }
    const monthStart: CivilDate = { year: reference.year, month: reference.month, day: 1 };
    // Month arithmetic on day-1 civil dates is exact: +/- one calendar month
    // with year rollover.
    const nextMonthStart: CivilDate = reference.month === 12
      ? { year: reference.year + 1, month: 1, day: 1 }
      : { year: reference.year, month: reference.month + 1, day: 1 };
    const previousMonthStart: CivilDate = reference.month === 1
      ? { year: reference.year - 1, month: 12, day: 1 }
      : { year: reference.year, month: reference.month - 1, day: 1 };
    const window = isLast
      ? {
        start: localStartOfDay(previousMonthStart, timezone),
        end: localStartOfDay(monthStart, timezone),
      }
      : {
        start: localStartOfDay(monthStart, timezone),
        end: localStartOfDay(nextMonthStart, timezone),
      };
    return {
      ...window,
      remainingQuery: removeMatch(query, periodMatch.index, periodMatch[0].length),
      description: `${periodMatch[0]} (local month)`,
    };
  }

  // 6. Absolute tokens: YYYY-MM-DD or <month name> <d>[, <yyyy>].
  const absolutePattern = new RegExp(`\\b${DATE_TOKEN_PATTERN}\\b`, "i");
  const absoluteMatch = absolutePattern.exec(query);
  if (absoluteMatch !== null && absoluteMatch.index !== undefined) {
    const civil = parseAbsoluteToken(absoluteMatch[0], reference);
    if (civil !== null) {
      return {
        ...dayRange(civil, timezone),
        remainingQuery: removeMatch(query, absoluteMatch.index, absoluteMatch[0].length),
        description: `${absoluteMatch[0]} (local day)`,
      };
    }
    return null;
  }

  // 7. Date-like but unsupported/ambiguous: keyword mode (lenient degrade).
  return null;
}

export const __internal = {
  addCivilDays,
  civilDateExists,
  dayPartRange,
  dayRange,
  localHourOfDay,
  localStartOfDay,
  parseAbsoluteToken,
  parseWeekdayNumber,
  resolveWeekday,
  weekdayNumberOf,
  dateLikePhraseExists,
};
