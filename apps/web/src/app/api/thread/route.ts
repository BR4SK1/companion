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
 */

import { cookies } from "next/headers";
import type { NextRequest } from "next/server";

import { toClientMessage } from "@/lib/server/client-contract";
import { loadWebConfigSafe } from "@/lib/server/config";
import { jsonError, jsonOk, nowSeconds } from "@/lib/server/respond";
import { SESSION_COOKIE_NAME, verifySessionToken } from "@/lib/server/session";
import { createWorkerClient } from "@/lib/server/worker-client";
import { THREAD_PAGE_SIZE } from "@/lib/thread-state";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Upper sanity bound for the history cursor (safe-integer seq range). */
const MAX_SEQ_VALUE = Number.MAX_SAFE_INTEGER;

function parseBeforeParam(
  raw: string | null,
): { ok: true; before?: number } | { ok: false } {
  if (raw === null) {
    return { ok: true };
  }
  const value = Number(raw);
  if (
    !Number.isInteger(value) ||
    value < 1 ||
    value > MAX_SEQ_VALUE
  ) {
    return { ok: false };
  }
  return { ok: true, before: value };
}

export async function GET(request: NextRequest) {
  const configResult = loadWebConfigSafe(process.env);
  if (!configResult.ok) {
    return jsonError(503, "unavailable");
  }
  const config = configResult.config;
  const session = verifySessionToken(
    (await cookies()).get(SESSION_COOKIE_NAME)?.value,
    config.sessionSecret,
    nowSeconds(),
  );
  if (session === null) {
    return jsonError(401, "unauthorized");
  }
  const beforeParam = parseBeforeParam(
    request.nextUrl.searchParams.get("before"),
  );
  if (!beforeParam.ok) {
    return jsonError(400, "bad_request");
  }

  const client = createWorkerClient({
    baseUrl: config.workerUrl,
    token: config.workerToken,
    timeoutMs: config.workerTimeoutMs,
  });
  const result = await client.getThread(
    THREAD_PAGE_SIZE,
    beforeParam.before,
  );
  if (result.ok) {
    return jsonOk({
      messages: result.snapshot.messages.map(toClientMessage),
      status: {
        queued: result.snapshot.queued,
        generating: result.snapshot.generating,
        highestAllocatedSeq: result.snapshot.highestAllocatedSeq,
        hasRecentFailure: result.snapshot.hasRecentFailure,
      },
      page: result.snapshot.page,
    });
  }
  // The page size and cursor are BFF-validated, so a bad_request can only
  // mean a contract mismatch — report it generically, never to the client.
  return jsonError(result.kind === "bad_request" ? 500 : 502, "unavailable");
}
