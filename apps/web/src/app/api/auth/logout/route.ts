/**
 * Sign-out: clears the BFF session cookie. Same-origin verified
 * (state-changing POST) and session-gated; the identity-provider session
 * itself is intentionally left untouched (local logout only).
 *
 * Channel-aware: on the non-production-only test channel it verifies the
 * separate test session and clears the test cookie (main-channel owner
 * cookies are never consulted there, and vice versa).
 */

import { NextResponse, type NextRequest } from "next/server";

import { loadWebConfigSafe } from "@/lib/server/config";
import { jsonError, nowSeconds } from "@/lib/server/respond";
import { SESSION_COOKIE_NAME, TEST_SESSION_COOKIE_NAME } from "@/lib/server/session";
import {
  resolveRequestChannel,
  stateChangeAllowedForChannel,
  TEST_ATTESTATION_HEADER,
  verifyAccessForChannel,
} from "@/lib/server/test-gate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const configResult = loadWebConfigSafe(process.env);
  if (!configResult.ok) {
    return jsonError(503, "unavailable");
  }
  const config = configResult.config;
  const channel = resolveRequestChannel(
    config,
    request.headers.get(TEST_ATTESTATION_HEADER),
  );
  if (!stateChangeAllowedForChannel(config, channel, request.headers.get("origin"))) {
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
  // Each channel clears its own session cookie only.
  const cookieName = channel === "test" ? TEST_SESSION_COOKIE_NAME : SESSION_COOKIE_NAME;
  const response = new NextResponse(null, {
    status: 204,
    headers: { "cache-control": "no-store" },
  });
  response.cookies.set({
    name: cookieName,
    value: "",
    path: "/",
    maxAge: 0,
    httpOnly: true,
    sameSite: "lax",
    secure: channel === "test" ? false : config.publicOrigin.startsWith("https:"),
  });
  return response;
}
