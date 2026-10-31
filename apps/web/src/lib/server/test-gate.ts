/**
 * Non-production-only test-entry gate: channel resolution and per-channel
 * access decisions for the BFF edge.
 *
 * The application is served on two listeners:
 *
 * - The **main listener** (the container's normal port): owner-only,
 *   Keycloak-authenticated, exactly as before the gate existed. Nothing in
 *   this module relaxes it.
 * - The **test listener** (loopback-bound inside the pod, see
 *   `server/test-listener.mjs`): full application access without sign-in,
 *   for end-to-end testing of a non-production candidate. It is reachable
 *   only through `kubectl port-forward`; never through the Service or
 *   Ingress.
 *
 * A request belongs to the test channel only when the test listener itself
 * attested it: the listener accepts a connection only after checking the
 * actual socket peer address is loopback and the gate is enabled, then
 * injects a process-random attestation token into the request headers.
 * Route handlers verify that token against the in-memory value published
 * by the custom server — a client-supplied header, Host, or forwarding
 * header can never produce a test-channel request on the main listener,
 * because the token is generated at server start, kept in process memory
 * only, and never logged or exposed.
 *
 * Fail-closed rules implemented here:
 * - Every decision re-checks that the gate is configured (`config.testGate`
 *   is non-null) and the attestation token is present and matching; with
 *   the gate off, no request can resolve to the test channel.
 * - Test sessions are a disjoint kind: HMAC-signed with a dedicated secret
 *   (`WEB_TEST_GATE_SESSION_SECRET`, required to differ from the owner
 *   session secret), carried in a dedicated cookie, carrying no identity
 *   (no subject — the gate grants no identity-provider identity, and
 *   nothing identity-like is propagated to the worker or domain).
 * - The OIDC login flow is never reachable on the test channel, so an
 *   owner session can never be minted through it; owner cookies are never
 *   accepted on the test channel and test cookies are never accepted on
 *   the main channel.
 * - Same-origin protection for state-changing requests is preserved per
 *   channel: the main channel requires the configured public origin, the
 *   test channel requires exactly its configured loopback origin. Host and
 *   forwarding headers are never consulted for any decision.
 *
 * Pure and framework-free so the rules are directly unit-testable; the
 * shared constants and environment parsing come from
 * `server/gate-env.mjs` (the same source the custom server binds with).
 */

import { createHash, timingSafeEqual } from "node:crypto";

import {
  TEST_ATTESTATION_HEADER,
  TEST_CHANNEL_TOKEN_GLOBAL_KEY,
} from "../../../server/gate-env.mjs";
import type { WebConfig } from "./config.ts";
import { isSameOriginRequest } from "./request-guard.ts";
import {
  verifySessionToken,
  verifyTestSessionToken,
} from "./session.ts";

export { TEST_ATTESTATION_HEADER };

/** The request channel a request was accepted on. */
export type RequestChannel = "main" | "test";

/**
 * The test channel's fixed origin: loopback, plain http, the configured
 * gate port. Deliberately not derived from the request (host, forwarding
 * headers) and deliberately not configurable beyond the port — the test
 * entry is always `http://127.0.0.1:<port>`.
 */
export function testChannelOrigin(config: WebConfig): string {
  const gate = config.testGate;
  if (gate === null) {
    throw new Error("test channel origin requested while the test gate is disabled");
  }
  return `http://127.0.0.1:${String(gate.port)}`;
}

/** Timing-safe comparison of two secrets of arbitrary length. */
function secretsMatch(provided: string, expected: string): boolean {
  const providedDigest = createHash("sha256").update(provided).digest();
  const expectedDigest = createHash("sha256").update(expected).digest();
  return timingSafeEqual(providedDigest, expectedDigest);
}

/** Read the process-random channel attestation token, or null when absent. */
function channelAttestationToken(): string | null {
  const token = (globalThis as Record<string, unknown>)[TEST_CHANNEL_TOKEN_GLOBAL_KEY];
  return typeof token === "string" && token.length > 0 ? token : null;
}

/** Publish (or clear with `null`) the process-random attestation token. */
export function setChannelAttestationTokenForTesting(token: string | null): void {
  const holder = globalThis as Record<string, unknown>;
  if (token === null) {
    delete holder[TEST_CHANNEL_TOKEN_GLOBAL_KEY];
  } else {
    holder[TEST_CHANNEL_TOKEN_GLOBAL_KEY] = token;
  }
}

/**
 * True when the request may be treated as a test-channel request: the gate
 * is configured in this deployment, the process has an attestation token
 * (i.e. the custom server started the loopback listener), and the request
 * carries that exact token — which only the loopback listener injects.
 */
export function isTestChannelRequest(
  attestationHeader: string | null | undefined,
  config: WebConfig,
): boolean {
  if (config.testGate === null) {
    return false;
  }
  const token = channelAttestationToken();
  if (token === null) {
    return false;
  }
  if (typeof attestationHeader !== "string" || attestationHeader.length === 0) {
    return false;
  }
  return secretsMatch(attestationHeader, token);
}

/**
 * Resolve which listener accepted this request. Everything defaults to the
 * main channel: only an attested request on a gate-enabled deployment is
 * the test channel.
 */
export function resolveRequestChannel(
  config: WebConfig,
  attestationHeader: string | null | undefined,
): RequestChannel {
  return isTestChannelRequest(attestationHeader, config) ? "test" : "main";
}

export type AccessResult =
  | { readonly ok: true; readonly channel: "main"; readonly subject: string }
  | { readonly ok: true; readonly channel: "test" }
  | { readonly ok: false; readonly status: 401; readonly kind: "unauthorized" };

/**
 * Verify the caller's session for the resolved channel.
 *
 * Main channel: the owner session cookie, signed with the owner session
 * secret, exactly as before the gate existed. Test channel: the test
 * session cookie, signed with the dedicated gate secret — an owner cookie
 * is never consulted there, so the test door grants no owner identity and
 * cannot be used to impersonate one.
 */
export function verifyAccessForChannel(
  config: WebConfig,
  channel: RequestChannel,
  ownerSessionCookie: string | undefined,
  testSessionCookie: string | undefined,
  nowSeconds: number,
): AccessResult {
  if (channel === "test") {
    // Defense in depth: the channel can only be "test" when the gate is
    // configured, but never trust a session when it is not.
    if (config.testGate === null) {
      return { ok: false, status: 401, kind: "unauthorized" };
    }
    const session = verifyTestSessionToken(
      testSessionCookie,
      config.testGate.sessionSecret,
      nowSeconds,
    );
    if (session === null) {
      return { ok: false, status: 401, kind: "unauthorized" };
    }
    return { ok: true, channel: "test" };
  }
  const session = verifySessionToken(ownerSessionCookie, config.sessionSecret, nowSeconds);
  if (session === null) {
    return { ok: false, status: 401, kind: "unauthorized" };
  }
  return { ok: true, channel: "main", subject: session.sub };
}

/**
 * Same-origin decision for a state-changing request, per channel. The main
 * channel requires the configured public origin; the test channel requires
 * exactly its loopback origin. Neither decision ever consults the request
 * Host or forwarding headers — they are client-controlled and never a
 * trust anchor.
 */
export function stateChangeAllowedForChannel(
  config: WebConfig,
  channel: RequestChannel,
  originHeader: string | null | undefined,
): boolean {
  const expectedOrigin = channel === "test" ? testChannelOrigin(config) : config.publicOrigin;
  return isSameOriginRequest(originHeader, expectedOrigin);
}
