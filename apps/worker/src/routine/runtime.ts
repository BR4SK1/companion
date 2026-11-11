import { toZoneTime } from "../memory/time.ts";
import type {
  RoutineAppliedState,
  RoutineConfiguration,
  RoutineOccurrence,
  RoutineTransition,
} from "./types.ts";

function isoDate(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function dateParts(date: string): { year: number; month: number; day: number } {
  const [year, month, day] = date.split("-").map(Number);
  if (![year, month, day].every(Number.isInteger)) {
    throw new Error(`invalid local date: ${date}`);
  }
  return { year: year!, month: month!, day: day! };
}

function addLocalDays(date: string, days: number): string {
  const parts = dateParts(date);
  const shifted = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return isoDate(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, shifted.getUTCDate());
}

function localDateAt(instant: Date, timezone: string): string {
  const local = toZoneTime(instant, timezone);
  return isoDate(local.year, local.month, local.day);
}

function sameLocalMinute(
  instant: Date,
  target: { year: number; month: number; day: number; hour: number; minute: number },
  timezone: string,
): boolean {
  const local = toZoneTime(instant, timezone);
  return local.year === target.year && local.month === target.month &&
    local.day === target.day && local.hour === target.hour && local.minute === target.minute;
}

/**
 * Resolve a configured local wall-clock minute without relying on host TZ.
 * A fall-back fold chooses its first occurrence. A spring-forward gap shifts
 * the wall time forward by the size of that gap (02:30 becomes 03:30 for a
 * one-hour gap), matching recurring human schedule expectations.
 */
function scheduledInstantForLocal(
  target: { year: number; month: number; day: number; hour: number; minute: number },
  timezone: string,
): Date {
  const localEpoch = Date.UTC(target.year, target.month - 1, target.day, target.hour, target.minute);
  const samples: { instant: number; offset: number }[] = [];
  const step = 30 * 60 * 1000;
  for (let instant = localEpoch - 36 * 60 * 60 * 1000;
       instant <= localEpoch + 36 * 60 * 60 * 1000;
       instant += step) {
    const local = toZoneTime(new Date(instant), timezone);
    const civilEpoch = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second);
    samples.push({ instant, offset: civilEpoch - instant });
  }
  const offsets = [...new Set(samples.map((sample) => sample.offset))];
  const resolveExact = (civilEpoch: number): Date | null => {
    const desired = new Date(civilEpoch);
    const desiredParts = {
      year: desired.getUTCFullYear(),
      month: desired.getUTCMonth() + 1,
      day: desired.getUTCDate(),
      hour: desired.getUTCHours(),
      minute: desired.getUTCMinutes(),
    };
    const matches = offsets
      .map((offset) => new Date(civilEpoch - offset))
      .filter((candidate) => sameLocalMinute(candidate, desiredParts, timezone))
      .sort((a, b) => a.getTime() - b.getTime());
    return matches[0] ?? null;
  };
  const direct = resolveExact(localEpoch);
  if (direct !== null) return direct;
  for (let index = 1; index < samples.length; index += 1) {
    const before = samples[index - 1]!.offset;
    const after = samples[index]!.offset;
    if (after > before) {
      const shifted = resolveExact(localEpoch + (after - before));
      if (shifted !== null) return shifted;
    }
  }
  throw new Error(`cannot resolve configured local schedule minute in ${timezone}`);
}

function weekdayForLocalDate(date: string): number {
  const { year, month, day } = dateParts(date);
  const sundayZero = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return sundayZero === 0 ? 7 : sundayZero;
}

function occurrenceFor(
  transition: RoutineTransition,
  date: string,
  timezone: string,
): RoutineOccurrence {
  const { year, month, day } = dateParts(date);
  const scheduledAt = scheduledInstantForLocal({
    year,
    month,
    day,
    hour: Math.floor(transition.localMinute / 60),
    minute: transition.localMinute % 60,
  }, timezone);
  return {
    transitionId: transition.id,
    transitionKey: transition.key,
    localDate: date,
    scheduledAt,
    location: transition.location,
    activity: transition.activity,
    available: transition.available,
    interactionContext: transition.interactionContext,
  };
}

function compareTransitionKeys(a: string, b: string): number {
  const left = Array.from(a, (character) => character.codePointAt(0)!);
  const right = Array.from(b, (character) => character.codePointAt(0)!);
  const commonLength = Math.min(left.length, right.length);
  for (let index = 0; index < commonLength; index += 1) {
    if (left[index] !== right[index]) return left[index]! - right[index]!;
  }
  return left.length - right.length;
}

function compareOccurrences(a: RoutineOccurrence, b: RoutineOccurrence): number {
  return a.scheduledAt.getTime() - b.scheduledAt.getTime() ||
    compareTransitionKeys(a.transitionKey, b.transitionKey);
}

function matchesWeekday(transition: RoutineTransition, date: string): boolean {
  return transition.weekday === weekdayForLocalDate(date);
}

function findOccurrences(input: {
  readonly configuration: RoutineConfiguration;
  readonly fromLocalDate: string;
  readonly throughLocalDate: string;
  readonly after?: Date;
  readonly afterKey?: string;
  readonly atOrBefore?: Date;
}): RoutineOccurrence[] {
  const occurrences: RoutineOccurrence[] = [];
  for (let date = input.fromLocalDate; date <= input.throughLocalDate; date = addLocalDays(date, 1)) {
    for (const transition of input.configuration.transitions) {
      if (!matchesWeekday(transition, date)) continue;
      const occurrence = occurrenceFor(transition, date, input.configuration.timezone);
      const ms = occurrence.scheduledAt.getTime();
      if (input.after !== undefined && (
        ms < input.after.getTime() ||
        (ms === input.after.getTime() &&
          (input.afterKey === undefined || compareTransitionKeys(transition.key, input.afterKey) <= 0))
      )) continue;
      if (input.atOrBefore !== undefined && ms > input.atOrBefore.getTime()) continue;
      occurrences.push(occurrence);
    }
  }
  return occurrences.sort(compareOccurrences);
}

/** The most recent recurring transition at or before an instant. */
export function scheduledRoutineStateAt(
  now: Date,
  configuration: RoutineConfiguration,
): RoutineOccurrence {
  if (!Number.isFinite(now.getTime())) throw new Error("now must be a valid Date");
  const today = localDateAt(now, configuration.timezone);
  const occurrences = findOccurrences({
    configuration,
    fromLocalDate: addLocalDays(today, -8),
    throughLocalDate: today,
    atOrBefore: now,
  });
  const latest = occurrences.at(-1);
  if (latest === undefined) {
    throw new Error("routine configuration has no transition at or before the requested time");
  }
  return latest;
}

export interface RoutineUnavailablePeriod {
  /** Latest configured occurrence that made the current schedule unavailable. */
  readonly current: RoutineOccurrence;
  /** Start of the current continuous unavailable interval, if one is configured. */
  readonly start: RoutineOccurrence | null;
  /** Next configured available occurrence, if one exists. */
  readonly resumes: RoutineOccurrence | null;
}

/** The current unavailable interval and its actual configured boundaries. */
export function currentRoutineUnavailablePeriod(
  now: Date,
  configuration: RoutineConfiguration,
): RoutineUnavailablePeriod | null {
  if (!Number.isFinite(now.getTime())) throw new Error("now must be a valid Date");
  const today = localDateAt(now, configuration.timezone);
  const occurrences = findOccurrences({
    configuration,
    fromLocalDate: addLocalDays(today, -8),
    throughLocalDate: addLocalDays(today, 8),
  });
  let currentIndex = -1;
  for (let index = 0; index < occurrences.length; index += 1) {
    if (occurrences[index]!.scheduledAt.getTime() <= now.getTime()) currentIndex = index;
    else break;
  }
  const current = occurrences[currentIndex];
  if (current === undefined || current.available) return null;

  let start: RoutineOccurrence | null = null;
  for (let index = currentIndex; index >= 0; index -= 1) {
    const occurrence = occurrences[index]!;
    if (occurrence.available) break;
    const previous = occurrences[index - 1];
    if (previous === undefined) break;
    if (previous.available) {
      start = occurrence;
      break;
    }
  }
  const resumes = occurrences.slice(currentIndex + 1).find((occurrence) => occurrence.available) ?? null;
  return { current, start, resumes };
}

function formatScheduleInstant(instant: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en", {
    timeZone: timezone,
    weekday: "long",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(instant);
}

/** A factual, schedule-derived notice; no provider response or personal defaults. */
export function renderRoutineAnnouncement(input: {
  readonly period: RoutineUnavailablePeriod;
  readonly timezone: string;
  readonly departureContext: string | null;
}): string {
  const lines = ["The configured schedule currently has me unavailable."];
  if (input.period.start !== null) {
    lines.push(`This unavailable period began ${formatScheduleInstant(input.period.start.scheduledAt, input.timezone)}.`);
  }
  if (input.period.resumes !== null) {
    lines.push(`The next configured available time is ${formatScheduleInstant(input.period.resumes.scheduledAt, input.timezone)}.`);
  } else {
    lines.push("There is no next available transition in the current schedule.");
  }
  if (input.departureContext !== null) {
    lines.push(input.departureContext);
  }
  return lines.join(" ");
}

/** Next recurring transition strictly after an instant. */
export function nextRoutineTransition(
  now: Date,
  configuration: RoutineConfiguration,
): RoutineOccurrence {
  if (!Number.isFinite(now.getTime())) throw new Error("now must be a valid Date");
  const today = localDateAt(now, configuration.timezone);
  const occurrences = findOccurrences({
    configuration,
    fromLocalDate: today,
    throughLocalDate: addLocalDays(today, 8),
    after: now,
  });
  const next = occurrences[0];
  if (next === undefined) throw new Error("routine configuration has no future transition");
  return next;
}

/** All recurring transitions after a persisted occurrence through a cutoff. */
export function routineTransitionsAfter(
  after: Date,
  through: Date,
  configuration: RoutineConfiguration,
  afterTransitionKey?: string,
): readonly RoutineOccurrence[] {
  if (!Number.isFinite(after.getTime()) || !Number.isFinite(through.getTime())) {
    throw new Error("routine reconciliation dates must be valid");
  }
  if (through.getTime() <= after.getTime()) return [];
  const fromDate = localDateAt(after, configuration.timezone);
  const throughDate = localDateAt(through, configuration.timezone);
  return findOccurrences({
    configuration,
    fromLocalDate: fromDate,
    throughLocalDate: throughDate,
    after,
    ...(afterTransitionKey !== undefined ? { afterKey: afterTransitionKey } : {}),
    atOrBefore: through,
  });
}

/**
 * Render current schedule state for ordinary turns. The durable schedule
 * notice is published separately, so an in-flight reply stays natural and
 * does not repeat the notice.
 */
export function renderRoutineContext(input: {
  readonly scheduled: RoutineOccurrence;
  readonly applied: RoutineAppliedState | null;
  readonly next: RoutineOccurrence;
}): string {
  const lines = [
    "Routine state (configured schedule):",
    `Scheduled now: ${describeState(input.scheduled)}.`,
    `Currently applied: ${input.applied === null
      ? "not yet applied"
      : `${describeState(input.applied)}; applied_at=${input.applied.appliedAt.toISOString()}`}.`,
    `Next configured transition: ${describeState(input.next)}.`,
  ];
  if (input.scheduled.available === false) {
    lines.push(
      "A separate schedule notice communicates this unavailable period; keep this reply focused on the current conversation and do not repeat the schedule notice.",
    );
  }
  if (input.scheduled.interactionContext !== null) {
    lines.push(`Configured interaction context for the current response: ${input.scheduled.interactionContext}`);
  }
  return lines.join("\n");
}

function describeState(state: RoutineOccurrence): string {
  const details = [
    `availability=${state.available ? "available" : "unavailable"}`,
    `location=${state.location ?? "unspecified"}`,
    `activity=${state.activity ?? "unspecified"}`,
    `transition=${state.transitionKey}`,
    `local_date=${state.localDate}`,
    `scheduled_at=${state.scheduledAt.toISOString()}`,
  ];
  return details.join(", ");
}

export const __internal = { addLocalDays, dateParts, weekdayForLocalDate, scheduledInstantForLocal };
