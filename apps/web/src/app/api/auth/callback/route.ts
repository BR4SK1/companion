/**
 * OIDC authorization-response callback: completes the authorization-code
 * exchange, enforces the owner allowlist, and issues the session cookie.
 *
 * Security-relevant checks: the signed flow cookie must verify (it binds
 * the CSRF state, nonce, and PKCE verifier to this browser); the code
 * exchange validates state, nonce, PKCE, and the ID token's signature,
 * issuer, and audience (openid-client); and only then is the subject
 * checked against the explicit owner allowlist. Anything else ends in a
 * generic failure redirect — no account enumeration, no internal detail,
 * and no session for a denied subject.
 */

import { NextResponse, type NextRequest } from "next/server";

import { loadWebConfigSafe } from "@/lib/server/config";
import { isOwnerSubject } from "@/lib/server/owner";
import { nowSeconds } from "@/lib/server/respond";
import {
  AUTH_FLOW_COOKIE_NAME,
  SESSION_COOKIE_NAME,
  createSessionPayload,
  signToken,
  verifyAuthFlowToken,
} from "@/lib/server/session";
import {
  authorizationResponseCallbackUrl,
  discoverOidcConfiguration,
  exchangeAuthorizationCode,
} from "@/lib/server/oidc";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The one generic sign-in failure surface; `reason` is never rendered. */
function redirectFailed(publicOrigin: string): NextResponse {
  const response = NextResponse.redirect(new URL("/?auth=failed", publicOrigin), 303);
  response.cookies.set({
    name: AUTH_FLOW_COOKIE_NAME,
    value: "",
    path: "/",
    maxAge: 0,
  });
  return response;
}

export async function GET(request: NextRequest) {
  const configResult = loadWebConfigSafe(process.env);
  if (!configResult.ok) {
    return new NextResponse("Sign-in is temporarily unavailable.", {
      status: 503,
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
    });
  }
  const config = configResult.config;

  // The flow cookie must verify before anything else is trusted.
  const flow = verifyAuthFlowToken(
    request.cookies.get(AUTH_FLOW_COOKIE_NAME)?.value,
    config.sessionSecret,
    nowSeconds(),
  );
  if (flow === null) {
    return redirectFailed(config.publicOrigin);
  }

  // Identity-provider-reported errors end the flow generically.
  if (request.nextUrl.searchParams.has("error")) {
    return redirectFailed(config.publicOrigin);
  }

  try {
    const configuration = await discoverOidcConfiguration(config);
    const exchange = await exchangeAuthorizationCode(
      configuration,
      // Rebuilt from the trusted configured public origin and the
      // registered callback path — never the request host (behind a
      // reverse proxy it can be an internal address, which would mismatch
      // the registered redirect URI). The authorization-response query
      // parameters travel over unchanged for the exchange's state, code,
      // and iss validation.
      authorizationResponseCallbackUrl(config, request.nextUrl),
      {
        state: flow.state,
        nonce: flow.nonce,
        codeVerifier: flow.codeVerifier,
      },
    );
    if (exchange === null) {
      return redirectFailed(config.publicOrigin);
    }
    // Owner-only: subjects outside the allowlist get the same generic
    // failure as any other error, and no session exists afterwards.
    if (!isOwnerSubject(exchange.subject, config.ownerSubjects)) {
      console.log("owner authorization denied a subject outside the allowlist");
      return redirectFailed(config.publicOrigin);
    }
    const session = createSessionPayload(
      exchange.subject,
      nowSeconds(),
      config.sessionTtlSeconds,
    );
    const response = NextResponse.redirect(new URL("/", config.publicOrigin), 303);
    response.cookies.set({
      name: SESSION_COOKIE_NAME,
      value: signToken(session, config.sessionSecret),
      httpOnly: true,
      sameSite: "lax",
      secure: config.publicOrigin.startsWith("https:"),
      path: "/",
      maxAge: config.sessionTtlSeconds,
    });
    response.cookies.set({
      name: AUTH_FLOW_COOKIE_NAME,
      value: "",
      path: "/",
      maxAge: 0,
    });
    return response;
  } catch {
    return redirectFailed(config.publicOrigin);
  }
}
