/**
 * BFF message acceptance for the signed-in owner: an authenticated proxy of
 * the worker's idempotent ingest.
 *
 * Contract preserved end to end:
 * - The browser supplies one stable client key per composed message and
 *   reuses it across retries; the worker's idempotency makes a retried
 *   POST a no-op that returns the existing message.
 * - Reusing a key with different content is rejected by the worker as a
 *   conflict (409), surfaced here unchanged so the client can recover with
 *   a fresh key.
 * - Failures are generic: input problems are 4xx with a stable kind;
 *   worker unavailability is 502 "unavailable" with no upstream detail.
 * No identity information is forwarded to the worker.
 */

import type { NextRequest } from "next/server";

import { loadWebConfigSafe } from "@/lib/server/config";
import { isSameOriginRequest } from "@/lib/server/request-guard";
import { jsonError, jsonOk, nowSeconds } from "@/lib/server/respond";
import { SESSION_COOKIE_NAME, verifySessionToken } from "@/lib/server/session";
import { createWorkerClient } from "@/lib/server/worker-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Maximum accepted JSON body size, in bytes (defense against abuse). */
const MAX_BODY_BYTES = 64 * 1024;

/**
 * Message content bound. Matches the worker's HTTP contract; enforced here
 * so invalid input never crosses the service boundary.
 */
const MAX_MESSAGE_LENGTH = 20_000;

/** Client-key shape: one stable key per composed message. */
const CLIENT_KEY_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

interface ParsedBody {
  readonly text: string;
  readonly clientKey: string;
}

function parseBody(raw: string): ParsedBody | undefined {
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
  return { text, clientKey };
}

export async function POST(request: NextRequest) {
  const configResult = loadWebConfigSafe(process.env);
  if (!configResult.ok) {
    return jsonError(503, "unavailable");
  }
  const config = configResult.config;
  if (!isSameOriginRequest(request.headers.get("origin"), config.publicOrigin)) {
    return jsonError(403, "forbidden");
  }
  const session = verifySessionToken(
    request.cookies.get(SESSION_COOKIE_NAME)?.value,
    config.sessionSecret,
    nowSeconds(),
  );
  if (session === null) {
    return jsonError(401, "unauthorized");
  }

  const contentType = request.headers.get("content-type");
  if (contentType === null || !contentType.toLowerCase().startsWith("application/json")) {
    return jsonError(415, "unsupported_media_type");
  }
  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) {
    return jsonError(413, "request_too_large");
  }
  const parsed = parseBody(raw);
  if (parsed === undefined) {
    return jsonError(400, "bad_request");
  }

  const client = createWorkerClient({
    baseUrl: config.workerUrl,
    token: config.workerToken,
    timeoutMs: config.workerTimeoutMs,
  });
  const result = await client.sendMessage(parsed.text, parsed.clientKey);
  if (result.ok) {
    return jsonOk({ message: result.message });
  }
  if (result.kind === "conflict") {
    return jsonError(409, "conflict");
  }
  if (result.kind === "bad_request") {
    return jsonError(400, "bad_request");
  }
  return jsonError(502, "unavailable");
}
