/**
 * Private HTTP API over the conversation-work domain.
 *
 * This is the ingest/read boundary the web BFF calls. It is a private,
 * service-to-service surface, never a public one:
 *
 * - Every API endpoint requires a bearer token (`WORKER_API_TOKEN`), the
 *   shared service-to-service credential configured identically on the BFF
 *   (`WEB_WORKER_TOKEN`). Comparison is constant-time.
 * - Deployment exposes the listener only through a cluster-internal Service;
 *   there is no ingress, no TLS termination, and no public route to it. The
 *   health endpoints are the only unauthenticated routes and expose nothing
 *   beyond liveness/readiness.
 * - Failures are reported generically and sanitized: status codes plus
 *   stable, generic error kinds. Internal error details are logged on the
 *   server side only, never in responses.
 *
 * Thread reads are cursor-paged: `GET /v1/thread?limit=N` returns the newest
 * page (ascending `seq`) with `page.oldestSeq`/`page.hasMore`, and
 * `?before=<seq>` returns the page immediately below that bound, so callers
 * can walk the full durable history. `status.highestAllocatedSeq` reports
 * the allocation invariant (every seq up to it is committed-visible,
 * in-flight, or burned; allocation is contiguous), which lets a consumer
 * reason about what may exist below any page; the web client reconciles by
 * re-deriving gaps between its loaded seqs and walking pages downward with
 * a bounded per-cycle budget and no timing assumption.
 * `status.hasRecentFailure` is a sanitized trailing-failure flag; provider
 * error text never crosses this boundary.
 *
 * Composition rules: behavior lives in the domain store; this module owns
 * only transport concerns (parsing, limits, auth framing, status codes).
 * Application policy (e.g. the message size bound) is a module constant so
 * the contract is explicit and testable.
 *
 * Shutdown is graceful: `close()` stops accepting new connections and waits
 * for in-flight requests (all handlers are short database operations) before
 * resolving; idle keep-alive sockets are closed so shutdown is prompt.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";

import {
  ClientKeyConflictError,
  type ConversationStore,
} from "../conversation/store.ts";
import type { CanonicalRecallResponse } from "../memory/types.ts";
import type { EngagementSummary } from "../engagement/types.ts";
import { CanonicalRecallValidationError } from "../memory/recall.ts";
import type { ArticleMemoriesResponse } from "../articles/types.ts";
import {
  ArticleMemoriesValidationError,
  MAX_ARTICLE_MEMORIES_LIMIT,
} from "../articles/retrieval.ts";

/** Maximum accepted JSON request body size, in bytes. */
export const MAX_BODY_BYTES = 64 * 1024;

/** Maximum accepted message content length, in characters. */
export const MAX_MESSAGE_LENGTH = 20_000;

/**
 * Client-key shape: UUIDs from the web client and similar short opaque
 * tokens. Bounded and character-restricted so keys stay usable identifiers.
 */
const CLIENT_KEY_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/** Default page size of the bounded thread snapshot. */
export const DEFAULT_THREAD_LIMIT = 100;

/** Maximum page size of the bounded thread snapshot. */
export const MAX_THREAD_LIMIT = 500;

export interface ApiServerDeps {
  readonly store: ConversationStore;
  /** Shared service-to-service bearer token; required, never empty. */
  readonly token: string;
  readonly host: string;
  readonly port: number;
  /** Startup-captured configured local timezone; null is explicitly unconfigured. */
  readonly timezone?: string | null;
  readonly log?: (message: string) => void;
  /**
   * Readiness check (dependency usability, e.g. a database ping). Liveness
   * needs no dependency check and always reports process health only.
   */
  readonly ready?: () => Promise<boolean>;
  /**
   * Canonical memory recall by arbitrary query — the general recall surface
   * (not the per-turn chat assembly, which derives its query from the turn's
   * user text). The domain owns input validation; a rejected input surfaces
   * as a validation error to map to 400. Absent when memory is not
   * provisioned: the route then reports the recall surface as unavailable
   * rather than serving an empty imitation of it.
   */
  readonly recall?: (input: {
    readonly query: string;
    readonly limit?: number;
  }) => Promise<CanonicalRecallResponse>;
  /**
   * Engagement-domain summary read (the domain's own shared read surface).
   * Recomputed per call from the last user message's effective time and the
   * configured bands. The route reports the current band, the anchor
   * message, and the configured boundaries — configuration content stays
   * server-side by design; the response carries the values in force.
   */
  readonly engagement?: () => Promise<EngagementSummary>;
  /**
   * Programmatic article-memory retrieval: deterministic newest-first
   * accepted memories with a caller-configurable limit (bounded by the
   * domain's safe defaults and maxima). Independent of lexical recall — a
   * read-only surface that never writes state. Absent when the article
   * domain is not active: the route then reports the surface as unavailable
   * rather than serving an empty imitation of it.
   */
  readonly articleMemories?: (input: {
    readonly limit?: number;
  }) => Promise<ArticleMemoriesResponse>;
}

export interface ApiServer {
  /** Bind the listener; resolves with the actually bound port. */
  readonly start: () => Promise<number>;
  /**
   * Stop accepting connections and wait for in-flight requests to finish.
   * Resolves once the listener is fully closed.
   */
  readonly close: () => Promise<void>;
}

function writeJson(
  res: ServerResponse,
  status: number,
  body: Record<string, unknown>,
  extraHeaders: Record<string, string> = {},
): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...extraHeaders,
  });
  res.end(JSON.stringify(body));
}

function writeGenericError(res: ServerResponse, status: number, kind: string): void {
  writeJson(res, status, { error: kind });
}

/**
 * Constant-time bearer-token comparison. Both sides are hashed first so the
 * comparison length never depends on the input lengths.
 */
function tokenMatches(provided: string | undefined, expected: string): boolean {
  if (provided === undefined) {
    return false;
  }
  const providedDigest = createHash("sha256").update(provided).digest();
  const expectedDigest = createHash("sha256").update(expected).digest();
  return timingSafeEqual(providedDigest, expectedDigest);
}

function bearerTokenOf(request: IncomingMessage): string | undefined {
  const header = request.headers.authorization;
  if (header === undefined) {
    return undefined;
  }
  const match = /^Bearer\s+(.+)$/.exec(header);
  return match === null ? undefined : (match[1]?.trim() || undefined);
}

function isUnauthorized(request: IncomingMessage, token: string): boolean {
  return !tokenMatches(bearerTokenOf(request), token);
}

function readBody(
  request: IncomingMessage,
  log: (message: string) => void,
): Promise<{ ok: true; body: string } | { ok: false; status: number; kind: string }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (result: { ok: true; body: string } | { ok: false; status: number; kind: string }): void => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(result);
    };
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        log(`request body rejected: exceeds ${String(MAX_BODY_BYTES)} bytes`);
        // Stop buffering; keep the socket usable until the caller has
        // responded, then let the response path tear the connection down.
        request.removeAllListeners("data");
        finish({ ok: false, status: 413, kind: "request_too_large" });
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => finish({ ok: true, body: Buffer.concat(chunks).toString("utf8") }));
    request.on("error", () => finish({ ok: false, status: 400, kind: "bad_request" }));
  });
}

interface ParsedSendBody {
  readonly text: string;
  readonly clientKey: string;
  /** Raw client-reported send time; shape-validated only. */
  readonly clientSentAt?: number | string;
}

/** Sanity bound for an epoch-ms client send time (year 2100). */
const MAX_CLIENT_EPOCH_MS = 4_102_444_800_000;

/**
 * Client send time: an epoch-ms number (safe integer, sane range) or a
 * non-empty bounded string (typically ISO 8601). Shape validation only —
 * semantic classification (skew, ordering, provenance) belongs to the
 * conversation domain's ingest timing and is recorded on the message.
 */
function parseClientSentAt(value: unknown): number | string | undefined | false {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === "number") {
    if (
      !Number.isSafeInteger(value) ||
      value < 0 ||
      value > MAX_CLIENT_EPOCH_MS
    ) {
      return false;
    }
    return value;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length === 0 || trimmed.length > 64) {
      return false;
    }
    return trimmed;
  }
  return false;
}

function parseSendBody(raw: string): ParsedSendBody | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return undefined;
  }
  const record = parsed as Record<string, unknown>;
  const text = record.text;
  const clientKey = record.clientKey;
  if (typeof text !== "string" || typeof clientKey !== "string") {
    return undefined;
  }
  if (text.length === 0 || text.length > MAX_MESSAGE_LENGTH) {
    return undefined;
  }
  if (!CLIENT_KEY_PATTERN.test(clientKey)) {
    return undefined;
  }
  const clientSentAt = parseClientSentAt(record.clientSentAt);
  if (clientSentAt === false) {
    return undefined;
  }
  return {
    text,
    clientKey,
    ...(clientSentAt !== undefined ? { clientSentAt } : {}),
  };
}

/**
 * Recall request body: `{query, limit?}`. Shape validation only — the recall
 * domain owns the semantic validation (length, limit range, timezone rules)
 * and reports violations as validation errors mapped to 400.
 */
function parseRecallBody(raw: string): { query: string; limit?: number } | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return undefined;
  }
  const record = parsed as Record<string, unknown>;
  const query = record.query;
  const limit = record.limit;
  if (typeof query !== "string" || query.length === 0) {
    return undefined;
  }
  if (limit !== undefined && (typeof limit !== "number" || !Number.isInteger(limit))) {
    return undefined;
  }
  return limit === undefined ? { query } : { query, limit };
}

function parseThreadLimit(query: URLSearchParams): number | undefined {
  const raw = query.get("limit");
  if (raw === null) {
    return DEFAULT_THREAD_LIMIT;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > MAX_THREAD_LIMIT) {
    return undefined;
  }
  return value;
}

/**
 * Parse the optional `limit` of the article-memory retrieval: null when
 * absent (the domain's own default applies), the bounded value when valid,
 * undefined when malformed or out of the transport-level range.
 */
function parseArticleMemoriesLimit(query: URLSearchParams): number | null | undefined {
  const raw = query.get("limit");
  if (raw === null) {
    return null;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > MAX_ARTICLE_MEMORIES_LIMIT) {
    return undefined;
  }
  return value;
}

/** Upper sanity bound for a client-supplied seq (safe-integer range). */
const MAX_SEQ_VALUE = Number.MAX_SAFE_INTEGER;

/**
 * Parse the optional `before` history cursor: null when absent, the seq
 * value when valid, undefined when malformed.
 */
function parseThreadBefore(
  query: URLSearchParams,
): number | null | undefined {
  const raw = query.get("before");
  if (raw === null) {
    return null;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > MAX_SEQ_VALUE) {
    return undefined;
  }
  return value;
}

/**
 * Create the private API server. Does not bind; call `start()` afterwards.
 */
export function createApiServer(deps: ApiServerDeps): ApiServer {
  if (deps.token.length === 0) {
    throw new Error("api token must be a non-empty service credential");
  }
  const log = deps.log ?? (() => {});

  const server: Server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      // Last-resort guard: nothing about the failure may reach the client.
      log(`api request failed: ${error instanceof Error ? error.message : String(error)}`);
      if (!response.headersSent) {
        writeGenericError(response, 500, "internal_error");
      } else {
        response.end();
      }
    });
  });

  async function handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const url = new URL(request.url ?? "/", "http://localhost");
    const route = `${request.method ?? ""} ${url.pathname}`;

    if (url.pathname === "/healthz" && request.method === "GET") {
      writeJson(response, 200, { ok: true });
      return;
    }
    if (url.pathname === "/readyz" && request.method === "GET") {
      const ready = deps.ready === undefined ? true : await deps.ready();
      if (ready) {
        writeJson(response, 200, { ok: true });
      } else {
        writeGenericError(response, 503, "unavailable");
      }
      return;
    }

    if (
      url.pathname !== "/v1/messages" &&
      url.pathname !== "/v1/thread" &&
      url.pathname !== "/v1/memory/recall" &&
      url.pathname !== "/v1/articles/memories" &&
      url.pathname !== "/v1/engagement"
    ) {
      writeGenericError(response, 404, "not_found");
      request.resume();
      return;
    }
    if (request.method !== "POST" && request.method !== "GET") {
      writeGenericError(response, 405, "method_not_allowed");
      request.resume();
      return;
    }
    if (url.pathname === "/v1/messages" && request.method !== "POST") {
      writeJson(response, 405, { error: "method_not_allowed" }, { allow: "POST" });
      request.resume();
      return;
    }
    if (url.pathname === "/v1/thread" && request.method !== "GET") {
      writeJson(response, 405, { error: "method_not_allowed" }, { allow: "GET" });
      request.resume();
      return;
    }
    if (url.pathname === "/v1/memory/recall" && request.method !== "POST") {
      writeJson(response, 405, { error: "method_not_allowed" }, { allow: "POST" });
      request.resume();
      return;
    }
    if (url.pathname === "/v1/engagement" && request.method !== "GET") {
      writeJson(response, 405, { error: "method_not_allowed" }, { allow: "GET" });
      request.resume();
      return;
    }
    if (url.pathname === "/v1/articles/memories" && request.method !== "GET") {
      writeJson(response, 405, { error: "method_not_allowed" }, { allow: "GET" });
      request.resume();
      return;
    }

    if (isUnauthorized(request, deps.token)) {
      writeGenericError(response, 401, "unauthorized");
      // Drain any unread body so the connection can close or be reused.
      request.resume();
      return;
    }

    if (route === "POST /v1/messages") {
      const contentType = request.headers["content-type"];
      if (contentType === undefined || !contentType.toLowerCase().startsWith("application/json")) {
        writeGenericError(response, 415, "unsupported_media_type");
        request.resume();
        return;
      }
      const body = await readBody(request, log);
      if (!body.ok) {
        writeGenericError(response, body.status, body.kind);
        // Node tears down the socket automatically when a response ends
        // before the request body was fully consumed.
        return;
      }
      const parsed = parseSendBody(body.body);
      if (parsed === undefined) {
        writeGenericError(response, 400, "bad_request");
        return;
      }
      try {
        const message = await deps.store.appendUserMessage({
          content: parsed.text,
          clientKey: parsed.clientKey,
          ...(parsed.clientSentAt !== undefined
            ? { clientSentAt: parsed.clientSentAt }
            : {}),
        });
        writeJson(response, 200, { message });
      } catch (error) {
        if (error instanceof ClientKeyConflictError) {
          writeGenericError(response, 409, "conflict");
          return;
        }
        throw error;
      }
      return;
    }

    if (route === "GET /v1/thread") {
      const limit = parseThreadLimit(url.searchParams);
      const before = parseThreadBefore(url.searchParams);
      if (limit === undefined || before === undefined) {
        writeGenericError(response, 400, "bad_request");
        return;
      }
      const [page, status] = await Promise.all([
        deps.store.getThreadPage({ limit, ...(before !== null ? { before } : {}) }),
        deps.store.getThreadStatus(),
      ]);
      writeJson(response, 200, {
        messages: page.messages,
        timezone: deps.timezone ?? null,
        status: {
          queued: status.queuedUserMessages,
          generating: status.generating,
          highestAllocatedSeq: status.highestAllocatedSeq,
          hasRecentFailure: status.hasRecentFailure,
        },
        page: {
          oldestSeq: page.oldestSeq,
          hasMore: page.hasMore,
        },
      });
      return;
    }

    if (route === "GET /v1/engagement") {
      if (deps.engagement === undefined) {
        writeGenericError(response, 503, "unavailable");
        return;
      }
      try {
        const summary = await deps.engagement();
        writeJson(response, 200, { ...summary });
      } catch (error) {
        log(`engagement read failed: ${error instanceof Error ? error.message : String(error)}`);
        writeGenericError(response, 500, "internal_error");
      }
      return;
    }

    if (route === "POST /v1/memory/recall") {
      // The general recall surface exists only when memory is provisioned;
      // reporting it as unavailable (not 404) distinguishes an unprovisioned
      // deployment from an unknown route.
      if (deps.recall === undefined) {
        writeGenericError(response, 503, "unavailable");
        return;
      }
      const contentType = request.headers["content-type"];
      if (contentType === undefined || !contentType.toLowerCase().startsWith("application/json")) {
        writeGenericError(response, 415, "unsupported_media_type");
        request.resume();
        return;
      }
      const body = await readBody(request, log);
      if (!body.ok) {
        writeGenericError(response, body.status, body.kind);
        return;
      }
      const parsed = parseRecallBody(body.body);
      if (parsed === undefined) {
        writeGenericError(response, 400, "bad_request");
        return;
      }
      try {
        const result = await deps.recall(parsed);
        // Spread into a fresh literal: writeJson's parameter is a string-index
        // record, which an interface type does not structurally satisfy.
        writeJson(response, 200, { ...result });
      } catch (error) {
        if (error instanceof CanonicalRecallValidationError) {
          writeJson(response, 400, { error: "invalid_query", message: error.message });
          return;
        }
        throw error;
      }
      return;
    }

    if (route === "GET /v1/articles/memories") {
      // The article-memory retrieval surface exists only when the article
      // domain is active; reporting it as unavailable (not 404) distinguishes
      // an unprovisioned deployment from an unknown route.
      if (deps.articleMemories === undefined) {
        writeGenericError(response, 503, "unavailable");
        return;
      }
      const limit = parseArticleMemoriesLimit(url.searchParams);
      if (limit === undefined) {
        writeGenericError(response, 400, "bad_request");
        return;
      }
      try {
        const result = await deps.articleMemories(limit === null ? {} : { limit });
        // Spread into a fresh literal: writeJson's parameter is a string-index
        // record, which an interface type does not structurally satisfy.
        writeJson(response, 200, { ...result });
      } catch (error) {
        if (error instanceof ArticleMemoriesValidationError) {
          writeJson(response, 400, { error: "invalid_query", message: error.message });
          return;
        }
        throw error;
      }
      return;
    }

    writeGenericError(response, 404, "not_found");
  }

  return {
    start: () =>
      new Promise((resolve, reject) => {
        const onError = (error: Error): void => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = (): void => {
          const address = server.address();
          server.off("error", onError);
          resolve(typeof address === "object" && address !== null ? address.port : deps.port);
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(deps.port, deps.host);
      }),
    close: () =>
      new Promise((resolve, reject) => {
        server.closeIdleConnections();
        server.close((error) => {
          if (error !== undefined) {
            reject(error);
            return;
          }
          resolve();
        });
      }),
  };
}
