/**
 * Pure time-label helpers for the thread UI.
 *
 * Preview simplification: fixture timestamps are UTC instants and all labels
 * and day keys are derived in UTC so the statically prerendered HTML and the
 * hydrated client always agree (no Today/Yesterday recomputation against the
 * wall clock, which would mismatch the prerender on later visits). Revisit
 * with a real clock and locale requirements when live data exists.
 */

const dayFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  month: "short",
  day: "numeric",
  year: "numeric",
});

const clockFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/** Calendar-day key (YYYY-MM-DD) for a millisecond instant, in UTC. */
export function utcDayKey(instant: number): string {
  return new Date(instant).toISOString().slice(0, 10);
}

/** True when two instants fall on different UTC calendar days. */
export function isDifferentUtcDay(fromIso: string, toIso: string): boolean {
  const from = Date.parse(fromIso);
  const to = Date.parse(toIso);
  if (Number.isNaN(from) || Number.isNaN(to)) {
    throw new Error(`Invalid ISO timestamp: ${fromIso}, ${toIso}`);
  }
  return utcDayKey(from) !== utcDayKey(to);
}

/** Label for a time divider, e.g. "Oct 29, 2026". */
export function formatDayLabel(iso: string): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) {
    throw new Error(`Invalid ISO timestamp: ${iso}`);
  }
  return dayFormat.format(at);
}

/** Short clock label for an individual message, e.g. "14:05". */
export function formatClockTime(iso: string): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) {
    throw new Error(`Invalid ISO timestamp: ${iso}`);
  }
  return clockFormat.format(at);
}
