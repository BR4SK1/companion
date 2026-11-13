// Unit tests for the web client's live-thread state logic
// (apps/web/src/lib/thread-state.ts): snapshot merging keyed by message id
// (never a bare seq watermark), gap detection and bounded gap-walk
// decisions for reconciliation without timing assumptions, the
// may-have-earlier-history rule, pending-send lifecycle, snapshot response
// validation, and client-key generation.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  appendPending,
  createClientKey,
  detectThreadGaps,
  dropConfirmedPending,
  mayHaveEarlierHistory,
  mergeThreadMessages,
  nextGapWalkStep,
  parseThreadSnapshotResponse,
  removePending,
  updatePending,
} from "../../apps/web/src/lib/thread-state.ts";

function threadMessage(id, seq, role = "user", text = `text ${id}`) {
  return { id, seq, role, text, sentAt: "2026-10-30T00:00:00.000Z" };
}

function page(overrides = {}) {
  return { oldestSeq: 1, hasMore: false, messages: [], ...overrides };
}

/** A loaded range with interior gaps: seqs 1..3, 5, 7..8. */
function gappedMessages() {
  return [
    threadMessage("a", 1),
    threadMessage("b", 2),
    threadMessage("c", 3),
    threadMessage("d", 5),
    threadMessage("e", 7),
    threadMessage("f", 8),
  ];
}

describe("thread snapshot merging", () => {
  it("keeps one entry per message id and orders by seq", () => {
    const previous = [threadMessage("a", 1), threadMessage("b", 2)];
    const incoming = [threadMessage("a", 1), threadMessage("c", 3)];
    assert.deepEqual(mergeThreadMessages(previous, incoming), [
      threadMessage("a", 1),
      threadMessage("b", 2),
      threadMessage("c", 3),
    ]);
  });

  it("lets the incoming snapshot win for the same id", () => {
    const previous = [threadMessage("a", 1, "user", "stale text")];
    const incoming = [threadMessage("a", 1, "user", "fresh text")];
    assert.equal(mergeThreadMessages(previous, incoming)[0].text, "fresh text");
  });

  it("picks up a reply committed behind an already-observed seq", () => {
    // Publication transaction ordering: the reply's seq is assigned at
    // insert time inside the publication transaction but becomes visible at
    // commit — a poller may already have observed a user message with a
    // higher seq. A watermark read would miss the reply; the id-keyed merge
    // over a bounded tail must include it.
    const previous = [threadMessage("u-late", 5), threadMessage("u-earlier", 4)];
    const incoming = [threadMessage("u-earlier", 4), threadMessage("reply", 3, "assistant")];
    const merged = mergeThreadMessages(previous, incoming);
    assert.deepEqual(
      merged.map((message) => message.id),
      ["reply", "u-earlier", "u-late"],
      "the late-committed reply must appear, ordered by seq",
    );
  });

  it("does not reorder or drop messages on repeated merges", () => {
    let state = [];
    for (let seq = 1; seq <= 5; seq += 1) {
      state = mergeThreadMessages(state, [threadMessage(`m${String(seq)}`, seq)]);
    }
    assert.deepEqual(
      state.map((message) => message.seq),
      [1, 2, 3, 4, 5],
    );
    // Re-delivering an older snapshot changes nothing.
    state = mergeThreadMessages(state, [threadMessage("m2", 2)]);
    assert.equal(state.length, 5);
  });
});

describe("pending send lifecycle", () => {
  function pending(overrides = {}) {
    return {
      clientKey: "k1",
      text: "hello",
      sentAt: "2026-10-30T00:00:00.000Z",
      kind: "in_flight",
      needsNewKey: false,
      ...overrides,
    };
  }

  it("appends, updates by client key, and removes", () => {
    let list = appendPending([], pending());
    list = appendPending(list, pending({ clientKey: "k2", text: "second" }));
    assert.equal(list.length, 2);

    list = updatePending(list, "k1", (entry) => ({
      ...entry,
      kind: "confirmed",
      serverId: "srv-1",
    }));
    assert.equal(list[0].kind, "confirmed");
    assert.equal(list[0].serverId, "srv-1");
    assert.equal(list[1].kind, "in_flight");

    list = removePending(list, "k2");
    assert.deepEqual(
      list.map((entry) => entry.clientKey),
      ["k1"],
    );
  });

  it("drops confirmed entries once the durable snapshot contains them", () => {
    const list = [
      pending({ clientKey: "k1", serverId: "srv-1", kind: "confirmed" }),
      pending({ clientKey: "k2" }),
      pending({ clientKey: "k3", serverId: "srv-9", kind: "confirmed" }),
    ];
    const remaining = dropConfirmedPending(list, [threadMessage("srv-1", 7, "user")]);
    assert.deepEqual(
      remaining.map((entry) => entry.clientKey),
      ["k2", "k3"],
      "entries whose durable message arrived are dropped; unconfirmed and not-yet-arrived entries stay",
    );
  });
});

describe("thread gap detection", () => {
  it("finds no gaps in a contiguous loaded range", () => {
    const messages = [
      threadMessage("a", 1),
      threadMessage("b", 2),
      threadMessage("c", 3),
    ];
    assert.deepEqual(detectThreadGaps(messages), []);
  });

  it("finds no gaps in an empty or single-message range", () => {
    assert.deepEqual(detectThreadGaps([]), []);
    assert.deepEqual(detectThreadGaps([threadMessage("a", 9)]), []);
  });

  it("reports one gap per unloaded run between loaded messages", () => {
    // Loaded seqs 1..3, 5, 7..8: two interior gaps (4 and 6).
    assert.deepEqual(detectThreadGaps(gappedMessages()), [
      { after: 3, before: 5 },
      { after: 5, before: 7 },
    ]);
  });

  it("derives gaps from the loaded seqs alone, with no span cap", () => {
    // A very old loaded range with a wide gap is detected like any other:
    // detection is O(loaded messages), so neither long history nor a large
    // allocated bound can disable it.
    const messages = [
      threadMessage("old", 1),
      threadMessage("new", 500_000),
    ];
    assert.deepEqual(detectThreadGaps(messages), [
      { after: 1, before: 500_000 },
    ]);
  });

  it("is order-insensitive", () => {
    const messages = [threadMessage("e", 7), threadMessage("a", 1), threadMessage("d", 5)];
    assert.deepEqual(detectThreadGaps(messages), [
      { after: 1, before: 5 },
      { after: 5, before: 7 },
    ]);
  });
});

describe("gap walk step decision", () => {
  /** Gap between loaded seqs 3 and 9. */
  const gap = { after: 3, before: 9 };

  it("stops at an empty page (nothing committed below the cursor)", () => {
    assert.deepEqual(
      nextGapWalkStep(page({ oldestSeq: null, hasMore: false }), gap),
      { kind: "stop" },
    );
  });

  it("stops when the page reaches the gap's lower neighbor", () => {
    const fetched = page({
      oldestSeq: 3,
      hasMore: true,
      messages: Array.from({ length: 100 }, (_, i) => ({})),
    });
    assert.deepEqual(nextGapWalkStep(fetched, gap), { kind: "stop" });
  });

  it("stops on a not-full page above the lower neighbor", () => {
    // Everything committed below the cursor is now loaded; the rest of the
    // gap is in flight or burned and needs no further fetching now.
    const fetched = page({
      oldestSeq: 5,
      hasMore: false,
      messages: Array.from({ length: 7 }, (_, i) => ({})),
    });
    assert.deepEqual(nextGapWalkStep(fetched, gap), { kind: "stop" });
  });

  it("continues downward from the page bottom on a full page above the lower neighbor", () => {
    const fetched = page({
      oldestSeq: 5,
      hasMore: true,
      messages: Array.from({ length: 100 }, (_, i) => ({})),
    });
    assert.deepEqual(nextGapWalkStep(fetched, gap), {
      kind: "continue",
      cursor: 5,
    });
  });
});

describe("may-have-earlier-history rule", () => {
  it("trusts the worker's hasMore when it is true", () => {
    assert.equal(mayHaveEarlierHistory(page({ hasMore: true, oldestSeq: 40 }), 50), true);
  });

  it("keeps ambiguity when the page bottoms out above seq 1", () => {
    // No committed messages below seq 40, but seqs 1..39 were allocated
    // (contiguity from any committed seq above them) — in flight or
    // burned, so they may still appear.
    assert.equal(mayHaveEarlierHistory(page({ hasMore: false, oldestSeq: 40 }), 100), true);
  });

  it("hides the control only once the walk demonstrably reaches seq 1", () => {
    assert.equal(mayHaveEarlierHistory(page({ hasMore: false, oldestSeq: 1 }), 100), false);
  });

  it("resolves the empty-page ambiguity from the allocation bound", () => {
    // Cursor 41 with nothing committed below it: seqs 1..40 were drawn
    // (allocated bound), so they are in flight or burned — keep the control.
    assert.equal(
      mayHaveEarlierHistory(page({ hasMore: false, oldestSeq: null }), 40, 41),
      true,
    );
    // Nothing below the cursor was ever drawn: no earlier history exists.
    assert.equal(
      mayHaveEarlierHistory(page({ hasMore: false, oldestSeq: null }), 40, 45),
      false,
    );
    // An empty newest page (no cursor) means an empty thread, not history.
    assert.equal(
      mayHaveEarlierHistory(page({ hasMore: false, oldestSeq: null }), 3),
      false,
    );
  });
});

describe("thread snapshot response validation", () => {
  it("accepts a well-formed page with status and paging bounds", () => {
    const parsed = parseThreadSnapshotResponse({
      timezone: "America/New_York",
      messages: [
        { id: "a", seq: 1, role: "user", text: "hi", sentAt: "2026-10-30T00:00:00.000Z" },
        { id: "b", seq: 2, role: "assistant", text: "hello", sentAt: "2026-10-30T00:00:01.000Z" },
      ],
      status: {
        queued: 1,
        generating: true,
        highestAllocatedSeq: 2,
        hasRecentFailure: false,
      },
      page: { oldestSeq: 1, hasMore: false },
    });
    assert.ok(parsed !== null);
    assert.equal(parsed.messages.length, 2);
    assert.deepEqual(parsed.status, {
      queued: 1,
      generating: true,
      highestAllocatedSeq: 2,
      hasRecentFailure: false,
    });
    assert.deepEqual(parsed.page, {
      oldestSeq: 1,
      hasMore: false,
      messages: parsed.messages,
    });
  });

  it("accepts an empty page with a null oldest seq", () => {
    const parsed = parseThreadSnapshotResponse({
      timezone: "America/New_York",
      messages: [],
      status: {
        queued: 0,
        generating: false,
        highestAllocatedSeq: 0,
        hasRecentFailure: false,
      },
      page: { oldestSeq: null, hasMore: false },
    });
    assert.ok(parsed !== null);
    assert.deepEqual(parsed.page, {
      oldestSeq: null,
      hasMore: false,
      messages: [],
    });
  });

  it("carries an explicitly unconfigured timezone without guessing from the browser", () => {
    const parsed = parseThreadSnapshotResponse({
      timezone: null,
      messages: [],
      status: { queued: 0, generating: false, highestAllocatedSeq: 0, hasRecentFailure: false },
      page: { oldestSeq: null, hasMore: false },
    });
    assert.ok(parsed !== null);
    assert.equal(parsed.timezone, null);
  });

  it("keeps a structurally valid snapshot when this browser lacks the worker's timezone data", () => {
    const parsed = parseThreadSnapshotResponse({
      timezone: "Mars/Olympus_Mons",
      messages: [threadMessage("zone-fallback", 1)],
      status: { queued: 0, generating: false, highestAllocatedSeq: 1, hasRecentFailure: false },
      page: { oldestSeq: 1, hasMore: false },
    });
    assert.ok(parsed !== null);
    assert.equal(parsed.timezone, "Mars/Olympus_Mons");
  });

  it("rejects malformed pages instead of crashing", () => {
    const fullStatus = {
      queued: 0,
      generating: false,
      highestAllocatedSeq: 2,
      hasRecentFailure: false,
    };
    const goodMessage = {
      id: "a",
      seq: 1,
      role: "user",
      text: "t",
      sentAt: "2026-10-30T00:00:00.000Z",
    };
    const bad = [
      null,
      "nope",
      {},
      // Missing page entirely.
      { messages: [goodMessage], status: fullStatus },
      // Malformed page bounds.
      {
        messages: [goodMessage],
        status: fullStatus,
        page: { oldestSeq: 0, hasMore: false },
      },
      {
        messages: [goodMessage],
        status: fullStatus,
        page: { oldestSeq: "1", hasMore: false },
      },
      {
        messages: [goodMessage],
        status: fullStatus,
        page: { oldestSeq: 1.5, hasMore: false },
      },
      {
        messages: [goodMessage],
        status: fullStatus,
        page: { oldestSeq: 1, hasMore: "yes" },
      },
      // Malformed status fields.
      {
        messages: [goodMessage],
        status: { ...fullStatus, highestAllocatedSeq: -1 },
        page: { oldestSeq: 1, hasMore: false },
      },
      {
        messages: [goodMessage],
        status: { ...fullStatus, highestAllocatedSeq: 1.5 },
        page: { oldestSeq: 1, hasMore: false },
      },
      {
        messages: [goodMessage],
        status: { ...fullStatus, hasRecentFailure: "yes" },
        page: { oldestSeq: 1, hasMore: false },
      },
      {
        messages: [goodMessage],
        status: { queued: "x", generating: true, highestAllocatedSeq: 1, hasRecentFailure: false },
        page: { oldestSeq: 1, hasMore: false },
      },
      {
        messages: [goodMessage],
        status: { queued: 1, generating: "yes", highestAllocatedSeq: 1, hasRecentFailure: false },
        page: { oldestSeq: 1, hasMore: false },
      },
      // Malformed messages.
      {
        messages: [{ id: "a" }],
        status: fullStatus,
        page: { oldestSeq: 1, hasMore: false },
      },
      {
        messages: [{ ...goodMessage, seq: 0 }],
        status: fullStatus,
        page: { oldestSeq: 1, hasMore: false },
      },
      {
        messages: [{ ...goodMessage, role: "system" }],
        status: fullStatus,
        page: { oldestSeq: 1, hasMore: false },
      },
    ];
    for (const raw of bad) {
      assert.equal(
        parseThreadSnapshotResponse(raw),
        null,
        `expected rejection for: ${JSON.stringify(raw)}`,
      );
    }
  });
});

describe("client key generation", () => {
  it("uses the platform UUID where available", () => {
    const key = createClientKey();
    // UUID shape: 8-4-4-4-12 hex with dashes — always within the worker's
    // client-key contract.
    assert.match(key, /^[A-Za-z0-9_-]{1,128}$/);
  });

  it("falls back to a contract-shaped random key without crypto.randomUUID", () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
    assert.ok(descriptor !== undefined && descriptor.configurable);
    try {
      Object.defineProperty(globalThis, "crypto", { value: {}, configurable: true });
      const key = createClientKey();
      assert.match(key, /^[A-Za-z0-9_-]{1,128}$/);
      assert.equal(key.length, 32);
    } finally {
      Object.defineProperty(globalThis, "crypto", descriptor);
    }
  });

  it("produces distinct keys across calls", () => {
    const keys = new Set(Array.from({ length: 20 }, () => createClientKey()));
    assert.equal(keys.size, 20);
  });
});
