import { DateTime } from "luxon";

export type MeteorologicalSeason = "spring" | "summer" | "autumn" | "winter";
export type Hemisphere = "north" | "south";

export interface TemporalSettings {
  readonly timezone: string | null;
  readonly seasonHemisphere: Hemisphere | null;
  readonly birthdayMonth: number | null;
  readonly birthdayDay: number | null;
}

/** Immutable, typed view of the wall-clock context used by one chat attempt. */
export interface TemporalContext {
  readonly asOf: Date;
  readonly timezone: string | null;
  readonly localDate: string | null;
  readonly localTime: string | null;
  readonly season: MeteorologicalSeason | null;
  readonly occasionKeys: readonly string[];
  readonly occasionContext: string | null;
  readonly promptText: string;
}

interface Occasion {
  readonly key: string;
  readonly name: string;
  readonly date: DateTime;
}

/**
 * Explicit allowlist of zones reviewed as clear, non-tropical examples for
 * seasonal wording. Do not infer from continent or region prefixes: unknown,
 * tropical, and cross-hemisphere zones remain unspecified until reviewed.
 */
const REVIEWED_HEMISPHERES: ReadonlyMap<string, Hemisphere> = new Map([
  ["America/New_York", "north"],
  ["America/Detroit", "north"],
  ["America/Chicago", "north"],
  ["America/Denver", "north"],
  ["America/Los_Angeles", "north"],
  ["America/Anchorage", "north"],
  ["America/Toronto", "north"],
  ["America/Vancouver", "north"],
  ["America/Halifax", "north"],
  ["America/Winnipeg", "north"],
  ["Europe/London", "north"],
  ["Europe/Paris", "north"],
  ["Europe/Berlin", "north"],
  ["Europe/Rome", "north"],
  ["Europe/Madrid", "north"],
  ["Europe/Oslo", "north"],
  ["Europe/Stockholm", "north"],
  ["Europe/Helsinki", "north"],
  ["Asia/Tokyo", "north"],
  ["Asia/Seoul", "north"],
  ["Asia/Ulaanbaatar", "north"],
  ["Arctic/Longyearbyen", "north"],
  ["Pacific/Honolulu", "north"],
  ["Pacific/Midway", "north"],
  ["Pacific/Guam", "north"],
  ["Pacific/Saipan", "north"],
  ["America/Argentina/Buenos_Aires", "south"],
  ["America/Argentina/Cordoba", "south"],
  ["America/Argentina/Jujuy", "south"],
  ["America/Argentina/La_Rioja", "south"],
  ["America/Argentina/Mendoza", "south"],
  ["America/Argentina/Rio_Gallegos", "south"],
  ["America/Argentina/Salta", "south"],
  ["America/Argentina/San_Juan", "south"],
  ["America/Argentina/San_Luis", "south"],
  ["America/Argentina/Tucuman", "south"],
  ["America/Argentina/Ushuaia", "south"],
  ["America/Sao_Paulo", "south"],
  ["America/Santiago", "south"],
  ["America/Punta_Arenas", "south"],
  ["America/Montevideo", "south"],
  ["America/Asuncion", "south"],
  ["Australia/Adelaide", "south"],
  ["Australia/Broken_Hill", "south"],
  ["Australia/Canberra", "south"],
  ["Australia/Currie", "south"],
  ["Australia/Eucla", "south"],
  ["Australia/Hobart", "south"],
  ["Australia/Lord_Howe", "south"],
  ["Australia/Melbourne", "south"],
  ["Australia/Perth", "south"],
  ["Australia/Sydney", "south"],
  ["Pacific/Auckland", "south"],
  ["Pacific/Chatham", "south"],
]);

/** Return a hemisphere only for a zone in the reviewed seasonal allowlist. */
export function inferHemisphere(timezone: string): Hemisphere | null {
  return REVIEWED_HEMISPHERES.get(timezone) ?? null;
}

function seasonFor(month: number, hemisphere: Hemisphere): MeteorologicalSeason {
  if (hemisphere === "north") {
    if (month <= 2 || month === 12) return "winter";
    if (month <= 5) return "spring";
    if (month <= 8) return "summer";
    return "autumn";
  }
  if (month <= 2) return "summer";
  if (month <= 5) return "autumn";
  if (month <= 8) return "winter";
  if (month <= 11) return "spring";
  return "summer";
}

function nthWeekdayOfMonth(year: number, month: number, weekday: number, nth: number): DateTime {
  const first = DateTime.utc(year, month, 1);
  const daysToWeekday = (weekday - first.weekday + 7) % 7;
  return first.plus({ days: daysToWeekday + (nth - 1) * 7 });
}

function occasionsForYear(year: number, settings: TemporalSettings): Occasion[] {
  const thanksgiving = nthWeekdayOfMonth(year, 11, 4, 4); // Luxon: Monday=1, Thursday=4
  const events: Occasion[] = [
    { key: "july_fourth", name: "Independence Day", date: DateTime.utc(year, 7, 4) },
    { key: "halloween", name: "Halloween", date: DateTime.utc(year, 10, 31) },
    { key: "thanksgiving", name: "US Thanksgiving", date: thanksgiving },
    { key: "black_friday", name: "Black Friday", date: thanksgiving.plus({ days: 1 }) },
    { key: "christmas_eve", name: "Christmas Eve", date: DateTime.utc(year, 12, 24) },
    { key: "christmas_day", name: "Christmas Day", date: DateTime.utc(year, 12, 25) },
  ];
  if (settings.birthdayMonth !== null && settings.birthdayDay !== null) {
    const birthday = DateTime.utc(year, settings.birthdayMonth, settings.birthdayDay);
    if (birthday.isValid) events.push({ key: "birthday", name: "your birthday", date: birthday });
  }
  return events;
}

function nextOccurrence(event: Occasion, today: DateTime): DateTime {
  return event.date < today ? event.date.plus({ years: 1 }) : event.date;
}

function countdownProse(date: DateTime, today: DateTime): string {
  const days = Math.round(date.diff(today, "days").days);
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days <= 7) return `in ${days} days`;
  const dateText = date.toFormat("cccc, LLLL d");
  if (date.year !== today.year) return `on ${date.toFormat("cccc, LLLL d, yyyy")}`;
  if (date.month === today.month) return `later this month on ${dateText}`;
  if (date.month === today.month + 1 || (today.month === 12 && date.month === 1)) {
    return `next month on ${dateText}`;
  }
  return `on ${dateText}`;
}

function formatOccasion(event: Occasion, date: DateTime, today: DateTime): string {
  const when = countdownProse(date, today);
  if (when === "today") return `${event.name} is today (${date.toFormat("cccc, LLLL d")})`;
  if (when === "tomorrow") return `${event.name} is tomorrow (${date.toFormat("cccc, LLLL d")})`;
  if (when.startsWith("in ")) return `${event.name} is ${when} (${date.toFormat("cccc, LLLL d")})`;
  return `${event.name} is ${when}`;
}

function occasionContext(today: DateTime, settings: TemporalSettings): { keys: string[]; text: string | null } {
  const eligible = occasionsForYear(today.year, settings)
    .map((event) => ({ event, date: nextOccurrence(event, today) }))
    .filter(({ date }) => {
      const days = Math.round(date.diff(today, "days").days);
      return days >= 0 && days <= 45;
    })
    .sort((a, b) => a.date.toMillis() - b.date.toMillis() || a.event.key.localeCompare(b.event.key));
  if (eligible.length === 0) return { keys: [], text: null };

  const byKey = new Map(eligible.map((entry) => [entry.event.key, entry]));
  const consumed = new Set<string>();
  const phrases: { date: DateTime; text: string }[] = [];
  const pair = (firstKey: string, secondKey: string, connector: string): void => {
    const first = byKey.get(firstKey);
    const second = byKey.get(secondKey);
    if (first === undefined || second === undefined) return;
    consumed.add(firstKey);
    consumed.add(secondKey);
    phrases.push({
      date: first.date,
      text: `${formatOccasion(first.event, first.date, today)}${connector}${formatOccasion(second.event, second.date, today)}`,
    });
  };
  pair("thanksgiving", "black_friday", "; ");
  pair("christmas_eve", "christmas_day", "; then ");
  for (const entry of eligible) {
    if (consumed.has(entry.event.key)) continue;
    consumed.add(entry.event.key);
    phrases.push({ date: entry.date, text: formatOccasion(entry.event, entry.date, today) });
  }
  phrases.sort((a, b) => a.date.toMillis() - b.date.toMillis());
  return {
    keys: eligible.map(({ event }) => event.key),
    text: phrases.map(({ text }) => text).join(". ") + ".",
  };
}

export function buildTemporalContext(
  now: Date,
  settings: TemporalSettings,
): TemporalContext {
  const asOf = new Date(now.getTime());
  if (settings.timezone === null) {
    return {
      asOf,
      timezone: null,
      localDate: null,
      localTime: null,
      season: null,
      occasionKeys: [],
      occasionContext: null,
      promptText: "Current local date, time, and season are unspecified because no timezone is configured. Do not infer them from your environment.",
    };
  }
  let local = DateTime.fromJSDate(asOf, { zone: settings.timezone });
  if (!local.isValid) {
    return {
      asOf,
      timezone: null,
      localDate: null,
      localTime: null,
      season: null,
      occasionKeys: [],
      occasionContext: null,
      promptText: "Current local date, time, and season are unspecified because the configured timezone is unusable. Do not infer them from your environment.",
    };
  }
  const seasonHemisphere = settings.seasonHemisphere ?? inferHemisphere(settings.timezone);
  const season = seasonHemisphere === null ? null : seasonFor(local.month, seasonHemisphere);
  // Use a UTC-midnight representation of the local civil date. Converting the
  // actual local start-of-day instant to UTC would shift dates in positive-offset
  // zones and corrupt day counts near New Year or daylight-saving changes.
  const occasion = occasionContext(DateTime.utc(local.year, local.month, local.day), settings);
  const pieces = [
    `Current local date and time: ${local.toFormat("cccc, LLLL d, yyyy 'at' h:mm a")} (${settings.timezone}, ${local.offsetNameShort}).`,
    season === null
      ? "Meteorological season is unspecified for this timezone; do not guess."
      : `Meteorological season: ${season}.`,
    ...(occasion.text === null
      ? []
      : [`Possible upcoming occasions: ${occasion.text} These dates are gentle context only: mention one only when naturally relevant, do not assume the user celebrates or wants to celebrate, and do not force anticipation.`]),
  ];
  return {
    asOf,
    timezone: settings.timezone,
    localDate: local.toISODate(),
    localTime: local.toFormat("HH:mm:ss"),
    season,
    occasionKeys: occasion.keys,
    occasionContext: occasion.text,
    promptText: pieces.join(" "),
  };
}
