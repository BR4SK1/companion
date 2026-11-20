import assert from "node:assert/strict";
import test from "node:test";

import {
  deployedPinFromEnvironment,
  digestFromImageId,
  verifyDeployedPin,
} from "../../tests/e2e/deployed-smoke-lib.mjs";

const WEB_DIGEST = `sha256:${"a".repeat(64)}`;
const WORKER_DIGEST = `sha256:${"b".repeat(64)}`;
const WEB_POD_UID = "77777777-7777-7777-7777-777777777777";
const WORKER_POD_UID = "88888888-8888-8888-8888-888888888888";
const REPLACEMENT_POD_UID = "99999999-9999-9999-9999-999999999999";

const PIN_ENV = {
  E2E_DEPLOYED_EXPECT_WEB_POD: "companion-web-test-0",
  E2E_DEPLOYED_EXPECT_WORKER_POD: "companion-worker-test-0",
  E2E_DEPLOYED_EXPECT_WEB_POD_UID: WEB_POD_UID,
  E2E_DEPLOYED_EXPECT_WORKER_POD_UID: WORKER_POD_UID,
  E2E_DEPLOYED_EXPECT_WEB_IMAGE_ID: `localhost:5104/companion/web@${WEB_DIGEST}`,
  E2E_DEPLOYED_EXPECT_WORKER_IMAGE_ID: `docker-pullable://localhost:5104/companion/worker@${WORKER_DIGEST}`,
};

test("deployedPinFromEnvironment returns null standalone and requires all six values when pinning", () => {
  assert.equal(deployedPinFromEnvironment({}), null);
  const pin = deployedPinFromEnvironment(PIN_ENV);
  assert.equal(pin.webPod, "companion-web-test-0");
  assert.equal(pin.webPodUid, WEB_POD_UID);
  assert.equal(pin.workerPodUid, WORKER_POD_UID);
  assert.equal(pin.webDigest, WEB_DIGEST);
  assert.equal(pin.workerDigest, WORKER_DIGEST);
  assert.throws(() => deployedPinFromEnvironment({ E2E_DEPLOYED_EXPECT_WEB_POD: "x" }), /deployed_pin_configuration_invalid/);
  assert.throws(
    () => deployedPinFromEnvironment({ ...PIN_ENV, E2E_DEPLOYED_EXPECT_WEB_IMAGE_ID: "repo:latest" }),
    /deployed_pin_configuration_invalid/,
  );
  assert.throws(
    () => deployedPinFromEnvironment({ ...PIN_ENV, E2E_DEPLOYED_EXPECT_WORKER_POD: "has space" }),
    /deployed_pin_configuration_invalid/,
  );
  // Old four-value pins (names + digests only) and malformed UIDs fail closed:
  // without UIDs a same-name replacement pod would be accepted.
  const { E2E_DEPLOYED_EXPECT_WEB_POD_UID: _w, E2E_DEPLOYED_EXPECT_WORKER_POD_UID: _x, ...fourValuePin } = PIN_ENV;
  assert.throws(() => deployedPinFromEnvironment(fourValuePin), /deployed_pin_configuration_invalid/);
  assert.throws(
    () => deployedPinFromEnvironment({ ...PIN_ENV, E2E_DEPLOYED_EXPECT_WEB_POD_UID: "not-a-uid" }),
    /deployed_pin_configuration_invalid/,
  );
});

test("verifyDeployedPin proves exact pods, UIDs, and digests in the non-production namespace", () => {
  const pin = deployedPinFromEnvironment(PIN_ENV);
  const deployment = {
    webPod: "companion-web-test-0",
    workerPod: "companion-worker-test-0",
    webPodUid: WEB_POD_UID,
    workerPodUid: WORKER_POD_UID,
    webImageId: `localhost:5104/companion/web@${WEB_DIGEST}`,
    workerImageId: `localhost:5104/companion/worker@${WORKER_DIGEST}`,
  };
  assert.deepEqual(verifyDeployedPin(deployment, pin, "companion-np"), { passed: true, reason: "verified" });
  assert.equal(verifyDeployedPin(deployment, pin, "companion").passed, false);
  assert.equal(verifyDeployedPin({ ...deployment, webPod: "other" }, pin, "companion-np").reason, "web_pod_mismatch");
  assert.equal(verifyDeployedPin({ ...deployment, workerPod: "other" }, pin, "companion-np").reason, "worker_pod_mismatch");
  // Same-name replacement pod with a new UID must fail closed.
  assert.equal(verifyDeployedPin({ ...deployment, webPodUid: REPLACEMENT_POD_UID }, pin, "companion-np").reason, "web_pod_uid_mismatch");
  assert.equal(verifyDeployedPin({ ...deployment, workerPodUid: REPLACEMENT_POD_UID }, pin, "companion-np").reason, "worker_pod_uid_mismatch");
  assert.equal(verifyDeployedPin({ ...deployment, webPodUid: undefined }, pin, "companion-np").reason, "web_pod_uid_mismatch");
  assert.equal(
    verifyDeployedPin({ ...deployment, webImageId: `repo@sha256:${"c".repeat(64)}` }, pin, "companion-np").reason,
    "web_digest_mismatch",
  );
  assert.equal(
    verifyDeployedPin({ ...deployment, workerImageId: "repo:latest" }, pin, "companion-np").reason,
    "worker_digest_mismatch",
  );
  // Reasons are fixed codes: they must not echo pod names or image references.
  for (const result of [
    verifyDeployedPin({ ...deployment, webPod: "secret-pod-name" }, pin, "companion-np"),
    verifyDeployedPin(deployment, pin, "other-ns"),
  ]) {
    assert.ok(!result.reason.includes("secret-pod-name"));
    assert.ok(!result.reason.includes("localhost"));
  }
});

test("digestFromImageId in the smoke lib matches the runner digests", () => {
  assert.equal(digestFromImageId(`repo@${WEB_DIGEST}`), WEB_DIGEST);
  assert.equal(digestFromImageId("repo:latest"), null);
});
