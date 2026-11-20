#!/usr/bin/env node
/**
 * Companion full E2E owner runner (root `test:e2e`).
 *
 * This is the complete suite the fleet ship wrapper runs after
 * `scripts/ship-deploy` succeeds, with SHIP_TARGET_SHA and
 * SHIP_DEPLOYED_SHA set to the exact candidate SHA. It is deliberately
 * full-only: there is no local-only, filtered, or skip mode. Local-only
 * disposable validation remains available directly through the E2E package
 * (`pnpm --filter @companion/e2e test`), which does not prove deployed
 * exact-candidate validation and is never a substitute for this runner.
 *
 * Prerequisites (fail closed, never guessed or weakened):
 *   - Node.js exactly 22.23.4 (the E2E toolchain pin; select it before
 *     invoking the ship workflow, as documented in tests/e2e/README.md).
 *   - SHIP_TARGET_SHA == SHIP_DEPLOYED_SHA == the 40-hex candidate SHA,
 *     HEAD == that SHA, and a clean working tree (local suites build from
 *     the working tree, so it must be the candidate).
 *   - No Ship lock: this runner consults no lock file and requires no
 *     reservation gate. It has no replacement reservation or lock. The
 *     expected immutable full-SHA image tags are resolved independently
 *     here at the same fixed registry (from the trusted identity pins),
 *     verified against both deployed Deployment spec images and live pod
 *     runtime digests, and the exact verified pod names and UIDs are
 *     captured in memory at run start and rechecked through the run.
 *   - The trusted local identity pins and local-only values file used by
 *     ship-deploy, verified again here against the live cluster before any
 *     test runs. Identity values are never printed.
 *   - WORKER_MEMORY_EMBEDDING_BASE_URL resolved without inventing a default:
 *     an explicitly inherited value takes precedence when set; otherwise the
 *     dedicated local-only `.private/e2e-local.json` `localEmbeddingBaseUrl`
 *     (documented LAN / host variant, never the in-cluster DNS) supplies it.
 *     Both are validated as an HTTP(S) origin without credentials, path,
 *     query, or fragment, the value is never printed, and the runner fails
 *     clearly without it. The resolved value is injected only into steps
 *     that read the host-local setting (playwright, stack-ops,
 *     embedding-integration).
 *
 * Inventory (every step must exit 0; the first failure stops the run and is
 * never reported as a pass):
 *   Local candidate suites (no cluster):
 *     format-check, lint, unit, typecheck, web-typecheck, render-checks,
 *     playwright (6 specs, disposable stack), stack-ops, smoke-regression,
 *     embedding-integration (non-database check of the real embedding
 *     service; fails without its configured URL).
 *   Deployed suite (exact candidate in companion-np):
 *     deployed-smoke (guarded normal-use smoke through the loopback gate,
 *     pinned to the in-memory verified pods/digests, retaining its
 *     synthetic history).
 *   Explicitly not run (by repository safety rules, not by omission):
 *     the database-backed integration suites under tests/integration are
 *     destructive/disposable-only tools, not routine ship gates. They are
 *     not invoked here and WORKER_TEST_DATABASE_URL is stripped from child
 *     environments so no suite can accidentally target an application
 *     database. Their skip-without-a-disposable-target behaviour would be
 *     a no-op skip if invoked without disposable provisioning, which this
 *     full runner forbids. Focused disposable persistence coverage for a
 *     candidate change remains a separate manual step per AGENTS.md.
 *     The config-manager is local-only and not deployed; it is covered by
 *     the unit suite above.
 */

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const SHA_RE = /^[0-9a-f]{40}$/;
export const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
export const UID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const PINNED_NODE = "22.23.4";
export const NAMESPACE = "companion-np";
export const RELEASE = "companion";
export const IDENTITY_FILE_REL = ".private/deploy/ship-target-identity.json";
export const VALUES_FILE_REL = ".private/deploy/non-production-values.yaml";
export const E2E_LOCAL_FILE_REL = ".private/e2e-local.json";

/**
 * The complete, ordered inventory. Each step is executed in full with no
 * filtering arguments. `kind` selects how the runner builds the command;
 * `envMode` selects the extra environment for that step.
 */
export const STEPS = [
  { id: "format-check", label: "format check", kind: "pnpm", args: ["run", "format:check"] },
  { id: "lint", label: "web lint", kind: "pnpm", args: ["run", "lint"] },
  { id: "unit", label: "hermetic unit suite", kind: "pnpm", args: ["run", "test:unit"] },
  { id: "typecheck", label: "typecheck (libraries, worker, config-manager)", kind: "pnpm", args: ["run", "typecheck"] },
  { id: "web-typecheck", label: "web typecheck", kind: "pnpm", args: ["--filter", "@companion/web", "typecheck"] },
  { id: "render-checks", label: "Helm chart render checks", kind: "chart" },
  { id: "playwright", label: "local disposable Playwright suite (6 specs)", kind: "pnpm", args: ["--filter", "@companion/e2e", "test"], envMode: "runsDir" },
  { id: "stack-ops", label: "stack supervisor operations suite", kind: "pnpm", args: ["--filter", "@companion/e2e", "test:stack"], envMode: "runsDir" },
  { id: "smoke-regression", label: "deployed-smoke regression suite (disposable only)", kind: "pnpm", args: ["--filter", "@companion/e2e", "test:smoke"], envMode: "runsDir" },
  { id: "embedding-integration", label: "embedding service integration check (non-database)", kind: "nodeTest", args: ["--test", "tests/integration/memory-embedding-service.test.mjs"] },
  { id: "deployed-smoke", label: "deployed normal-use smoke against the exact candidate", kind: "pnpm", args: ["--filter", "@companion/e2e", "test:deployed-smoke"], envMode: "deployedSmoke" },
];

export function validateShipEnv(env) {
  const target = env.SHIP_TARGET_SHA ?? "";
  const deployed = env.SHIP_DEPLOYED_SHA ?? "";
  if (!SHA_RE.test(target) || !SHA_RE.test(deployed)) {
    throw new Error(
      "SHIP_TARGET_SHA and SHIP_DEPLOYED_SHA must both be the exact 40-hex candidate SHA (the fleet ship wrapper sets both; root test:e2e has no local-only or unpinned mode)",
    );
  }
  if (target !== deployed) {
    throw new Error(`SHIP_TARGET_SHA (${target}) does not equal SHIP_DEPLOYED_SHA (${deployed}); refusing to run E2E against an unpinned deployment`);
  }
  return { sha: target };
}

export function validateVerifiedBaseline(baseline) {
  if (baseline === null || typeof baseline !== "object" || Array.isArray(baseline)) {
    throw new Error("verified baseline is not an object");
  }
  if (!DIGEST_RE.test(String(baseline.webDigest ?? "")) || !DIGEST_RE.test(String(baseline.workerDigest ?? ""))) {
    throw new Error("verified baseline digests are missing or invalid");
  }
  if (typeof baseline.webPod !== "string" || !baseline.webPod || typeof baseline.workerPod !== "string" || !baseline.workerPod) {
    throw new Error("verified baseline pod names are missing");
  }
  if (!UID_RE.test(String(baseline.webPodUid ?? "")) || !UID_RE.test(String(baseline.workerPodUid ?? ""))) {
    throw new Error("verified baseline pod UIDs are missing or invalid");
  }
  return baseline;
}

export function digestFromImageId(imageId) {
  const text = String(imageId ?? "");
  const at = text.lastIndexOf("@");
  if (at === -1) return null;
  const digest = text.slice(at + 1);
  return DIGEST_RE.test(digest) ? digest : null;
}

/**
 * Strict live-pod check against the in-memory verified baseline captured
 * at E2E start: the pod must be exactly that pod (name AND UID), not
 * terminating, Running and Ready, carrying exactly one named
 * container/status pair running the digest-pinned candidate image. Error
 * messages are predicate-only and never echo pod names or UIDs. Exported
 * for hermetic unit tests; the baseline recheck delegates here after
 * selecting the sole match.
 */
export function checkLivePod(pod, name, digest, expectedPod, expectedPodUid, expectedImage) {
  if (pod?.metadata?.name !== expectedPod) {
    throw new Error(`${name} pod is not the pod verified at E2E start; refusing to run E2E against a different pod`);
  }
  if (pod?.metadata?.uid !== expectedPodUid) {
    throw new Error(`${name} pod UID does not match the pod verified at E2E start; refusing to run E2E against a replacement pod`);
  }
  if (pod?.metadata?.deletionTimestamp) throw new Error(`${name} pod is terminating`);
  if (pod?.status?.phase !== "Running") throw new Error(`${name} pod is not Running`);
  const containers = pod?.spec?.containers;
  if (!Array.isArray(containers) || containers.length !== 1 || containers[0]?.name !== name) {
    throw new Error(`${name} pod does not carry exactly one ${name} container`);
  }
  const statuses = pod?.status?.containerStatuses;
  if (!Array.isArray(statuses) || statuses.length !== 1 || statuses[0]?.name !== name) {
    throw new Error(`${name} pod does not carry exactly one ${name} container status`);
  }
  if (statuses[0]?.ready !== true) throw new Error(`${name} pod is not Ready`);
  if (digestFromImageId(statuses[0]?.imageID) !== digest) throw new Error(`${name} pod image digest does not match the deployed candidate digest`);
  if (containers[0]?.image !== expectedImage) {
    throw new Error(`${name} pod image reference does not match the digest-pinned candidate image`);
  }
  return pod;
}

/**
 * Build the registry manifest URL for an immutable full-SHA tag.
 * Pure and exported for hermetic tests. Loopback registries use `http`;
 * all other hosts use `https`. The host comes from the trusted identity
 * pins, never from the live cluster, so the expected digest is never
 * inferred from a live pod.
 */
export function registryManifestUrl(repo, sha) {
  if (typeof repo !== "string" || !repo || /\s/.test(repo) || repo.includes("@") || repo.includes("://")) {
    throw new Error("registry repository is missing or invalid");
  }
  const slash = repo.indexOf("/");
  if (slash === -1) throw new Error("registry repository is missing or invalid");
  const host = repo.slice(0, slash);
  const name = repo.slice(slash + 1);
  if (!host || !name || name.endsWith("/") || name.startsWith("/") || name.includes("..")) {
    throw new Error("registry repository is missing or invalid");
  }
  if (!/^[A-Za-z0-9._-]+(:\d+)?$/.test(host) && !/^\[[0-9A-Fa-f:.]+\](:\d+)?$/.test(host)) {
    throw new Error("registry repository is missing or invalid");
  }
  if (!SHA_RE.test(String(sha ?? ""))) throw new Error("candidate SHA is not a 40-hex SHA");
  const hostname = host.replace(/:\d+$/, "").replace(/^\[/, "").replace(/\]$/, "");
  const isLoopback =
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "127.0.0.1" ||
    /^127\.\d+\.\d+\.\d+$/.test(hostname) ||
    hostname === "::1";
  const scheme = isLoopback ? "http" : "https";
  return `${scheme}://${host}/v2/${name}/manifests/${sha}`;
}

/**
 * Resolve one expected digest independently from the registry for the
 * immutable full-SHA tag. Read-only manifest lookup; any failure is
 * fail-closed and never falls back to a live-pod value. Exported with an
 * injectable fetch for hermetic tests.
 */
export async function resolveRegistryDigest(repo, sha, { fetchImpl = globalThis.fetch, timeoutMs = 15_000 } = {}) {
  const url = registryManifestUrl(repo, sha);
  if (typeof fetchImpl !== "function") {
    throw new Error("cannot resolve the expected image digest from the registry for the candidate (refusing to infer it from the live pod)");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(url, {
      headers: {
        Accept:
          "application/vnd.docker.distribution.manifest.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.index.v1+json",
      },
      signal: controller.signal,
    });
  } catch {
    throw new Error("cannot resolve the expected image digest from the registry for the candidate (refusing to infer it from the live pod)");
  } finally {
    clearTimeout(timer);
  }
  if (!response || response.ok !== true) {
    throw new Error("cannot resolve the expected image digest from the registry for the candidate (refusing to infer it from the live pod)");
  }
  let digest = null;
  try {
    digest = response.headers?.get?.("docker-content-digest") ?? response.headers?.get?.("Docker-Content-Digest");
  } catch {
    digest = null;
  }
  if (!digest || !DIGEST_RE.test(String(digest))) {
    throw new Error("cannot resolve the expected image digest from the registry for the candidate (refusing to infer it from the live pod)");
  }
  try {
    await response.text?.();
  } catch {
    // Body is intentionally discarded; only the validated digest header matters.
  }
  return String(digest);
}

/**
 * Resolve both expected digests at the fixed registry for the candidate.
 * Both repos come from the trusted identity pins. Any failure blocks the
 * run before any test step executes.
 */
export async function resolveExpectedDigests(pins, sha, options = {}) {
  const repos = pins?.registryRepositories;
  if (!repos || typeof repos !== "object" || Array.isArray(repos)) {
    throw new Error("cannot resolve expected digests without the fixed registry repositories (refusing to infer them from the live pod)");
  }
  let webDigest;
  try {
    webDigest = await resolveRegistryDigest(repos.web, sha, options);
  } catch {
    throw new Error("cannot resolve the expected web image digest from the registry for the candidate (refusing to infer it from the live pod)");
  }
  let workerDigest;
  try {
    workerDigest = await resolveRegistryDigest(repos.worker, sha, options);
  } catch {
    throw new Error("cannot resolve the expected worker image digest from the registry for the candidate (refusing to infer it from the live pod)");
  }
  return { webDigest, workerDigest };
}

/** Verify a Deployment spec carries exactly the digest-pinned candidate image. */
export function checkDeploymentSpec(deploy, containerName, expectedImage) {
  const containers = deploy?.spec?.template?.spec?.containers;
  if (!Array.isArray(containers) || containers.length !== 1 || containers[0]?.name !== containerName) {
    throw new Error(`${containerName} deployment does not carry exactly one ${containerName} container`);
  }
  if (containers[0]?.image !== expectedImage) {
    throw new Error(`${containerName} deployment spec image does not match the registry-resolved candidate digest`);
  }
  return deploy;
}

/** Select the sole workload pod for one workload label. */
export function selectSoleWorkloadPod(pods, name) {
  const matches = (Array.isArray(pods) ? pods : []).filter(
    (p) => p?.metadata?.labels?.["app.kubernetes.io/name"] === name && p?.metadata?.labels?.["app.kubernetes.io/instance"] === RELEASE,
  );
  if (matches.length !== 1) throw new Error(`expected exactly one ${name} pod in ${NAMESPACE}, found ${matches.length}`);
  return matches[0];
}

/**
 * Capture the in-memory verified baseline at E2E start. Digests come
 * only from the registry (`expected`); pod names/UIDs are captured here
 * only after both Deployment specs and pod runtimes prove those
 * digests. Never persists anything to disk. Pure for hermetic tests.
 */
export function captureVerifiedBaseline({ pods, webDeploy, workerDeploy }, pins, expected) {
  if (!DIGEST_RE.test(String(expected?.webDigest ?? "")) || !DIGEST_RE.test(String(expected?.workerDigest ?? ""))) {
    throw new Error("expected registry digests are missing or invalid");
  }
  const webRepo = pins?.registryRepositories?.web;
  const workerRepo = pins?.registryRepositories?.worker;
  if (!webRepo || !workerRepo) {
    throw new Error("cannot verify the live deployment without the fixed registry repositories");
  }
  checkDeploymentSpec(webDeploy, "web", `${webRepo}@${expected.webDigest}`);
  checkDeploymentSpec(workerDeploy, "worker", `${workerRepo}@${expected.workerDigest}`);
  const webPod = selectSoleWorkloadPod(pods, "web");
  const workerPod = selectSoleWorkloadPod(pods, "worker");
  const capturePod = (pod, name, digest, expectedImage) => {
    if (pod?.metadata?.deletionTimestamp) throw new Error(`${name} pod is terminating`);
    if (pod?.status?.phase !== "Running") throw new Error(`${name} pod is not Running`);
    const podName = pod?.metadata?.name;
    const podUid = pod?.metadata?.uid;
    if (typeof podName !== "string" || !podName) throw new Error(`${name} pod name is missing`);
    if (!UID_RE.test(String(podUid ?? ""))) throw new Error(`${name} pod UID is missing or invalid`);
    const containers = pod?.spec?.containers;
    if (!Array.isArray(containers) || containers.length !== 1 || containers[0]?.name !== name) {
      throw new Error(`${name} pod does not carry exactly one ${name} container`);
    }
    const statuses = pod?.status?.containerStatuses;
    if (!Array.isArray(statuses) || statuses.length !== 1 || statuses[0]?.name !== name) {
      throw new Error(`${name} pod does not carry exactly one ${name} container status`);
    }
    if (statuses[0]?.ready !== true) throw new Error(`${name} pod is not Ready`);
    if (digestFromImageId(statuses[0]?.imageID) !== digest) {
      throw new Error(`${name} pod image digest does not match the registry-resolved candidate digest`);
    }
    if (containers[0]?.image !== expectedImage) {
      throw new Error(`${name} pod image reference does not match the digest-pinned candidate image`);
    }
    return { podName, podUid };
  };
  const web = capturePod(webPod, "web", expected.webDigest, `${webRepo}@${expected.webDigest}`);
  const worker = capturePod(workerPod, "worker", expected.workerDigest, `${workerRepo}@${expected.workerDigest}`);
  return validateVerifiedBaseline({
    webDigest: expected.webDigest,
    workerDigest: expected.workerDigest,
    webPod: web.podName,
    webPodUid: web.podUid,
    workerPod: worker.podName,
    workerPodUid: worker.podUid,
  });
}

/**
 * Recheck the live deployment against the same in-memory baseline after
 * the suites (and through the run via the smoke pin). Any pod
 * replacement (name or UID), spec drift, or digest drift fails closed.
 * Pure for hermetic tests.
 */
export function assertBaselineCurrent(baseline, { pods, webDeploy, workerDeploy }, pins) {
  validateVerifiedBaseline(baseline);
  const webRepo = pins?.registryRepositories?.web;
  const workerRepo = pins?.registryRepositories?.worker;
  if (!webRepo || !workerRepo) {
    throw new Error("cannot verify the live deployment without the fixed registry repositories");
  }
  checkDeploymentSpec(webDeploy, "web", `${webRepo}@${baseline.webDigest}`);
  checkDeploymentSpec(workerDeploy, "worker", `${workerRepo}@${baseline.workerDigest}`);
  const webPod = selectSoleWorkloadPod(pods, "web");
  const workerPod = selectSoleWorkloadPod(pods, "worker");
  checkLivePod(webPod, "web", baseline.webDigest, baseline.webPod, baseline.webPodUid, `${webRepo}@${baseline.webDigest}`);
  checkLivePod(workerPod, "worker", baseline.workerDigest, baseline.workerPod, baseline.workerPodUid, `${workerRepo}@${baseline.workerDigest}`);
  return baseline;
}

/** Run a command, capturing stdout (trimmed). Throws on non-zero exit. */
export function runCaptured(command, args, { cwd, env } = {}) {
  const result = spawnSync(command, args, { cwd, env, encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed (exit ${String(result.status)})`);
  }
  return String(result.stdout ?? "").trim();
}

export function loadIdentityPins(repoRoot) {
  const file = path.join(repoRoot, IDENTITY_FILE_REL);
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch {
    throw new Error(`trusted local identity file is missing: ${IDENTITY_FILE_REL} (provision the fixed identity pins locally; refusing to guess cluster identity)`);
  }
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("identity file must be a regular file, not a symlink");
  if (stat.uid !== process.geteuid()) throw new Error("identity file must be owned by the operator running E2E");
  if ((stat.mode & 0o777) !== 0o600) throw new Error("identity file must have mode 0600");
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    throw new Error("identity file is not valid JSON");
  }
  if (data.namespace !== NAMESPACE || data.release !== RELEASE) {
    throw new Error("identity file does not match the predetermined non-production target");
  }
  return data;
}

export function loadGatePort(repoRoot) {
  const valuesFile = path.join(repoRoot, VALUES_FILE_REL);
  if (!fs.existsSync(valuesFile)) {
    throw new Error(`local-only non-production values file is missing: ${VALUES_FILE_REL}`);
  }
  const script = [
    "import sys, yaml",
    "data = yaml.safe_load(open(sys.argv[1], encoding='utf-8'))",
    "port = ((data.get('web') or {}).get('testGate') or {}).get('port', 3100)",
    "print(port)",
  ].join("\n");
  const result = spawnSync("python3", ["-c", script, valuesFile], { encoding: "utf8" });
  if (result.error || result.status !== 0) {
    throw new Error("cannot parse the gate port from the local values file (python3 with PyYAML is required)");
  }
  const port = Number(String(result.stdout).trim());
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("gate port in the local values file is invalid");
  return port;
}

/**
 * Validate an embedding base URL as an HTTP(S) origin with no credentials,
 * path, query, or fragment (same rule as `tests/e2e/helpers/config.mjs`).
 * Returns the normalized `origin`. Failures never echo the value.
 */
export function validateEmbeddingOrigin(value) {
  const name = "WORKER_MEMORY_EMBEDDING_BASE_URL";
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} must be a valid HTTP(S) base URL`);
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid HTTP(S) base URL`);
  }
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(`${name} must be an HTTP(S) origin without credentials, path, query, or fragment`);
  }
  return parsed.origin;
}

/**
 * Resolve the host-local embedding base URL for the disposable stack.
 * An explicit `WORKER_MEMORY_EMBEDDING_BASE_URL` takes precedence; otherwise
 * fall back to `localEmbeddingBaseUrl` in the dedicated local-only
 * `.private/e2e-local.json` (documented LAN/host variant). The deployed
 * worker's in-cluster value is intentionally never used on the host. All
 * failures fail closed without echoing the value.
 */
export function loadEmbeddingBaseUrl(repoRoot, env = process.env) {
  const fromEnv = env.WORKER_MEMORY_EMBEDDING_BASE_URL;
  if (fromEnv !== undefined && fromEnv.length > 0) {
    return validateEmbeddingOrigin(fromEnv);
  }
  const localFile = path.join(repoRoot, E2E_LOCAL_FILE_REL);
  let stat;
  try {
    stat = fs.lstatSync(localFile);
  } catch {
    throw new Error(
      `local-only E2E config is missing: ${E2E_LOCAL_FILE_REL} (populate localEmbeddingBaseUrl from the approved local infrastructure source or set WORKER_MEMORY_EMBEDDING_BASE_URL; refusing to guess the embedding endpoint)`,
    );
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`local-only E2E config must be a regular file, not a symlink: ${E2E_LOCAL_FILE_REL}`);
  }
  let data;
  try {
    data = JSON.parse(fs.readFileSync(localFile, "utf8"));
  } catch {
    throw new Error(`local-only E2E config is not valid JSON: ${E2E_LOCAL_FILE_REL}`);
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new Error(
      "localEmbeddingBaseUrl is missing or invalid in the local E2E config (populate it from the approved local infrastructure source or set WORKER_MEMORY_EMBEDDING_BASE_URL; refusing to guess the embedding endpoint)",
    );
  }
  const raw = data.localEmbeddingBaseUrl;
  if (typeof raw !== "string" || raw.length === 0) {
    throw new Error(
      "localEmbeddingBaseUrl is missing or invalid in the local E2E config (populate it from the approved local infrastructure source or set WORKER_MEMORY_EMBEDDING_BASE_URL; refusing to guess the embedding endpoint)",
    );
  }
  try {
    return validateEmbeddingOrigin(raw);
  } catch {
    throw new Error(
      "localEmbeddingBaseUrl in the local E2E config is invalid (must be an HTTP(S) origin without credentials, path, query, or fragment)",
    );
  }
}

/** Steps that read the host-local embedding setting from their own env. */
export const EMBEDDING_STEP_IDS = ["playwright", "stack-ops", "embedding-integration"];

/**
 * Build the child environment for one inventory step. Strips the
 * destructive-suite target, injects the resolved host-local embedding
 * value into steps that need it, and applies run-scoped settings.
 * The value itself is never logged.
 */
export function buildChildEnv(step, baseEnv, { runsBase, gatePort, baseline, pins, embeddingBaseUrl } = {}) {
  const childEnv = { ...baseEnv };
  if (childEnv.WORKER_TEST_DATABASE_URL !== undefined) {
    delete childEnv.WORKER_TEST_DATABASE_URL;
  }
  if (embeddingBaseUrl !== undefined && EMBEDDING_STEP_IDS.includes(step.id)) {
    childEnv.WORKER_MEMORY_EMBEDDING_BASE_URL = embeddingBaseUrl;
  }
  if (step.envMode === "runsDir" || step.envMode === "deployedSmoke") {
    childEnv.E2E_RUNS_DIR = fs.mkdtempSync(path.join(runsBase, `${step.id}-`));
  }
  if (step.envMode === "deployedSmoke") {
    childEnv.E2E_DEPLOYED_SMOKE_ALLOWED = "1";
    childEnv.E2E_DEPLOYED_SMOKE_EXCLUSIVE_DEV_ACCESS = "1";
    childEnv.E2E_DEPLOYED_NAMESPACE = NAMESPACE;
    childEnv.E2E_DEPLOYED_GATE_PORT = String(gatePort);
    childEnv.E2E_DEPLOYED_EXPECT_WEB_POD = baseline.webPod;
    childEnv.E2E_DEPLOYED_EXPECT_WORKER_POD = baseline.workerPod;
    childEnv.E2E_DEPLOYED_EXPECT_WEB_POD_UID = baseline.webPodUid;
    childEnv.E2E_DEPLOYED_EXPECT_WORKER_POD_UID = baseline.workerPodUid;
    childEnv.E2E_DEPLOYED_EXPECT_WEB_IMAGE_ID = `${pins.registryRepositories.web}@${baseline.webDigest}`;
    childEnv.E2E_DEPLOYED_EXPECT_WORKER_IMAGE_ID = `${pins.registryRepositories.worker}@${baseline.workerDigest}`;
  }
  return childEnv;
}

function log(message) {
  process.stderr.write(`[ship-e2e] ${message}\n`);
}

function repoRoot() {
  const fromFile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const gitRoot = runCaptured("git", ["rev-parse", "--show-toplevel"], { cwd: fromFile });
  if (path.resolve(gitRoot) !== fromFile) throw new Error("test-e2e runner is not at the repository root entry point");
  return fromFile;
}

function verifyClusterIdentity(root, pins) {
  const context = runCaptured("kubectl", ["config", "current-context"], { cwd: root });
  if (context !== pins.context) throw new Error("kubectl context does not match the fixed identity pin");
  const kubeSystemUid = runCaptured("kubectl", ["get", "namespace", "kube-system", "-o", "jsonpath={.metadata.uid}"], { cwd: root });
  if (kubeSystemUid !== pins.kubeSystemUid) throw new Error("kube-system UID does not match the fixed identity pin");
  const nsRaw = runCaptured("kubectl", ["get", "namespace", NAMESPACE, "-o", "json"], { cwd: root });
  const ns = JSON.parse(nsRaw);
  if (ns?.metadata?.uid !== pins.namespaceUid || ns?.status?.phase !== "Active") {
    throw new Error("non-production namespace does not match the fixed identity pin");
  }
}

function loadLiveState(root) {
  const podsRaw = runCaptured("kubectl", ["get", "pods", "-n", NAMESPACE, "-o", "json"], { cwd: root });
  const pods = JSON.parse(podsRaw)?.items ?? [];
  const webDeploy = JSON.parse(runCaptured("kubectl", ["get", "deploy", "companion-web", "-n", NAMESPACE, "-o", "json"], { cwd: root }));
  const workerDeploy = JSON.parse(runCaptured("kubectl", ["get", "deploy", "companion-worker", "-n", NAMESPACE, "-o", "json"], { cwd: root }));
  return { pods, webDeploy, workerDeploy };
}

function runStep(step, { root, runsBase, gatePort, baseline, pins, embeddingBaseUrl }) {
  log(`step ${step.id}: ${step.label}`);
  // Destructive integration suites are not run by this runner; strip their
  // target so nothing in the runnable inventory can use an application DB.
  if (process.env.WORKER_TEST_DATABASE_URL !== undefined) {
    log("WORKER_TEST_DATABASE_URL is set in the environment; removing it for all runnable steps (database-backed integration suites are not routine ship gates)");
  }
  const childEnv = buildChildEnv(step, process.env, { runsBase, gatePort, baseline, pins, embeddingBaseUrl });
  let command;
  let args;
  if (step.kind === "pnpm") {
    command = "pnpm";
    args = step.args;
  } else if (step.kind === "chart") {
    command = path.join(root, "deploy/helm/render-checks.sh");
    args = [];
  } else if (step.kind === "nodeTest") {
    command = process.execPath;
    args = step.args;
  } else {
    throw new Error(`unknown step kind for ${step.id}`);
  }
  const result = spawnSync(command, args, { cwd: root, env: childEnv, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`step ${step.id} failed (exit ${String(result.status)}); full E2E stops here and is not reported as a pass`);
  log(`step ${step.id}: passed`);
}

async function main() {
  if (process.versions.node !== PINNED_NODE) {
    throw new Error(
      `Companion full E2E requires Node.js ${PINNED_NODE}; found ${process.versions.node}. Select the version pinned in tests/e2e/.nvmrc (for example, nvm use) and rerun the ship workflow.`,
    );
  }
  const { sha } = validateShipEnv(process.env);
  const root = repoRoot();
  const head = runCaptured("git", ["rev-parse", "HEAD"], { cwd: root });
  if (head !== sha) throw new Error(`HEAD (${head}) does not equal the candidate (${sha})`);
  const status = runCaptured("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: root });
  if (status) throw new Error("working tree is not clean; local E2E suites must run from the exact candidate tree");
  for (const candidatePath of ["scripts/test-e2e.mjs", "scripts/ship-deploy", "package.json"]) {
    const check = spawnSync("git", ["cat-file", "-e", `${sha}:${candidatePath}`], { cwd: root });
    if (check.status !== 0) throw new Error(`candidate tree is missing ${candidatePath}`);
  }

  const pins = loadIdentityPins(root);
  const gatePort = loadGatePort(root);
  const embeddingBaseUrl = loadEmbeddingBaseUrl(root, process.env);
  log(
    process.env.WORKER_MEMORY_EMBEDDING_BASE_URL
      ? "embedding base URL resolved from explicit WORKER_MEMORY_EMBEDDING_BASE_URL (value not printed)"
      : "embedding base URL resolved from local E2E config localEmbeddingBaseUrl (value not printed)",
  );

  // No handoff file: resolve the expected immutable full-SHA digests
  // independently at the fixed registry, verify them against both the
  // Deployment specs and the pod runtimes, and capture the verified pod
  // baseline in memory. Nothing is persisted for the run.
  verifyClusterIdentity(root, pins);
  const expected = await resolveExpectedDigests(pins, sha);
  const baseline = captureVerifiedBaseline(loadLiveState(root), pins, expected);
  log("live deployment verified against the registry-resolved candidate (specs, runtimes, pods); baseline held in memory");

  const runsBase = fs.mkdtempSync(path.join(os.tmpdir(), "companion-ship-e2e-"));
  log(`E2E runs directory (task-owned, outside the repo): ${runsBase}`);
  log(`running the complete inventory (${STEPS.length} steps, no filtering, no skips) against ${sha}`);
  for (const step of STEPS) {
    runStep(step, { root, runsBase, gatePort, baseline, pins, embeddingBaseUrl });
  }
  // Re-verify the deployment is still the same verified pods/digests
  // after all suites (in particular after the deployed smoke).
  verifyClusterIdentity(root, pins);
  assertBaselineCurrent(baseline, loadLiveState(root), pins);
  log(`full E2E passed for ${sha} (${STEPS.length}/${STEPS.length} steps)`);
}

const invokedAsMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedAsMain) {
  main().catch((error) => {
    process.stderr.write(`[ship-e2e] ERROR: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
