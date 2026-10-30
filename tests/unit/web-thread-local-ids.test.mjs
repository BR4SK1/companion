// Unit tests for locally composed preview message ids
// (apps/web/src/lib/local-ids.ts). The preview keeps sent messages only in
// memory, but their ids must still be unique and stable within a session.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { nextLocalMessageId } from "../../apps/web/src/lib/local-ids.ts";

describe("web preview local message ids", () => {
  it("produces unique ids even within the same millisecond", () => {
    const fixedNow = () => 1_760_000_000_000;
    const ids = new Set(
      Array.from({ length: 100 }, () => nextLocalMessageId(fixedNow)),
    );
    assert.equal(ids.size, 100);
  });

  it("embeds the timestamp and stays roughly sortable", () => {
    let tick = 1_000;
    const now = () => tick;
    const first = nextLocalMessageId(now);
    tick += 5;
    const second = nextLocalMessageId(now);
    assert.match(first, /^local-1000-\d+$/);
    assert.match(second, /^local-1005-\d+$/);
    assert.ok(first < second, "ids should sort in composition order");
  });
});
