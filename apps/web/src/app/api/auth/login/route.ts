/**
 * Owner sign-in entry point: starts the OIDC authorization-code flow with
 * PKCE against the configured external Keycloak service.
 *
 * Fail-closed: when the BFF configuration is missing or malformed, sign-in
 * refuses to start instead of degrading to open access. The in-flight
 * flow's CSRF state, nonce, and PKCE verifier travel in a short-lived
 * HMAC-signed HttpOnly cookie, never in the URL or browser storage.
 */

import { NextResponse } from "next/server";

import { loadWebConfigSafe } from "@/lib/server/config";
import {
  AUTH_FLOW_COOKIE_NAME,
  createAuthFlowPayload,
  signToken,
} from "@/lib/server/session";
import { nowSeconds } from "@/lib/server/respond";
import {
  createLoginChallenge,
  discoverOidcConfiguration,
} from "@/lib/server/oidc";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Lifetime of the signed login-flow cookie, in seconds. */
const FLOW_TTL_SECONDS = 600;

export async function GET() {
  const configResult = loadWebConfigSafe(process.env);
  if (!configResult.ok) {
    // Fail closed: no configuration, no sign-in. A plain generic response
    // rather than a redirect avoids trusting the request host.
    return new NextResponse("Sign-in is temporarily unavailable.", {
      status: 503,
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
    });
  }
  const config = configResult.config;
  try {
    const configuration = await discoverOidcConfiguration(config);
    const challenge = await createLoginChallenge(config, configuration);
    const flow = createAuthFlowPayload(
      {
        state: challenge.state,
        nonce: challenge.nonce,
        codeVerifier: challenge.codeVerifier,
      },
      nowSeconds(),
      FLOW_TTL_SECONDS,
    );
    const response = NextResponse.redirect(challenge.authorizationUrl);
    response.cookies.set({
      name: AUTH_FLOW_COOKIE_NAME,
      value: signToken(flow, config.sessionSecret),
      httpOnly: true,
      // Top-level navigation back from the identity provider must carry
      // this cookie, so Lax (not Strict) is required.
      sameSite: "lax",
      secure: config.publicOrigin.startsWith("https:"),
      path: "/",
      maxAge: FLOW_TTL_SECONDS,
    });
    return response;
  } catch {
    // Discovery or provider failure: generic, nothing internal is exposed.
    return NextResponse.redirect(new URL("/?auth=unavailable", config.publicOrigin), 303);
  }
}
