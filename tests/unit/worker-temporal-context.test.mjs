// Hermetic coverage for civil-time context; birthday data is synthetic and
// deliberately differs from the private owner setting.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildTemporalContext, inferHemisphere } from "../../apps/worker/src/temporal/context.ts";
import { temporalMigrations } from "../../apps/worker/src/temporal/migrations.ts";
import { loadTemporalSettings, TemporalSettingsError } from "../../apps/worker/src/temporal/store.ts";
import { loadMemoryBehavior } from "../../apps/worker/src/memory/subjects.ts";

const settings = (overrides = {}) => ({
  timezone: "America/New_York",
  seasonHemisphere: null,
  birthdayMonth: null,
  birthdayDay: null,
  ...overrides,
});
const at = (instant, zone = "America/New_York", overrides = {}) =>
  buildTemporalContext(new Date(instant), settings({ timezone: zone, ...overrides }));

describe("attempt temporal context", () => {
  it("records current local civil date/time and season from the configured zone", () => {
    const context = at("2026-11-01T06:30:45.000Z");
    assert.equal(context.timezone, "America/New_York");
    assert.equal(context.localDate, "2026-11-01");
    assert.equal(context.localTime, "01:30:45");
    assert.equal(context.season, "autumn");
    assert.match(context.promptText, /Sunday, November 1, 2026 at 1:30 AM \(America\/New_York, EST\)/);
  });

  it("uses one local civil date across DST folds and fresh instants across each attempt", () => {
    const first = at("2026-11-01T05:30:00.000Z");
    const second = at("2026-11-01T06:30:00.000Z");
    assert.equal(first.localDate, second.localDate);
    assert.equal(first.localTime, "01:30:00");
    assert.equal(second.localTime, "01:30:00");
    assert.notEqual(first.asOf.toISOString(), second.asOf.toISOString());
  });

  it("keeps local date coherent around spring-forward midnight", () => {
    const before = at("2026-03-08T04:59:00.000Z");
    const after = at("2026-03-08T05:01:00.000Z");
    assert.equal(before.localDate, "2026-03-07");
    assert.equal(after.localDate, "2026-03-08");
    assert.equal(after.localTime, "00:01:00");
  });

  it("leaves time and season unspecified without a valid zone and never guesses", () => {
    const unconfigured = at("2026-06-01T12:00:00.000Z", null);
    assert.equal(unconfigured.timezone, null);
    assert.equal(unconfigured.localDate, null);
    assert.equal(unconfigured.season, null);
    assert.deepEqual(unconfigured.occasionKeys, []);
    assert.match(unconfigured.promptText, /Do not infer them from your environment/);

    const ambiguous = at("2026-06-01T12:00:00.000Z", "Africa/Nairobi");
    assert.equal(ambiguous.timezone, "Africa/Nairobi");
    assert.equal(ambiguous.season, null);
    assert.match(ambiguous.promptText, /season is unspecified/);
  });

  it("infers hemisphere conservatively and honors an explicit override", () => {
    assert.equal(inferHemisphere("America/New_York"), "north");
    assert.equal(inferHemisphere("Australia/Sydney"), "south");
    assert.equal(inferHemisphere("America/Argentina/Buenos_Aires"), "south");
    assert.equal(inferHemisphere("Asia/Singapore"), null);
    assert.equal(inferHemisphere("Africa/Nairobi"), null);
    for (const zone of [
      "Asia/Dili", "Asia/Jayapura", "Asia/Singapore", "Asia/Jakarta",
      "Europe/Kyiv", "Australia/Darwin", "Pacific/Fiji",
      "America/Bogota", "America/Caracas", "America/Paramaribo", "America/Cayenne",
      "America/Boa_Vista", "Pacific/Tahiti", "Pacific/Rarotonga",
      "Pacific/Marquesas", "Pacific/Gambier",
    ]) {
      assert.equal(inferHemisphere(zone), null, `${zone} remains unspecified by default`);
    }
    for (const zone of ["Asia/Dili", "Asia/Jayapura"]) {
      assert.equal(at("2026-06-01T12:00:00.000Z", zone).season, null);
    }
    assert.equal(at("2026-06-01T12:00:00.000Z", "Pacific/Tahiti").season, null);
    assert.equal(
      at("2026-06-01T12:00:00.000Z", "Pacific/Tahiti", { seasonHemisphere: "south" }).season,
      "winter",
      "an explicit owner override is still honored",
    );
    assert.equal(at("2026-06-01T12:00:00.000Z", "Asia/Singapore", { seasonHemisphere: "south" }).season, "winter");
  });
});

describe("deterministic occasion context", () => {
  it("includes the 45th local calendar day and excludes the 46th", () => {
    const on45 = at("2026-05-20T16:00:00.000Z"); // May 20 locally; July 4 is 45 days away.
    const on46 = at("2026-05-19T16:00:00.000Z");
    assert.ok(on45.occasionKeys.includes("july_fourth"));
    assert.ok(!on46.occasionKeys.includes("july_fourth"));
  });

  it("prioritizes today, tomorrow, and close-day countdown wording", () => {
    assert.match(at("2026-10-31T12:00:00.000Z").occasionContext, /Halloween is today/);
    assert.match(at("2026-10-30T12:00:00.000Z").occasionContext, /Halloween is tomorrow/);
    assert.match(at("2026-10-28T12:00:00.000Z").occasionContext, /Halloween is in 3 days/);
  });

  it("uses accurate same-month/next-month date wording after the close countdown", () => {
    const thisMonth = at("2026-10-01T12:00:00.000Z");
    assert.match(thisMonth.occasionContext, /later this month on Saturday, October 31/);
    const nextMonth = at("2026-10-31T12:00:00.000Z");
    assert.match(nextMonth.occasionContext, /next month on Thursday, November 26/);
  });

  it("pairs Thanksgiving and Black Friday only when independently eligible", () => {
    const both = at("2026-11-20T12:00:00.000Z");
    assert.ok(both.occasionKeys.includes("thanksgiving"));
    assert.ok(both.occasionKeys.includes("black_friday"));
    assert.match(both.occasionContext, /US Thanksgiving is in 6 days.*Black Friday is in 7 days/);

    const boundary = at("2026-10-12T12:00:00.000Z");
    assert.ok(boundary.occasionKeys.includes("thanksgiving"));
    assert.ok(!boundary.occasionKeys.includes("black_friday"));
    assert.match(boundary.occasionContext, /US Thanksgiving is next month on Thursday, November 26/);
    assert.doesNotMatch(boundary.occasionContext, /Black Friday/);
  });

  it("pairs Christmas Eve and Christmas Day when they are in range", () => {
    const context = at("2026-12-10T12:00:00.000Z");
    assert.ok(context.occasionKeys.includes("christmas_eve"));
    assert.ok(context.occasionKeys.includes("christmas_day"));
    assert.match(context.occasionContext, /Christmas Eve.*Christmas Day/);
    assert.match(context.promptText, /do not assume the user celebrates/);
  });

  it("calculates a yearless configured birthday across New Year", () => {
    const context = at("2026-12-20T12:00:00.000Z", "America/New_York", {
      birthdayMonth: 1,
      birthdayDay: 2,
    });
    assert.ok(context.occasionKeys.includes("birthday"));
    assert.match(context.occasionContext, /your birthday is on Saturday, January 2, 2027/);
    assert.doesNotMatch(context.occasionContext, /19\d\d|20\d\d.*birthday/);
  });

  it("includes a synthetic birthday on the 45th day and excludes it on the 46th", () => {
    const settings = { birthdayMonth: 3, birthdayDay: 11 };
    const on45 = at("2027-01-25T17:00:00.000Z", "America/New_York", settings);
    const on46 = at("2027-01-24T17:00:00.000Z", "America/New_York", settings);
    assert.ok(on45.occasionKeys.includes("birthday"));
    assert.match(on45.occasionContext, /your birthday is on .*March 11/);
    assert.ok(!on46.occasionKeys.includes("birthday"));
    assert.doesNotMatch(on46.occasionContext ?? "", /birthday/);
  });
});

describe("authoritative temporal settings loader", () => {
  const poolFor = (row) => ({
    query: async (sql) => {
      assert.match(String(sql), /FROM companion_time_settings WHERE id = true/);
      return { rows: row === null ? [] : [row] };
    },
  });

  it("loads one configured zone and yearless personal selections", async () => {
    assert.deepEqual(await loadTemporalSettings(poolFor({
      timezone: "America/New_York",
      season_hemisphere: "north",
      birthday_month: 3,
      birthday_day: 11,
    })), {
      timezone: "America/New_York",
      seasonHemisphere: "north",
      birthdayMonth: 3,
      birthdayDay: 11,
    });
  });

  it("keeps an unconfigured zone explicit and rejects missing or invalid settings", async () => {
    assert.deepEqual(await loadTemporalSettings(poolFor({
      timezone: null,
      season_hemisphere: null,
      birthday_month: null,
      birthday_day: null,
    })), {
      timezone: null,
      seasonHemisphere: null,
      birthdayMonth: null,
      birthdayDay: null,
    });
    await assert.rejects(loadTemporalSettings(poolFor(null)), TemporalSettingsError);
    await assert.rejects(loadTemporalSettings(poolFor({
      timezone: "Not/A_Zone",
      season_hemisphere: null,
      birthday_month: null,
      birthday_day: null,
    })), /usable IANA timezone/);
    await assert.rejects(loadTemporalSettings(poolFor({
      timezone: "UTC",
      season_hemisphere: null,
      birthday_month: 2,
      birthday_day: 30,
    })), /valid month and day/);
  });
});

describe("startup timezone snapshot wiring", () => {
  it("uses the captured worker zone for memory behavior without rereading the singleton", async () => {
    let seenSql;
    let seenValues;
    const behavior = await loadMemoryBehavior({
      query: async (sql, values) => {
        seenSql = String(sql);
        seenValues = values;
        return { rows: [{ timezone: values[0], day_start_hour: 4 }] };
      },
    }, "America/New_York");
    assert.equal(behavior.timezone, "America/New_York");
    assert.equal(behavior.dayStartHour, 4);
    assert.doesNotMatch(seenSql, /companion_time_settings/);
    assert.deepEqual(seenValues, ["America/New_York"]);
  });
});

describe("authoritative timezone migration safety", () => {
  it("does not seed personal birthday/hemisphere values and refuses conflicting zones", () => {
    const sql = temporalMigrations[0].sql;
    assert.match(sql, /RAISE EXCEPTION 'authoritative timezone migration blocked/);
    assert.match(sql, /CREATE TABLE companion_time_settings/);
    assert.match(sql, /INSERT INTO companion_time_settings \(id, timezone\)/);
    assert.doesNotMatch(sql, /birthday_month\s*=\s*\d|birthday_day\s*=\s*\d|season_hemisphere\s*=\s*'/i);
  });

  it("adds typed attempt tracing without a generic payload column", () => {
    const sql = temporalMigrations[1].sql;
    for (const column of ["temporal_timezone", "temporal_as_of", "temporal_local_date", "temporal_local_time", "temporal_season", "temporal_occasion_keys"]) {
      assert.match(sql, new RegExp(`ADD COLUMN ${column}`));
    }
    assert.doesNotMatch(sql, /jsonb/i);
  });
});
