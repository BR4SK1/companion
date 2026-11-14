// Unit tests for authoritative-zone web labels (apps/web/src/lib/time.ts).
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  formatClockTime,
  formatDayLabel,
  isValidTimezone,
  isDifferentLocalDay,
  timezoneOffsetLabel,
} from "../../apps/web/src/lib/time.ts";

describe("web thread time labels", () => {
  it("formats labels in the worker-provided IANA zone, not the host zone", () => {
    assert.equal(formatDayLabel("2026-10-30T02:30:00Z", "America/New_York"), "Oct 29, 2026");
    assert.equal(formatClockTime("2026-10-30T02:30:00Z", "America/New_York"), "22:30 EDT");
  });

  it("formats fold instants with distinct offsets while retaining one local date", () => {
    const first = "2026-11-01T05:30:00Z";
    const second = "2026-11-01T06:30:00Z";
    assert.equal(formatClockTime(first, "America/New_York"), "01:30 EDT");
    assert.equal(formatClockTime(second, "America/New_York"), "01:30 EST");
    assert.equal(isDifferentLocalDay(first, second, "America/New_York"), false);
  });

  it("uses a numeric offset when Intl has no short timezone name", () => {
    assert.equal(timezoneOffsetLabel(null, "-04:00"), "UTC-04:00");
    assert.equal(timezoneOffsetLabel("EDT", "-04:00"), "EDT");
    assert.doesNotMatch(formatClockTime("2026-11-01T05:30:00Z", "America/New_York"), /null/);
  });

  it("uses one local calendar day through spring-forward and handles a local rollover", () => {
    assert.equal(
      isDifferentLocalDay("2026-03-08T06:30:00Z", "2026-03-08T07:30:00Z", "America/New_York"),
      false,
    );
    assert.equal(
      isDifferentLocalDay("2026-03-08T04:59:00Z", "2026-03-08T05:01:00Z", "America/New_York"),
      true,
    );
  });

  it("does not invent local-day dividers when the worker has no configured zone", () => {
    assert.equal(isDifferentLocalDay("2026-10-29T23:59:00Z", "2026-10-30T00:01:00Z", null), false);
    assert.equal(formatDayLabel("2026-10-30T02:30:00Z", null), "Oct 30, 2026 (UTC)");
    assert.equal(formatClockTime("2026-10-30T02:30:00Z", null), "02:30 UTC");
  });

  it("falls back to explicitly labeled UTC when this runtime cannot format a zone", () => {
    const unsupported = "Mars/Olympus_Mons";
    assert.equal(formatDayLabel("2026-10-30T02:30:00Z", unsupported), "Oct 30, 2026 (UTC)");
    assert.equal(formatClockTime("2026-10-30T02:30:00Z", unsupported), "02:30 UTC");
    assert.equal(
      isDifferentLocalDay("2026-10-29T23:59:00Z", "2026-10-30T00:01:00Z", unsupported),
      false,
    );
  });

  it("rejects invalid timestamps and identifies unsupported zones without crashing labels", () => {
    assert.throws(() => formatDayLabel("not-a-date", "UTC"));
    assert.throws(() => formatClockTime("", "UTC"));
    assert.equal(isValidTimezone("Not/AZone"), false);
    assert.equal(formatDayLabel("2026-10-29T00:00:00Z", "Not/AZone"), "Oct 29, 2026 (UTC)");
  });
});
