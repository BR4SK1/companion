/**
 * HMAC-signed cookie tokens for the BFF session and the OIDC login flow.
 *
 * Design: a small, dependency-free authenticated cookie. The cookie value is
 * `base64url(JSON payload).base64url(HMAC-SHA256(payload, secret))`.
 * Verification recomputes the MAC in constant time and rejects wrong,
 * malformed, or expired tokens. Payloads carry the minimum needed: the
 * session holds only the identity-provider subject (authentication identity
 * at this edge — it is never propagated into domain records or worker
 * calls); the flow token holds the in-flight login's CSRF state, nonce, and
 * PKCE verifier until the callback consumes it.
 *
 * Secrets stay server-side: only this module and the route handlers touch
 * them; nothing is exposed to browser clients beyond the opaque cookie.
 * Cookie attributes (HttpOnly, SameSite, Secure, expiry) are applied by the
 * route handlers; this module owns signing and verification only.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE_NAME = "companion_session";
export const AUTH_FLOW_COOKIE_NAME = "companion_auth_flow";
/**
 * The test gate's separate session cookie (non-production-only loopback
 * entry; see `test-gate.ts`). Deliberately a different name AND a
 * different signing secret from the owner session: the two session kinds
 * are disjoint, so the test door grants no owner identity and an owner
 * session can never be presented as a test session or vice versa.
 */
export const TEST_SESSION_COOKIE_NAME = "companion_test_session";

export interface SessionPayload {
  /** Identity-provider subject; the allowlist was checked at sign-in. */
  readonly sub: string;
  readonly iat: number;
  /** Expiry as a Unix timestamp in seconds. */
  readonly exp: number;
}

/**
 * The test gate's session payload: a fixed kind marker and expiry only —
 * it carries no subject and no identity of any kind. The gate grants
 * access to a non-production candidate, not an identity.
 */
export interface TestSessionPayload {
  readonly kind: "e2e";
  readonly iat: number;
  /** Expiry as a Unix timestamp in seconds. */
  readonly exp: number;
}

export interface AuthFlowPayload {
  readonly state: string;
  readonly nonce: string;
  readonly codeVerifier: string;
  readonly iat: number;
  readonly exp: number;
}

function base64UrlEncode(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function base64UrlDecode(value: string): string {
  return Buffer.from(value, "base64url").toString("utf8");
}

/** Serialize a JSON-serializable payload into a MAC-protected token. */
export function signToken(payload: object, secret: string): string {
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const mac = createHmac("sha256", secret).update(encodedPayload).digest("base64url");
  return `${encodedPayload}.${mac}`;
}

function macMatches(token: string, mac: string, secret: string): boolean {
  const expected = createHmac("sha256", secret).update(token).digest();
  const provided = Buffer.from(mac, "base64url");
  if (provided.length !== expected.length) {
    return false;
  }
  return timingSafeEqual(provided, expected);
}

/**
 * Verify a token's MAC and expiry; resolve the raw payload object or null.
 * Any malformed, re-signed, or expired token yields null — never an error
 * that could leak details. Field-level validation is the typed wrapper's
 * job.
 */
function verifyTokenPayload(
  token: string | undefined,
  secret: string,
  nowSeconds: number,
): Record<string, unknown> | null {
  if (token === undefined || token.length === 0) {
    return null;
  }
  const separator = token.lastIndexOf(".");
  if (separator <= 0 || separator === token.length - 1) {
    return null;
  }
  const encodedPayload = token.slice(0, separator);
  const mac = token.slice(separator + 1);
  if (!macMatches(encodedPayload, mac, secret)) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(base64UrlDecode(encodedPayload));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  if (
    typeof record.exp !== "number" ||
    !Number.isFinite(record.exp) ||
    record.exp <= nowSeconds
  ) {
    return null;
  }
  return record;
}

export function createSessionPayload(
  sub: string,
  nowSeconds: number,
  ttlSeconds: number,
): SessionPayload {
  return {
    sub,
    iat: nowSeconds,
    exp: nowSeconds + ttlSeconds,
  };
}

export function verifySessionToken(
  token: string | undefined,
  secret: string,
  nowSeconds: number,
): SessionPayload | null {
  const payload = verifyTokenPayload(token, secret, nowSeconds);
  if (
    payload === null ||
    // Shape disjointness: a test-session payload (which carries a `kind`
    // marker and no subject) is never accepted as an owner session.
    "kind" in payload ||
    typeof payload.sub !== "string" ||
    payload.sub.length === 0 ||
    typeof payload.iat !== "number" ||
    typeof payload.exp !== "number"
  ) {
    return null;
  }
  return { sub: payload.sub, iat: payload.iat, exp: payload.exp };
}

export function createTestSessionPayload(
  nowSeconds: number,
  ttlSeconds: number,
): TestSessionPayload {
  return {
    kind: "e2e",
    iat: nowSeconds,
    exp: nowSeconds + ttlSeconds,
  };
}

export function verifyTestSessionToken(
  token: string | undefined,
  secret: string,
  nowSeconds: number,
): TestSessionPayload | null {
  const payload = verifyTokenPayload(token, secret, nowSeconds);
  if (
    payload === null ||
    // Shape disjointness: an owner session (which carries a subject) is
    // never accepted as a test session, and the kind marker must be exact.
    payload.kind !== "e2e" ||
    "sub" in payload ||
    typeof payload.iat !== "number" ||
    typeof payload.exp !== "number"
  ) {
    return null;
  }
  return { kind: "e2e", iat: payload.iat, exp: payload.exp };
}

export function createAuthFlowPayload(
  flow: Omit<AuthFlowPayload, "iat" | "exp">,
  nowSeconds: number,
  ttlSeconds: number,
): AuthFlowPayload {
  return { ...flow, iat: nowSeconds, exp: nowSeconds + ttlSeconds };
}

export function verifyAuthFlowToken(
  token: string | undefined,
  secret: string,
  nowSeconds: number,
): AuthFlowPayload | null {
  const payload = verifyTokenPayload(token, secret, nowSeconds);
  if (
    payload === null ||
    typeof payload.state !== "string" ||
    typeof payload.nonce !== "string" ||
    typeof payload.codeVerifier !== "string" ||
    payload.state.length === 0 ||
    payload.nonce.length === 0 ||
    payload.codeVerifier.length === 0 ||
    typeof payload.iat !== "number" ||
    typeof payload.exp !== "number"
  ) {
    return null;
  }
  return {
    state: payload.state,
    nonce: payload.nonce,
    codeVerifier: payload.codeVerifier,
    iat: payload.iat,
    exp: payload.exp,
  };
}
