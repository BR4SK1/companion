import { DateTime, IANAZone } from "luxon";

/**
 * Pure labels for message instants. The zone is supplied by the authenticated
 * BFF from the worker's authoritative database setting; the browser's own zone
 * is never consulted. If that setting is unavailable, fixed UTC labels are
 * explicitly marked and no guessed local-day dividers are added.
 */
export function isValidTimezone(timezone: string): boolean {
  return IANAZone.isValidZone(timezone);
}

const EXPLICIT_OFFSET = /(?:Z|[+-]\d{2}:\d{2})$/i;

export function isValidInstant(iso: string): boolean {
  return EXPLICIT_OFFSET.test(iso) && DateTime.fromISO(iso, { setZone: true }).isValid;
}

function dateTime(iso: string, timezone: string | null): DateTime {
  const instant = DateTime.fromISO(iso, { setZone: true });
  if (!isValidInstant(iso) || !instant.isValid) throw new Error(`Invalid ISO timestamp: ${iso}`);
  // The authenticated BFF validates the worker's IANA zone. A particular
  // browser may nevertheless have an older ICU database; render explicitly in
  // UTC rather than breaking the thread or consulting the browser's local zone.
  if (timezone === null || !IANAZone.isValidZone(timezone)) return instant.toUTC();
  return instant.setZone(timezone);
}

function supportsTimezone(timezone: string | null): boolean {
  return timezone !== null && IANAZone.isValidZone(timezone);
}

export function timezoneOffsetLabel(shortName: string | null, numericOffset: string): string {
  return shortName ?? `UTC${numericOffset}`;
}

/** Calendar-day key (YYYY-MM-DD) for a timestamp in the authoritative zone. */
export function localDayKey(iso: string, timezone: string | null): string {
  return dateTime(iso, timezone).toISODate()!;
}

/** True only when both instants have a configured zone and cross its local day. */
export function isDifferentLocalDay(
  fromIso: string,
  toIso: string,
  timezone: string | null,
): boolean {
  if (!supportsTimezone(timezone)) return false;
  return localDayKey(fromIso, timezone) !== localDayKey(toIso, timezone);
}

/** Label for a day divider, e.g. "Oct 29, 2026". */
export function formatDayLabel(iso: string, timezone: string | null): string {
  const local = dateTime(iso, timezone);
  return `${local.toFormat("LLL d, yyyy")}${supportsTimezone(timezone) ? "" : " (UTC)"}`;
}

/** Short clock label for an individual message, e.g. "14:05". */
export function formatClockTime(iso: string, timezone: string | null): string {
  const local = dateTime(iso, timezone);
  if (!supportsTimezone(timezone)) return `${local.toFormat("HH:mm")} UTC`;
  const shortName = local.offsetNameShort;
  // Some Intl/ICU builds expose a valid numeric offset but no localized short
  // name. Never render the string "null" as a timezone abbreviation.
  return `${local.toFormat("HH:mm")} ${timezoneOffsetLabel(shortName, local.toFormat("ZZ"))}`;
}
