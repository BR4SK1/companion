// Unit tests for the web BFF's OIDC URL construction (apps/web/src/lib/
// server/oidc.ts): the registered redirect URI and the authorization-code
// exchange callback URL. Pure modules — no Next.js runtime, no network,
// no provider calls; the code-exchange itself is exercised by openid-client
// at runtime and intentionally not faked here.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { loadWebConfig } from "../../apps/web/src/lib/server/config.ts";
import {
  authorizationResponseCallbackUrl,
  redirectUriOf,
} from "../../apps/web/src/lib/server/oidc.ts";

const validEnv = {
  WEB_PUBLIC_URL: "https://companion.example.com",
  WEB_OIDC_ISSUER_URL: "https://keycloak.example.com/realms/companion",
  WEB_OIDC_CLIENT_ID: "companion-web",
  WEB_OIDC_CLIENT_SECRET: "client-secret",
  WEB_SESSION_SECRET: "session-secret-that-is-long-enough",
  WEB_OWNER_SUBJECTS: "owner-subject-1",
  WEB_WORKER_URL: "http://companion-worker:8080",
  WEB_WORKER_TOKEN: "service-token",
};

describe("registered redirect URI", () => {
  it("is the configured public origin plus the exact callback path", () => {
    const config = loadWebConfig(validEnv);
    assert.equal(redirectUriOf(config), "https://companion.example.com/api/auth/callback");
  });
});

describe("authorization-response callback URL for the code exchange", () => {
  const config = loadWebConfig(validEnv);

  it("keeps the configured origin and callback path, never the request host", () => {
    // A reverse-proxy style internal request URL: the server-side request
    // carries an internal listener address instead of the public origin.
    const internalRequest = new URL(
      "https://0.0.0.0:3000/api/auth/callback?code=svc-code&state=st-1",
    );
    const callback = authorizationResponseCallbackUrl(config, internalRequest);
    // The origin and path are exactly the registered redirect URI, which is
    // what the code exchange sends as the token request's redirect_uri.
    assert.equal(callback.origin + callback.pathname, redirectUriOf(config));
    assert.equal(callback.origin, "https://companion.example.com");
    assert.equal(callback.pathname, "/api/auth/callback");
  });

  it("preserves the authorization-response query parameters unchanged", () => {
    const requestUrl = new URL(
      "http://127.0.0.1:3000/api/auth/callback" +
        "?iss=https%3A%2F%2Fkeycloak.example.com%2Frealms%2Fcompanion" +
        "&code=svc-code&state=st-1",
    );
    const callback = authorizationResponseCallbackUrl(config, requestUrl);
    assert.equal(callback.search, requestUrl.search);
    // The parameters the exchange validates are present as sent.
    assert.equal(callback.searchParams.get("code"), "svc-code");
    assert.equal(callback.searchParams.get("state"), "st-1");
    assert.equal(
      callback.searchParams.get("iss"),
      "https://keycloak.example.com/realms/companion",
    );
  });

  it("stays consistent with the redirect URI for any request URL shape", () => {
    // Whatever the request host, port, or scheme, the exchange URL minus
    // its query is always the registered redirect URI (with trailing-slash
    // and default-port normalizations applied by URL parsing).
    for (const requestUrlString of [
      "https://0.0.0.0:3000/api/auth/callback?code=c&state=s",
      "http://127.0.0.1:3000/api/auth/callback?code=c&state=s",
      "https://companion.local.example/internal/api/auth/callback?code=c&state=s",
      "https://companion.example.com/api/auth/callback?code=c&state=s",
    ]) {
      const callback = authorizationResponseCallbackUrl(
        config,
        new URL(requestUrlString),
      );
      assert.equal(
        callback.origin + callback.pathname,
        redirectUriOf(config),
        `for request ${requestUrlString}`,
      );
      assert.equal(callback.search, "?code=c&state=s");
    }
  });
});
