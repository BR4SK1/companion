// Joined BFF message-contract regression test: the worker's wire shape, as
// validated by the BFF's worker client (apps/web/src/lib/server/worker-
// client.ts), mapped through the exact reduction both BFF routes apply
// (apps/web/src/lib/server/client-contract.ts), assembled into the routes'
// response payloads, and fed to the browser's actual thread-snapshot parser
// (apps/web/src/lib/thread-state.ts). Guards the 2026-10-30 defect where the
// routes forwarded the worker's domain field names (`content`, `createdAt`)
// unchanged, so the client parser rejected every nonempty page and the live
// thread showed a permanent connection error. Route handlers themselves need
// the Next.js runtime; here the same mapping and payload assembly functions
// are exercised over real worker-client output, no network, no database.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { toClientMessage } from "../../apps/web/src/lib/server/client-contract.ts";
import { createWorkerClient } from "../../apps/web/src/lib/server/worker-client.ts";
import { parseThreadSnapshotResponse } from "../../apps/web/src/lib/thread-state.ts";

const TOKEN = "test-service-token";
const BASE = "http://worker.internal";

/**
 * A message exactly as the worker's private API serializes it on the wire —
 * the full domain record, including the worker-only fields the BFF must
 * never pass through.
 */
function workerMessage(overrides = {}) {
  return {
    id: "0b9e6c1e-0000-4000-8000-000000000001",
    seq: 1,
    role: "user",
    content: "hello",
    turnId: "turn-1",
    clientKey: "client-key-1",
    createdAt: "2026-10-30T12:00:00.000Z",
    ...overrides,
  };
}

/** A worker thread snapshot body, worker-shaped. */
function workerSnapshotBody(messages, overrides = {}) {
  return {
    timezone: "America/New_York",
    messages,
    status: {
      queued: 0,
      generating: false,
      highestAllocatedSeq: messages.at(-1)?.seq ?? 0,
      hasRecentFailure: false,
    },
    page: {
      oldestSeq: messages[0]?.seq ?? null,
      hasMore: false,
    },
    ...overrides,
  };
}

/** A worker client whose fetch plays one scripted JSON response. */
function clientResponding(status, body) {
  return createWorkerClient({
    baseUrl: BASE,
    token: TOKEN,
    timeoutMs: 1_000,
    fetchImpl: async () => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    }),
  });
}

/** The GET /api/thread response payload, assembled exactly as the route does. */
function threadRoutePayload(snapshot) {
  return {
    timezone: snapshot.timezone,
    messages: snapshot.messages.map(toClientMessage),
    status: {
      queued: snapshot.queued,
      generating: snapshot.generating,
      highestAllocatedSeq: snapshot.highestAllocatedSeq,
      hasRecentFailure: snapshot.hasRecentFailure,
    },
    page: snapshot.page,
  };
}

/** The client-facing key set; anything else is a worker-field leak. */
const CLIENT_KEYS = new Set(["id", "seq", "role", "text", "sentAt"]);

describe("BFF message contract: thread pages through the client parser", () => {
  it("a nonempty newest page parses and carries the client-facing shape only", async () => {
    const worker = clientResponding(
      200,
      workerSnapshotBody([
        workerMessage(),
        workerMessage({
          id: "0b9e6c1e-0000-4000-8000-000000000002",
          seq: 2,
          role: "assistant",
          content: "hi there\nsecond line ✓",
          clientKey: null,
          turnId: "turn-1",
          createdAt: "2026-10-30T12:00:05.000Z",
        }),
      ]),
    );
    const result = await worker.getThread(100);
    assert.equal(result.ok, true);
    if (!result.ok) return;

    const parsed = parseThreadSnapshotResponse(threadRoutePayload(result.snapshot));
    assert.notEqual(parsed, null, "the client parser must accept the BFF page");
    assert.equal(parsed.messages.length, 2);
    assert.deepEqual(parsed.messages[0], {
      id: "0b9e6c1e-0000-4000-8000-000000000001",
      seq: 1,
      role: "user",
      text: "hello",
      sentAt: "2026-10-30T12:00:00.000Z",
    });
    assert.equal(parsed.messages[1].text, "hi there\nsecond line ✓");
    for (const message of parsed.messages) {
      assert.deepEqual(
        Object.keys(message).sort(),
        [...CLIENT_KEYS].sort(),
        "no worker-domain field may reach the client",
      );
    }
    assert.deepEqual(parsed.status, {
      queued: 0,
      generating: false,
      highestAllocatedSeq: 2,
      hasRecentFailure: false,
    });
    assert.deepEqual(parsed.page.oldestSeq, 1);
    assert.equal(parsed.page.hasMore, false);
  });

  it("an empty newest page still parses", async () => {
    const worker = clientResponding(200, workerSnapshotBody([]));
    const result = await worker.getThread(100);
    assert.equal(result.ok, true);
    if (!result.ok) return;

    const parsed = parseThreadSnapshotResponse(threadRoutePayload(result.snapshot));
    assert.notEqual(parsed, null);
    assert.deepEqual(parsed.messages, []);
  });

  it("a history page (before cursor) joins through the same shape", async () => {
    const worker = clientResponding(
      200,
      workerSnapshotBody([workerMessage({ seq: 41 })], {
        page: { oldestSeq: 41, hasMore: true },
      }),
    );
    const result = await worker.getThread(100, 41);
    assert.equal(result.ok, true);
    if (!result.ok) return;

    const parsed = parseThreadSnapshotResponse(threadRoutePayload(result.snapshot));
    assert.notEqual(parsed, null, "history pages must parse client-side too");
    assert.equal(parsed.messages.length, 1);
    assert.equal(parsed.messages[0].text, "hello");
    assert.equal(parsed.messages[0].sentAt, "2026-10-30T12:00:00.000Z");
    assert.deepEqual(parsed.page, {
      oldestSeq: 41,
      hasMore: true,
      messages: parsed.messages,
    });
  });
});

describe("BFF message contract: send acceptance through the client shape", () => {
  it("the accepted message is the client-facing shape with no worker fields", async () => {
    const worker = clientResponding(200, { message: workerMessage() });
    const result = await worker.sendMessage("hello", "client-key-1");
    assert.equal(result.ok, true);
    if (!result.ok) return;

    const message = toClientMessage(result.message);
    assert.deepEqual(message, {
      id: "0b9e6c1e-0000-4000-8000-000000000001",
      seq: 1,
      role: "user",
      text: "hello",
      sentAt: "2026-10-30T12:00:00.000Z",
    });
    assert.deepEqual(
      Object.keys(message).sort(),
      [...CLIENT_KEYS].sort(),
      "no worker-domain field may reach the client",
    );
    // What the client actually reads off the acceptance response.
    assert.equal(typeof message.id, "string");
    assert.notEqual(message.id, "");
  });

  it("reducing a worker message preserves values exactly (no coercion)", () => {
    const original = workerMessage({
      content: "emoji 🎉 <html> & quotes \"'",
      createdAt: "2026-02-29T23:59:59.999Z",
    });
    const message = toClientMessage({
      id: original.id,
      seq: original.seq,
      role: original.role,
      content: original.content,
      createdAt: original.createdAt,
    });
    assert.equal(message.text, original.content);
    assert.equal(message.sentAt, original.createdAt);
    assert.equal(message.id, original.id);
    assert.equal(message.seq, original.seq);
    assert.equal(message.role, original.role);
  });
});
