/**
 * Sign-out: clears the BFF session cookie. Same-origin verified
 * (state-changing POST) and session-gated; the identity-provider session
 * itself is intentionally left untouched (local logout only).
 */

import { NextResponse, type NextRequest } from "next/server";

import { loadWebConfigSafe } from "@/lib/server/config";
import { isSameOriginRequest } from "@/lib/server/request-guard";
import { jsonError, nowSeconds } from "@/lib/server/respond";
import { SESSION_COOKIE_NAME, verifySessionToken } from "@/lib/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
  const response = new NextResponse(null, {
    status: 204,
    headers: { "cache-control": "no-store" },
  });
  response.cookies.set({
    name: SESSION_COOKIE_NAME,
    value: "",
    path: "/",
    maxAge: 0,
    httpOnly: true,
    sameSite: "lax",
    secure: config.publicOrigin.startsWith("https:"),
  });
  return response;
}
