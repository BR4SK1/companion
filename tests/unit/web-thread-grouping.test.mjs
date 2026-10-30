// Unit tests for the web preview's pure thread-grouping logic
// (apps/web/src/lib/grouping.ts). No browser, no network.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  CLUSTER_GAP_MINUTES,
  groupThread,
} from "../../apps/web/src/lib/grouping.ts";

function message(id, role, sentAt, extra = {}) {
  return { id, role, sentAt, ...extra };
}

describe("web preview thread grouping", () => {
  it("keeps consecutive same-role messages in one cluster", () => {
    const items = groupThread([
      message("a", "user", "2026-10-29T08:00:00Z"),
      message("b", "user", "2026-10-29T08:01:00Z"),
    ]);
    assert.equal(items.length, 1);
    assert.equal(items[0].kind, "cluster");
    assert.equal(items[0].role, "user");
    assert.deepEqual(items[0].messages.map((m) => m.id), ["a", "b"]);
  });

  it("starts a new cluster when the role switches", () => {
    const items = groupThread([
      message("a", "user", "2026-10-29T08:00:00Z"),
      message("b", "assistant", "2026-10-29T08:00:10Z"),
      message("c", "user", "2026-10-29T08:00:20Z"),
    ]);
    assert.equal(items.length, 3);
    assert.ok(items.every((item) => item.kind === "cluster"));
    assert.deepEqual(items.map((item) => item.role), ["user", "assistant", "user"]);
  });

  it("splits same-role messages that drift beyond the cluster window", () => {
    const items = groupThread([
      message("a", "assistant", "2026-10-29T08:00:00Z"),
      message("b", "assistant", `2026-10-29T08:0${CLUSTER_GAP_MINUTES}:01Z`),
    ]);
    // 5 minutes + 1 second is outside the cluster window (<= CLUSTER_GAP_MINUTES groups).
    assert.equal(items.length, 2);
    assert.ok(items.every((item) => item.kind === "cluster"));
  });

  it("keeps same-role messages at exactly the cluster window together", () => {
    const items = groupThread([
      message("a", "assistant", "2026-10-29T08:00:00Z"),
      message("b", "assistant", `2026-10-29T08:0${CLUSTER_GAP_MINUTES}:00Z`),
    ]);
    assert.equal(items.length, 1);
  });

  it("emits a divider and starts fresh when the UTC day changes", () => {
    const items = groupThread([
      message("a", "user", "2026-10-29T23:00:00Z"),
      message("b", "user", "2026-10-30T01:00:00Z"),
    ]);
    assert.deepEqual(
      items.map((item) => item.kind),
      ["cluster", "divider", "cluster"],
    );
    // The divider carries the timestamp of the message that follows it.
    assert.equal(items[1].at, "2026-10-30T01:00:00Z");
  });

  it("does not emit a divider for a large gap within the same day", () => {
    const items = groupThread([
      message("a", "user", "2026-10-29T08:00:00Z"),
      message("b", "assistant", "2026-10-29T13:00:00Z"),
    ]);
    // 5 hours apart, same UTC day: clusters split, but no repeated date label.
    assert.deepEqual(
      items.map((item) => item.kind),
      ["cluster", "cluster"],
    );
  });

  it("keeps the divider between the surrounding clusters in order", () => {
    const items = groupThread([
      message("a", "user", "2026-10-29T08:00:00Z"),
      message("b", "assistant", "2026-10-29T10:00:00Z"),
      message("c", "user", "2026-10-30T09:00:00Z"),
    ]);
    assert.deepEqual(
      items.map((item) => (item.kind === "divider" ? "divider" : item.messages[0].id)),
      ["a", "b", "divider", "c"],
    );
    assert.equal(items[2].at, "2026-10-30T09:00:00Z");
  });

  it("preserves order and never drops messages", () => {
    const messages = [
      message("a", "user", "2026-10-29T08:00:00Z"),
      message("b", "assistant", "2026-10-29T08:00:05Z"),
      message("c", "assistant", "2026-10-29T08:01:00Z"),
      message("d", "user", "2026-10-30T09:00:00Z"),
      message("e", "assistant", "2026-10-30T09:02:00Z"),
    ];
    const items = groupThread(messages);
    const flattened = items.flatMap((item) =>
      item.kind === "cluster" ? item.messages.map((m) => m.id) : [],
    );
    assert.deepEqual(flattened, ["a", "b", "c", "d", "e"]);
  });

  it("returns an empty list for an empty thread", () => {
    assert.deepEqual(groupThread([]), []);
  });

  it("rejects invalid timestamps instead of guessing", () => {
    assert.throws(() => groupThread([message("a", "user", "not-a-date")]));
  });
});
