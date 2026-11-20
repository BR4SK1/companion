import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  STEPS,
  digestFromImageId,
  isPidLive,
  pidStarttime,
  validateLockOwner,
  validateShipEnv,
} from "../../scripts/test-e2e.mjs";

const SHA = "a".repeat(40);
const SHA_B = "b".repeat(40);
const WEB_DIGEST = `sha256:${"a".repeat(64)}`;
const WORKER_DIGEST = `sha256:${"b".repeat(64)}`;

test("validateShipEnv requires matching 40-hex SHIP variables and the exclusive window", () => {
  assert.equal(validateShipEnv({ SHIP_TARGET_SHA: SHA, SHIP_DEPLOYED_SHA: SHA, SHIP_DEPLOY_EXCLUSIVE_WINDOW: "1" }).sha, SHA);
  assert.throws(() => validateShipEnv({ SHIP_TARGET_SHA: SHA, SHIP_DEPLOYED_SHA: SHA }), /exclusive window/);
  assert.throws(() => validateShipEnv({ SHIP_TARGET_SHA: SHA_B, SHIP_DEPLOYED_SHA: SHA, SHIP_DEPLOY_EXCLUSIVE_WINDOW: "1" }), /does not equal/);
  assert.throws(() => validateShipEnv({ SHIP_TARGET_SHA: "abc", SHIP_DEPLOYED_SHA: "abc", SHIP_DEPLOY_EXCLUSIVE_WINDOW: "1" }), /40-hex/);
  assert.throws(() => validateShipEnv({ SHIP_DEPLOY_EXCLUSIVE_WINDOW: "1" }), /40-hex/);
  assert.throws(() => validateShipEnv({ SHIP_TARGET_SHA: SHA.toUpperCase(), SHIP_DEPLOYED_SHA: SHA.toUpperCase(), SHIP_DEPLOY_EXCLUSIVE_WINDOW: "1" }), /40-hex/);
});

test("validateLockOwner requires the deployed handoff for the predetermined target", () => {
  const owner = {
    sha: SHA,
    phase: "deployed",
    namespace: "companion-np",
    release: "companion",
    webDigest: WEB_DIGEST,
    workerDigest: WORKER_DIGEST,
    webPod: "companion-web-test-0",
    workerPod: "companion-worker-test-0",
  };
  assert.equal(validateLockOwner(owner), owner);
  assert.throws(() => validateLockOwner({ ...owner, phase: "deploying" }), /phase/);
  assert.throws(() => validateLockOwner({ ...owner, namespace: "prod" }), /namespace/);
  assert.throws(() => validateLockOwner({ ...owner, webDigest: "sha256:xyz" }), /digests/);
  assert.throws(() => validateLockOwner({ ...owner, webPod: "" }), /pod/);
  assert.throws(() => validateLockOwner(null), /not an object/);
});

test("digestFromImageId extracts only a full sha256 digest", () => {
  assert.equal(digestFromImageId(`localhost:5104/companion/web@${WEB_DIGEST}`), WEB_DIGEST);
  assert.equal(digestFromImageId(`docker-pullable://localhost:5104/companion/web@${WEB_DIGEST}`), WEB_DIGEST);
  assert.equal(digestFromImageId("localhost:5104/companion/web:latest"), null);
  assert.equal(digestFromImageId(""), null);
  assert.equal(digestFromImageId("repo@sha256:xyz"), null);
});

test("pid identity helpers recognise the current process and reject dead pids", () => {
  const start = pidStarttime(process.pid);
  assert.notEqual(start, "gone");
  assert.equal(isPidLive(process.pid, start), true);
  assert.equal(isPidLive(process.pid, "1"), false);
  assert.equal(isPidLive(999999999, "1"), false);
  assert.equal(isPidLive(0, start), false);
});

test("STEPS inventory is complete, ordered, and contains no filtering or skip arguments", () => {
  const ids = STEPS.map((step) => step.id);
  assert.deepEqual(ids, [
    "format-check",
    "lint",
    "unit",
    "typecheck",
    "web-typecheck",
    "render-checks",
    "playwright",
    "stack-ops",
    "smoke-regression",
    "embedding-integration",
    "deployed-smoke",
  ]);
  const forbidden = ["--grep", "-g", "--testNamePattern", "--skip", "--retries"];
  for (const step of STEPS) {
    const joined = (step.args ?? []).join(" ");
    for (const token of forbidden) {
      assert.ok(!joined.includes(token), `step ${step.id} must not contain filtering token ${token}`);
    }
    assert.ok(step.label && step.label.length > 0, `step ${step.id} needs a label`);
    assert.ok(["pnpm", "chart", "nodeTest"].includes(step.kind), `step ${step.id} kind`);
  }
  // The deployed smoke is the final inventory step: local disposable suites
  // cannot substitute for it, and it runs only after every local suite.
  assert.equal(ids.at(-1), "deployed-smoke");
  const playwright = STEPS.find((step) => step.id === "playwright");
  assert.deepEqual(playwright.args, ["--filter", "@companion/e2e", "test"]);
  const smoke = STEPS.find((step) => step.id === "deployed-smoke");
  assert.deepEqual(smoke.args, ["--filter", "@companion/e2e", "test:deployed-smoke"]);
  assert.equal(smoke.envMode, "deployedSmoke");
});

test("loadIdentityPins is covered via the runner module surface (pins live only in the local file)", async () => {
  // The pins themselves are provisioned in the operator's local-only file
  // and must never appear in tracked fixtures; this test only asserts the
  // loader is exported and rejects a missing file shape through the module.
  const { loadIdentityPins } = await import("../../scripts/test-e2e.mjs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ship-runner-pin-test-"));
  try {
    assert.throws(() => loadIdentityPins(dir), /identity file is missing/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
