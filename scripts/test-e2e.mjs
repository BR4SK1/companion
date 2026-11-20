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
 *   - SHIP_DEPLOY_EXCLUSIVE_WINDOW=1, confirming the owner-coordinated
 *     exclusive window (Cal asks the user). The local ship lock does not
 *     prove all-writer exclusivity; this flag records operator coordination
 *     and is required before any deployed smoke send.
 *   - The ship lock handoff (.git/ship-deploy.lock, phase "deployed") from
 *     a successful ship-deploy for the same SHA, with matching digests and
 *     pod names. The runner adopts that lock for the whole E2E run so a
 *     concurrent candidate cannot deploy over the deployment under test.
 *     The lock only serializes ship entry points on this host; it does not
 *     enforce exclusivity against manual writers (hence the exclusive
 *     window requirement above).
 *   - The trusted local identity pins and local-only values file used by
 *     ship-deploy, verified again here against the live cluster before any
 *     test runs. Identity values are never printed.
 *   - WORKER_MEMORY_EMBEDDING_BASE_URL from approved private local
 *     infrastructure configuration for the local stack and embedding check.
 *     This runner never invents or defaults it; the suites fail without it.
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
 *     pinned to the lock's pods/digests, retaining its synthetic history).
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
export const PINNED_NODE = "22.23.4";
export const NAMESPACE = "companion-np";
export const RELEASE = "companion";
export const IDENTITY_FILE_REL = ".private/deploy/ship-target-identity.json";
export const VALUES_FILE_REL = ".private/deploy/non-production-values.yaml";

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
  if (env.SHIP_DEPLOY_EXCLUSIVE_WINDOW !== "1") {
    throw new Error(
      "requires SHIP_DEPLOY_EXCLUSIVE_WINDOW=1 confirming the owner-coordinated exclusive window for companion-np (Cal must ask the user; the local lock alone does not prove exclusivity)",
    );
  }
  return { sha: target };
}

export function validateLockOwner(owner) {
  if (owner === null || typeof owner !== "object" || Array.isArray(owner)) {
    throw new Error("ship lock owner record is not an object");
  }
  if (!SHA_RE.test(String(owner.sha ?? ""))) {
    throw new Error("ship lock owner SHA is not a 40-hex SHA");
  }
  if (owner.phase !== "deployed") {
    throw new Error(`ship lock phase is ${String(owner.phase ?? "missing")}, expected "deployed" (ship-deploy must have succeeded for this candidate first)`);
  }
  if (owner.namespace !== NAMESPACE || owner.release !== RELEASE) {
    throw new Error("ship lock namespace/release do not match the predetermined non-production target");
  }
  if (!DIGEST_RE.test(String(owner.webDigest ?? "")) || !DIGEST_RE.test(String(owner.workerDigest ?? ""))) {
    throw new Error("ship lock digests are missing or invalid");
  }
  if (typeof owner.webPod !== "string" || !owner.webPod || typeof owner.workerPod !== "string" || !owner.workerPod) {
    throw new Error("ship lock pod names are missing");
  }
  return owner;
}

export function digestFromImageId(imageId) {
  const text = String(imageId ?? "");
  const at = text.lastIndexOf("@");
  if (at === -1) return null;
  const digest = text.slice(at + 1);
  return DIGEST_RE.test(digest) ? digest : null;
}

export function pidStarttime(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${String(pid)}/stat`, "utf8");
    const after = stat.slice(stat.lastIndexOf(")") + 2);
    return after.split(" ")[19] ?? "gone";
  } catch {
    return "gone";
  }
}

export function isPidLive(pid, starttime) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  const current = pidStarttime(pid);
  return current !== "gone" && String(starttime) !== "gone" && current === String(starttime);
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

function log(message) {
  process.stderr.write(`[ship-e2e] ${message}\n`);
}

function repoRoot() {
  const fromFile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const gitRoot = runCaptured("git", ["rev-parse", "--show-toplevel"], { cwd: fromFile });
  if (path.resolve(gitRoot) !== fromFile) throw new Error("test-e2e runner is not at the repository root entry point");
  return fromFile;
}

function gitDir(root) {
  return runCaptured("git", ["rev-parse", "--absolute-git-dir"], { cwd: root });
}

function verifyLiveDeployment(root, pins, lock) {
  const context = runCaptured("kubectl", ["config", "current-context"], { cwd: root });
  if (context !== pins.context) throw new Error("kubectl context does not match the fixed identity pin");
  const kubeSystemUid = runCaptured("kubectl", ["get", "namespace", "kube-system", "-o", "jsonpath={.metadata.uid}"], { cwd: root });
  if (kubeSystemUid !== pins.kubeSystemUid) throw new Error("kube-system UID does not match the fixed identity pin");
  const nsRaw = runCaptured("kubectl", ["get", "namespace", NAMESPACE, "-o", "json"], { cwd: root });
  const ns = JSON.parse(nsRaw);
  if (ns?.metadata?.uid !== pins.namespaceUid || ns?.status?.phase !== "Active") {
    throw new Error("non-production namespace does not match the fixed identity pin");
  }
  const podsRaw = runCaptured("kubectl", ["get", "pods", "-n", NAMESPACE, "-o", "json"], { cwd: root });
  const pods = JSON.parse(podsRaw)?.items ?? [];
  const checkPod = (name, digest, expectedPod) => {
    const matches = pods.filter(
      (p) => p?.metadata?.labels?.["app.kubernetes.io/name"] === name && p?.metadata?.labels?.["app.kubernetes.io/instance"] === RELEASE,
    );
    if (matches.length !== 1) throw new Error(`expected exactly one ${name} pod in ${NAMESPACE}, found ${matches.length}`);
    const pod = matches[0];
    if (pod.metadata.name !== expectedPod) {
      throw new Error(`${name} pod is ${pod.metadata.name}, not the pod verified at deploy time (${expectedPod}); refusing to run E2E against a different pod`);
    }
    if (pod.status?.phase !== "Running") throw new Error(`${name} pod is not Running`);
    const status = pod.status?.containerStatuses?.[0];
    if (status?.ready !== true) throw new Error(`${name} pod is not Ready`);
    if (digestFromImageId(status?.imageID) !== digest) throw new Error(`${name} pod image digest does not match the deployed candidate digest`);
    if (pod.spec?.containers?.[0]?.image !== `${pins.registryRepositories[name]}@${digest}`) {
      throw new Error(`${name} pod image reference does not match the digest-pinned candidate image`);
    }
  };
  checkPod("web", lock.webDigest, lock.webPod);
  checkPod("worker", lock.workerDigest, lock.workerPod);
  log("live deployment verified against the ship lock (pods, digests, namespace identity)");
}

function runStep(step, { root, runsBase, gatePort, lock, pins }) {
  log(`step ${step.id}: ${step.label}`);
  const childEnv = { ...process.env };
  // Destructive integration suites are not run by this runner; strip their
  // target so nothing in the runnable inventory can use an application DB.
  if (childEnv.WORKER_TEST_DATABASE_URL !== undefined) {
    log("WORKER_TEST_DATABASE_URL is set in the environment; removing it for all runnable steps (database-backed integration suites are not routine ship gates)");
    delete childEnv.WORKER_TEST_DATABASE_URL;
  }
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
  if (step.envMode === "runsDir" || step.envMode === "deployedSmoke") {
    childEnv.E2E_RUNS_DIR = fs.mkdtempSync(path.join(runsBase, `${step.id}-`));
  }
  if (step.envMode === "deployedSmoke") {
    childEnv.E2E_DEPLOYED_SMOKE_ALLOWED = "1";
    childEnv.E2E_DEPLOYED_SMOKE_EXCLUSIVE_DEV_ACCESS = "1";
    childEnv.E2E_DEPLOYED_NAMESPACE = NAMESPACE;
    childEnv.E2E_DEPLOYED_GATE_PORT = String(gatePort);
    childEnv.E2E_DEPLOYED_EXPECT_WEB_POD = lock.webPod;
    childEnv.E2E_DEPLOYED_EXPECT_WORKER_POD = lock.workerPod;
    childEnv.E2E_DEPLOYED_EXPECT_WEB_IMAGE_ID = `${pins.registryRepositories.web}@${lock.webDigest}`;
    childEnv.E2E_DEPLOYED_EXPECT_WORKER_IMAGE_ID = `${pins.registryRepositories.worker}@${lock.workerDigest}`;
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

  // Adopt the ship lock handoff for the whole E2E run.
  const lockDir = path.join(gitDir(root), "ship-deploy.lock");
  let lockStat;
  try {
    lockStat = fs.lstatSync(lockDir);
  } catch {
    throw new Error("ship lock handoff is missing (.git/ship-deploy.lock); ship-deploy must succeed for this candidate before E2E");
  }
  if (lockStat.isSymbolicLink() || !lockStat.isDirectory()) throw new Error("ship lock must be a directory, not a symlink");
  const ownerFile = path.join(lockDir, "owner.json");
  const ownerStat = fs.lstatSync(ownerFile);
  if (ownerStat.isSymbolicLink() || !ownerStat.isFile()) throw new Error("ship lock owner record must be a regular file");
  const lock = validateLockOwner(JSON.parse(fs.readFileSync(ownerFile, "utf8")));
  if (lock.sha !== sha) throw new Error(`ship lock SHA (${lock.sha}) does not equal the candidate (${sha})`);
  if (isPidLive(lock.pid, lock.pid_starttime)) {
    throw new Error("ship-deploy process from the lock is still live; refusing to adopt a lock owned by a running deploy");
  }
  const adopted = {
    ...lock,
    phase: "e2e",
    pid: process.pid,
    pid_starttime: pidStarttime(process.pid),
    adopted_at: new Date().toISOString(),
  };
  const tmpOwner = path.join(lockDir, ".owner.tmp");
  fs.writeFileSync(tmpOwner, `${JSON.stringify(adopted, null, 2)}\n`, { encoding: "utf8" });
  fs.renameSync(tmpOwner, ownerFile);
  log(`adopted ship lock for ${sha} (phase=deployed -> e2e); concurrent candidates are blocked for the whole E2E run`);

  const removeLockIfOurs = () => {
    try {
      const current = JSON.parse(fs.readFileSync(ownerFile, "utf8"));
      if (current.sha === sha && current.pid === process.pid && current.phase === "e2e") {
        const dirStat = fs.lstatSync(lockDir);
        if (!dirStat.isSymbolicLink() && dirStat.isDirectory()) fs.rmSync(lockDir, { recursive: true, force: true });
      }
    } catch {
      // Lock already gone or unreadable; leaving it is fail-closed.
    }
  };

  try {
    verifyLiveDeployment(root, pins, lock);
    const runsBase = fs.mkdtempSync(path.join(os.tmpdir(), "companion-ship-e2e-"));
    log(`E2E runs directory (task-owned, outside the repo): ${runsBase}`);
    log(`running the complete inventory (${STEPS.length} steps, no filtering, no skips) against ${sha}`);
    for (const step of STEPS) {
      runStep(step, { root, runsBase, gatePort, lock, pins });
    }
    // Re-verify the deployment is still the pinned pods/digests after all
    // suites (in particular after the deployed smoke).
    verifyLiveDeployment(root, pins, lock);
    log(`full E2E passed for ${sha} (${STEPS.length}/${STEPS.length} steps)`);
  } finally {
    removeLockIfOurs();
  }
}

const invokedAsMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedAsMain) {
  main().catch((error) => {
    process.stderr.write(`[ship-e2e] ERROR: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
