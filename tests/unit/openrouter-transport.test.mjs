// Deterministic transport tests for the shared OpenRouter transport
// (libraries/openrouter/src/transport.ts).
//
// No network: fetch is injected, and every response is an inline fake. The
// tests cover request framing (method, headers, JSON body), typed error
// translation (network, timeout, HTTP status, invalid JSON), and the absence
// of retries — the transport performs exactly one fetch per call.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  OpenRouterTransportError,
  postJson,
} from "../../libraries/openrouter/src/transport.ts";

function jsonFetch(status, body, headers) {
  return async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: headers ?? { "content-type": "application/json" },
    });
}

describe("transport request framing", () => {
  it("sends a POST with JSON body and bearer authorization", async () => {
    let captured;
    const fetchImpl = async (url, init) => {
      captured = { url, init };
      return new Response('{"ok":true}', {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const result = await postJson("https://example.test/endpoint", { a: 1 }, {
      apiKey: "secret-token",
      fetchImpl,
    });
    assert.deepEqual(result, { ok: true });
    assert.equal(captured.init.method, "POST");
    assert.equal(captured.init.headers["Content-Type"], "application/json");
    assert.equal(captured.init.headers.Authorization, "Bearer secret-token");
    assert.equal(captured.init.body, JSON.stringify({ a: 1 }));
  });

  it("omits the Authorization header when no key is supplied", async () => {
    let captured;
    const fetchImpl = async (url, init) => {
      captured = init;
      return new Response("{}", { status: 200 });
    };
    await postJson("https://example.test/endpoint", {}, { fetchImpl });
    assert.equal(captured.headers.Authorization, undefined);
  });

  it("performs exactly one fetch — no retry on failure", async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      throw new Error("connection refused");
    };
    await assert.rejects(
      postJson("https://example.test/endpoint", {}, { fetchImpl }),
      OpenRouterTransportError,
    );
    assert.equal(calls, 1);
  });
});

describe("transport error translation", () => {
  it("maps fetch rejection to a network error with the cause attached", async () => {
    const cause = new Error("ECONNREFUSED");
    const fetchImpl = async () => {
      throw cause;
    };
    await assert.rejects(
      postJson("https://example.test/endpoint", {}, { fetchImpl }),
      (error) => {
        assert.ok(error instanceof OpenRouterTransportError);
        assert.equal(error.kind, "network");
        assert.equal(error.cause, cause);
        return true;
      },
    );
  });

  it("maps abort during the request to a timeout error", async () => {
    const fetchImpl = async (url, init) =>
      new Promise((resolve, reject) => {
        init.signal.addEventListener("abort", () => {
          const error = new Error("The operation was aborted");
          error.name = "AbortError";
          reject(error);
        });
      });
    await assert.rejects(
      postJson("https://example.test/endpoint", {}, { fetchImpl, timeoutMs: 20 }),
      (error) => {
        assert.ok(error instanceof OpenRouterTransportError);
        assert.equal(error.kind, "timeout");
        return true;
      },
    );
  });

  it("maps non-2xx responses to http_status errors with truncated body", async () => {
    const fetchImpl = jsonFetch(429, { error: "rate limited" });
    await assert.rejects(
      postJson("https://example.test/endpoint", {}, { fetchImpl }),
      (error) => {
        assert.ok(error instanceof OpenRouterTransportError);
        assert.equal(error.kind, "http_status");
        assert.equal(error.status, 429);
        assert.ok(error.body.includes("rate limited"));
        return true;
      },
    );
  });

  it("maps a non-JSON success body to invalid_json", async () => {
    const fetchImpl = async () =>
      new Response("<html>gateway error</html>", { status: 200 });
    await assert.rejects(
      postJson("https://example.test/endpoint", {}, { fetchImpl }),
      (error) => {
        assert.ok(error instanceof OpenRouterTransportError);
        assert.equal(error.kind, "invalid_json");
        return true;
      },
    );
  });
});
