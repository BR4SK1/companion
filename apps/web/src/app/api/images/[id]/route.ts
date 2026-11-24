/**
 * Owner-authenticated proxy of one rendered image from the worker's private
 * API. The browser never talks to the worker directly and no worker token
 * crosses this boundary; image ids are opaque asset ids. Rendered images are
 * immutable once published, so the response is privately cacheable.
 */

import type { NextRequest } from "next/server";

import { loadWebConfigSafe } from "@/lib/server/config";
import { jsonError, nowSeconds } from "@/lib/server/respond";
import { SESSION_COOKIE_NAME, TEST_SESSION_COOKIE_NAME } from "@/lib/server/session";
import {
  resolveRequestChannel,
  TEST_ATTESTATION_HEADER,
  verifyAccessForChannel,
} from "@/lib/server/test-gate";
import { createWorkerClient } from "@/lib/server/worker-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const IMAGE_ID_PATTERN = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  if (!IMAGE_ID_PATTERN.test(id)) {
    return jsonError(404, "not_found");
  }
  const configResult = loadWebConfigSafe(process.env);
  if (!configResult.ok) {
    return jsonError(503, "unavailable");
  }
  const config = configResult.config;
  const channel = resolveRequestChannel(
    config,
    request.headers.get(TEST_ATTESTATION_HEADER),
  );
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
  const result = await client.getImage(id);
  if (!result.ok) {
    return result.kind === "not_found"
      ? jsonError(404, "not_found")
      : jsonError(502, "unavailable");
  }
  return new Response(result.data, {
    status: 200,
    headers: {
      "content-type": result.mimeType,
      "content-length": String(result.data.byteLength),
      "cache-control": "private, max-age=31536000, immutable",
    },
  });
}
