/**
 * Memory-domain time semantics.
 *
 * The behavioral day boundary — the timezone and the local hour the
 * behavioral day starts at — is personal behavior configuration: it is
 * provisioned privately in the `memory_behavior` table and loaded with the
 * rest of the memory configuration (fail closed when missing). It is never
 * code content. Evidence counting, period keys, and profile regeneration
 * cadence all use this boundary.
 *
 * Zone conversion uses the ICU timezone database through `Intl`, so any
 * IANA timezone works, including DST transitions; no timezone library
 * dependency is needed. Civil-date arithmetic is done with plain UTC math on
 * zone-shifted values.
 */

export interface BehaviorTime {
  readonly timezone: string;
  /** Local hour (0-23) the behavioral day starts at. */
  readonly dayStartHour: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

const formatters = new Map<string, Intl.DateTimeFormat>();

function zoneFormatter(timezone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timezone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timezone, formatter);
  }
  return formatter;
}

/** Whether the string names a timezone the runtime can convert with. */
export function isValidTimezone(timezone: string): boolean {
  try {
    zoneFormatter(timezone);
    return true;
  } catch {
    return false;
  }
}

export interface BehavioralLocalTime {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  readonly millisecond: number;
}

function zonedParts(date: Date, timezone: string): BehavioralLocalTime {
  const parts = zoneFormatter(timezone).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((candidate) => candidate.type === type);
    return part === undefined ? NaN : Number(part.value);
  };
  return {
    year: value("year"),
    month: value("month"),
    day: value("day"),
    hour: value("hour"),
    minute: value("minute"),
    second: value("second"),
    // Zone offsets are whole-minute, so the millisecond component is the
    // same in the zone as in UTC.
    millisecond: date.getUTCMilliseconds(),
  };
}

function zoneOffsetMs(date: Date, timezone: string): number {
  // Offsets are computed at whole-second precision; civil second values map
  // exactly, so the offset of any instant equals the offset of its
  // whole-second truncation.
  const truncated = Math.floor(date.getTime() / 1000) * 1000;
  const civil = zonedParts(new Date(truncated), timezone);
  const asUtc = Date.UTC(
    civil.year,
    civil.month - 1,
    civil.day,
    civil.hour,
    civil.minute,
    civil.second,
  );
  return asUtc - truncated;
}

/** Civil time of a timestamp in the configured behavioral timezone. */
export function toZoneTime(date: Date, timezone: string): BehavioralLocalTime {
  return zonedParts(date, timezone);
}

/** Construct a UTC Date from a civil time in the configured timezone. */
export function fromZoneTime(
  parts: {
    year: number;
    month: number;
    day: number;
    hour: number;
    minute?: number;
    second?: number;
    millisecond?: number;
  },
  timezone: string,
): Date {
  const minute = parts.minute ?? 0;
  const second = parts.second ?? 0;
  const millisecond = parts.millisecond ?? 0;
  const guess = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    minute,
    second,
    millisecond,
  );
  // Resolve the (at most one hour) ambiguity by iterating the offset: each
  // candidate instant is checked against the requested civil time. Handles
  // instants that sit on the far side of a transition from their naive guess
  // (e.g. a day-start hour on the fall-back day, whose naive guess is still
  // on the other side of the transition).
  let candidate = new Date(guess - zoneOffsetMs(new Date(guess), timezone));
  for (let refinement = 0; refinement < 3; refinement += 1) {
    const civil = toZoneTime(candidate, timezone);
    if (
      civil.year === parts.year &&
      civil.month === parts.month &&
      civil.day === parts.day &&
      civil.hour === parts.hour &&
      civil.minute === minute &&
      civil.second === second
    ) {
      return candidate;
    }
    candidate = new Date(guess - zoneOffsetMs(candidate, timezone));
  }
  // Nonexistent local time (DST gap): shift forward from the guess offset.
  return candidate;
}

/** The calendar date (ISO, behavioral timezone) a timestamp belongs to. */
export function behavioralDay(date: Date, behavior: BehaviorTime): string {
  const shifted = new Date(date.getTime() + zoneOffsetMs(date, behavior.timezone));
  if (shifted.getUTCHours() < behavior.dayStartHour) {
    shifted.setUTCDate(shifted.getUTCDate() - 1);
  }
  const year = shifted.getUTCFullYear();
  const month = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const day = String(shifted.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** Timestamp of the behavioral-day start hour on the given behavioral date. */
export function behavioralDayStart(isoDate: string, behavior: BehaviorTime): Date {
  const [year, month, day] = isoDate.split("-").map((part) => Number(part));
  if (
    year === undefined || month === undefined || day === undefined ||
    !Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)
  ) {
    throw new Error(`invalid behavioral date: ${isoDate}`);
  }
  return fromZoneTime(
    { year, month, day, hour: behavior.dayStartHour },
    behavior.timezone,
  );
}

export function calculateRecencyScore(
  lastObservedAt: Date,
  referenceTime: Date,
  windowDays: number,
): number {
  if (!Number.isFinite(lastObservedAt.getTime())) return 0;
  if (!Number.isFinite(referenceTime.getTime())) return 0;
  if (!Number.isFinite(windowDays) || windowDays <= 0) return 0;
  const ageDays = Math.max(0, (referenceTime.getTime() - lastObservedAt.getTime()) / DAY_MS);
  return Math.max(0, Math.min(1, 1 - ageDays / windowDays));
}

export function formatObservationAge(
  lastObservedAt: Date,
  referenceTime: Date,
): string {
  const ageDays = Math.max(0, Math.floor((referenceTime.getTime() - lastObservedAt.getTime()) / DAY_MS));
  if (ageDays === 0) return "today";
  if (ageDays === 1) return "1 day ago";
  return `${ageDays} days ago`;
}

/** Milliseconds until the next occurrence of local `hour` in the behavioral timezone. */
export function nextLocalHourDelay(now: Date, hour: number, timezone: string): number {
  const zoneNow = toZoneTime(now, timezone);
  const today = fromZoneTime({
    year: zoneNow.year,
    month: zoneNow.month,
    day: zoneNow.day,
    hour,
  }, timezone);
  if (today.getTime() > now.getTime()) {
    return today.getTime() - now.getTime();
  }
  const tomorrow = fromZoneTime({
    year: zoneNow.year,
    month: zoneNow.month,
    day: zoneNow.day + 1,
    hour,
  }, timezone);
  return tomorrow.getTime() - now.getTime();
}

export const __internal = { DAY_MS, zoneOffsetMs, zonedParts };
