/**
 * OIDC relying-party integration for owner sign-in, built on
 * `openid-client` (the certified Node.js OpenID Connect Relying Party
 * library).
 *
 * Flow: authorization code with PKCE, `state`, and `nonce` against the
 * existing external Keycloak service. The wrapper is deliberately thin:
 * discovery caching, the authorization redirect URL, and the code
 * exchange. The security-relevant decisions (state/nonce comparison, PKCE
 * verifier storage in a signed flow cookie, owner allowlist check, session
 * issuance) live in the route handlers and the pure modules they use.
 *
 * The issuer, client id, and client secret are deployment configuration;
 * no values appear in this repository.
 */

import * as oidc from "openid-client";

import type { WebConfig } from "./config.ts";

export interface OidcConfiguration {
  readonly configuration: oidc.Configuration;
}

type DiscoveryCache = Map<string, Promise<oidc.Configuration>>;

/**
 * Module-level discovery cache, keyed by issuer and client id. Discovery
 * fetches the provider's well-known metadata once per process; a per-request
 * discovery round-trip would be wasteful and add a failure mode to every
 * login.
 */
const discoveryCache: DiscoveryCache = new Map();

/**
 * Resolve (and cache) the provider configuration for this deployment.
 * Plain-http issuers are allowed only by explicitly opting in per
 * configuration, so an https issuer can never silently downgrade.
 */
export async function discoverOidcConfiguration(
  config: WebConfig,
): Promise<oidc.Configuration> {
  const cacheKey = `${config.oidcIssuerUrl}|${config.oidcClientId}`;
  const cached = discoveryCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }
  const pending = (async () => {
    const configuration = await oidc.discovery(
      new URL(config.oidcIssuerUrl),
      config.oidcClientId,
      config.oidcClientSecret,
    );
    if (configuration.serverMetadata().issuer === undefined) {
      throw new Error("discovered metadata has no issuer");
    }
    if (new URL(config.oidcIssuerUrl).protocol === "http:") {
      oidc.allowInsecureRequests(configuration);
    }
    return configuration;
  })();
  pending.catch(() => {
    // Drop failed discoveries so a later attempt can retry (e.g. the
    // provider was briefly unreachable at first login).
    discoveryCache.delete(cacheKey);
  });
  discoveryCache.set(cacheKey, pending);
  return pending;
}

/** Redirect URI registered for this deployment's OIDC client. */
export function redirectUriOf(config: WebConfig): string {
  return `${config.publicOrigin}/api/auth/callback`;
}

/**
 * The callback URL handed to the authorization-code exchange: the trusted
 * configured public origin and the exact registered callback path, carrying
 * the authorization-response query parameters (code, state, iss) for the
 * exchange's validation.
 *
 * The request's own host is never trusted: behind a reverse proxy the
 * server-side request URL can carry an internal origin, and the code
 * exchange derives the token request's `redirect_uri` from the origin and
 * path of the URL it is given. Rebuilding the URL from the configuration
 * keeps that `redirect_uri` identical to the one in the authorization
 * request and registered with the provider; only the response parameters
 * travel over from the actual request.
 */
export function authorizationResponseCallbackUrl(
  config: WebConfig,
  requestUrl: URL,
): URL {
  const callbackUrl = new URL(redirectUriOf(config));
  callbackUrl.search = requestUrl.search;
  return callbackUrl;
}

export interface LoginChallenge {
  readonly authorizationUrl: URL;
  readonly state: string;
  readonly nonce: string;
  readonly codeVerifier: string;
}

/**
 * Build the authorization redirect for a fresh login attempt: PKCE S256
 * with a random verifier, a random CSRF state, and a nonce bound into the
 * ID token.
 */
export async function createLoginChallenge(
  config: WebConfig,
  configuration: oidc.Configuration,
): Promise<LoginChallenge> {
  const codeVerifier = oidc.randomPKCECodeVerifier();
  const codeChallenge = await oidc.calculatePKCECodeChallenge(codeVerifier);
  const state = oidc.randomState();
  const nonce = oidc.randomNonce();
  const authorizationUrl = oidc.buildAuthorizationUrl(configuration, {
    redirect_uri: redirectUriOf(config),
    scope: "openid",
    state,
    nonce,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });
  return { authorizationUrl, state, nonce, codeVerifier };
}

export interface CodeExchangeResult {
  /** The authenticated identity-provider subject from the ID token. */
  readonly subject: string;
}

/**
 * Exchange the authorization response for tokens and return the validated
 * ID-token subject. `openid-client` enforces the state, nonce, PKCE, and
 * ID-token signature/issuer/audience checks; a failure of any of them
 * rejects the exchange.
 */
export async function exchangeAuthorizationCode(
  configuration: oidc.Configuration,
  callbackUrl: URL,
  checks: { readonly state: string; readonly nonce: string; readonly codeVerifier: string },
): Promise<CodeExchangeResult | null> {
  let tokens;
  try {
    tokens = await oidc.authorizationCodeGrant(configuration, callbackUrl, {
      expectedState: checks.state,
      expectedNonce: checks.nonce,
      pkceCodeVerifier: checks.codeVerifier,
    });
  } catch {
    // Rejected exchange: invalid code, state/nonce/PKCE mismatch, or a
    // provider problem. The caller maps this to a generic failure.
    return null;
  }
  const claims = tokens.claims();
  const subject = claims?.sub;
  if (typeof subject !== "string" || subject.length === 0) {
    return null;
  }
  return { subject };
}
