/**
 * Temporal memory periods.
 *
 * All periods are bounded by the behavioral day — the timezone and local
 * start hour provisioned in `memory_behavior` and passed in explicitly (see
 * `../time.ts`) — the same boundary the evidence policy uses. Civil-date
 * arithmetic is done with plain UTC math on zone-shifted values, so DST
 * transitions resolve through the same helpers the rest of the domain uses.
 * Leaf periods (morning/afternoon/night) and day periods are behavioral-day
 * bounded; a week is the Monday-through-Sunday behavioral week that has
 * already ended, and a month is the behavioral month that has already ended.
 * The leaf-structure hours (noon, 5pm) are period structure, not personal
 * configuration; only the day boundary and timezone are provisioned.
 */

import { fromZoneTime, toZoneTime, type BehaviorTime } from "../time.ts";
import type { TemporalPeriod, TemporalSummaryKind } from "../types.ts";

export interface CivilDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

/** Civil date of a timestamp in the behavioral timezone. */
export function civilOf(date: Date, behavior: BehaviorTime): CivilDate {
  const zone = toZoneTime(date, behavior.timezone);
  return { year: zone.year, month: zone.month, day: zone.day };
}

/** Civil date of the behavioral day a timestamp belongs to. */
export function behavioralCivilOf(date: Date, behavior: BehaviorTime): CivilDate {
  const zone = toZoneTime(date, behavior.timezone);
  if (zone.hour < behavior.dayStartHour) {
    return shiftDays({ year: zone.year, month: zone.month, day: zone.day }, -1);
  }
  return { year: zone.year, month: zone.month, day: zone.day };
}

export function shiftDays(civil: CivilDate, days: number): CivilDate {
  const shifted = new Date(Date.UTC(civil.year, civil.month - 1, civil.day + days));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

/** First civil day of the month before the given civil date. */
export function previousMonthStart(civil: CivilDate): CivilDate {
  return civil.month === 1
    ? { year: civil.year - 1, month: 12, day: 1 }
    : { year: civil.year, month: civil.month - 1, day: 1 };
}

/** ISO weekday of a civil date: 1 = Monday … 7 = Sunday. */
export function isoWeekday(civil: CivilDate): number {
  const weekday = new Date(Date.UTC(civil.year, civil.month - 1, civil.day)).getUTCDay();
  return ((weekday + 6) % 7) + 1;
}

function isoDate(civil: CivilDate): string {
  const month = String(civil.month).padStart(2, "0");
  const day = String(civil.day).padStart(2, "0");
  return `${String(civil.year)}-${month}-${day}`;
}

function isoMonth(civil: CivilDate): string {
  return `${String(civil.year)}-${String(civil.month).padStart(2, "0")}`;
}

/** Local timestamp at the start of a civil day plus `hour` hours. */
function atLocalHour(civil: CivilDate, hour: number, timezone: string): Date {
  return fromZoneTime({ year: civil.year, month: civil.month, day: civil.day, hour }, timezone);
}

/** The behavioral-day boundary (configured start hour, local) of a civil date. */
export function behavioralBoundary(civil: CivilDate, behavior: BehaviorTime): Date {
  return atLocalHour(civil, behavior.dayStartHour, behavior.timezone);
}

function period(
  kind: TemporalSummaryKind,
  periodKey: string,
  start: Date,
  end: Date,
): TemporalPeriod {
  return { kind, periodKey, startAt: start, endAt: end };
}

export function getTemporalPeriod(
  kind: TemporalSummaryKind,
  value: Date,
  behavior: BehaviorTime,
): TemporalPeriod {
  const behavioralDate = behavioralCivilOf(value, behavior);

  switch (kind) {
    case "morning":
      return period(
        kind,
        `${isoDate(behavioralDate)}-morning`,
        behavioralBoundary(behavioralDate, behavior),
        atLocalHour(behavioralDate, 12, behavior.timezone),
      );
    case "afternoon":
      return period(
        kind,
        `${isoDate(behavioralDate)}-afternoon`,
        atLocalHour(behavioralDate, 12, behavior.timezone),
        atLocalHour(behavioralDate, 17, behavior.timezone),
      );
    case "night":
      return period(
        kind,
        `${isoDate(behavioralDate)}-night`,
        atLocalHour(behavioralDate, 17, behavior.timezone),
        behavioralBoundary(shiftDays(behavioralDate, 1), behavior),
      );
    case "day":
      return period(
        kind,
        `${isoDate(behavioralDate)}-day`,
        behavioralBoundary(behavioralDate, behavior),
        behavioralBoundary(shiftDays(behavioralDate, 1), behavior),
      );
    case "week": {
      const currentMonday = shiftDays(behavioralDate, -(isoWeekday(behavioralDate) - 1));
      const start = shiftDays(currentMonday, -7);
      return period(
        kind,
        `${isoDate(start)}-week`,
        behavioralBoundary(start, behavior),
        behavioralBoundary(currentMonday, behavior),
      );
    }
    case "month": {
      const start = previousMonthStart({ year: behavioralDate.year, month: behavioralDate.month, day: 1 });
      return period(
        kind,
        `${isoMonth(start)}-month`,
        behavioralBoundary(start, behavior),
        behavioralBoundary({ year: behavioralDate.year, month: behavioralDate.month, day: 1 }, behavior),
      );
    }
  }
}

export function getPreviousPeriod(
  kind: TemporalSummaryKind,
  value: Date,
  behavior: BehaviorTime,
): TemporalPeriod {
  const current = getTemporalPeriod(kind, value, behavior);
  return getTemporalPeriod(kind, new Date(current.startAt.getTime() - 1), behavior);
}

/**
 * Only near-term prompt slots. Historical week/month backfills are
 * intentionally not part of the live rollout while summary quality is being
 * evaluated (source behavior preserved).
 */
export function getPromptTemporalPeriods(value: Date, behavior: BehaviorTime): TemporalPeriod[] {
  const now = value;
  const behavioralDate = behavioralCivilOf(now, behavior);
  const periods = [
    getTemporalPeriod("night", behavioralBoundary(shiftDays(behavioralDate, -1), behavior), behavior),
  ];

  const morning = getTemporalPeriod("morning", now, behavior);
  if (now.getTime() >= morning.endAt.getTime()) periods.push(morning);

  const afternoon = getTemporalPeriod("afternoon", now, behavior);
  if (now.getTime() >= afternoon.endAt.getTime()) periods.push(afternoon);

  return periods;
}

export function getClosedRefreshPeriods(value: Date, behavior: BehaviorTime): TemporalPeriod[] {
  return getPromptTemporalPeriods(value, behavior).filter(
    (candidate) => candidate.endAt.getTime() <= value.getTime(),
  );
}

/**
 * The periods the live generator is allowed to refresh. Prompt context
 * intentionally remains limited to recent leaf periods, while the generator
 * also needs the latest closed aggregate periods.
 */
export function getClosedTemporalSummaryPeriods(value: Date, behavior: BehaviorTime): TemporalPeriod[] {
  const periods = [...getClosedRefreshPeriods(value, behavior)];
  const latestDay = getPreviousPeriod("day", value, behavior);
  const latestWeek = getTemporalPeriod("week", value, behavior);
  const latestMonth = getTemporalPeriod("month", value, behavior);

  for (const candidate of [latestDay, latestWeek, latestMonth]) {
    if (
      candidate.endAt.getTime() <= value.getTime() &&
      !periods.some((existing) => existing.periodKey === candidate.periodKey)
    ) {
      periods.push(candidate);
    }
  }

  return periods;
}

export function isNearTermRefreshPeriod(
  candidate: TemporalPeriod,
  value: Date,
  behavior: BehaviorTime,
): boolean {
  return getClosedTemporalSummaryPeriods(value, behavior).some(
    (period) =>
      period.kind === candidate.kind && period.periodKey === candidate.periodKey,
  );
}

export function getChildPeriods(periodToExpand: TemporalPeriod, behavior: BehaviorTime): TemporalPeriod[] {
  if (periodToExpand.kind === "day") {
    const start = civilOf(periodToExpand.startAt, behavior);
    return [
      getTemporalPeriod("morning", behavioralBoundary(start, behavior), behavior),
      getTemporalPeriod("afternoon", behavioralBoundary(start, behavior), behavior),
      getTemporalPeriod("night", behavioralBoundary(start, behavior), behavior),
    ];
  }

  if (periodToExpand.kind === "week" || periodToExpand.kind === "month") {
    const children: TemporalPeriod[] = [];
    let civil = civilOf(periodToExpand.startAt, behavior);
    // Safety bound: a month can span 31 behavioral days; never loop wider.
    while (children.length < 40) {
      const boundary = behavioralBoundary(civil, behavior);
      if (boundary.getTime() >= periodToExpand.endAt.getTime()) break;
      children.push(getTemporalPeriod("day", boundary, behavior));
      civil = shiftDays(civil, 1);
    }
    return children;
  }

  return [];
}

export const __internal = {
  atLocalHour,
  civilOf,
  behavioralBoundary,
  isoDate,
  isoWeekday,
};
