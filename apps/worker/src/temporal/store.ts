import type { PostgresPool } from "@companion/postgres";
import { DateTime } from "luxon";

import { isValidTimezone } from "../memory/time.ts";
import type { Hemisphere, TemporalSettings } from "./context.ts";

interface SettingsRow {
  timezone: string | null;
  season_hemisphere: string | null;
  birthday_month: number | null;
  birthday_day: number | null;
}

export class TemporalSettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TemporalSettingsError";
  }
}

/** Load the singleton once at worker startup; zone edits take effect on restart. */
export async function loadTemporalSettings(pool: PostgresPool): Promise<TemporalSettings> {
  const result = await pool.query<SettingsRow>(
    `SELECT timezone, season_hemisphere, birthday_month, birthday_day
     FROM companion_time_settings WHERE id = true`,
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new TemporalSettingsError("companion_time_settings singleton is missing");
  }
  if (row.timezone !== null && !isValidTimezone(row.timezone)) {
    throw new TemporalSettingsError("companion_time_settings.timezone is not a usable IANA timezone");
  }
  if (row.season_hemisphere !== null && row.season_hemisphere !== "north" && row.season_hemisphere !== "south") {
    throw new TemporalSettingsError("companion_time_settings.season_hemisphere is invalid");
  }
  if ((row.birthday_month === null) !== (row.birthday_day === null)) {
    throw new TemporalSettingsError("companion_time_settings birthday month and day must be provisioned together");
  }
  if (row.birthday_month !== null && row.birthday_day !== null) {
    const probe = DateTime.utc(2024, row.birthday_month, row.birthday_day);
    if (!probe.isValid || probe.month !== row.birthday_month || probe.day !== row.birthday_day) {
      throw new TemporalSettingsError("companion_time_settings birthday is not a valid month and day");
    }
  }
  return {
    timezone: row.timezone,
    seasonHemisphere: row.season_hemisphere as Hemisphere | null,
    birthdayMonth: row.birthday_month,
    birthdayDay: row.birthday_day,
  };
}
