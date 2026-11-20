/**
 * Hermetic black-box fixtures for scripts/ship-deploy.
 *
 * No cluster, registry, Docker daemon, or network is used: docker, helm,
 * and kubectl are PATH shims that record their arguments and return canned
 * data. Each scenario builds a throwaway Git repository whose candidate
 * commit contains the real ship-deploy bytes plus the minimal candidate
 * tree the script requires, plus local-only identity/values files that are
 * gitignored (synthetic values, never the operator's real pins).
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const REAL_SHIP_DEPLOY = fs.readFileSync(path.join(repoRoot, "scripts", "ship-deploy"));

const WEB_DIGEST = `sha256:${"a".repeat(64)}`;
const WORKER_DIGEST = `sha256:${"b".repeat(64)}`;
const KUBE_SYSTEM_UID = "11111111-1111-4111-8111-111111111111";
const NAMESPACE_UID = "22222222-2222-4222-8222-222222222222";

function git(dir, args) {
  const result = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

function writeFile(file, content, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  if (mode !== undefined) fs.chmodSync(file, mode);
}

function makeShims(shimDir, logFile) {
  const docker = `#!/bin/sh
echo "docker $*" >> "${logFile}"
case "$1" in
  info) exit 0 ;;
  manifest)
    if [ "\${FAKE_TAG_EXISTS:-}" = "1" ]; then echo '{}'; exit 0; fi
    exit 1 ;;
  build)
    if [ "\${FAKE_DOCKER_BUILD_FAIL:-}" = "1" ]; then echo "fake build failure" >&2; exit 9; fi
    # Last argument is the build context; it must be the git-archive source
    # (contains /source/) and must not contain the dirty working-tree file.
    for last; do :; done
    case "$last" in */source) ;; *) echo "build context is not the candidate archive source: $last" >&2; exit 8 ;; esac
    if [ -e "$last/dirty.txt" ]; then echo "dirty working-tree file leaked into candidate build context" >&2; exit 7; fi
    # Verify the revision label was passed.
    case "$*" in *"org.opencontainers.image.revision="*) ;; *) echo "missing revision label" >&2; exit 6 ;; esac
    exit 0 ;;
  push) exit 0 ;;
  inspect)
    ref="$2"
    case "$ref" in
      *companion/web:*) repo="localhost:5104/companion/web"; digest="${WEB_DIGEST}" ;;
      *companion/worker:*) repo="localhost:5104/companion/worker"; digest="${WORKER_DIGEST}" ;;
      *) echo "unexpected inspect ref $ref" >&2; exit 5 ;;
    esac
    candidate="\${ref##*:}"
    case "$*" in
      *--format*) echo "$repo@$digest"; exit 0 ;;
    esac
    cat <<JSON
[{"Config":{"Labels":{"org.opencontainers.image.revision":"$candidate","companion.ship.candidate":"$candidate"}},"RepoDigests":["$repo@$digest"]}]
JSON
    exit 0 ;;
esac
exit 4
`;
  const helm = `#!/bin/sh
echo "helm $*" >> "${logFile}"
case "$1" in
  list)
    cat <<JSON
[{"name":"companion","namespace":"companion-np","chart":"companion-0.1.0","status":"deployed"}]
JSON
    exit 0 ;;
  template)
    # Chart directory is the 3rd argument (helm template <release> <chart> ...);
    # it must be inside the candidate archive source.
    chart="$3"
    case "$chart" in */source/deploy/helm/companion) ;; *) echo "chart is not from the candidate archive: $chart" >&2; exit 8 ;; esac
    if [ ! -f "$chart/Chart.yaml" ]; then echo "candidate chart missing" >&2; exit 8; fi
    web_digest=""; worker_digest=""
    for a in "$@"; do
      case "$a" in web.image.digest=*) web_digest="\${a#web.image.digest=}" ;; worker.image.digest=*) worker_digest="\${a#worker.image.digest=}" ;; esac
    done
    [ -n "$web_digest" ] && [ -n "$worker_digest" ] || { echo "helm template missing digest sets" >&2; exit 8; }
    cat <<YAML
apiVersion: apps/v1
kind: Deployment
metadata:
  name: companion-web
  namespace: companion-np
spec:
  template:
    spec:
      containers:
        - name: web
          image: "localhost:5104/companion/web@$web_digest"
          env:
            - name: COMPANION_DEPLOYMENT_PURPOSE
              value: "non-production"
            - name: COMPANION_DEPLOYMENT_NAMESPACE
              value: "companion-np"
            - name: WEB_TEST_GATE_ENABLED
              value: "true"
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: companion-worker
  namespace: companion-np
spec:
  template:
    spec:
      containers:
        - name: worker
          image: "localhost:5104/companion/worker@$worker_digest"
          env:
            - name: COMPANION_DEPLOYMENT_PURPOSE
              value: "non-production"
            - name: COMPANION_DEPLOYMENT_NAMESPACE
              value: "companion-np"
YAML
    exit 0 ;;
  upgrade)
    if [ "\${FAKE_HELM_FAIL:-}" = "1" ]; then echo "fake helm upgrade failure" >&2; exit 9; fi
    exit 0 ;;
esac
exit 4
`;
  const kubectl = `#!/bin/sh
echo "kubectl $*" >> "${logFile}"
case "$*" in
  "config current-context")
    if [ "\${FAKE_WRONG_CONTEXT:-}" = "1" ]; then echo "other-context"; else echo "default"; fi
    exit 0 ;;
  "config view -o json")
    cat <<JSON
{"contexts":[{"name":"default","context":{"cluster":"default"}}],"clusters":[{"name":"default","cluster":{"server":"https://k3s.test:6443"}}]}
JSON
    exit 0 ;;
  "version -o json")
    echo '{"serverVersion":{"gitVersion":"v1.35.4+k3s1"}}'
    exit 0 ;;
  "get namespace kube-system -o jsonpath={.metadata.uid}")
    echo "${KUBE_SYSTEM_UID}"
    exit 0 ;;
  "get namespace companion-np -o json")
    cat <<JSON
{"metadata":{"name":"companion-np","uid":"${NAMESPACE_UID}"},"status":{"phase":"Active"}}
JSON
    exit 0 ;;
  "get deploy companion-web -n companion-np -o name") echo "deployment.apps/companion-web"; exit 0 ;;
  "get deploy companion-worker -n companion-np -o name") echo "deployment.apps/companion-worker"; exit 0 ;;
  "get deploy companion-web -n companion-np -o json")
    echo '{"metadata":{"name":"companion-web"},"status":{"readyReplicas":1,"replicas":1}}'
    exit 0 ;;
  "get deploy companion-worker -n companion-np -o json")
    echo '{"metadata":{"name":"companion-worker"},"status":{"readyReplicas":1,"replicas":1}}'
    exit 0 ;;
  "rollout status deploy/companion-web -n companion-np --timeout=600s") exit 0 ;;
  "rollout status deploy/companion-worker -n companion-np --timeout=600s") exit 0 ;;
  "get pods -n companion-np -o json")
    cat <<JSON
{"items":[
{"metadata":{"name":"companion-web-test-0","labels":{"app.kubernetes.io/name":"web","app.kubernetes.io/instance":"companion"}},"spec":{"containers":[{"image":"localhost:5104/companion/web@${WEB_DIGEST}"}]},"status":{"phase":"Running","containerStatuses":[{"ready":true,"imageID":"localhost:5104/companion/web@${WEB_DIGEST}"}]}},
{"metadata":{"name":"companion-worker-test-0","labels":{"app.kubernetes.io/name":"worker","app.kubernetes.io/instance":"companion"}},"spec":{"containers":[{"image":"localhost:5104/companion/worker@${WORKER_DIGEST}"}]},"status":{"phase":"Running","containerStatuses":[{"ready":true,"imageID":"localhost:5104/companion/worker@${WORKER_DIGEST}"}]}}
]}
JSON
    exit 0 ;;
esac
echo "unexpected kubectl call: $*" >&2
exit 4
`;
  writeFile(path.join(shimDir, "docker"), docker, 0o755);
  writeFile(path.join(shimDir, "helm"), helm, 0o755);
  writeFile(path.join(shimDir, "kubectl"), kubectl, 0o755);
}

function makeFixture({ identityOverrides = {}, valuesText = null, dirty = false } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ship-deploy-test-"));
  const repo = path.join(base, "repo");
  const shimDir = path.join(base, "shims");
  const logFile = path.join(base, "calls.log");
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(shimDir, { recursive: true });
  fs.writeFileSync(logFile, "");
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["config", "user.email", "test@example.invalid"]);
  git(repo, ["config", "user.name", "Test"]);
  writeFile(path.join(repo, ".gitignore"), ".private/\n");
  writeFile(path.join(repo, "scripts/ship-deploy"), REAL_SHIP_DEPLOY, 0o755);
  writeFile(path.join(repo, "scripts/test-e2e.mjs"), "// fixture runner\n");
  writeFile(path.join(repo, "package.json"), '{"name":"fixture"}\n');
  writeFile(path.join(repo, "deploy/helm/companion/Chart.yaml"), "apiVersion: v2\nname: companion\nversion: 0.1.0\n");
  writeFile(path.join(repo, "deploy/docker/Dockerfile.web"), "FROM scratch\n");
  writeFile(path.join(repo, "deploy/docker/Dockerfile.worker"), "FROM scratch\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "test: candidate"]);
  const sha = git(repo, ["rev-parse", "HEAD"]);
  const identity = {
    context: "default",
    apiServer: "https://k3s.test:6443",
    kubeSystemUid: KUBE_SYSTEM_UID,
    namespace: "companion-np",
    namespaceUid: NAMESPACE_UID,
    release: "companion",
    chart: "companion",
    deployments: { web: "companion-web", worker: "companion-worker" },
    registryRepositories: { web: "localhost:5104/companion/web", worker: "localhost:5104/companion/worker" },
    ...identityOverrides,
  };
  writeFile(path.join(repo, ".private/deploy/ship-target-identity.json"), `${JSON.stringify(identity, null, 2)}\n`, 0o600);
  const defaultValues = [
    "deployment:",
    "  purpose: non-production",
    "  namespace: companion-np",
    "web:",
    "  image:",
    "    repository: localhost:5104/companion/web",
    "  testGate:",
    "    enabled: true",
    "    port: 3100",
    "worker:",
    "  enabled: true",
    "  image:",
    "    repository: localhost:5104/companion/worker",
    "",
  ].join("\n");
  writeFile(path.join(repo, ".private/deploy/non-production-values.yaml"), valuesText ?? defaultValues);
  if (dirty) writeFile(path.join(repo, "dirty.txt"), "uncommitted dirty file that must not enter the build\n");
  makeShims(shimDir, logFile);
  return { base, repo, shimDir, logFile, sha };
}

function runShipDeploy(fixture, args, extraEnv = {}) {
  const env = {
    ...process.env,
    PATH: `${fixture.shimDir}:${process.env.PATH}`,
    SHIP_DEPLOY_EXCLUSIVE_WINDOW: "1",
    ...extraEnv,
  };
  return spawnSync("bash", [path.join(fixture.repo, "scripts/ship-deploy"), ...args], {
    cwd: fixture.repo,
    env,
    encoding: "utf8",
  });
}

function readCalls(fixture) {
  return fs.readFileSync(fixture.logFile, "utf8");
}

function lockOwner(fixture) {
  return JSON.parse(fs.readFileSync(path.join(fixture.repo, ".git/ship-deploy.lock/owner.json"), "utf8"));
}

test("ship-deploy rejects argument and exclusive-window violations without calling tools", () => {
  const fixture = makeFixture();
  try {
    for (const args of [[], [fixture.sha, "extra"], ["abc"], [fixture.sha.toUpperCase()], ["g".repeat(40)]]) {
      const result = runShipDeploy(fixture, args);
      assert.notEqual(result.status, 0, `args ${JSON.stringify(args)} must fail`);
      assert.ok(!result.stdout.includes("SHIP_DEPLOYED_SHA="), "no success line on failure");
    }
    const noWindow = runShipDeploy(fixture, [fixture.sha], { SHIP_DEPLOY_EXCLUSIVE_WINDOW: "" });
    assert.notEqual(noWindow.status, 0);
    assert.match(noWindow.stderr, /exclusive window/);
    const unknown = runShipDeploy(fixture, ["f".repeat(40)]);
    assert.notEqual(unknown.status, 0);
    assert.match(unknown.stderr, /not a commit/);
    assert.equal(readCalls(fixture), "", "no docker/helm/kubectl shim should be called for early rejections");
    assert.ok(!fs.existsSync(path.join(fixture.repo, ".git/ship-deploy.lock")), "early rejections must not leave a lock");
  } finally {
    fs.rmSync(fixture.base, { recursive: true, force: true });
  }
});

test("ship-deploy happy path deploys the exact candidate and prints only the success line to stdout", () => {
  const fixture = makeFixture({ dirty: true });
  try {
    const result = runShipDeploy(fixture, [fixture.sha]);
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    assert.equal(result.stdout, `SHIP_DEPLOYED_SHA=${fixture.sha}\n`);
    assert.ok(!result.stderr.includes("SHIP_DEPLOYED_SHA="), "success line must not appear on stderr");
    const calls = readCalls(fixture);
    assert.match(calls, /docker build .*localhost:5104\/companion\/web:/);
    assert.match(calls, /docker push /);
    assert.match(calls, /helm upgrade --install companion /);
    assert.match(calls, /web\.image\.digest=sha256:aaa/);
    assert.match(calls, /worker\.image\.digest=sha256:bbb/);
    const owner = lockOwner(fixture);
    assert.equal(owner.sha, fixture.sha);
    assert.equal(owner.phase, "deployed");
    assert.equal(owner.webDigest, WEB_DIGEST);
    assert.equal(owner.workerDigest, WORKER_DIGEST);
    assert.equal(owner.webPod, "companion-web-test-0");
    assert.equal(owner.workerPod, "companion-worker-test-0");
  } finally {
    fs.rmSync(fixture.base, { recursive: true, force: true });
  }
});

test("ship-deploy refuses to race an existing lock", () => {
  const fixture = makeFixture();
  try {
    fs.mkdirSync(path.join(fixture.repo, ".git/ship-deploy.lock"));
    fs.writeFileSync(path.join(fixture.repo, ".git/ship-deploy.lock/owner.json"), `${JSON.stringify({ sha: fixture.sha, phase: "deployed" })}\n`);
    const result = runShipDeploy(fixture, [fixture.sha]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /lock already exists/);
    assert.ok(!readCalls(fixture).includes("docker build"), "must not build while another candidate holds the lock");
  } finally {
    fs.rmSync(fixture.base, { recursive: true, force: true });
  }
});

test("ship-deploy keeps the lock after a Helm failure and removes it after an early build failure", () => {
  const helmFail = makeFixture();
  try {
    const result = runShipDeploy(helmFail, [helmFail.sha], { FAKE_HELM_FAIL: "1" });
    assert.notEqual(result.status, 0);
    assert.equal(lockOwner(helmFail).phase, "failed-after-helm");
  } finally {
    fs.rmSync(helmFail.base, { recursive: true, force: true });
  }
  const buildFail = makeFixture();
  try {
    const result = runShipDeploy(buildFail, [buildFail.sha], { FAKE_DOCKER_BUILD_FAIL: "1" });
    assert.notEqual(result.status, 0);
    assert.ok(!fs.existsSync(path.join(buildFail.repo, ".git/ship-deploy.lock")), "early failure must remove the lock");
  } finally {
    fs.rmSync(buildFail.base, { recursive: true, force: true });
  }
});

test("ship-deploy blocks on cluster identity mismatch, registry tag reuse, and values mismatch before deploying", () => {
  const wrongContext = makeFixture();
  try {
    const result = runShipDeploy(wrongContext, [wrongContext.sha], { FAKE_WRONG_CONTEXT: "1" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /context does not match/);
    assert.ok(!readCalls(wrongContext).includes("docker build"));
  } finally {
    fs.rmSync(wrongContext.base, { recursive: true, force: true });
  }
  const tagExists = makeFixture();
  try {
    const result = runShipDeploy(tagExists, [tagExists.sha], { FAKE_TAG_EXISTS: "1" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /already exists/);
  } finally {
    fs.rmSync(tagExists.base, { recursive: true, force: true });
  }
  const badValues = makeFixture({
    valuesText: [
      "deployment:",
      "  purpose: production",
      "  namespace: companion-np",
      "web:",
      "  image:",
      "    repository: localhost:5104/companion/web",
      "  testGate:",
      "    enabled: true",
      "    port: 3100",
      "worker:",
      "  enabled: true",
      "  image:",
      "    repository: localhost:5104/companion/worker",
      "",
    ].join("\n"),
  });
  try {
    const result = runShipDeploy(badValues, [badValues.sha]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /purpose/);
    assert.ok(!readCalls(badValues).includes("docker build"));
  } finally {
    fs.rmSync(badValues.base, { recursive: true, force: true });
  }
});
