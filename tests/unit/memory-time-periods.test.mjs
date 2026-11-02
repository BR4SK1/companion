// Unit tests for the memory domain's time semantics and temporal periods:
// the behavioral day — configured via the provisioned behavior (timezone and
// local start hour), including DST transition days — day-start instants,
// next-local-hour scheduling delays, period construction for every kind,
// prompt-period closure rules, and child-period expansion. Deterministic —
// no database, no network.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  behavioralDay,
  behavioralDayStart,
  nextLocalHourDelay,
  calculateRecencyScore,
  isValidTimezone,
} from "../../apps/worker/src/memory/time.ts";
import {
  getTemporalPeriod,
  getPreviousPeriod,
  getPromptTemporalPeriods,
  getClosedRefreshPeriods,
  getClosedTemporalSummaryPeriods,
  isNearTermRefreshPeriod,
  getChildPeriods,
} from "../../apps/worker/src/memory/temporal/periods.ts";

// The provisioned boundary under test in most cases: 4am America/New_York.
const NY4 = { timezone: "America/New_York", dayStartHour: 4 };

describe("memory behavioral day (configured boundary: 4am America/New_York)", () => {
  it("assigns early-morning timestamps to the previous behavioral day", () => {
    // 3am EDT on 2026-06-15 (UTC-4) belongs behaviorally to 2026-06-14.
    assert.equal(behavioralDay(new Date("2026-06-15T07:00:00Z"), NY4), "2026-06-14");
    // 5am EDT on 2026-06-15 belongs to 2026-06-15.
    assert.equal(behavioralDay(new Date("2026-06-15T09:00:00Z"), NY4), "2026-06-15");
    // 9pm EST on 2026-01-14 (UTC-5) belongs to 2026-01-14.
    assert.equal(behavioralDay(new Date("2026-01-15T02:00:00Z"), NY4), "2026-01-14");
  });

  it("resolves the fall-back DST transition (2026-11-01, 2am EDT -> EST)", () => {
    // 1:30am EDT (before the 06:00Z transition): still Oct 31 behaviorally.
    assert.equal(behavioralDay(new Date("2026-11-01T05:59:00Z"), NY4), "2026-10-31");
    // 1:30am EST (after the transition): also Oct 31 — the repeated hour does
    // not change the behavioral date.
    assert.equal(behavioralDay(new Date("2026-11-01T06:01:00Z"), NY4), "2026-10-31");
    // 4am EST on Nov 1 starts the Nov 1 behavioral day.
    assert.equal(behavioralDay(new Date("2026-11-01T09:00:00Z"), NY4), "2026-11-01");
  });

  it("resolves the spring-forward DST transition (2026-03-08, 2am EST -> EDT)", () => {
    assert.equal(behavioralDay(new Date("2026-03-08T06:30:00Z"), NY4), "2026-03-07");
    assert.equal(behavioralDay(new Date("2026-03-08T08:30:00Z"), NY4), "2026-03-08");
  });

  it("computes day-start instants per season", () => {
    // 4am EDT (UTC-4) in summer.
    assert.equal(
      behavioralDayStart("2026-06-15", NY4).toISOString(),
      "2026-06-15T08:00:00.000Z",
    );
    // 4am EST (UTC-5) in winter.
    assert.equal(
      behavioralDayStart("2026-01-15", NY4).toISOString(),
      "2026-01-15T09:00:00.000Z",
    );
    // 4am EST on the fall-back day itself.
    assert.equal(
      behavioralDayStart("2026-11-01", NY4).toISOString(),
      "2026-11-01T09:00:00.000Z",
    );
  });

  it("schedules the next local hour across the 4am boundary", () => {
    // 3am EDT: the next 4am is one hour away, today.
    const threeAm = new Date("2026-06-15T07:00:00Z");
    assert.equal(nextLocalHourDelay(threeAm, 4, NY4.timezone), 60 * 60 * 1000);
    // 6am EDT: the next 4am is tomorrow, 22 hours away.
    const sixAm = new Date("2026-06-15T10:00:00Z");
    assert.equal(nextLocalHourDelay(sixAm, 4, NY4.timezone), 22 * 60 * 60 * 1000);
    // Across a DST transition: 11pm EDT Oct 31 (03:00Z Nov 1) -> 4am EST
    // (09:00Z Nov 1) is ten hours away.
    const lateNight = new Date("2026-11-01T03:00:00Z");
    assert.equal(nextLocalHourDelay(lateNight, 4, NY4.timezone), 6 * 60 * 60 * 1000);
  });

  it("accepts a provisioned boundary different from the default zone and hour", () => {
    // The boundary is configuration, not code: a different timezone and a
    // different start hour must both change the behavioral day.
    const berlin3 = { timezone: "Europe/Berlin", dayStartHour: 3 };
    // 2am CEST (UTC+2) on 2026-06-15 is before 3am: previous behavioral day.
    assert.equal(behavioralDay(new Date("2026-06-15T00:00:00Z"), berlin3), "2026-06-14");
    // 4am CEST on 2026-06-15 belongs to 2026-06-15.
    assert.equal(behavioralDay(new Date("2026-06-15T02:00:00Z"), berlin3), "2026-06-15");
    // Day start: 3am CEST (UTC+2) is 01:00Z.
    assert.equal(
      behavioralDayStart("2026-06-15", berlin3).toISOString(),
      "2026-06-15T01:00:00.000Z",
    );
    // A fixed-offset zone without DST: the whole day is offset uniformly.
    const honolulu4 = { timezone: "Pacific/Honolulu", dayStartHour: 4 };
    assert.equal(
      behavioralDayStart("2026-06-15", honolulu4).toISOString(),
      "2026-06-15T14:00:00.000Z",
    );
    // 2am HST (UTC-10) on 2026-06-15: before the 4am start, previous day.
    assert.equal(behavioralDay(new Date("2026-06-15T12:00:00Z"), honolulu4), "2026-06-14");
  });

  it("rejects unusable timezone strings (the loader fails closed on them)", () => {
    assert.equal(isValidTimezone("America/New_York"), true);
    assert.equal(isValidTimezone("UTC"), true);
    assert.equal(isValidTimezone("Not/AZone"), false);
  });

  it("scores recency linearly inside the window and clamps outside", () => {
    const reference = new Date("2026-06-15T12:00:00Z");
    assert.equal(calculateRecencyScore(reference, reference, 30), 1);
    assert.equal(
      calculateRecencyScore(new Date("2026-06-08T12:00:00Z"), reference, 30),
      1 - 7 / 30,
    );
    assert.equal(
      calculateRecencyScore(new Date("2026-01-01T12:00:00Z"), reference, 30),
      0,
    );
  });
});

describe("temporal periods", () => {
  const afternoon = new Date("2026-06-15T18:00:00Z"); // 2pm EDT Monday

  it("builds leaf periods from the behavioral day", () => {
    const morning = getTemporalPeriod("morning", afternoon, NY4);
    assert.equal(morning.periodKey, "2026-06-15-morning");
    assert.equal(morning.startAt.toISOString(), "2026-06-15T08:00:00.000Z");
    assert.equal(morning.endAt.toISOString(), "2026-06-15T16:00:00.000Z");

    const afternoonPeriod = getTemporalPeriod("afternoon", afternoon, NY4);
    assert.equal(afternoonPeriod.periodKey, "2026-06-15-afternoon");
    assert.equal(afternoonPeriod.startAt.toISOString(), "2026-06-15T16:00:00.000Z");
    assert.equal(afternoonPeriod.endAt.toISOString(), "2026-06-15T21:00:00.000Z");

    const night = getTemporalPeriod("night", afternoon, NY4);
    assert.equal(night.periodKey, "2026-06-15-night");
    assert.equal(night.startAt.toISOString(), "2026-06-15T21:00:00.000Z");
    assert.equal(night.endAt.toISOString(), "2026-06-16T08:00:00.000Z");
  });

  it("builds the day period from one 4am boundary to the next", () => {
    const day = getTemporalPeriod("day", afternoon, NY4);
    assert.equal(day.periodKey, "2026-06-15-day");
    assert.equal(day.startAt.toISOString(), "2026-06-15T08:00:00.000Z");
    assert.equal(day.endAt.toISOString(), "2026-06-16T08:00:00.000Z");
  });

  it("measures DST transition days correctly", () => {
    // Fall-back day: Saturday Oct 31's behavioral day runs 4am EDT Oct 31 to
    // 4am EST Nov 1 — 25 hours.
    const fallDay = getTemporalPeriod(
      "day",
      new Date("2026-10-31T20:00:00Z"),
      NY4,
    );
    assert.equal(fallDay.periodKey, "2026-10-31-day");
    assert.equal(
      (fallDay.endAt.getTime() - fallDay.startAt.getTime()) / 3_600_000,
      25,
    );
    // Spring-forward day: Saturday Mar 7's behavioral day runs 4am EST Mar 7
    // to 4am EDT Mar 8 — 23 hours.
    const springDay = getTemporalPeriod(
      "day",
      new Date("2026-03-07T20:00:00Z"),
      NY4,
    );
    assert.equal(springDay.periodKey, "2026-03-07-day");
    assert.equal(
      (springDay.endAt.getTime() - springDay.startAt.getTime()) / 3_600_000,
      23,
    );
  });

  it("builds the previous complete behavioral week (Monday-based)", () => {
    // Wednesday 2026-06-17: current behavioral week started Monday 06-15, so
    // the week period covers Monday 06-08 4am to Monday 06-15 4am.
    const week = getTemporalPeriod(
      "week",
      new Date("2026-06-17T18:00:00Z"),
      NY4,
    );
    assert.equal(week.periodKey, "2026-06-08-week");
    assert.equal(week.startAt.toISOString(), "2026-06-08T08:00:00.000Z");
    assert.equal(week.endAt.toISOString(), "2026-06-15T08:00:00.000Z");
  });

  it("builds the previous complete behavioral month", () => {
    const month = getTemporalPeriod(
      "month",
      new Date("2026-06-17T18:00:00Z"),
      NY4,
    );
    assert.equal(month.periodKey, "2026-05-month");
    assert.equal(month.startAt.toISOString(), "2026-05-01T08:00:00.000Z");
    assert.equal(month.endAt.toISOString(), "2026-06-01T08:00:00.000Z");
  });

  it("steps back one period of the same kind", () => {
    const value = new Date("2026-06-17T18:00:00Z");
    const previousDay = getPreviousPeriod("day", value, NY4);
    assert.equal(previousDay.periodKey, "2026-06-16-day");
    // Source quirk, preserved: the previous-period reference instant is one
    // millisecond before the week's 4am start, whose behavioral date is the
    // prior Sunday — so a week steps back past the intervening week period.
    // Only the day kind is used for closure decisions in the live flow.
    const previousWeek = getPreviousPeriod("week", value, NY4);
    assert.equal(previousWeek.periodKey, "2026-05-25-week");
  });

  it("serves only closed prompt periods", () => {
    // 2pm EDT Monday: previous night always; this morning is closed; this
    // afternoon is still open.
    const periods = getPromptTemporalPeriods(afternoon, NY4);
    assert.deepEqual(
      periods.map((period) => period.periodKey),
      ["2026-06-14-night", "2026-06-15-morning"],
    );

    // 6pm EDT: the afternoon has closed.
    const evening = new Date("2026-06-15T22:00:00Z");
    assert.deepEqual(
      getPromptTemporalPeriods(evening, NY4).map((period) => period.periodKey),
      ["2026-06-14-night", "2026-06-15-morning", "2026-06-15-afternoon"],
    );

    // 1am EDT (behaviorally still Sunday): the prompt slots are the previous
    // night (the night that ended at 4am Sunday) plus the closed leaf periods
    // of the current behavioral day (Sunday).
    const lateNight = new Date("2026-06-15T05:00:00Z");
    assert.deepEqual(
      getClosedRefreshPeriods(lateNight, NY4).map((period) => period.periodKey),
      [
        "2026-06-13-night",
        "2026-06-14-morning",
        "2026-06-14-afternoon",
      ],
    );
  });

  it("adds the closed aggregates to the generator's refresh set", () => {
    const value = new Date("2026-06-17T18:00:00Z"); // Wednesday
    const periods = getClosedTemporalSummaryPeriods(value, NY4);
    const keys = periods.map((period) => `${period.kind}:${period.periodKey}`);
    // The latest closed day, the previous week, and the previous month join
    // the closed leaf periods.
    assert.ok(keys.includes("day:2026-06-16-day"));
    assert.ok(keys.includes("week:2026-06-08-week"));
    assert.ok(keys.includes("month:2026-05-month"));
    assert.ok(!keys.includes("day:2026-06-17-day"));
    assert.ok(
      isNearTermRefreshPeriod(
        { kind: "week", periodKey: "2026-06-08-week", startAt: periods[0].startAt, endAt: periods[0].endAt },
        value,
        NY4,
      ),
    );
    assert.ok(
      !isNearTermRefreshPeriod(
        { kind: "week", periodKey: "2026-06-01-week", startAt: periods[0].startAt, endAt: periods[0].endAt },
        value,
        NY4,
      ),
    );
  });

  it("expands aggregates into their children", () => {
    const day = getTemporalPeriod("day", new Date("2026-06-17T18:00:00Z"), NY4);
    const children = getChildPeriods(day, NY4);
    assert.deepEqual(
      children.map((child) => child.periodKey),
      [
        "2026-06-17-morning",
        "2026-06-17-afternoon",
        "2026-06-17-night",
      ],
    );

    const week = getTemporalPeriod("week", new Date("2026-06-17T18:00:00Z"), NY4);
    const weekChildren = getChildPeriods(week, NY4);
    assert.equal(weekChildren.length, 7);
    assert.deepEqual(
      weekChildren.map((child) => child.periodKey),
      [
        "2026-06-08-day",
        "2026-06-09-day",
        "2026-06-10-day",
        "2026-06-11-day",
        "2026-06-12-day",
        "2026-06-13-day",
        "2026-06-14-day",
      ],
    );

    const month = getTemporalPeriod("month", new Date("2026-06-17T18:00:00Z"), NY4);
    assert.equal(getChildPeriods(month, NY4).length, 31);

    assert.deepEqual(getChildPeriods(getTemporalPeriod("morning", afternoon, NY4), NY4), []);
  });
});
