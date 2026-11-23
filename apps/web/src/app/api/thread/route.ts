/**
 * BFF thread page for the signed-in owner: an authenticated proxy of the
 * worker's paged thread read.
 *
 * The page bound (`limit`) is a BFF constant, not a client-controlled
 * value; the optional `before` cursor only selects which history page is
 * read and is validated to the safe-integer seq range. Messages are reduced
 * from the worker's domain shape to the client-facing shape (see
 * `client-contract.ts`). Errors are generic; worker details never pass
 * through. No identity information is forwarded to the worker.
 *
 * Non-production-only test channel: a request attested by the loopback test
 * listener (see `test-gate.ts`) is authorized by the separate identity-free
 * test session. The main channel's behavior is unchanged, and a test
 * session is worthless on it (and vice versa).
 */

import type { NextRequest } from "next/server";

import { toClientMessage } from "@/lib/server/client-contract";
import { loadWebConfigSafe } from "@/lib/server/config";
import { jsonError, jsonOk, nowSeconds } from "@/lib/server/respond";
import { SESSION_COOKIE_NAME, TEST_SESSION_COOKIE_NAME } from "@/lib/server/session";
import {
  resolveRequestChannel,
  stateChangeAllowedForChannel,
  TEST_ATTESTATION_HEADER,
  verifyAccessForChannel,
} from "@/lib/server/test-gate";
import { createWorkerClient } from "@/lib/server/worker-client";
import { THREAD_PAGE_SIZE } from "@/lib/thread-state";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Upper sanity bound for the history cursor (safe-integer seq range). */
const MAX_SEQ_VALUE = Number.MAX_SAFE_INTEGER;

function parseCursor(
  raw: string | null, minimum = 1,
): { ok: true; cursor?: number } | { ok: false } {
  if (raw === null) {
    return { ok: true };
  }
  const value = Number(raw);
  if (
    !Number.isInteger(value) ||
    !raw.trim() || value < minimum ||
    value > MAX_SEQ_VALUE
  ) {
    return { ok: false };
  }
  return { ok: true, cursor: value };
}

async function threadRequest(request: NextRequest, retry: boolean) {
  const configResult = loadWebConfigSafe(process.env);
  if (!configResult.ok) {
    return jsonError(503, "unavailable");
  }
  const config = configResult.config;
  const channel = resolveRequestChannel(
    config,
    request.headers.get(TEST_ATTESTATION_HEADER),
  );
  if (retry && !stateChangeAllowedForChannel(config, channel, request.headers.get("origin"))) {
    return jsonError(403, "forbidden");
  }
  const access = verifyAccessForChannel(
    config,
    channel,
    request.cookies.get(SESSION_COOKIE_NAME)?.value,
    request.cookies.get(TEST_SESSION_COOKIE_NAME)?.value,
    nowSeconds(),
  );
  if (!access.ok) {
    return jsonError(access.status, access.kind);
  }
  const client = createWorkerClient({
    baseUrl: config.workerUrl,
    token: config.workerToken,
    timeoutMs: config.workerTimeoutMs,
  });
  if (retry) {
    const attempt = request.nextUrl.searchParams.get("attempt");
    if (!attempt) return jsonError(400, "bad_request");
    const status = await client.retryGeneration(attempt);
    if (status === 200) return jsonOk({ accepted: true });
    return jsonError(status, status === 409 ? "stale_attempt" : status === 400 ? "bad_request" : "unavailable");
  }
  const beforeParam = parseCursor(
    request.nextUrl.searchParams.get("before"),
  );
  const afterParam = parseCursor(request.nextUrl.searchParams.get("after"), 0);
  if (!beforeParam.ok || !afterParam.ok || (beforeParam.cursor !== undefined && afterParam.cursor !== undefined)) {
    return jsonError(400, "bad_request");
  }

  const result = await client.getThread(
    THREAD_PAGE_SIZE,
    beforeParam.cursor,
    afterParam.cursor,
  );
  if (result.ok) {
    return jsonOk({
      timezone: result.snapshot.timezone,
      messages: result.snapshot.messages.map(toClientMessage),
      status: {
        queued: result.snapshot.queued,
        generating: result.snapshot.generating,
        highestAllocatedSeq: result.snapshot.highestAllocatedSeq,
        hasRecentFailure: result.snapshot.hasRecentFailure,
        retryAttemptId: result.snapshot.retryAttemptId,
      },
      page: result.snapshot.page,
    });
  }
  // The page size and cursor are BFF-validated, so a bad_request can only
  // mean a contract mismatch — report it generically, never to the client.
  return jsonError(result.kind === "bad_request" ? 500 : 502, "unavailable");
}

export function GET(request: NextRequest) {
  return threadRequest(request, false);
}

export function POST(request: NextRequest) {
  return threadRequest(request, true);
}
