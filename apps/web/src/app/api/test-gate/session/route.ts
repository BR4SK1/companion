/**
 * Test-gate session issuance for the non-production-only loopback entry.
 *
 * Visiting this endpoint on the test channel establishes the separate test
 * session (an HMAC-signed cookie signed with the dedicated gate secret,
 * carrying no identity) and returns to the application. On any other
 * channel it does not exist: the route answers a generic 404 unless the
 * request is an attested test-channel request.
 *
 * Fail-closed checks at issuance (use-side checks happen on every request
 * through the listener and the per-route access decisions):
 * - the deployment's test-gate configuration must be valid and enabled;
 * - the request must be attested by the loopback test listener
 *   (`isTestChannelRequest` — socket-checked there, token-checked here);
 *   a request on the main listener can never carry the attestation token.
 *
 * The redirect target is built from the configured loopback origin — never
 * from the request host or forwarding headers.
 */

import { NextResponse, type NextRequest } from "next/server";

import { loadWebConfigSafe } from "@/lib/server/config";
import { nowSeconds } from "@/lib/server/respond";
import {
  createTestSessionPayload,
  signToken,
  TEST_SESSION_COOKIE_NAME,
  verifyTestSessionToken,
} from "@/lib/server/session";
import {
  isTestChannelRequest,
  testChannelOrigin,
  TEST_ATTESTATION_HEADER,
} from "@/lib/server/test-gate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const configResult = loadWebConfigSafe(process.env);
  if (!configResult.ok) {
    return new NextResponse("Unavailable.", {
      status: 503,
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
    });
  }
  const config = configResult.config;
  if (config.testGate === null || !isTestChannelRequest(request.headers.get(TEST_ATTESTATION_HEADER), config)) {
    // Not the attested test channel: the endpoint does not exist there.
    return new NextResponse("Not found.", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
    });
  }
  const gate = config.testGate;
  const origin = testChannelOrigin(config);

  const existing = verifyTestSessionToken(
    request.cookies.get(TEST_SESSION_COOKIE_NAME)?.value,
    gate.sessionSecret,
    nowSeconds(),
  );
  if (existing !== null) {
    const reuse = NextResponse.redirect(new URL("/", origin), 303);
    reuse.headers.set("cache-control", "no-store");
    return reuse;
  }

  const session = createTestSessionPayload(nowSeconds(), gate.sessionTtlSeconds);
  const response = NextResponse.redirect(new URL("/", origin), 303);
  response.headers.set("cache-control", "no-store");
  response.cookies.set({
    name: TEST_SESSION_COOKIE_NAME,
    value: signToken(session, gate.sessionSecret),
    httpOnly: true,
    sameSite: "lax",
    // The test entry is always plain http on the loopback interface.
    secure: false,
    path: "/",
    maxAge: gate.sessionTtlSeconds,
  });
  return response;
}
