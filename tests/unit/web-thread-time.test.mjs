// Unit tests for the web preview's deterministic time labels
// (apps/web/src/lib/time.ts). Labels are UTC-based so the statically
// prerendered HTML and the hydrated client always agree.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  formatClockTime,
  formatDayLabel,
  isDifferentUtcDay,
} from "../../apps/web/src/lib/time.ts";

describe("web preview time labels", () => {
  it("formats divider dates deterministically in UTC", () => {
    assert.equal(formatDayLabel("2026-10-29T08:12:00Z"), "Oct 29, 2026");
    assert.equal(formatDayLabel("2026-10-30T23:59:00Z"), "Oct 30, 2026");
    // January rolls over with the year included.
    assert.equal(formatDayLabel("2027-01-01T00:30:00Z"), "Jan 1, 2027");
  });

  it("formats message clock times as 24-hour UTC", () => {
    assert.equal(formatClockTime("2026-10-29T08:12:00Z"), "08:12");
    assert.equal(formatClockTime("2026-10-29T17:05:30Z"), "17:05");
  });

  it("rejects invalid timestamps", () => {
    assert.throws(() => formatDayLabel("not-a-date"));
    assert.throws(() => formatClockTime(""));
  });

  it("detects UTC day boundaries for dividers", () => {
    assert.equal(isDifferentUtcDay("2026-10-29T23:59:00Z", "2026-10-30T00:00:00Z"), true);
    assert.equal(isDifferentUtcDay("2026-10-29T08:00:00Z", "2026-10-29T20:00:00Z"), false);
    assert.throws(() => isDifferentUtcDay("2026-10-29T08:00:00Z", "nope"));
  });
});
