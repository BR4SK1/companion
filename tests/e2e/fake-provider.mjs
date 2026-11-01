/**
 * Local fake OpenRouter provider for the end-to-end suite.
 *
 * Implements the two endpoints the worker is configured to call —
 * `POST /api/v1/chat/completions` and `POST /api/alpha/decisions` — plus a
 * control API under `/__control/` that the tests use to script behavior
 * (success, HTTP 500, hang), to read the recorded requests so assertions
 * can verify what the worker actually sent (seeded response-pattern
 * options, response guidance as the leading system message, conversation
 * context order), and to observe in-flight capability calls for
 * cross-test quiescence (`/__control/pending`).
 *
 * The provider is a deliberate fake: deterministic, no network egress, no
 * model calls anywhere. It requires the bearer credential the worker was
 * configured with, so the tests also verify that the configured key is
 * actually presented. Recorded bodies contain only synthetic test text.
 * Secrets (the bearer value) are checked but never logged or recorded.
 */

import http from "node:http";

const MAX_RECORDED = 200;

/**
 * @param {{
 *   port: number,
 *   expectedBearer: string,
 *   log?: (message: string) => void,
 * }} options
 */
export function startFakeProvider({ port, expectedBearer, log = () => {} }) {
  /** Ring buffers of the most recent requests, per endpoint. */
  const recorded = { chat: [], decisions: [] };
  /** Capability calls currently being served (any scripted behavior). */
  const inFlight = { chat: 0, decisions: 0 };
  /** Scripted behavior per endpoint: "ok" | "fail500" | "hang". */
  const mode = { chat: "ok", decisions: "ok" };
  /** Audit trail of control-API calls (bounded; aids run diagnosis). */
  const controlLog = [];
  /** Optional artificial chat latency (ms) to make generation observable. */
  let chatLatencyMs = 0;
  let chatCounter = 0;

  /**
   * Record a request and return the record entry itself. The response is
   * later attached to this exact object (not to "whatever is last in the
   * array" at completion time), so a response can never be attributed to a
   * newer request — including after a concurrent record reset.
   */
  function record(kind, body) {
    const list = recorded[kind];
    const entry = { receivedAt: new Date().toISOString(), body };
    list.push(entry);
    if (list.length > MAX_RECORDED) {
      list.shift();
    }
    return entry;
  }

  function bearerOk(request) {
    const header = request.headers.authorization ?? "";
    return header === `Bearer ${expectedBearer}`;
  }

  function readBody(request) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      request.on("data", (chunk) => {
        size += chunk.length;
        if (size > 1024 * 1024) {
          reject(new Error("body too large"));
          request.destroy();
          return;
        }
        chunks.push(chunk);
      });
      request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      request.on("error", reject);
    });
  }

  function chatReply() {
    chatCounter += 1;
    return `E2E reply #${String(chatCounter)}`;
  }

  function chatResponse(requestBody) {
    return {
      id: `e2e-chat-${String(chatCounter)}`,
      model: requestBody.model,
      choices: [
        {
          message: { role: "assistant", content: chatReply() },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    };
  }

  function decisionsResponse(requestBody) {
    // One choice question per turn, keyed `response_pattern` (worker
    // contract). Answer with the first offered option, preserving the
    // request's order, and include optional probability fields so the
    // worker's diagnostics path handles them as returned.
    const question = requestBody.questions?.response_pattern;
    if (
      question === undefined ||
      question === null ||
      question.type !== "choice" ||
      typeof question.criteria !== "object" ||
      question.criteria === null
    ) {
      return { status: 400, body: { error: "unsupported decision request" } };
    }
    const options = Object.keys(question.criteria);
    if (options.length === 0) {
      return { status: 400, body: { error: "no options offered" } };
    }
    const probabilities = {};
    for (const option of options) {
      probabilities[option] = 1 / options.length;
    }
    return {
      status: 200,
      body: {
        id: `e2e-decision-${String(chatCounter + 1)}`,
        model: requestBody.model,
        answers: {
          response_pattern: {
            type: "choice",
            choice: options[0],
            probabilities,
            confidence: 0.9,
          },
        },
        usage: { input_tokens: 7, output_tokens: 3 },
      },
    };
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  async function handleCapability(kind, request, response) {
    inFlight[kind] += 1;
    try {
      if (!bearerOk(request)) {
        response.writeHead(401, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "missing or invalid credential" }));
        return;
      }
      let requestBody;
      try {
        requestBody = JSON.parse(await readBody(request));
      } catch {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "invalid JSON body" }));
        return;
      }
      const entry = record(kind, requestBody);
      const behavior = kind === "chat" ? mode.chat : mode.decisions;
      if (behavior === "fail500") {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "scripted provider failure" }));
        return;
      }
      if (behavior === "hang") {
        // Never answer within the worker's configured call timeout: the
        // worker must abort and fail the turn. Hold the socket open.
        await sleep(120_000);
        response.destroy();
        return;
      }
      if (kind === "chat" && chatLatencyMs > 0) {
        await sleep(chatLatencyMs);
      }
      const result =
        kind === "chat" ? { status: 200, body: chatResponse(requestBody) } : decisionsResponse(requestBody);
      // Record the produced response content on THIS request's record so
      // tests can await the exact text that this specific request generated.
      if (kind === "chat") {
        entry.response = result.body.choices[0].message.content;
      }
      response.writeHead(result.status, { "content-type": "application/json" });
      response.end(JSON.stringify(result.body));
    } finally {
      inFlight[kind] -= 1;
    }
  }

  async function handleControl(request, response, pathname) {
    const send = (status, body) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    controlLog.push({
      at: new Date().toISOString(),
      method: request.method,
      path: pathname,
      chatRecords: recorded.chat.length,
      decisionRecords: recorded.decisions.length,
    });
    if (controlLog.length > 400) {
      controlLog.shift();
    }
    if (pathname === "/__control/health" && request.method === "GET") {
      send(200, { ok: true });
      return;
    }
    if (pathname === "/__control/requests" && request.method === "GET") {
      send(200, recorded);
      return;
    }
    if (pathname === "/__control/pending" && request.method === "GET") {
      send(200, { chat: inFlight.chat, decisions: inFlight.decisions });
      return;
    }
    if (pathname === "/__control/log" && request.method === "GET") {
      send(200, controlLog);
      return;
    }
    if (pathname === "/__control/reset" && request.method === "POST") {
      recorded.chat.length = 0;
      recorded.decisions.length = 0;
      // Deliberately NOT resetting chatCounter: reply texts are unique for
      // the whole run ("E2E reply #N" never repeats), so a test can never
      // mistake an older reply for the new one it is waiting for.
      send(200, { ok: true });
      return;
    }
    if (pathname === "/__control/mode" && request.method === "POST") {
      const body = JSON.parse(await readBody(request));
      if (body.chat !== undefined) mode.chat = body.chat;
      if (body.decisions !== undefined) mode.decisions = body.decisions;
      if (body.chatLatencyMs !== undefined) chatLatencyMs = Number(body.chatLatencyMs) || 0;
      send(200, { mode: { ...mode }, chatLatencyMs });
      return;
    }
    send(404, { error: "unknown control endpoint" });
  }

  const server = http.createServer((request, response) => {
    void (async () => {
      const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
      try {
        if (pathname.startsWith("/__control/")) {
          await handleControl(request, response, pathname);
          return;
        }
        if (pathname === "/api/v1/chat/completions" && request.method === "POST") {
          await handleCapability("chat", request, response);
          return;
        }
        if (pathname === "/api/alpha/decisions" && request.method === "POST") {
          await handleCapability("decisions", request, response);
          return;
        }
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "not found" }));
      } catch (error) {
        log(`provider request failed: ${error instanceof Error ? error.message : String(error)}`);
        if (!response.headersSent) {
          response.writeHead(500, { "content-type": "application/json" });
        }
        response.end(JSON.stringify({ error: "internal error" }));
      }
    })();
  });

  const start = () =>
    new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => resolve(server));
    });

  const close = () =>
    new Promise((resolve) => {
      server.close(() => resolve());
      // Do not wait for keep-alive sockets.
      server.closeIdleConnections?.();
    });

  return { server, start, close };
}
