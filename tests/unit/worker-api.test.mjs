// Contract tests for the worker's private HTTP API
// (apps/worker/src/api/server.ts): bearer-token enforcement, message
// ingestion (idempotent replay, conflicting key reuse), cursor-paged thread
// reads with generic status, health/readiness, and sanitized failures.
//
// The store is a fake; no database and no external network are involved.
// Each server binds to an ephemeral loopback port so behavior is exercised
// over real HTTP framing without touching anything outside the test
// process.

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";

import { ClientKeyConflictError } from "../../apps/worker/src/conversation/store.ts";
import { createApiServer } from "../../apps/worker/src/api/server.ts";

const TOKEN = "test-service-token";

function message(seq, overrides = {}) {
  return {
    id: `id-${String(seq)}`,
    seq,
    role: "user",
    content: `content ${String(seq)}`,
    turnId: null,
    clientKey: null,
    createdAt: "2026-10-30T00:00:00.000Z",
    ...overrides,
  };
}

/** Minimal fake store: records calls, plays scripted outcomes. */
function fakeStore(overrides = {}) {
  const calls = { append: [], pageParams: [] };
  return {
    calls,
    appendUserMessage: async (params) => {
      calls.append.push(params);
      return message(calls.append.length, {
        content: params.content,
        clientKey: params.clientKey ?? null,
      });
    },
    getThreadPage: async (params) => {
      calls.pageParams.push(params);
      return {
        messages: [message(1), message(2, { role: "assistant", turnId: "t1" })],
        oldestSeq: 1,
        hasMore: false,
      };
    },
    getThreadStatus: async () => ({
      queuedUserMessages: 2,
      generating: true,
      highestAllocatedSeq: 2,
      hasRecentFailure: false,
    }),
    ...overrides,
  };
}

describe("worker private HTTP API", () => {
  /** @type {import("../../apps/worker/src/api/server.ts").ApiServer[]} */
  const started = [];

  async function startServer(depsOverrides = {}, store = fakeStore()) {
    const server = createApiServer({
      store,
      token: TOKEN,
      host: "127.0.0.1",
      port: 0,
      ...depsOverrides,
    });
    const port = await server.start();
    started.push(server);
    return { server, store, baseUrl: `http://127.0.0.1:${String(port)}` };
  }

  after(async () => {
    while (started.length > 0) {
      const server = started.pop();
      await server.close().catch(() => {});
    }
  });

  it("serves liveness without authentication and exposes nothing else", async () => {
    const { baseUrl } = await startServer();
    const health = await fetch(`${baseUrl}/healthz`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true });

    const unknown = await fetch(`${baseUrl}/v1/unknown`);
    assert.equal(unknown.status, 404);
    assert.deepEqual(await unknown.json(), { error: "not_found" });
  });

  it("reports readiness from the injected dependency check", async () => {
    const { baseUrl } = await startServer({ ready: async () => true });
    const ready = await fetch(`${baseUrl}/readyz`);
    assert.equal(ready.status, 200);
    assert.deepEqual(await ready.json(), { ok: true });

    const failing = await startServer({ ready: async () => false });
    const down = await fetch(`${failing.baseUrl}/readyz`);
    assert.equal(down.status, 503);
    assert.deepEqual(await down.json(), { error: "unavailable" });
  });

  it("rejects API requests without or with a wrong bearer token", async () => {
    const { baseUrl } = await startServer();
    const missing = await fetch(`${baseUrl}/v1/thread`);
    assert.equal(missing.status, 401);
    assert.deepEqual(await missing.json(), { error: "unauthorized" });

    const wrong = await fetch(`${baseUrl}/v1/thread`, {
      headers: { authorization: "Bearer not-the-token" },
    });
    assert.equal(wrong.status, 401);

    const malformed = await fetch(`${baseUrl}/v1/thread`, {
      headers: { authorization: `Basic ${TOKEN}` },
    });
    assert.equal(malformed.status, 401);
  });

  it("accepts a message and returns its durable form", async () => {
    const store = fakeStore();
    const { baseUrl } = await startServer({}, store);
    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ text: "hello thread", clientKey: "key-1" }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.message.content, "hello thread");
    assert.equal(body.message.clientKey, "key-1");
    assert.deepEqual(store.calls.append, [
      { content: "hello thread", clientKey: "key-1" },
    ]);
  });

  it("treats an idempotent replay as success and a conflicting reuse as 409", async () => {
    const first = await startServer();
    const replay = await fetch(`${first.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ text: "same", clientKey: "dup" }),
    });
    assert.equal(replay.status, 200);
    assert.deepEqual(await replay.json(), {
      message: { ...replayMessage(), content: "same", clientKey: "dup" },
    });

    const conflicting = await startServer(
      {},
      fakeStore({
        appendUserMessage: async () => {
          throw new ClientKeyConflictError("dup");
        },
      }),
    );
    const conflict = await fetch(`${conflicting.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ text: "different content", clientKey: "dup" }),
    });
    assert.equal(conflict.status, 409);
    assert.deepEqual(await conflict.json(), { error: "conflict" });
  });

  it("maps a store failure to a generic sanitized error", async () => {
    const { baseUrl } = await startServer(
      {},
      fakeStore({
        appendUserMessage: async () => {
          throw new Error("secret database detail: host db-internal-7");
        },
      }),
    );
    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ text: "boom", clientKey: "k" }),
    });
    assert.equal(response.status, 500);
    const body = await response.json();
    assert.deepEqual(body, { error: "internal_error" });
    assert.ok(!JSON.stringify(body).includes("db-internal-7"));
  });

  it("validates message input and content type", async () => {
    const { baseUrl } = await startServer();
    const post = (body, contentType) =>
      fetch(`${baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          ...(contentType !== null ? { "content-type": contentType } : {}),
        },
        body,
      });

    const cases = [
      // [body, content type, expected status]
      ["", "application/json", 400], // empty body
      ["not json", "application/json", 400],
      [JSON.stringify({ clientKey: "k" }), "application/json", 400], // no text
      [JSON.stringify({ text: "hi" }), "application/json", 400], // no clientKey
      [JSON.stringify({ text: "", clientKey: "k" }), "application/json", 400],
      [
        JSON.stringify({ text: "x".repeat(20_001), clientKey: "k" }),
        "application/json",
        400,
      ],
      [JSON.stringify({ text: "hi", clientKey: "bad key!" }), "application/json", 400],
      [JSON.stringify({ text: "hi", clientKey: "k" }), "text/plain", 415],
    ];
    for (const [body, contentType, expected] of cases) {
      const response = await post(body, contentType);
      assert.equal(response.status, expected, `body: ${String(body)}`);
      const json = await response.json();
      assert.ok(
        ["bad_request", "unsupported_media_type"].includes(json.error),
        `unexpected error kind: ${json.error}`,
      );
    }
  });

  it("serves a bounded thread page with generic status and paging bounds", async () => {
    const store = fakeStore();
    const { baseUrl } = await startServer({}, store);
    const response = await fetch(`${baseUrl}/v1/thread`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.messages.length, 2);
    assert.equal(body.messages[0].seq, 1);
    assert.equal(body.messages[1].role, "assistant");
    assert.deepEqual(body.status, {
      queued: 2,
      generating: true,
      highestAllocatedSeq: 2,
      hasRecentFailure: false,
    });
    assert.deepEqual(body.page, { oldestSeq: 1, hasMore: false });
    // Default bound is the server constant; no cursor means the newest page.
    assert.deepEqual(store.calls.pageParams, [{ limit: 100 }]);

    const limited = await fetch(`${baseUrl}/v1/thread?limit=7`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(limited.status, 200);
    assert.deepEqual(store.calls.pageParams, [{ limit: 100 }, { limit: 7 }]);
  });

  it("passes a valid history cursor through as the page bound", async () => {
    const store = fakeStore();
    const { baseUrl } = await startServer({}, store);
    const response = await fetch(`${baseUrl}/v1/thread?before=41`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(store.calls.pageParams, [{ limit: 100, before: 41 }]);
  });

  it("surfaces the sanitized failure flag and nothing else about it", async () => {
    const { baseUrl } = await startServer(
      {},
      fakeStore({
        getThreadStatus: async () => ({
          queuedUserMessages: 0,
          generating: false,
          highestAllocatedSeq: 9,
          hasRecentFailure: true,
        }),
      }),
    );
    const response = await fetch(`${baseUrl}/v1/thread`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.status, {
      queued: 0,
      generating: false,
      highestAllocatedSeq: 9,
      hasRecentFailure: true,
    });
    // The response carries exactly the sanitized fields: no error text,
    // no turn identifiers, no provider detail anywhere in the payload.
    assert.deepEqual(Object.keys(body).sort(), ["messages", "page", "status"]);
  });

  it("rejects out-of-range or malformed page bounds and limits", async () => {
    const { baseUrl } = await startServer();
    for (const limit of ["0", "501", "-1", "abc", "1.5"]) {
      const response = await fetch(`${baseUrl}/v1/thread?limit=${limit}`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      assert.equal(response.status, 400, `limit: ${limit}`);
      assert.deepEqual(await response.json(), { error: "bad_request" });
    }
    for (const before of ["0", "-1", "abc", "1.5", "9007199254740992"]) {
      const response = await fetch(`${baseUrl}/v1/thread?before=${before}`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      assert.equal(response.status, 400, `before: ${before}`);
      assert.deepEqual(await response.json(), { error: "bad_request" });
    }
  });

  it("enforces method and route rules", async () => {
    const { baseUrl } = await startServer();
    const postThread = await fetch(`${baseUrl}/v1/thread`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
      },
      body: "{}",
    });
    assert.equal(postThread.status, 405);
    const getMessages = await fetch(`${baseUrl}/v1/messages`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(getMessages.status, 405);
    const putMessages = await fetch(`${baseUrl}/v1/messages`, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
      },
      body: "{}",
    });
    assert.equal(putMessages.status, 405);
  });

  it("rejects oversized request bodies", async () => {
    const { baseUrl } = await startServer();
    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ text: "x".repeat(70_000), clientKey: "k" }),
    });
    assert.equal(response.status, 413);
  });

  it("refuses to create a server without a token", () => {
    assert.throws(() =>
      createApiServer({ store: fakeStore(), token: "", host: "127.0.0.1", port: 0 }),
    );
  });

  it("closes the listener cleanly", async () => {
    const { server } = await startServer();
    await server.close();
    // Closing an already-closed listener reports an error rather than
    // hanging; treat that as acceptable close semantics.
    await assert.rejects(server.close());
  });

  it("forwards an optional client send time to the store on ingest", async () => {
    const { baseUrl, store } = await startServer();
    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        text: "hello",
        clientKey: "k-with-time",
        clientSentAt: 1_700_000_000_000,
      }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(store.calls.append.at(-1), {
      content: "hello",
      clientKey: "k-with-time",
      clientSentAt: 1_700_000_000_000,
    });
  });

  it("forwards an ISO-string client send time unchanged", async () => {
    const { baseUrl, store } = await startServer();
    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        text: "hello",
        clientKey: "k-iso",
        clientSentAt: "2026-11-04T12:00:00.000Z",
      }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(store.calls.append.at(-1), {
      content: "hello",
      clientKey: "k-iso",
      clientSentAt: "2026-11-04T12:00:00.000Z",
    });
  });

  it("rejects malformed client send times as bad_request", async () => {
    for (const clientSentAt of [1.5, -1, 99999999999999999, "x".repeat(65), {}, true]) {
      const { baseUrl, store } = await startServer();
      const response = await fetch(`${baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ text: "hi", clientKey: "k", clientSentAt }),
      });
      assert.equal(response.status, 400, `clientSentAt=${String(clientSentAt)}`);
      assert.equal(store.calls.append.length, 0);
      await new Promise((resolve) => setImmediate(resolve));
    }
  });

  it("serves the engagement summary when the domain is wired", async () => {
    const calls = [];
    const engagement = async (input) => {
      calls.push(input);
      return {
        state: "lull",
        lastUserMessageId: "last-1",
        lastUserEffectiveAt: "2026-11-04T11:57:00.000Z",
        silenceMs: 4 * 60_000,
        bands: {
          lullMs: 180_000,
          idleMs: 420_000,
          goneMs: 1_800_000,
        },
      };
    };
    const { baseUrl } = await startServer({ engagement });
    const response = await fetch(`${baseUrl}/v1/engagement`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.state, "lull");
    assert.equal(body.lastUserMessageId, "last-1");
    assert.equal(body.silenceMs, 240_000);
    assert.equal(calls.length, 1);
  });

  it("reports the engagement surface unavailable when not wired", async () => {
    const { baseUrl } = await startServer({});
    const response = await fetch(`${baseUrl}/v1/engagement`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(response.status, 503);
  });

  it("requires the bearer token for the engagement read", async () => {
    const { baseUrl } = await startServer({
      engagement: async () => ({
        state: null,
        lastUserMessageId: null,
        lastUserEffectiveAt: null,
        silenceMs: null,
        bands: {
          lullMs: 1,
          idleMs: 2,
          goneMs: 3,
        },
      }),
    });
    const noToken = await fetch(`${baseUrl}/v1/engagement`);
    assert.equal(noToken.status, 401);
    const post = await fetch(`${baseUrl}/v1/engagement`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(post.status, 405);
  });
});

function replayMessage() {
  return message(1, { content: "same", clientKey: "dup" });
}
