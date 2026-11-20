import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  NAMESPACE,
  STEPS,
  E2E_LOCAL_FILE_REL,
  EMBEDDING_STEP_IDS,
  assertBaselineCurrent,
  buildChildEnv,
  captureVerifiedBaseline,
  checkLivePod,
  digestFromImageId,
  loadEmbeddingBaseUrl,
  registryManifestUrl,
  resolveExpectedDigests,
  resolveRegistryDigest,
  validateEmbeddingOrigin,
  validateShipEnv,
  validateVerifiedBaseline,
} from "../../scripts/test-e2e.mjs";

const SHA = "a".repeat(40);
const SHA_B = "b".repeat(40);
const WEB_DIGEST = `sha256:${"a".repeat(64)}`;
const WORKER_DIGEST = `sha256:${"b".repeat(64)}`;
const WRONG_DIGEST = `sha256:${"d".repeat(64)}`;
const WEB_POD_UID = "77777777-7777-7777-7777-777777777777";
const WORKER_POD_UID = "88888888-8888-8888-8888-888888888888";
const REPLACEMENT_POD_UID = "99999999-9999-9999-9999-999999999999";
const WEB_REPO = "localhost:5104/companion/web";
const WORKER_REPO = "localhost:5104/companion/worker";
const PINS = {
  context: "default",
  kubeSystemUid: "11111111-1111-4111-8111-111111111111",
  namespaceUid: "22222222-2222-4222-8222-222222222222",
  registryRepositories: { web: WEB_REPO, worker: WORKER_REPO },
};

function makeDeploy(name, container, image) {
  return {
    metadata: { name, namespace: "companion-np", uid: "33333333-3333-3333-3333-333333333333" },
    spec: {
      replicas: 1,
      template: { spec: { containers: [{ name: container, image }] } },
    },
    status: { observedGeneration: 2, updatedReplicas: 1, readyReplicas: 1, availableReplicas: 1 },
  };
}

function makePod(name, uid, workload, image, imageID, ready = true) {
  return {
    metadata: {
      name,
      uid,
      labels: {
        "app.kubernetes.io/name": workload,
        "app.kubernetes.io/instance": "companion",
      },
    },
    spec: { containers: [{ name: workload, image }] },
    status: { phase: "Running", containerStatuses: [{ name: workload, ready, imageID }] },
  };
}

function goodLiveState() {
  return {
    pods: [
      makePod("companion-web-test-0", WEB_POD_UID, "web", `${WEB_REPO}@${WEB_DIGEST}`, `${WEB_REPO}@${WEB_DIGEST}`),
      makePod("companion-worker-test-0", WORKER_POD_UID, "worker", `${WORKER_REPO}@${WORKER_DIGEST}`, `${WORKER_REPO}@${WORKER_DIGEST}`),
    ],
    webDeploy: makeDeploy("companion-web", "web", `${WEB_REPO}@${WEB_DIGEST}`),
    workerDeploy: makeDeploy("companion-worker", "worker", `${WORKER_REPO}@${WORKER_DIGEST}`),
  };
}

function fakeFetchFor(map) {
  return async (url) => {
    const digest = map.get(String(url));
    if (digest === undefined) {
      return { ok: false, status: 404, headers: { get: () => null }, text: async () => "" };
    }
    return {
      ok: true,
      status: 200,
      headers: { get: (key) => (String(key).toLowerCase() === "docker-content-digest" ? digest : null) },
      text: async () => "{}",
    };
  };
}

test("validateShipEnv requires matching 40-hex SHIP variables with no exclusive-window or lock requirement", () => {
  assert.equal(validateShipEnv({ SHIP_TARGET_SHA: SHA, SHIP_DEPLOYED_SHA: SHA }).sha, SHA);
  // A reservation attestation is neither required nor consulted: any or
  // no value is ignored, and a missing value never blocks.
  assert.equal(validateShipEnv({ SHIP_TARGET_SHA: SHA, SHIP_DEPLOYED_SHA: SHA, SHIP_DEPLOY_EXCLUSIVE_WINDOW: "1" }).sha, SHA);
  assert.equal(validateShipEnv({ SHIP_TARGET_SHA: SHA, SHIP_DEPLOYED_SHA: SHA, SHIP_DEPLOY_EXCLUSIVE_WINDOW: "" }).sha, SHA);
  assert.throws(() => validateShipEnv({ SHIP_TARGET_SHA: SHA_B, SHIP_DEPLOYED_SHA: SHA }), /does not equal/);
  assert.throws(() => validateShipEnv({ SHIP_TARGET_SHA: "abc", SHIP_DEPLOYED_SHA: "abc" }), /40-hex/);
  assert.throws(() => validateShipEnv({}), /40-hex/);
  assert.throws(() => validateShipEnv({ SHIP_TARGET_SHA: SHA.toUpperCase(), SHIP_DEPLOYED_SHA: SHA.toUpperCase() }), /40-hex/);
  // Wrong SHA relationship is blocked even when the exclusive window is set.
  assert.throws(() => validateShipEnv({ SHIP_TARGET_SHA: SHA_B, SHIP_DEPLOYED_SHA: SHA, SHIP_DEPLOY_EXCLUSIVE_WINDOW: "1" }), /does not equal/);
});

test("test-e2e runner source consults no Ship lock and requires no reservation gate", () => {
  const hereDir = path.dirname(new URL(import.meta.url).pathname);
  const runnerSource = fs.readFileSync(path.join(path.resolve(hereDir, "..", ".."), "scripts", "test-e2e.mjs"), "utf8");
  assert.ok(!runnerSource.includes("ship-deploy.lock"), "runner must not reference a Ship lock path");
  assert.ok(!runnerSource.includes("SHIP_DEPLOY_EXCLUSIVE_WINDOW"), "runner must not reference a reservation gate");
  assert.ok(!runnerSource.includes("validateLockOwner"), "runner must not consult lock owner records");
  assert.ok(!runnerSource.includes("owner.json"), "runner must not read a lock owner file");
});

test("validateVerifiedBaseline requires in-memory digests, pod names, and UIDs", () => {
  const baseline = {
    webDigest: WEB_DIGEST,
    workerDigest: WORKER_DIGEST,
    webPod: "companion-web-test-0",
    workerPod: "companion-worker-test-0",
    webPodUid: WEB_POD_UID,
    workerPodUid: WORKER_POD_UID,
  };
  assert.equal(validateVerifiedBaseline(baseline), baseline);
  assert.throws(() => validateVerifiedBaseline({ ...baseline, webDigest: "sha256:xyz" }), /digests/);
  assert.throws(() => validateVerifiedBaseline({ ...baseline, webPod: "" }), /pod names/);
  assert.throws(() => validateVerifiedBaseline(null), /not an object/);
  // Pod UIDs are bound in the baseline: without them a same-name
  // replacement pod with a new UID would otherwise be accepted.
  const { webPodUid: _webUid, ...withoutWebUid } = baseline;
  assert.throws(() => validateVerifiedBaseline(withoutWebUid), /pod UIDs/);
  const { workerPodUid: _workerUid, ...withoutWorkerUid } = baseline;
  assert.throws(() => validateVerifiedBaseline(withoutWorkerUid), /pod UIDs/);
  assert.throws(() => validateVerifiedBaseline({ ...baseline, webPodUid: "not-a-uid" }), /pod UIDs/);
  assert.throws(() => validateVerifiedBaseline({ ...baseline, workerPodUid: REPLACEMENT_POD_UID.slice(0, 8) }), /pod UIDs/);
  // A well-formed but different UID is a valid baseline shape; the live
  // recheck (assertBaselineCurrent via checkLivePod) is what rejects the
  // replacement pod's UID.
  assert.equal(validateVerifiedBaseline({ ...baseline, webPodUid: REPLACEMENT_POD_UID }).webPodUid, REPLACEMENT_POD_UID);
});

test("checkLivePod rejects a same-name replacement pod with a new UID", () => {
  const goodPod = {
    metadata: { name: "companion-web-test-0", uid: WEB_POD_UID },
    spec: { containers: [{ name: "web", image: `${WEB_REPO}@${WEB_DIGEST}` }] },
    status: { phase: "Running", containerStatuses: [{ name: "web", ready: true, imageID: `${WEB_REPO}@${WEB_DIGEST}` }] },
  };
  const expectedImage = `${WEB_REPO}@${WEB_DIGEST}`;
  assert.equal(checkLivePod(goodPod, "web", WEB_DIGEST, "companion-web-test-0", WEB_POD_UID, expectedImage), goodPod);
  assert.throws(
    () => checkLivePod({ ...goodPod, metadata: { name: "companion-web-test-0", uid: REPLACEMENT_POD_UID } }, "web", WEB_DIGEST, "companion-web-test-0", WEB_POD_UID, expectedImage),
    /UID does not match/,
  );
  assert.throws(
    () => checkLivePod({ ...goodPod, metadata: { name: "companion-web-test-0", uid: REPLACEMENT_POD_UID } }, "web", WEB_DIGEST, "companion-web-test-0", WEB_POD_UID, expectedImage),
    (error) => !error.message.includes(REPLACEMENT_POD_UID) && !error.message.includes(WEB_POD_UID),
  );
  assert.throws(
    () => checkLivePod({ ...goodPod, metadata: { name: "companion-web-test-0", uid: WEB_POD_UID, deletionTimestamp: "2026-11-19T12:00:00Z" } }, "web", WEB_DIGEST, "companion-web-test-0", WEB_POD_UID, expectedImage),
    /terminating/,
  );
  // Wrong digest and wrong spec image are blocked even for the same pod.
  assert.throws(() => checkLivePod(goodPod, "web", WRONG_DIGEST, "companion-web-test-0", WEB_POD_UID, `${WEB_REPO}@${WRONG_DIGEST}`), /digest does not match/);
});

test("registryManifestUrl pins loopback to http and other hosts to https", () => {
  assert.equal(registryManifestUrl(WEB_REPO, SHA), `http://localhost:5104/v2/companion/web/manifests/${SHA}`);
  assert.equal(registryManifestUrl("registry.example.com/companion/web", SHA), `https://registry.example.com/v2/companion/web/manifests/${SHA}`);
  assert.equal(registryManifestUrl("127.0.0.1:5104/companion/worker", SHA), `http://127.0.0.1:5104/v2/companion/worker/manifests/${SHA}`);
  assert.throws(() => registryManifestUrl("", SHA), /registry repository/);
  assert.throws(() => registryManifestUrl(WEB_REPO, "abc"), /40-hex/);
  assert.throws(() => registryManifestUrl(`${WEB_REPO}@${WEB_DIGEST}`, SHA), /registry repository/);
  assert.throws(() => registryManifestUrl("https://registry.example.com/companion/web", SHA), /registry repository/);
});

test("resolveRegistryDigest returns the registry digest and fails closed without a live-pod fallback", async () => {
  const url = registryManifestUrl(WEB_REPO, SHA);
  const okFetch = fakeFetchFor(new Map([[url, WEB_DIGEST]]));
  assert.equal(await resolveRegistryDigest(WEB_REPO, SHA, { fetchImpl: okFetch }), WEB_DIGEST);
  // Missing tag, malformed digest, and transport failure all fail closed;
  // the expected digest is never taken from a live pod.
  await assert.rejects(() => resolveRegistryDigest(WEB_REPO, SHA, { fetchImpl: fakeFetchFor(new Map()) }), /refusing to infer/);
  await assert.rejects(() => resolveRegistryDigest(WEB_REPO, SHA, { fetchImpl: fakeFetchFor(new Map([[url, "not-a-digest"]])) }), /refusing to infer/);
  await assert.rejects(
    () => resolveRegistryDigest(WEB_REPO, SHA, { fetchImpl: async () => { throw new Error("network down"); } }),
    /refusing to infer/,
  );
  // A wrong SHA resolves a different tag: the caller must not accept a
  // digest that does not match the live spec/runtime (covered by the
  // baseline tests below), never an inferred live value.
  await assert.rejects(() => resolveRegistryDigest(WEB_REPO, "not-a-sha", { fetchImpl: okFetch }), /40-hex/);
});

test("resolveExpectedDigests resolves both fixed-registry tags and blocks wrong SHA", async () => {
  const webUrl = registryManifestUrl(WEB_REPO, SHA);
  const workerUrl = registryManifestUrl(WORKER_REPO, SHA);
  const fetchImpl = fakeFetchFor(
    new Map([
      [webUrl, WEB_DIGEST],
      [workerUrl, WORKER_DIGEST],
    ]),
  );
  assert.deepEqual(await resolveExpectedDigests(PINS, SHA, { fetchImpl }), { webDigest: WEB_DIGEST, workerDigest: WORKER_DIGEST });
  // Only the requested SHA's tags are queried: a different SHA has no
  // registry entry here, so resolution fails instead of blessing the
  // live deployment's digests.
  await assert.rejects(() => resolveExpectedDigests(PINS, SHA_B, { fetchImpl }), /refusing to infer/);
  await assert.rejects(() => resolveExpectedDigests({ registryRepositories: { web: WEB_REPO } }, SHA, { fetchImpl }), /refusing to infer/);
});

test("captureVerifiedBaseline proves Deployment specs and pod runtimes against registry digests", () => {
  const baseline = captureVerifiedBaseline(goodLiveState(), PINS, { webDigest: WEB_DIGEST, workerDigest: WORKER_DIGEST });
  assert.deepEqual(baseline, {
    webDigest: WEB_DIGEST,
    workerDigest: WORKER_DIGEST,
    webPod: "companion-web-test-0",
    workerPod: "companion-worker-test-0",
    webPodUid: WEB_POD_UID,
    workerPodUid: WORKER_POD_UID,
  });
  // Wrong registry digest blocked: spec and runtime still carry the old digests.
  assert.throws(() => captureVerifiedBaseline(goodLiveState(), PINS, { webDigest: WRONG_DIGEST, workerDigest: WORKER_DIGEST }), /does not match/);
  // Wrong Deployment spec blocked even when the pod runtime matches.
  const specDrift = goodLiveState();
  specDrift.webDeploy = makeDeploy("companion-web", "web", `${WEB_REPO}@${WRONG_DIGEST}`);
  assert.throws(() => captureVerifiedBaseline(specDrift, PINS, { webDigest: WEB_DIGEST, workerDigest: WORKER_DIGEST }), /spec image does not match/);
  // Wrong pod runtime digest blocked; the digest is never inferred from the live pod.
  const runtimeDrift = goodLiveState();
  runtimeDrift.pods[0] = makePod("companion-web-test-0", WEB_POD_UID, "web", `${WEB_REPO}@${WEB_DIGEST}`, `${WEB_REPO}@${WRONG_DIGEST}`);
  assert.throws(() => captureVerifiedBaseline(runtimeDrift, PINS, { webDigest: WEB_DIGEST, workerDigest: WORKER_DIGEST }), /digest does not match/);
  // Duplicate workload pods are blocked (exactly one required).
  const dup = goodLiveState();
  dup.pods.push(makePod("companion-web-other-0", REPLACEMENT_POD_UID, "web", `${WEB_REPO}@${WEB_DIGEST}`, `${WEB_REPO}@${WEB_DIGEST}`));
  assert.throws(() => captureVerifiedBaseline(dup, PINS, { webDigest: WEB_DIGEST, workerDigest: WORKER_DIGEST }), /exactly one web pod/);
});

test("assertBaselineCurrent rechecks the same pods and blocks replacement, drift, and wrong SHA", () => {
  const baseline = captureVerifiedBaseline(goodLiveState(), PINS, { webDigest: WEB_DIGEST, workerDigest: WORKER_DIGEST });
  assert.equal(assertBaselineCurrent(baseline, goodLiveState(), PINS), baseline);
  // Same-name replacement pod with a new UID is blocked on recheck.
  const replaced = goodLiveState();
  replaced.pods[0] = makePod("companion-web-test-0", REPLACEMENT_POD_UID, "web", `${WEB_REPO}@${WEB_DIGEST}`, `${WEB_REPO}@${WEB_DIGEST}`);
  assert.throws(() => assertBaselineCurrent(baseline, replaced, PINS), /UID does not match/);
  // Different pod name is blocked.
  const renamed = goodLiveState();
  renamed.pods[0] = makePod("companion-web-new-0", WEB_POD_UID, "web", `${WEB_REPO}@${WEB_DIGEST}`, `${WEB_REPO}@${WEB_DIGEST}`);
  assert.throws(() => assertBaselineCurrent(baseline, renamed, PINS), /not the pod verified/);
  // Spec or runtime digest drift after capture is blocked (wrong SHA/digest).
  const specDrift = goodLiveState();
  specDrift.workerDeploy = makeDeploy("companion-worker", "worker", `${WORKER_REPO}@${WRONG_DIGEST}`);
  assert.throws(() => assertBaselineCurrent(baseline, specDrift, PINS), /spec image does not match/);
  const runtimeDrift = goodLiveState();
  runtimeDrift.pods[1] = makePod("companion-worker-test-0", WORKER_POD_UID, "worker", `${WORKER_REPO}@${WORKER_DIGEST}`, `${WORKER_REPO}@${WRONG_DIGEST}`);
  assert.throws(() => assertBaselineCurrent(baseline, runtimeDrift, PINS), /digest does not match/);
  // A baseline for a different candidate (wrong SHA's digests) never
  // matches the live deployment for this SHA.
  assert.throws(
    () => assertBaselineCurrent({ ...baseline, webDigest: WRONG_DIGEST }, goodLiveState(), PINS),
    /spec image does not match/,
  );
});

test("digestFromImageId extracts only a full sha256 digest", () => {
  assert.equal(digestFromImageId(`${WEB_REPO}@${WEB_DIGEST}`), WEB_DIGEST);
  assert.equal(digestFromImageId(`docker-pullable://${WEB_REPO}@${WEB_DIGEST}`), WEB_DIGEST);
  assert.equal(digestFromImageId(`${WEB_REPO}:latest`), null);
  assert.equal(digestFromImageId(""), null);
  assert.equal(digestFromImageId("repo@sha256:xyz"), null);
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

function writeFixtureValuesRoot(dir, e2eValue) {
  const localFile = path.join(dir, E2E_LOCAL_FILE_REL);
  fs.mkdirSync(path.dirname(localFile), { recursive: true });
  const body = e2eValue === undefined
    ? "{}\n"
    : `${JSON.stringify({ localEmbeddingBaseUrl: e2eValue }, null, 2)}\n`;
  fs.writeFileSync(localFile, body);
  return localFile;
}

test("validateEmbeddingOrigin requires an HTTP(S) origin and never echoes the value", () => {
  assert.equal(validateEmbeddingOrigin("https://embedding.example.test/"), "https://embedding.example.test");
  assert.equal(validateEmbeddingOrigin("http://embedding.example.test"), "http://embedding.example.test");
  for (const invalid of [
    "https://user:password@embedding.example.test/",
    "https://embedding.example.test/path",
    "https://embedding.example.test/?token=synthetic",
    "https://embedding.example.test/#frag",
    "ftp://embedding.example.test",
    "not-a-url",
    "",
  ]) {
    assert.throws(() => validateEmbeddingOrigin(invalid), /WORKER_MEMORY_EMBEDDING_BASE_URL/);
  }
  assert.throws(() => validateEmbeddingOrigin("https://user:password@embedding.example.test/"), (error) => !error.message.includes("password"));
});

test("loadEmbeddingBaseUrl prefers explicit env and falls back to localEmbeddingBaseUrl", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ship-runner-embedding-"));
  try {
    writeFixtureValuesRoot(dir, "https://file.example.test/");
    assert.equal(loadEmbeddingBaseUrl(dir, {}), "https://file.example.test");
    assert.equal(loadEmbeddingBaseUrl(dir, { WORKER_MEMORY_EMBEDDING_BASE_URL: "" }), "https://file.example.test");
    assert.equal(
      loadEmbeddingBaseUrl(dir, { WORKER_MEMORY_EMBEDDING_BASE_URL: "https://env.example.test/" }),
      "https://env.example.test",
    );
    assert.throws(
      () => loadEmbeddingBaseUrl(dir, { WORKER_MEMORY_EMBEDDING_BASE_URL: "https://user:password@env.example.test/" }),
      (error) => /origin without credentials/.test(error.message) && !error.message.includes("password"),
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("loadEmbeddingBaseUrl fails closed without guessing when neither source provides a value", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ship-runner-embedding-"));
  try {
    assert.throws(() => loadEmbeddingBaseUrl(dir, {}), /E2E config is missing/);
    writeFixtureValuesRoot(dir, undefined);
    assert.throws(() => loadEmbeddingBaseUrl(dir, {}), /localEmbeddingBaseUrl is missing or invalid/);
    writeFixtureValuesRoot(dir, "https://user:password@file.example.test/path");
    assert.throws(
      () => loadEmbeddingBaseUrl(dir, {}),
      (error) => /localEmbeddingBaseUrl in the local E2E config is invalid/.test(error.message) && !error.message.includes("password"),
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("buildChildEnv injects the resolved embedding value only into steps that need it", () => {
  assert.deepEqual(EMBEDDING_STEP_IDS, ["playwright", "stack-ops", "embedding-integration"]);
  const runsBase = fs.mkdtempSync(path.join(os.tmpdir(), "ship-runner-childenv-"));
  try {
    const baseline = {
      webDigest: WEB_DIGEST,
      workerDigest: WORKER_DIGEST,
      webPod: "companion-web-test-0",
      workerPod: "companion-worker-test-0",
      webPodUid: WEB_POD_UID,
      workerPodUid: WORKER_POD_UID,
    };
    const embedding = "https://embedding.example.test";
    for (const step of STEPS) {
      const childEnv = buildChildEnv(step, { WORKER_TEST_DATABASE_URL: "postgres://synthetic" }, {
        runsBase,
        gatePort: 3100,
        baseline,
        pins: PINS,
        embeddingBaseUrl: embedding,
      });
      assert.equal(childEnv.WORKER_TEST_DATABASE_URL, undefined, `${step.id} must strip WORKER_TEST_DATABASE_URL`);
      if (EMBEDDING_STEP_IDS.includes(step.id)) {
        assert.equal(childEnv.WORKER_MEMORY_EMBEDDING_BASE_URL, embedding, `${step.id} must inherit approved value`);
      } else if (step.id !== "deployed-smoke") {
        assert.equal(childEnv.WORKER_MEMORY_EMBEDDING_BASE_URL, undefined, `${step.id} must not receive file value`);
      }
    }
    // Deployed-smoke pinning still applies alongside the embedding injection.
    const smokeStep = STEPS.find((step) => step.id === "deployed-smoke");
    const smokeEnv = buildChildEnv(smokeStep, {}, { runsBase, gatePort: 3100, baseline, pins: PINS, embeddingBaseUrl: embedding });
    assert.equal(smokeEnv.E2E_DEPLOYED_SMOKE_ALLOWED, "1");
    assert.equal(smokeEnv.E2E_DEPLOYED_NAMESPACE, NAMESPACE);
  } finally {
    fs.rmSync(runsBase, { recursive: true, force: true });
  }
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
