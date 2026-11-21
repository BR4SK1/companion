// Unit tests for the BFF's worker HTTP client
// (apps/web/src/lib/server/worker-client.ts) with an injected fetch: page
// request framing (bearer header, limit/before query), strict snapshot
// validation (status flags and paging bounds), and sanitized failure
// mapping. No network and no database.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createWorkerClient } from "../../apps/web/src/lib/server/worker-client.ts";

const TOKEN = "test-service-token";
const BASE = "http://worker.internal";

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

function snapshotBody(overrides = {}) {
  return {
    timezone: "America/New_York",
    messages: [
      {
        id: "m1",
        seq: 1,
        role: "user",
        content: "hi",
        createdAt: "2026-10-30T00:00:00.000Z",
      },
    ],
    status: {
      queued: 0,
      generating: false,
      highestAllocatedSeq: 1,
      hasRecentFailure: false,
    },
    page: { oldestSeq: 1, hasMore: false },
    ...overrides,
  };
}

/** A client whose fetch records requests and plays a scripted response. */
function makeClient(respond, requests) {
  const fetchImpl = async (input, init) => {
    requests.push({ input, init });
    return respond();
  };
  return createWorkerClient({
    baseUrl: BASE,
    token: TOKEN,
    timeoutMs: 1_000,
    fetchImpl,
  });
}

describe("BFF worker client: thread pages", () => {
  it("requests the newest page with the bearer token and limit only", async () => {
    const requests = [];
    const client = makeClient(() => jsonResponse(200, snapshotBody()), requests);
    const result = await client.getThread(100);
    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.equal(result.snapshot.queued, 0);
    assert.equal(result.snapshot.generating, false);
    assert.equal(result.snapshot.highestAllocatedSeq, 1);
    assert.equal(result.snapshot.hasRecentFailure, false);
    assert.deepEqual(result.snapshot.page, { oldestSeq: 1, hasMore: false });
    assert.equal(result.snapshot.messages.length, 1);

    assert.equal(requests.length, 1);
    const request = requests[0];
    assert.equal(request.input, `${BASE}/v1/thread?limit=100`);
    assert.equal(request.init.method, "GET");
    assert.equal(request.init.headers.authorization, `Bearer ${TOKEN}`);
  });

  it("maps a legacy worker response with no timezone to explicit UTC/unconfigured state", async () => {
    const body = snapshotBody();
    delete body.timezone;
    const client = makeClient(() => jsonResponse(200, body), []);
    const result = await client.getThread(100);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.snapshot.timezone, null);
  });

  it("appends the validated before cursor to the page query", async () => {
    const requests = [];
    const client = makeClient(() => jsonResponse(200, snapshotBody()), requests);
    const result = await client.getThread(50, 41);
    assert.equal(result.ok, true);
    assert.equal(requests[0].input, `${BASE}/v1/thread?limit=50&before=41`);
  });

  it("validates the snapshot strictly and maps malformed payloads to unavailable", async () => {
    const goodMessage = {
      id: "m1",
      seq: 1,
      role: "user",
      content: "hi",
      createdAt: "2026-10-30T00:00:00.000Z",
    };
    const fullStatus = {
      queued: 0,
      generating: false,
      highestAllocatedSeq: 1,
      hasRecentFailure: false,
    };
    const bad = [
      "not an object",
      { ...snapshotBody(), timezone: "Not/AZone" },
      { ...snapshotBody(), timezone: 17 },
      { messages: [goodMessage], status: fullStatus },
      { messages: [goodMessage], status: fullStatus, page: { oldestSeq: 0, hasMore: false } },
      { messages: [goodMessage], status: fullStatus, page: { oldestSeq: 1, hasMore: "yes" } },
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
        messages: [{ ...goodMessage, createdAt: "not a date" }],
        status: fullStatus,
        page: { oldestSeq: 1, hasMore: false },
      },
    ];
    for (const body of bad) {
      const requests = [];
      const client = makeClient(() => jsonResponse(200, body), requests);
      const result = await client.getThread(100);
      assert.deepEqual(
        result,
        { ok: false, kind: "unavailable" },
        `expected rejection for: ${JSON.stringify(body)}`,
      );
    }
  });

  it("collapses upstream failures into sanitized kinds", async () => {
    const cases = [
      [400, { ok: false, kind: "bad_request" }],
      [401, { ok: false, kind: "unavailable" }],
      [500, { ok: false, kind: "unavailable" }],
    ];
    for (const [status, expected] of cases) {
      const requests = [];
      const client = makeClient(
        () => jsonResponse(status, { error: "internal detail that must not surface" }),
        requests,
      );
      assert.deepEqual(await client.getThread(100), expected, `status: ${String(status)}`);
    }

    // A network-level failure also collapses to a sanitized kind.
    const requests = [];
    const client = createWorkerClient({
      baseUrl: BASE,
      token: TOKEN,
      timeoutMs: 1_000,
      fetchImpl: async () => {
        throw new Error("connection reset with internal detail");
      },
    });
    assert.deepEqual(await client.getThread(100), { ok: false, kind: "unavailable" });
  });
});

describe("BFF worker client: message send and engagement", () => {
  it("sends the composed message with the client send time when supplied", async () => {
    const requests = [];
    const client = makeClient(
      () =>
        jsonResponse(200, {
          message: {
            id: "m1",
            seq: 1,
            role: "user",
            content: "hi",
            createdAt: "2026-11-04T12:00:00.000Z",
          },
        }),
      requests,
    );
    const result = await client.sendMessage("hi", "key-1", 1_700_000_000_000);
    assert.equal(result.ok, true);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].input, `${BASE}/v1/messages`);
    assert.equal(requests[0].init.method, "POST");
    const body = JSON.parse(requests[0].init.body);
    assert.deepEqual(body, {
      text: "hi",
      clientKey: "key-1",
      clientSentAt: 1_700_000_000_000,
    });
  });

  it("omits the client send time field when the caller supplies none", async () => {
    const requests = [];
    const client = makeClient(
      () =>
        jsonResponse(200, {
          message: {
            id: "m1",
            seq: 1,
            role: "user",
            content: "hi",
            createdAt: "2026-11-04T12:00:00.000Z",
          },
        }),
      requests,
    );
    await client.sendMessage("hi", "key-1");
    const body = JSON.parse(requests[0].init.body);
    assert.deepEqual(body, { text: "hi", clientKey: "key-1" });
  });
});
