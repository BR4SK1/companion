// Unit tests for the BFF's fail-closed configuration parsing and the
// owner/origin request guards (apps/web/src/lib/server): required-variable
// validation, owner allowlist decisions, and same-origin checks for
// state-changing requests. Pure modules — no Next.js runtime, no network.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  WebConfigError,
  loadWebConfig,
  loadWebConfigSafe,
} from "../../apps/web/src/lib/server/config.ts";
import { isOwnerSubject } from "../../apps/web/src/lib/server/owner.ts";
import { isSameOriginRequest } from "../../apps/web/src/lib/server/request-guard.ts";

const validEnv = {
  WEB_PUBLIC_URL: "https://companion.example.com",
  WEB_OIDC_ISSUER_URL: "https://keycloak.example.com/realms/companion",
  WEB_OIDC_CLIENT_ID: "companion-web",
  WEB_OIDC_CLIENT_SECRET: "client-secret",
  WEB_SESSION_SECRET: "session-secret-that-is-long-enough",
  WEB_OWNER_SUBJECTS: "owner-subject-1, owner-subject-2",
  WEB_WORKER_URL: "http://companion-worker:8080",
  WEB_WORKER_TOKEN: "service-token",
};

describe("BFF configuration", () => {
  it("parses a complete environment with defaults and normalization", () => {
    const config = loadWebConfig(validEnv);
    assert.equal(config.publicOrigin, "https://companion.example.com");
    // The issuer stays exactly as configured (validated, not normalized) so
    // provider-side issuer validation compares the registered identifier.
    assert.equal(config.oidcIssuerUrl, "https://keycloak.example.com/realms/companion");
    assert.equal(config.oidcClientId, "companion-web");
    assert.equal(config.sessionTtlSeconds, 43200);
    assert.equal(config.workerTimeoutMs, 10000);
    // The allowlist is trimmed and order preserved.
    assert.deepEqual(config.ownerSubjects, ["owner-subject-1", "owner-subject-2"]);
    // Trailing slashes are trimmed so endpoint paths append cleanly.
    assert.equal(config.workerUrl, "http://companion-worker:8080");
  });

  it("fails closed on any missing or malformed required value", () => {
    const cases = [
      ["WEB_PUBLIC_URL"],
      ["WEB_OIDC_ISSUER_URL"],
      ["WEB_OIDC_CLIENT_ID"],
      ["WEB_OIDC_CLIENT_SECRET"],
      ["WEB_SESSION_SECRET"],
      ["WEB_OWNER_SUBJECTS"],
      ["WEB_WORKER_URL"],
      ["WEB_WORKER_TOKEN"],
    ];
    for (const [name] of cases) {
      assert.throws(
        () => loadWebConfig({ ...validEnv, [name]: undefined }),
        (error) => {
          assert.ok(error instanceof WebConfigError);
          assert.ok(error.message.includes(name));
          return true;
        },
        `expected rejection for missing ${name}`,
      );
    }
    // An allowlist that is empty after trimming denies everyone.
    assert.throws(
      () => loadWebConfig({ ...validEnv, WEB_OWNER_SUBJECTS: " , ," }),
      (error) => {
        assert.ok(error instanceof WebConfigError);
        assert.ok(error.message.includes("WEB_OWNER_SUBJECTS"));
        return true;
      },
    );
    // Short session secrets are refused.
    assert.throws(
      () => loadWebConfig({ ...validEnv, WEB_SESSION_SECRET: "short" }),
      (error) => {
        assert.ok(error.message.includes("WEB_SESSION_SECRET"));
        return true;
      },
    );
    // Non-http(s) URLs are refused.
    assert.throws(() => loadWebConfig({ ...validEnv, WEB_PUBLIC_URL: "ftp://x" }));
    assert.throws(() => loadWebConfig({ ...validEnv, WEB_WORKER_URL: "not a url" }));
  });

  it("exposes a non-throwing variant for request paths", () => {
    assert.equal(loadWebConfigSafe(validEnv).ok, true);
    const broken = loadWebConfigSafe({ ...validEnv, WEB_WORKER_TOKEN: undefined });
    assert.equal(broken.ok, false);
    assert.ok(!("config" in broken));
  });

  it("applies explicit overrides", () => {
    const config = loadWebConfig({
      ...validEnv,
      WEB_SESSION_TTL_SECONDS: "3600",
      WEB_WORKER_TIMEOUT_MS: "2500",
    });
    assert.equal(config.sessionTtlSeconds, 3600);
    assert.equal(config.workerTimeoutMs, 2500);
    assert.throws(() =>
      loadWebConfig({ ...validEnv, WEB_SESSION_TTL_SECONDS: "0" }),
    );
  });
});

describe("owner allowlist decision", () => {
  const allowlist = ["owner-subject-1", "owner-subject-2"];

  it("admits exactly the configured subjects", () => {
    assert.equal(isOwnerSubject("owner-subject-1", allowlist), true);
    assert.equal(isOwnerSubject("owner-subject-2", allowlist), true);
    assert.equal(isOwnerSubject("someone-else", allowlist), false);
    // Prefix collisions are not matches.
    assert.equal(isOwnerSubject("owner-subject-10", allowlist), false);
  });

  it("fails closed for missing subjects and empty allowlists", () => {
    assert.equal(isOwnerSubject(undefined, allowlist), false);
    assert.equal(isOwnerSubject("", allowlist), false);
    assert.equal(isOwnerSubject("owner-subject-1", []), false);
  });
});

describe("same-origin request guard", () => {
  const publicOrigin = "https://companion.example.com";

  it("accepts only the configured origin", () => {
    assert.equal(
      isSameOriginRequest("https://companion.example.com", publicOrigin),
      true,
    );
    assert.equal(
      isSameOriginRequest("https://companion.example.com/some/path", publicOrigin),
      true,
      "only the origin is compared, not the path",
    );
  });

  it("rejects cross-site and missing origins", () => {
    assert.equal(
      isSameOriginRequest("https://attacker.example.net", publicOrigin),
      false,
    );
    // Same host, different scheme or port: different origin.
    assert.equal(isSameOriginRequest("http://companion.example.com", publicOrigin), false);
    assert.equal(
      isSameOriginRequest("https://companion.example.com:8443", publicOrigin),
      false,
    );
    assert.equal(isSameOriginRequest(undefined, publicOrigin), false);
    assert.equal(isSameOriginRequest("", publicOrigin), false);
    assert.equal(isSameOriginRequest("not a url", publicOrigin), false);
  });
});
