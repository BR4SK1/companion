// Real-entrypoint tests for the test-entry gate's deployment-purpose
// attestation: the actual container command (`node server.mjs`) is spawned
// as a subprocess and must refuse to start — before any listener or Next.js
// work — for production, unknown, missing, or namespace-mismatched
// attestations, and must accept a valid non-production or explicit local
// attestation (proven by reaching the next startup step, a deliberately
// invalid main port, without any gate error). Hermetic: every case exits
// before binding anything.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const serverPath = path.join(repoRoot, "apps/web/server.mjs");
const serverCwd = path.join(repoRoot, "apps/web");

const GATE_ON = {
  WEB_TEST_GATE_ENABLED: "true",
  WEB_TEST_GATE_PORT: "3100",
  WEB_TEST_GATE_SESSION_SECRET: "test-gate-secret-0123456789abcdef",
};

const NON_PRODUCTION_ATTESTATION = {
  COMPANION_DEPLOYMENT_PURPOSE: "non-production",
  COMPANION_DEPLOYMENT_NAMESPACE: "companion-np",
  COMPANION_POD_NAMESPACE: "companion-np",
};

/**
 * Spawn the real server entry with a minimal environment. `portInvalid`
 * sets PORT=0 so a run that survives the gate configuration exits at the
 * next startup check ("invalid main listener port") — proving the
 * attestation was accepted without needing a Next.js build or any listener.
 */
function runServer(env, { portInvalid = false } = {}) {
  const childEnv = {
    ...env,
    ...(portInvalid ? { PORT: "0" } : {}),
  };
  const result = spawnSync(process.execPath, [serverPath], {
    cwd: serverCwd,
    env: childEnv,
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.ok(!result.error, String(result.error));
  return result;
}

function assertRefused(result, messageFragment) {
  assert.equal(result.status, 1, `expected exit 1, stdout: ${result.stdout}`);
  const output = `${result.stderr}`;
  assert.ok(output.includes("test gate configuration error"), output);
  assert.ok(output.includes(messageFragment), output);
}

function assertGateAccepted(result) {
  assert.equal(result.status, 1, `expected exit 1 at the port check, stdout: ${result.stdout}`);
  assert.ok(result.stderr.includes("invalid main listener port"), result.stderr);
  assert.ok(!result.stderr.includes("test gate configuration error"), result.stderr);
}

describe("server.mjs entrypoint: deployment-purpose attestation", () => {
  it("refuses to start for a production deployment purpose", () => {
    const result = runServer({
      ...GATE_ON,
      ...NON_PRODUCTION_ATTESTATION,
      COMPANION_DEPLOYMENT_PURPOSE: "production",
    });
    assertRefused(result, "must never run in a production deployment");
  });

  it("refuses to start without any deployment-purpose attestation", () => {
    const result = runServer({ ...GATE_ON });
    assertRefused(result, "requires a deployment-purpose attestation");
  });

  it("refuses to start for an unknown purpose value", () => {
    const result = runServer({
      ...GATE_ON,
      ...NON_PRODUCTION_ATTESTATION,
      COMPANION_DEPLOYMENT_PURPOSE: "canary",
    });
    assertRefused(result, "must be exactly");
  });

  it("refuses to start when the declared namespace does not match the pod namespace", () => {
    const result = runServer({
      ...GATE_ON,
      ...NON_PRODUCTION_ATTESTATION,
      COMPANION_DEPLOYMENT_NAMESPACE: "other-ns",
    });
    assertRefused(result, "does not match the pod's actual namespace");
  });

  it("refuses to start when the pod-namespace injection is missing", () => {
    const { COMPANION_POD_NAMESPACE, ...withoutPodNamespace } = NON_PRODUCTION_ATTESTATION;
    const result = runServer({ ...GATE_ON, ...withoutPodNamespace });
    assertRefused(result, "must be present");
  });

  it("refuses to start for a non-production purpose in an unauthorized namespace", () => {
    // Purpose plus downward-API agreement alone would let any namespace
    // self-declare itself non-production; only the pinned namespace
    // (companion-np, the fixture above) is authorized.
    const result = runServer({
      ...GATE_ON,
      COMPANION_DEPLOYMENT_PURPOSE: "non-production",
      COMPANION_DEPLOYMENT_NAMESPACE: "companion-dev",
      COMPANION_POD_NAMESPACE: "companion-dev",
    });
    assertRefused(result, "is not the authorized non-production namespace");
  });

  it("refuses to start when a local declaration is attempted inside Kubernetes", () => {
    // The kubelet sets these in every pod; a pod cannot pass itself off as
    // a run outside Kubernetes.
    for (const indicator of ["KUBERNETES_SERVICE_HOST", "KUBERNET_SERVICE_PORT"]) {
      const result = runServer({
        ...GATE_ON,
        WEB_TEST_GATE_TRUSTED_LOCAL: "true",
        [indicator]: "10.43.0.1",
      });
      assertRefused(result, "may not attest a local run inside Kubernetes");
    }
  });

  it("refuses to start when namespace attestation is smuggled in without a purpose", () => {
    const result = runServer({
      ...GATE_ON,
      COMPANION_DEPLOYMENT_NAMESPACE: "companion-np",
      COMPANION_POD_NAMESPACE: "companion-np",
    });
    assertRefused(result, "requires COMPANION_DEPLOYMENT_PURPOSE");
  });

  it("refuses to start when a local declaration is smuggled into a rendered deployment", () => {
    const result = runServer({
      ...GATE_ON,
      ...NON_PRODUCTION_ATTESTATION,
      WEB_TEST_GATE_TRUSTED_LOCAL: "true",
      COMPANION_DEPLOYMENT_PURPOSE: undefined,
    });
    assertRefused(result, "requires COMPANION_DEPLOYMENT_PURPOSE");
  });

  it("accepts a valid non-production attestation and proceeds past the gate check", () => {
    const result = runServer({ ...GATE_ON, ...NON_PRODUCTION_ATTESTATION }, { portInvalid: true });
    assertGateAccepted(result);
  });

  it("accepts an explicit local attestation outside Kubernetes and proceeds past the gate check", () => {
    const result = runServer(
      {
        ...GATE_ON,
        WEB_TEST_GATE_TRUSTED_LOCAL: "true",
      },
      { portInvalid: true },
    );
    assertGateAccepted(result);
  });

  it("never starts any listener while refusing a misattested gate", () => {
    const result = runServer({
      ...GATE_ON,
      ...NON_PRODUCTION_ATTESTATION,
      COMPANION_DEPLOYMENT_PURPOSE: "production",
    });
    assert.ok(!result.stdout.includes("listening"), result.stdout);
    assert.ok(!result.stdout.includes("test entry"), result.stdout);
  });
});
