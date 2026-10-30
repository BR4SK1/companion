// Unit tests for the web preview's scroll-anchoring helpers
// (apps/web/src/lib/scroll.ts). These encode the "never pull the reader away
// from older messages" rule that Thread's follow effect relies on.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  distanceFromBottom,
  isFollowingBottom,
} from "../../apps/web/src/lib/scroll.ts";

describe("web preview scroll anchoring", () => {
  it("computes the distance from the bottom", () => {
    assert.equal(
      distanceFromBottom({ scrollTop: 0, scrollHeight: 2000, clientHeight: 400 }),
      1600,
    );
    assert.equal(
      distanceFromBottom({ scrollTop: 1600, scrollHeight: 2000, clientHeight: 400 }),
      0,
    );
  });

  it("clamps at zero when overscrolled", () => {
    assert.equal(
      distanceFromBottom({ scrollTop: 9999, scrollHeight: 2000, clientHeight: 400 }),
      0,
    );
  });

  it("treats degenerate geometries as at-bottom", () => {
    assert.equal(distanceFromBottom({ scrollTop: 0, scrollHeight: 0, clientHeight: 0 }), 0);
  });

  it("follows at the bottom and inside the threshold", () => {
    const atBottom = { scrollTop: 1600, scrollHeight: 2000, clientHeight: 400 };
    assert.equal(isFollowingBottom(atBottom), true);
    const nearBottom = { scrollTop: 1520, scrollHeight: 2000, clientHeight: 400 };
    assert.equal(isFollowingBottom(nearBottom), true); // 80px away, default threshold 96
  });

  it("stops following beyond the threshold", () => {
    const scrolledUp = { scrollTop: 1000, scrollHeight: 2000, clientHeight: 400 };
    assert.equal(isFollowingBottom(scrolledUp), false);
    assert.equal(isFollowingBottom(scrolledUp, 50), false);
  });
});
