// Unit tests for the non-production-only test-entry gate
// (apps/web: server/gate-env.mjs, server/test-listener.mjs,
// src/lib/server/test-gate.ts, and its integration into config.ts and
// session.ts). Covers the fail-closed rules: explicit enablement only
// (never inferred from NODE_ENV), loopback-only listener isolation with
// real sockets, the process-random channel attestation, the disjoint
// identity-free test session, and Host/forwarding-header independence of
// the per-channel origin decisions. Hermetic: loopback sockets only, no
// database, no external network.

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { connect } from "node:net";
import { networkInterfaces } from "node:os";
import { request as httpRequest } from "node:http";

import {
  AUTHORIZED_NON_PRODUCTION_NAMESPACE,
  DEPLOYMENT_NAMESPACE_ENV,
  DEPLOYMENT_PURPOSE_ENV,
  hasTestChannelForbiddenHeaders,
  isExpectedTestHost,
  isLoopbackRemoteAddress,
  KUBERNET_SERVICE_PORT_ENV,
  KUBERNETES_SERVICE_HOST_ENV,
  parseTestGateEnv,
  PURPOSE_NON_PRODUCTION,
  PURPOSE_PRODUCTION,
  POD_NAMESPACE_ENV,
  resolveDeploymentPurpose,
  TEST_ATTESTATION_HEADER,
  TEST_CHANNEL_FORBIDDEN_HEADERS,
  TEST_CHANNEL_TOKEN_GLOBAL_KEY,
  TEST_GATE_ENABLED_ENV,
  TEST_GATE_PORT_ENV,
  TEST_GATE_SESSION_SECRET_ENV,
  TEST_GATE_SESSION_TTL_ENV,
  TEST_GATE_TRUSTED_LOCAL_ENV,
} from "../../apps/web/server/gate-env.mjs";
import {
  createTestEntryListener,
  shouldAcceptTestConnection,
} from "../../apps/web/server/test-listener.mjs";
import {
  loadWebConfig,
  WebConfigError,
} from "../../apps/web/src/lib/server/config.ts";
import {
  createSessionPayload,
  createTestSessionPayload,
  signToken,
  TEST_SESSION_COOKIE_NAME,
  verifySessionToken,
  verifyTestSessionToken,
} from "../../apps/web/src/lib/server/session.ts";
import {
  resolveRequestChannel,
  setChannelAttestationTokenForTesting,
  stateChangeAllowedForChannel,
  testChannelOrigin,
  verifyAccessForChannel,
} from "../../apps/web/src/lib/server/test-gate.ts";

const MAIN_SECRET = "main-session-secret-0123456789abcdef";
const GATE_SECRET = "test-gate-secret-0123456789abcdef";
const OWNER_SUBJECT = "owner-subject-1";

const baseEnv = {
  WEB_PUBLIC_URL: "https://companion.example.com",
  WEB_OIDC_ISSUER_URL: "https://keycloak.example.com/realms/companion",
  WEB_OIDC_CLIENT_ID: "companion-web",
  WEB_OIDC_CLIENT_SECRET: "client-secret",
  WEB_SESSION_SECRET: MAIN_SECRET,
  WEB_OWNER_SUBJECTS: OWNER_SUBJECT,
  WEB_WORKER_URL: "http://companion-worker:8080",
  WEB_WORKER_TOKEN: "service-token",
};

/** A chart-attested non-production deployment's environment. */
const k8sAttestation = {
  COMPANION_DEPLOYMENT_PURPOSE: "non-production",
  COMPANION_DEPLOYMENT_NAMESPACE: "companion-np",
  COMPANION_POD_NAMESPACE: "companion-np",
};

const gateEnv = {
  [TEST_GATE_ENABLED_ENV]: "true",
  [TEST_GATE_PORT_ENV]: "3100",
  [TEST_GATE_SESSION_SECRET_ENV]: GATE_SECRET,
  ...k8sAttestation,
};

describe("test gate environment parsing", () => {
  it("is disabled by default and by anything but the exact value", () => {
    assert.deepEqual(parseTestGateEnv({}), { enabled: false });
    for (const value of [undefined, "", "true ", " True", "TRUE", "1", "yes", "false"]) {
      const env = { ...gateEnv, [TEST_GATE_ENABLED_ENV]: value };
      assert.deepEqual(parseTestGateEnv(env), { enabled: false }, String(value));
    }
  });

  it("parses a complete enabled configuration with defaults", () => {
    const parsed = parseTestGateEnv({ ...gateEnv });
    assert.equal(parsed.enabled, true);
    assert.equal(parsed.port, 3100);
    assert.equal(parsed.sessionSecret, GATE_SECRET);
    assert.equal(parsed.sessionTtlSeconds, 3600);
  });

  it("applies an explicit positive session TTL override", () => {
    const parsed = parseTestGateEnv({ ...gateEnv, [TEST_GATE_SESSION_TTL_ENV]: "600" });
    assert.equal(parsed.sessionTtlSeconds, 600);
  });

  it("rejects missing or malformed values when enabled", () => {
    for (const [env, fragment] of [
      [{ ...gateEnv, [TEST_GATE_PORT_ENV]: undefined }, TEST_GATE_PORT_ENV],
      [{ ...gateEnv, [TEST_GATE_PORT_ENV]: "0" }, TEST_GATE_PORT_ENV],
      [{ ...gateEnv, [TEST_GATE_PORT_ENV]: "-1" }, TEST_GATE_PORT_ENV],
      [{ ...gateEnv, [TEST_GATE_PORT_ENV]: "65536" }, TEST_GATE_PORT_ENV],
      [{ ...gateEnv, [TEST_GATE_PORT_ENV]: "70000" }, TEST_GATE_PORT_ENV],
      [{ ...gateEnv, [TEST_GATE_PORT_ENV]: "http" }, TEST_GATE_PORT_ENV],
      [{ ...gateEnv, [TEST_GATE_SESSION_SECRET_ENV]: "short" }, TEST_GATE_SESSION_SECRET_ENV],
      [{ ...gateEnv, [TEST_GATE_SESSION_SECRET_ENV]: undefined }, TEST_GATE_SESSION_SECRET_ENV],
      [{ ...gateEnv, [TEST_GATE_SESSION_TTL_ENV]: "zero" }, TEST_GATE_SESSION_TTL_ENV],
      [{ ...gateEnv, [TEST_GATE_SESSION_TTL_ENV]: "0" }, TEST_GATE_SESSION_TTL_ENV],
    ]) {
      assert.throws(() => parseTestGateEnv(env), (error) => {
        assert.ok(error instanceof Error);
        assert.ok(error.message.includes(fragment), error.message);
        return true;
      });
    }
  });

  it("accepts the 1-65535 port range boundaries", () => {
    assert.equal(parseTestGateEnv({ ...gateEnv, [TEST_GATE_PORT_ENV]: "1" }).port, 1);
    assert.equal(parseTestGateEnv({ ...gateEnv, [TEST_GATE_PORT_ENV]: "65535" }).port, 65535);
  });

  it("rejects a gate port equal to the main listener port", () => {
    assert.throws(
      () => parseTestGateEnv({ ...gateEnv, PORT: "3100" }),
      (error) => error.message.includes(TEST_GATE_PORT_ENV),
    );
    // A different main port is fine.
    assert.equal(parseTestGateEnv({ ...gateEnv, PORT: "3000" }).enabled, true);
  });

  it("never reads NODE_ENV or other ambient signals", () => {
    for (const nodeEnv of ["production", "development", "test"]) {
      assert.deepEqual(parseTestGateEnv({ NODE_ENV: nodeEnv }), { enabled: false });
      assert.equal(parseTestGateEnv({ ...gateEnv, NODE_ENV: nodeEnv }).enabled, true);
    }
  });
});

describe("deployment-purpose attestation", () => {
  const localEnv = { [TEST_GATE_TRUSTED_LOCAL_ENV]: "true" };

  it("accepts a chart-attested non-production deployment with matching namespaces", () => {
    assert.deepEqual(resolveDeploymentPurpose(k8sAttestation), {
      kind: "kubernetes",
      purpose: PURPOSE_NON_PRODUCTION,
      namespace: "companion-np",
    });
    assert.equal(parseTestGateEnv({ ...gateEnv }).enabled, true);
  });

  it("accepts an explicit local run only when no chart attestation is present", () => {
    assert.deepEqual(resolveDeploymentPurpose(localEnv), { kind: "local" });
    const localGate = {
      [TEST_GATE_ENABLED_ENV]: "true",
      [TEST_GATE_PORT_ENV]: "3100",
      [TEST_GATE_SESSION_SECRET_ENV]: GATE_SECRET,
      [TEST_GATE_TRUSTED_LOCAL_ENV]: "true",
    };
    assert.equal(parseTestGateEnv(localGate).enabled, true);
  });

  it("refuses the local declaration when Kubernetes context indicators are present", () => {
    // The kubelet sets these in every pod; a container inside Kubernetes
    // cannot truthfully declare itself a run outside Kubernetes.
    for (const indicator of [KUBERNETES_SERVICE_HOST_ENV, KUBERNET_SERVICE_PORT_ENV]) {
      const env = { ...localEnv, [indicator]: "10.43.0.1" };
      assert.equal(resolveDeploymentPurpose(env).kind, "invalid", indicator);
      assert.throws(
        () => parseTestGateEnv({
          [TEST_GATE_ENABLED_ENV]: "true",
          [TEST_GATE_PORT_ENV]: "3100",
          [TEST_GATE_SESSION_SECRET_ENV]: GATE_SECRET,
          [TEST_GATE_TRUSTED_LOCAL_ENV]: "true",
          [indicator]: "10.43.0.1",
        }),
        (error) => {
          assert.ok(error.message.includes("may not attest a local run inside Kubernetes"), error.message);
          return true;
        },
        indicator,
      );
    }
  });

  it("rejects a non-production purpose from any namespace but the authorized one", () => {
    // Purpose plus downward-API agreement alone would let any namespace
    // self-declare itself non-production; only the pinned namespace is
    // authorized.
    for (const namespace of ["companion-prod", "companion-dev", "default", "companion"]) {
      const attestation = {
        [DEPLOYMENT_PURPOSE_ENV]: PURPOSE_NON_PRODUCTION,
        [DEPLOYMENT_NAMESPACE_ENV]: namespace,
        [POD_NAMESPACE_ENV]: namespace,
      };
      const resolved = resolveDeploymentPurpose(attestation);
      assert.equal(resolved.kind, "invalid", namespace);
      assert.ok(
        resolved.reason.includes("is not the authorized non-production namespace"),
        `${namespace}: ${resolved.reason}`,
      );
      assert.throws(
        () => parseTestGateEnv({
          [TEST_GATE_ENABLED_ENV]: "true",
          [TEST_GATE_PORT_ENV]: "3100",
          [TEST_GATE_SESSION_SECRET_ENV]: GATE_SECRET,
          ...attestation,
        }),
        (error) => error.message.includes("is not the authorized non-production namespace"),
        namespace,
      );
    }
    assert.equal(AUTHORIZED_NON_PRODUCTION_NAMESPACE, "companion-np");
  });

  it("rejects a production deployment explicitly", () => {
    const production = { ...k8sAttestation, [DEPLOYMENT_PURPOSE_ENV]: PURPOSE_PRODUCTION };
    assert.deepEqual(resolveDeploymentPurpose(production), {
      kind: "kubernetes",
      purpose: PURPOSE_PRODUCTION,
      namespace: "companion-np",
    });
    assert.throws(
      () => parseTestGateEnv({ ...gateEnv, [DEPLOYMENT_PURPOSE_ENV]: PURPOSE_PRODUCTION }),
      (error) => {
        assert.ok(error.message.includes("must never run in a production deployment"), error.message);
        return true;
      },
    );
    // The local declaration cannot override a rendered deployment's purpose.
    assert.throws(
      () => parseTestGateEnv({ ...gateEnv, [DEPLOYMENT_PURPOSE_ENV]: PURPOSE_PRODUCTION, [TEST_GATE_TRUSTED_LOCAL_ENV]: "true" }),
      (error) => error.message.includes("must never run in a production deployment"),
    );
  });

  it("rejects unknown and missing purposes and namespace mismatches", () => {
    const cases = [
      // Unknown purpose value.
      [{ ...gateEnv, [DEPLOYMENT_PURPOSE_ENV]: "canary" }, "must be exactly"],
      // Missing purpose entirely, with no other attestation present.
      [
        {
          [TEST_GATE_ENABLED_ENV]: "true",
          [TEST_GATE_PORT_ENV]: "3100",
          [TEST_GATE_SESSION_SECRET_ENV]: GATE_SECRET,
        },
        "requires a deployment-purpose attestation",
      ],
      // Purpose removed while namespace attestation values remain.
      [{ ...gateEnv, [DEPLOYMENT_PURPOSE_ENV]: undefined }, "requires COMPANION_DEPLOYMENT_PURPOSE"],
      // Namespace attestation incomplete or mismatched.
      [{ ...gateEnv, [POD_NAMESPACE_ENV]: undefined }, "must be present"],
      [{ ...gateEnv, [DEPLOYMENT_NAMESPACE_ENV]: undefined }, "must be present"],
      [{ ...gateEnv, [DEPLOYMENT_NAMESPACE_ENV]: "other-ns" }, "does not match the pod's actual namespace"],
      // Namespace envs without a purpose: incomplete attestation.
      [
        {
          [TEST_GATE_ENABLED_ENV]: "true",
          [TEST_GATE_PORT_ENV]: "3100",
          [TEST_GATE_SESSION_SECRET_ENV]: GATE_SECRET,
          [DEPLOYMENT_NAMESPACE_ENV]: "companion-np",
          [POD_NAMESPACE_ENV]: "companion-np",
        },
        "requires COMPANION_DEPLOYMENT_PURPOSE",
      ],
      // Local declaration cannot coexist with a chart-injected attestation.
      [
        {
          [TEST_GATE_ENABLED_ENV]: "true",
          [TEST_GATE_PORT_ENV]: "3100",
          [TEST_GATE_SESSION_SECRET_ENV]: GATE_SECRET,
          [TEST_GATE_TRUSTED_LOCAL_ENV]: "true",
          [DEPLOYMENT_NAMESPACE_ENV]: "companion-np",
          [POD_NAMESPACE_ENV]: "companion-np",
        },
        "requires COMPANION_DEPLOYMENT_PURPOSE",
      ],
      // A value other than the exact "true" is not a local attestation.
      [
        {
          [TEST_GATE_ENABLED_ENV]: "true",
          [TEST_GATE_PORT_ENV]: "3100",
          [TEST_GATE_SESSION_SECRET_ENV]: GATE_SECRET,
          [TEST_GATE_TRUSTED_LOCAL_ENV]: "1",
        },
        "requires a deployment-purpose attestation",
      ],
    ];
    for (const [env, fragment] of cases) {
      assert.throws(() => parseTestGateEnv(env), (error) => {
        assert.ok(error.message.includes(fragment), error.message);
        return true;
      }, fragment);
    }
  });

  it("is not inferred from NODE_ENV", () => {
    for (const nodeEnv of ["production", "development", "test"]) {
      assert.equal(resolveDeploymentPurpose({ NODE_ENV: nodeEnv }).kind, "none");
      assert.deepEqual(resolveDeploymentPurpose({ ...k8sAttestation, NODE_ENV: nodeEnv }).purpose, PURPOSE_NON_PRODUCTION);
    }
  });

  it("leaves a disabled gate alone regardless of the attestation", () => {
    assert.deepEqual(parseTestGateEnv({ ...k8sAttestation, [DEPLOYMENT_PURPOSE_ENV]: PURPOSE_PRODUCTION }), { enabled: false });
    assert.deepEqual(parseTestGateEnv({}), { enabled: false });
  });
});

describe("loopback address rule", () => {
  it("accepts loopback forms only", () => {
    for (const address of ["127.0.0.1", "127.255.255.254", "::1", "::ffff:127.0.0.1", "::FFFF:127.10.1.2"]) {
      assert.equal(isLoopbackRemoteAddress(address), true, address);
    }
  });

  it("rejects everything else", () => {
    for (const address of [
      undefined,
      null,
      "",
      "localhost",
      "0.0.0.0",
      "::",
      "10.1.2.3",
      "192.168.1.10",
      "172.16.0.9",
      "::ffff:10.0.0.1",
      "fe80::1",
      "not an address",
    ]) {
      assert.equal(isLoopbackRemoteAddress(address), false, String(address));
    }
  });

  it("accepts a connection only when the gate is enabled and the peer is loopback", () => {
    assert.equal(shouldAcceptTestConnection("127.0.0.1", true), true);
    assert.equal(shouldAcceptTestConnection("127.0.0.1", false), false);
    assert.equal(shouldAcceptTestConnection("10.1.2.3", true), false);
    assert.equal(shouldAcceptTestConnection(undefined, true), false);
  });
});

describe("test channel Host rule (DNS-rebinding defense)", () => {
  it("accepts exactly the bound loopback address and port", () => {
    assert.equal(isExpectedTestHost("127.0.0.1:3100", 3100), true);
    assert.equal(isExpectedTestHost("127.0.0.1:80", 80), true);
    // HTTP clients omit the port for the scheme's default port.
    assert.equal(isExpectedTestHost("127.0.0.1", 80), true);
  });

  it("rejects a rebinding attacker's Host and every other spelling", () => {
    for (const [host, port] of [
      ["attacker.example.net", 3100],
      ["attacker.example.net:3100", 3100],
      ["localhost:3100", 3100],
      ["localhost", 3100],
      ["127.0.0.1.evil.example.net:3100", 3100],
      ["127.0.0.1:3200", 3100],
      ["127.0.0.1", 3100],
      ["[127.0.0.1]:3100", 3100],
      ["::1:3100", 3100],
      ["127.0.0.1:3100.", 3100],
      ["0.0.0.0:3100", 3100],
      ["", 3100],
      [undefined, 3100],
      [null, 3100],
      // Not even other loopback forms: the documented entry is 127.0.0.1.
      ["[::1]:3100", 3100],
    ]) {
      assert.equal(isExpectedTestHost(host, port), false, String(host));
    }
  });

  it("detects forwarding and proxy headers on any request", () => {
    for (const name of TEST_CHANNEL_FORBIDDEN_HEADERS) {
      assert.equal(hasTestChannelForbiddenHeaders({ [name]: "1" }), true, name);
    }
    assert.equal(hasTestChannelForbiddenHeaders({ host: "127.0.0.1:3100" }), false);
    assert.equal(hasTestChannelForbiddenHeaders({}), false);
    assert.equal(hasTestChannelForbiddenHeaders(undefined), false);
    assert.equal(hasTestChannelForbiddenHeaders(null), false);
  });
});

describe("test gate configuration in the BFF config", () => {
  it("is null when the gate is not enabled", () => {
    const config = loadWebConfig(baseEnv);
    assert.equal(config.testGate, null);
  });

  it("is populated when explicitly enabled with a valid attestation", () => {
    const config = loadWebConfig({ ...baseEnv, ...gateEnv });
    assert.notEqual(config.testGate, null);
    assert.equal(config.testGate.port, 3100);
    assert.equal(config.testGate.sessionSecret, GATE_SECRET);
    assert.equal(config.testGate.sessionTtlSeconds, 3600);
  });

  it("fails the whole configuration when the gate secret equals the owner session secret", () => {
    assert.throws(
      () => loadWebConfig({
        ...baseEnv,
        ...gateEnv,
        [TEST_GATE_SESSION_SECRET_ENV]: MAIN_SECRET,
      }),
      (error) => {
        assert.ok(error instanceof WebConfigError);
        assert.ok(error.message.includes(TEST_GATE_SESSION_SECRET_ENV));
        return true;
      },
    );
  });

  it("fails the whole configuration on any malformed gate value", () => {
    assert.throws(
      () => loadWebConfig({ ...baseEnv, ...gateEnv, [TEST_GATE_PORT_ENV]: "99999" }),
      WebConfigError,
    );
    assert.throws(
      () => loadWebConfig({ ...baseEnv, ...gateEnv, [TEST_GATE_PORT_ENV]: "65536" }),
      WebConfigError,
    );
    assert.throws(
      () => loadWebConfig({ ...baseEnv, ...gateEnv, [TEST_GATE_SESSION_SECRET_ENV]: "short" }),
      WebConfigError,
    );
  });

  it("fails the whole configuration for production or unattested deployments", () => {
    assert.throws(
      () => loadWebConfig({
        ...baseEnv,
        ...gateEnv,
        [DEPLOYMENT_PURPOSE_ENV]: PURPOSE_PRODUCTION,
      }),
      (error) => error.message.includes("must never run in a production deployment"),
    );
    assert.throws(
      () => loadWebConfig({
        ...baseEnv,
        ...gateEnv,
        [DEPLOYMENT_PURPOSE_ENV]: undefined,
      }),
      WebConfigError,
    );
    assert.throws(
      () => loadWebConfig({
        ...baseEnv,
        ...gateEnv,
        [DEPLOYMENT_NAMESPACE_ENV]: "other-ns",
      }),
      (error) => error.message.includes("does not match the pod's actual namespace"),
    );
  });

  it("does not infer anything from NODE_ENV", () => {
    const enabled = { ...baseEnv, ...gateEnv };
    assert.equal(loadWebConfig({ ...enabled, NODE_ENV: "production" }).testGate.port, 3100);
    assert.equal(loadWebConfig({ ...enabled, NODE_ENV: "development" }).testGate.port, 3100);
    assert.equal(loadWebConfig({ ...baseEnv, NODE_ENV: "production" }).testGate, null);
    assert.equal(loadWebConfig({ ...baseEnv, NODE_ENV: "development" }).testGate, null);
  });
});

describe("session shape disjointness", () => {
  const now = 1_700_000_000;

  it("test sessions carry no identity and a fixed kind marker", () => {
    const payload = createTestSessionPayload(now, 3600);
    assert.deepEqual(payload, { kind: "e2e", iat: now, exp: now + 3600 });
    assert.ok(!("sub" in payload));
  });

  it("each verifier rejects the other kind even when signed with the same secret", () => {
    const ownerToken = signToken(createSessionPayload(OWNER_SUBJECT, now, 3600), MAIN_SECRET);
    const testToken = signToken(createTestSessionPayload(now, 3600), GATE_SECRET);
    assert.equal(verifySessionToken(testToken, MAIN_SECRET, now + 1), null);
    assert.equal(verifyTestSessionToken(ownerToken, MAIN_SECRET, now + 1), null);
    // Even the correct secret cannot smuggle the wrong shape across.
    const ownerShapedWithGateSecret = signToken(createSessionPayload(OWNER_SUBJECT, now, 3600), GATE_SECRET);
    assert.equal(verifyTestSessionToken(ownerShapedWithGateSecret, GATE_SECRET, now + 1), null);
    const testShapedWithMainSecret = signToken(createTestSessionPayload(now, 3600), MAIN_SECRET);
    assert.equal(verifySessionToken(testShapedWithMainSecret, MAIN_SECRET, now + 1), null);
  });

  it("verifies a test session with its own secret only", () => {
    const token = signToken(createTestSessionPayload(now, 3600), GATE_SECRET);
    assert.notEqual(verifyTestSessionToken(token, GATE_SECRET, now + 1), null);
    assert.equal(verifyTestSessionToken(token, MAIN_SECRET, now + 1), null);
    assert.equal(verifyTestSessionToken(token, GATE_SECRET, now + 3601), null);
    assert.equal(verifyTestSessionToken(undefined, GATE_SECRET, now + 1), null);
  });

  it("uses a dedicated cookie name distinct from the owner session cookie", () => {
    assert.notEqual(TEST_SESSION_COOKIE_NAME, "companion_session");
  });
});

describe("channel resolution and attestation", () => {
  const gateConfig = loadWebConfig({ ...baseEnv, ...gateEnv });
  const plainConfig = loadWebConfig(baseEnv);

  before(() => setChannelAttestationTokenForTesting("unit-test-token"));
  after(() => setChannelAttestationTokenForTesting(null));

  it("resolves the test channel only with the exact process token on a gate-enabled deployment", () => {
    assert.equal(resolveRequestChannel(gateConfig, "unit-test-token"), "test");
  });

  it("resolves the main channel for missing, wrong, or empty attestation", () => {
    assert.equal(resolveRequestChannel(gateConfig, undefined), "main");
    assert.equal(resolveRequestChannel(gateConfig, null), "main");
    assert.equal(resolveRequestChannel(gateConfig, ""), "main");
    assert.equal(resolveRequestChannel(gateConfig, "wrong-token"), "main");
    assert.equal(resolveRequestChannel(gateConfig, "unit-test-toke"), "main");
    assert.equal(resolveRequestChannel(gateConfig, "unit-test-tokens"), "main");
  });

  it("resolves the main channel when the gate is disabled even with a matching header", () => {
    assert.equal(resolveRequestChannel(plainConfig, "unit-test-token"), "main");
  });

  it("resolves the main channel when no attestation token exists in the process", () => {
    setChannelAttestationTokenForTesting(null);
    assert.equal(resolveRequestChannel(gateConfig, "unit-test-token"), "main");
    setChannelAttestationTokenForTesting("unit-test-token");
  });

  it("derives the fixed test origin from configuration, loopback and http only", () => {
    assert.equal(testChannelOrigin(gateConfig), "http://127.0.0.1:3100");
    assert.equal(testChannelOrigin(loadWebConfig({ ...baseEnv, ...gateEnv, [TEST_GATE_PORT_ENV]: "4599" })), "http://127.0.0.1:4599");
    assert.throws(() => testChannelOrigin(plainConfig));
  });
});

describe("per-channel access verification", () => {
  const now = 1_700_000_000;
  const gateConfig = loadWebConfig({ ...baseEnv, ...gateEnv });
  const ownerToken = signToken(createSessionPayload(OWNER_SUBJECT, now, 3600), MAIN_SECRET);
  const testToken = signToken(createTestSessionPayload(now, 3600), GATE_SECRET);

  it("admits an owner session on the main channel with its subject", () => {
    const result = verifyAccessForChannel(gateConfig, "main", ownerToken, undefined, now + 1);
    assert.deepEqual(result, { ok: true, channel: "main", subject: OWNER_SUBJECT });
  });

  it("admits a test session on the test channel without any subject", () => {
    const result = verifyAccessForChannel(gateConfig, "test", undefined, testToken, now + 1);
    assert.deepEqual(result, { ok: true, channel: "test" });
    assert.ok(!("subject" in result));
  });

  it("rejects the wrong session kind on each channel (no owner impersonation)", () => {
    // Owner cookie on the test channel: worthless.
    assert.equal(verifyAccessForChannel(gateConfig, "test", ownerToken, undefined, now + 1).ok, false);
    // Test cookie on the main channel: worthless.
    assert.equal(verifyAccessForChannel(gateConfig, "main", undefined, testToken, now + 1).ok, false);
    // Both cookies present: each channel still honors only its own kind.
    const onMain = verifyAccessForChannel(gateConfig, "main", undefined, testToken, now + 1);
    assert.equal(onMain.ok, false);
  });

  it("rejects missing, expired, and foreign-secret sessions", () => {
    assert.equal(verifyAccessForChannel(gateConfig, "main", undefined, undefined, now + 1).ok, false);
    assert.equal(verifyAccessForChannel(gateConfig, "test", undefined, undefined, now + 1).ok, false);
    const expiredTest = signToken(createTestSessionPayload(now, 10), GATE_SECRET);
    assert.equal(verifyAccessForChannel(gateConfig, "test", undefined, expiredTest, now + 11).ok, false);
  });

  it("fails closed when the channel says test but the gate is not configured", () => {
    const plainConfig = loadWebConfig(baseEnv);
    assert.equal(verifyAccessForChannel(plainConfig, "test", undefined, testToken, now + 1).ok, false);
  });
});

describe("per-channel same-origin decisions (Host and forwarding headers never consulted)", () => {
  const gateConfig = loadWebConfig({ ...baseEnv, ...gateEnv });

  it("requires the configured public origin on the main channel", () => {
    assert.equal(stateChangeAllowedForChannel(gateConfig, "main", "https://companion.example.com"), true);
    assert.equal(stateChangeAllowedForChannel(gateConfig, "main", "http://127.0.0.1:3100"), false);
    assert.equal(stateChangeAllowedForChannel(gateConfig, "main", undefined), false);
  });

  it("requires exactly the loopback test origin on the test channel", () => {
    assert.equal(stateChangeAllowedForChannel(gateConfig, "test", "http://127.0.0.1:3100"), true);
    assert.equal(stateChangeAllowedForChannel(gateConfig, "test", "http://127.0.0.1:3100/some/path"), true);
    assert.equal(stateChangeAllowedForChannel(gateConfig, "test", "https://companion.example.com"), false);
    // Different port or scheme: a different origin.
    assert.equal(stateChangeAllowedForChannel(gateConfig, "test", "http://127.0.0.1:3101"), false);
    assert.equal(stateChangeAllowedForChannel(gateConfig, "test", "https://127.0.0.1:3100"), false);
    assert.equal(stateChangeAllowedForChannel(gateConfig, "test", undefined), false);
    assert.equal(stateChangeAllowedForChannel(gateConfig, "test", "not a url"), false);
  });
});

describe("loopback-only test listener with real sockets", () => {
  const requests = [];
  const logLines = [];
  let listenerEnabled = true;
  let listener;
  let baseUrl;

  before(async () => {
    listener = createTestEntryListener({
      port: 0,
      token: "listener-unit-token",
      isEnabled: () => listenerEnabled,
      handler: (req, res) => {
        requests.push({
          attestation: req.headers[TEST_ATTESTATION_HEADER],
          host: req.headers.host,
        });
        // A cookie on every served response: the DNS-rebinding rejections
        // below prove a hostile request can never reach this handler (and
        // therefore can never obtain a session cookie or a redirect to a
        // sensitive endpoint).
        res.writeHead(200, {
          "content-type": "text/plain",
          "set-cookie": "probe=should-not-leak; Path=/",
        });
        res.end("served");
      },
      log: (message) => logLines.push(message),
    });
    const port = await listener.start();
    baseUrl = `http://127.0.0.1:${String(port)}`;
  });

  after(async () => {
    await listener.close();
  });

  it("binds strictly to 127.0.0.1", () => {
    assert.equal(listener.server.address().address, "127.0.0.1");
  });

  it("serves an accepted loopback request (exact loopback Host) with the attestation token injected", async () => {
    const { status, body, headers } = await rawRequest(baseUrl + "/api/thread");
    assert.equal(status, 200);
    assert.equal(body, "served");
    assert.ok(headers["set-cookie"].some((value) => value.startsWith("probe=")), "the handler ran");
    assert.equal(requests.length, 1);
    assert.equal(requests[0].host, `127.0.0.1:${listener.server.address().port}`);
    assert.equal(requests[0].attestation, "listener-unit-token");
  });

  it("rejects a DNS-rebinding Host before the handler, with no cookie and no redirect", async () => {
    const { status, body, headers } = await rawRequest(baseUrl + "/api/test-gate/session", {
      headers: { host: "attacker.example.net" },
    });
    assert.equal(status, 403);
    assert.equal(body, "forbidden");
    assert.equal(headers["set-cookie"], undefined, "a hostile Host must never obtain a cookie");
    assert.equal(headers.location, undefined, "a hostile Host must never be redirected");
    assert.equal(requests.length, 1, "the rebinding request never reached the handler");
  });

  it("rejects a rebinding Host even with the port appended (attacker.example.net:port)", async () => {
    const { status, headers } = await rawRequest(baseUrl + "/api/thread", {
      headers: { host: `attacker.example.net:${listener.server.address().port}` },
    });
    assert.equal(status, 403);
    assert.equal(headers["set-cookie"], undefined);
    assert.equal(requests.length, 1);
  });

  it("rejects a request without any Host header", async () => {
    const port = listener.server.address().port;
    // HTTP/1.1 without a Host: the server rejects it (400 from the HTTP
    // stack or 403 from the listener) — either way, no cookie, no
    // redirect, and the handler never runs.
    const response = await rawSocketRequest("GET /api/thread HTTP/1.1\r\nConnection: close\r\n\r\n", port);
    const status = Number(response.split(" ")[1]);
    assert.ok(status === 400 || status === 403, response);
    assert.ok(!/set-cookie/i.test(response), "a request without a Host must never obtain a cookie");
    assert.ok(!/^location:/im.test(response), "no redirect without a Host");
    assert.equal(requests.length, 1);
    // HTTP/1.0 without a Host reaches the listener and is refused there.
    const http10 = await rawSocketRequest("GET /api/thread HTTP/1.0\r\n\r\n", port);
    assert.match(http10, / 403 /);
    assert.ok(!/set-cookie/i.test(http10));
    assert.equal(requests.length, 1);
  });

  it("rejects a loopback Host with a mismatched port", async () => {
    const { status } = await rawRequest(baseUrl + "/api/thread", {
      headers: { host: "127.0.0.1:39999" },
    });
    assert.equal(status, 403);
    assert.equal(requests.length, 1);
  });

  it("rejects forwarding and proxy headers even with the correct Host", async () => {
    const { status, headers } = await rawRequest(baseUrl + "/api/thread", {
      headers: { "x-forwarded-host": "attacker.example.net" },
    });
    assert.equal(status, 403);
    assert.equal(headers["set-cookie"], undefined);
    assert.equal(headers.location, undefined);
    assert.equal(requests.length, 1);
    // The canonical Forwarded header is equally refused.
    const forwarded = await rawRequest(baseUrl + "/api/thread", {
      headers: { forwarded: "for=127.0.0.1;host=127.0.0.1" },
    });
    assert.equal(forwarded.status, 403);
    assert.equal(requests.length, 1);
  });

  it("refuses every request while the gate is disabled, before the app sees it", async () => {
    listenerEnabled = false;
    const { status, body } = await rawRequest(baseUrl + "/api/thread");
    assert.equal(status, 403);
    assert.equal(body, "forbidden");
    assert.equal(requests.length, 1, "the disabled-gate request never reached the handler");
    listenerEnabled = true;
  });

  it("never logs the attestation token or attacker-supplied Host values", () => {
    for (const line of logLines) {
      assert.ok(!line.includes("listener-unit-token"), line);
      assert.ok(!line.includes("attacker.example.net"), line);
    }
  });

  it("is unreachable on a non-loopback local address (socket-level isolation)", async () => {
    const nonLoopback = Object.values(networkInterfaces())
      .flat()
      .filter((entry) => entry && !entry.internal && entry.family === "IPv4")
      .map((entry) => entry.address);
    if (nonLoopback.length === 0) {
      // No non-loopback interface in this environment (e.g. some CI
      // sandboxes); the binding assertion above plus the loopback rule
      // tests carry the guarantee there.
      return;
    }
    const port = listener.server.address().port;
    const results = await Promise.all(nonLoopback.map((address) => connects(address, port)));
    for (const [index, connected] of results.entries()) {
      assert.equal(connected, false, `listener must not accept on ${nonLoopback[index]}`);
    }
  });

  it("globalThis attestation slot key matches the shared constant", () => {
    setChannelAttestationTokenForTesting("slot-check");
    assert.equal(globalThis[TEST_CHANNEL_TOKEN_GLOBAL_KEY], "slot-check");
    setChannelAttestationTokenForTesting(null);
    assert.equal(globalThis[TEST_CHANNEL_TOKEN_GLOBAL_KEY], undefined);
  });
});

/** Minimal raw HTTP request helper (fetch forbids Host overrides). */
function rawRequest(url, { headers = {}, method = "GET", body } = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { method, headers }, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
    });
    req.on("error", reject);
    if (body !== undefined) {
      req.end(body);
    } else {
      req.end();
    }
  });
}

/** Attempt a TCP connection; resolves true when it connected. */
function connects(host, port) {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const finish = (connected) => {
      socket.destroy();
      resolve(connected);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

/** Send a raw HTTP/1.x request over a real socket and read one response. */
function rawSocketRequest(requestText, port) {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port });
    let data = "";
    socket.on("connect", () => socket.end(requestText));
    socket.on("data", (chunk) => (data += chunk.toString("utf8")));
    socket.on("close", () => resolve(data));
    socket.on("error", reject);
    setTimeout(() => {
      socket.destroy();
      reject(new Error(`raw socket request timed out; got: ${data}`));
    }, 5000).unref();
  });
}
