// Unit tests for the message ingest timing contract
// (apps/worker/src/conversation/timing.ts): client send-time
// classification (absent, valid, unparseable, future skew, out of order
// against the monotonically tracked acceptance/order bound),
// effective-time resolution (the original client time when valid and
// ordered; otherwise the ACTUAL recorded server receive time — identical
// to the recorded receipt, never clamped or synthesized — with every
// fallback reason preserved independently), and provenance semantics.
//
// Pure functions only: no database, no network.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_CLIENT_MAX_AHEAD_MS,
  MAX_CLIENT_EPOCH_MS,
  classifyClientSentAt,
  resolveEffectiveAt,
} from "../../apps/worker/src/conversation/timing.ts";

const SERVER_NOW = new Date("2026-11-04T12:00:00.000Z");

describe("client send-time classification", () => {
  it("reports absent when no client time is supplied", () => {
    for (const raw of [undefined, null]) {
      const classified = classifyClientSentAt({
        clientSentAt: raw,
        serverReceivedAt: SERVER_NOW,
        maxAheadMs: DEFAULT_CLIENT_MAX_AHEAD_MS,
      });
      assert.equal(classified.clientSentAt, null);
      assert.equal(classified.status, "absent");
    }
  });

  it("accepts a moderately fast client clock as the original send time", () => {
    const client = new Date(SERVER_NOW.getTime() + 5_000);
    const classified = classifyClientSentAt({
      clientSentAt: client.getTime(),
      serverReceivedAt: SERVER_NOW,
      maxAheadMs: DEFAULT_CLIENT_MAX_AHEAD_MS,
    });
    assert.deepEqual(classified.clientSentAt, client);
    assert.equal(classified.status, "valid");
  });

  it("accepts the tolerance boundary exactly", () => {
    const client = new Date(SERVER_NOW.getTime() + DEFAULT_CLIENT_MAX_AHEAD_MS);
    const classified = classifyClientSentAt({
      clientSentAt: client.getTime(),
      serverReceivedAt: SERVER_NOW,
      maxAheadMs: DEFAULT_CLIENT_MAX_AHEAD_MS,
    });
    assert.equal(classified.status, "valid");
  });

  it("rejects a client clock too far ahead as future skew, preserving the raw claim", () => {
    const client = new Date(SERVER_NOW.getTime() + DEFAULT_CLIENT_MAX_AHEAD_MS + 1);
    const classified = classifyClientSentAt({
      clientSentAt: client.getTime(),
      serverReceivedAt: SERVER_NOW,
      maxAheadMs: DEFAULT_CLIENT_MAX_AHEAD_MS,
    });
    assert.deepEqual(classified.clientSentAt, client);
    assert.equal(classified.status, "future_skew");
  });

  it("rejects a client time below the acceptance/order bound as out of order", () => {
    // The bound is the maximum effective time recorded so far on user
    // messages — here an accepted client time 9 seconds ahead of the
    // server clock.
    const bound = new Date(SERVER_NOW.getTime() + 9_000);
    const client = new Date(SERVER_NOW.getTime() + 5_000);
    const classified = classifyClientSentAt({
      clientSentAt: client.getTime(),
      serverReceivedAt: SERVER_NOW,
      maxAheadMs: DEFAULT_CLIENT_MAX_AHEAD_MS,
      orderBoundAt: bound,
    });
    assert.deepEqual(classified.clientSentAt, client);
    assert.equal(classified.status, "out_of_order");
  });

  it("allows a client time equal to the bound (immediate follow-up)", () => {
    const bound = new Date(SERVER_NOW.getTime() - 60_000);
    const classified = classifyClientSentAt({
      clientSentAt: bound.getTime(),
      serverReceivedAt: SERVER_NOW,
      maxAheadMs: DEFAULT_CLIENT_MAX_AHEAD_MS,
      orderBoundAt: bound,
    });
    assert.equal(classified.status, "valid");
  });

  it("accepts a client time above the bound even when a later fallback exists", () => {
    // The bound is the running maximum: a fallback receipt below an
    // accepted future client time does not lower it.
    const bound = new Date(SERVER_NOW.getTime() + 9_000);
    const classified = classifyClientSentAt({
      clientSentAt: bound.getTime(),
      serverReceivedAt: SERVER_NOW,
      maxAheadMs: DEFAULT_CLIENT_MAX_AHEAD_MS,
      orderBoundAt: bound,
    });
    assert.equal(classified.status, "valid");
  });

  it("ignores the order bound when there is no previous user message", () => {
    const client = new Date(SERVER_NOW.getTime() - 3_600_000);
    const classified = classifyClientSentAt({
      clientSentAt: client.toISOString(),
      serverReceivedAt: SERVER_NOW,
      maxAheadMs: DEFAULT_CLIENT_MAX_AHEAD_MS,
      orderBoundAt: null,
    });
    assert.equal(classified.status, "valid");
  });

  it("reports unparseable values as invalid with no preserved timestamp", () => {
    for (const raw of ["not a time", "", 1.5, Number.NaN, {}, true]) {
      const classified = classifyClientSentAt({
        clientSentAt: raw,
        serverReceivedAt: SERVER_NOW,
        maxAheadMs: DEFAULT_CLIENT_MAX_AHEAD_MS,
      });
      assert.equal(classified.clientSentAt, null, `raw=${String(raw)}`);
      assert.equal(classified.status, "invalid", `raw=${String(raw)}`);
    }
  });

  it("accepts ISO-8601 strings and epoch-ms numbers alike", () => {
    const client = new Date(SERVER_NOW.getTime() - 30_000);
    const fromNumber = classifyClientSentAt({
      clientSentAt: client.getTime(),
      serverReceivedAt: SERVER_NOW,
      maxAheadMs: DEFAULT_CLIENT_MAX_AHEAD_MS,
    });
    const fromIso = classifyClientSentAt({
      clientSentAt: client.toISOString(),
      serverReceivedAt: SERVER_NOW,
      maxAheadMs: DEFAULT_CLIENT_MAX_AHEAD_MS,
    });
    assert.equal(fromNumber.status, "valid");
    assert.equal(fromIso.status, "valid");
    assert.deepEqual(fromIso.clientSentAt, fromNumber.clientSentAt);
  });

  it("treats implausibly large epoch values as malformed, not skewed", () => {
    const classified = classifyClientSentAt({
      clientSentAt: MAX_CLIENT_EPOCH_MS * 2,
      serverReceivedAt: SERVER_NOW,
      maxAheadMs: DEFAULT_CLIENT_MAX_AHEAD_MS,
    });
    assert.equal(classified.clientSentAt, null);
    assert.equal(classified.status, "invalid");
  });
});

describe("effective-time resolution (honest fallback contract)", () => {
  it("uses the original client time when valid", () => {
    const client = new Date(SERVER_NOW.getTime() - 5_000);
    const classified = classifyClientSentAt({
      clientSentAt: client.getTime(),
      serverReceivedAt: SERVER_NOW,
      maxAheadMs: DEFAULT_CLIENT_MAX_AHEAD_MS,
    });
    const resolved = resolveEffectiveAt(classified, SERVER_NOW);
    assert.deepEqual(resolved.effectiveAt, client);
    assert.equal(resolved.timeSource, "client");
  });

  it("falls back to the ACTUAL recorded server receive time for every non-valid status", () => {
    for (const raw of [null, "garbage", SERVER_NOW.getTime() + 999_999]) {
      const classified = classifyClientSentAt({
        clientSentAt: raw,
        serverReceivedAt: SERVER_NOW,
        maxAheadMs: DEFAULT_CLIENT_MAX_AHEAD_MS,
      });
      const resolved = resolveEffectiveAt(classified, SERVER_NOW);
      assert.deepEqual(resolved.effectiveAt, SERVER_NOW);
      assert.equal(resolved.timeSource, "server");
    }
  });

  it("keeps absent and invalid independently distinguishable on identical fallbacks", () => {
    const absent = classifyClientSentAt({
      clientSentAt: null,
      serverReceivedAt: SERVER_NOW,
      maxAheadMs: DEFAULT_CLIENT_MAX_AHEAD_MS,
    });
    const invalid = classifyClientSentAt({
      clientSentAt: "not a time",
      serverReceivedAt: SERVER_NOW,
      maxAheadMs: DEFAULT_CLIENT_MAX_AHEAD_MS,
    });
    // Same honest fallback value, two different preserved reasons.
    assert.equal(absent.status, "absent");
    assert.equal(invalid.status, "invalid");
    const absentResolved = resolveEffectiveAt(absent, SERVER_NOW);
    const invalidResolved = resolveEffectiveAt(invalid, SERVER_NOW);
    assert.deepEqual(absentResolved.effectiveAt, invalidResolved.effectiveAt);
    assert.equal(absentResolved.timeSource, "server");
    assert.equal(invalidResolved.timeSource, "server");
  });

  it("regression: accepted T+9, missing fallback T+1, client T+5 rejected by the bound", () => {
    // An accepted client time 9 seconds ahead of the server clock.
    const accepted = new Date(SERVER_NOW.getTime() + 9_000);
    const first = classifyClientSentAt({
      clientSentAt: accepted.getTime(),
      serverReceivedAt: SERVER_NOW,
      maxAheadMs: DEFAULT_CLIENT_MAX_AHEAD_MS,
    });
    assert.equal(first.status, "valid");
    assert.deepEqual(resolveEffectiveAt(first, SERVER_NOW).effectiveAt, accepted);

    // The next message supplies no client time and is received one second
    // later: the fallback is the ACTUAL recorded receipt (T+1) — identical
    // to server_received_at, never clamped — and the status stays `absent`.
    const receipt = new Date(SERVER_NOW.getTime() + 1_000);
    const second = classifyClientSentAt({
      clientSentAt: null,
      serverReceivedAt: receipt,
      maxAheadMs: DEFAULT_CLIENT_MAX_AHEAD_MS,
      orderBoundAt: accepted,
    });
    assert.equal(second.status, "absent");
    const secondResolved = resolveEffectiveAt(second, receipt);
    assert.deepEqual(secondResolved.effectiveAt, receipt);
    assert.equal(secondResolved.timeSource, "server");

    // A third message claims client T+5: below the still-monotone bound
    // (T+9), so the candidate is rejected as out of order while the
    // fallback remains its own actual receipt (T+5).
    const thirdReceipt = new Date(SERVER_NOW.getTime() + 5_000);
    const third = classifyClientSentAt({
      clientSentAt: thirdReceipt.getTime(),
      serverReceivedAt: thirdReceipt,
      maxAheadMs: DEFAULT_CLIENT_MAX_AHEAD_MS,
      orderBoundAt: accepted,
    });
    assert.equal(third.status, "out_of_order");
    assert.deepEqual(third.clientSentAt, thirdReceipt);
    const thirdResolved = resolveEffectiveAt(third, thirdReceipt);
    assert.deepEqual(thirdResolved.effectiveAt, thirdReceipt);
    assert.equal(thirdResolved.timeSource, "server");

    // The bound is unaffected by the fallbacks: still T+9 for the next
    // candidate (monotonically tracked as the running maximum).
    const stillRejected = classifyClientSentAt({
      clientSentAt: new Date(SERVER_NOW.getTime() + 8_999).getTime(),
      serverReceivedAt: new Date(SERVER_NOW.getTime() + 6_000),
      maxAheadMs: DEFAULT_CLIENT_MAX_AHEAD_MS,
      orderBoundAt: accepted,
    });
    assert.equal(stillRejected.status, "out_of_order");
  });
});

