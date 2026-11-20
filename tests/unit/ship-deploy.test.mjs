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

// The real-render regression fixtures delegate `helm template` to the
// local Helm binary against the repository's real Companion chart.
// Helm templating is a local render (no cluster, registry, or network),
// but the binary must exist; real-render tests skip cleanly when it
// does not. The fabricated shim path never consults this.
const REAL_HELM = (() => {
  const probe = spawnSync(process.platform === "win32" ? "where" : "which", ["helm"], {
    encoding: "utf8",
  });
  if (probe.status === 0 && probe.stdout.trim()) {
    return probe.stdout.trim().split("\n")[0];
  }
  for (const candidate of ["/usr/bin/helm", "/usr/local/bin/helm", "/opt/homebrew/bin/helm"]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
})();

const WEB_DIGEST = `sha256:${"a".repeat(64)}`;
const WORKER_DIGEST = `sha256:${"b".repeat(64)}`;
const OLD_DIGEST = `sha256:${"c".repeat(64)}`;
const WRONG_DIGEST = `sha256:${"d".repeat(64)}`;
const KUBE_SYSTEM_UID = "11111111-1111-4111-8111-111111111111";
const NAMESPACE_UID = "22222222-2222-4222-8222-222222222222";
const WEB_DEPLOY_UID = "33333333-3333-3333-3333-333333333333";
const WORKER_DEPLOY_UID = "44444444-4444-4444-4444-444444444444";
const WEB_RS_UID = "55555555-5555-5555-5555-555555555555";
const WORKER_RS_UID = "66666666-6666-6666-6666-666666666666";
const WEB_POD_UID = "77777777-7777-7777-7777-777777777777";
const WORKER_POD_UID = "88888888-8888-8888-8888-888888888888";
const OLD_WEB_RS_UID = "99999999-9999-9999-9999-999999999999";
const OLD_WEB_POD_UID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const FOREIGN_POD_UID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const FOREIGN_RS_UID = "cccccccc-cccc-cccc-cccc-cccccccccccc";

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

function makeShims(shimDir, logFile, { realRender = false } = {}) {
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
  // Fabricated render for the hermetic fixtures. It deliberately
  // mirrors the real chart's rendered shape: Deployments omit
  // metadata.namespace (applied into the `-n` release namespace) and
  // only the web Deployment carries COMPANION_* / WEB_TEST_GATE_* env.
  // The real-render fixtures instead run the local Helm binary against
  // the repository chart (see makeFixture realRender) and may then
  // mutate the rendered YAML via FAKE_RENDER_MUTATION.
  const fabricatedBranch = `    web_digest=""; worker_digest=""
    for a in "$@"; do
      case "$a" in web.image.digest=*) web_digest="\${a#web.image.digest=}" ;; worker.image.digest=*) worker_digest="\${a#worker.image.digest=}" ;; esac
    done
    [ -n "$web_digest" ] && [ -n "$worker_digest" ] || { echo "helm template missing digest sets" >&2; exit 8; }
    cat <<YAML
apiVersion: apps/v1
kind: Deployment
metadata:
  name: companion-web
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
spec:
  template:
    spec:
      containers:
        - name: worker
          image: "localhost:5104/companion/worker@$worker_digest"
          env:
            - name: WORKER_HTTP_PORT
              value: "8080"
YAML`;
  const realBranch = `    rendered="$(mktemp)"
    if ! "${REAL_HELM}" "$@" > "$rendered" 2>&1; then
      cat -- "$rendered" >&2
      rm -f -- "$rendered"
      exit 8
    fi
    mutation="\${FAKE_RENDER_MUTATION:-}"
    if [ -n "$mutation" ]; then
      python3 - "$rendered" "$mutation" <<'MUTPYEOF' || { rm -f -- "$rendered"; exit 8; }
import sys
import yaml
path, mutation = sys.argv[1], sys.argv[2]
with open(path, encoding="utf-8") as handle:
    docs = [d for d in yaml.safe_load_all(handle) if d]
def deps(suffix):
    return [d for d in docs if d.get("kind") == "Deployment" and d["metadata"]["name"].endswith(suffix)]
def web_envs():
    return deps("-web")[0]["spec"]["template"]["spec"]["containers"][0]["env"]
def set_env(name, value):
    for entry in web_envs():
        if entry["name"] == name:
            entry["value"] = value
            return
    web_envs().append({"name": name, "value": value})
def drop_env(name):
    deps("-web")[0]["spec"]["template"]["spec"]["containers"][0]["env"] = [e for e in web_envs() if e["name"] != name]
if mutation == "explicit-good-namespace":
    for suffix in ("-web", "-worker"):
        deps(suffix)[0]["metadata"]["namespace"] = "companion-np"
elif mutation == "explicit-bad-namespace":
    for suffix in ("-web", "-worker"):
        deps(suffix)[0]["metadata"]["namespace"] = "companion-prod"
elif mutation == "explicit-empty-namespace":
    for suffix in ("-web", "-worker"):
        deps(suffix)[0]["metadata"]["namespace"] = ""
elif mutation == "web-purpose-missing":
    drop_env("COMPANION_DEPLOYMENT_PURPOSE")
elif mutation == "web-purpose-wrong":
    set_env("COMPANION_DEPLOYMENT_PURPOSE", "production")
elif mutation == "web-namespace-missing":
    drop_env("COMPANION_DEPLOYMENT_NAMESPACE")
elif mutation == "web-namespace-wrong":
    set_env("COMPANION_DEPLOYMENT_NAMESPACE", "companion-prod")
elif mutation == "web-gate-missing":
    drop_env("WEB_TEST_GATE_ENABLED")
elif mutation == "web-gate-wrong":
    set_env("WEB_TEST_GATE_ENABLED", "false")
elif mutation == "image-mismatch":
    container = deps("-web")[0]["spec"]["template"]["spec"]["containers"][0]
    repo = container["image"].split("@", 1)[0]
    container["image"] = repo + "@sha256:" + "c" * 64
else:
    print(f"unknown FAKE_RENDER_MUTATION: {mutation}", file=sys.stderr)
    sys.exit(8)
with open(path, "w", encoding="utf-8") as handle:
    yaml.safe_dump_all(docs, handle, sort_keys=False)
MUTPYEOF
    fi
    cat -- "$rendered"
    rm -f -- "$rendered"`;
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
${realRender ? realBranch : fabricatedBranch}
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
    if [ "\${FAKE_POST_ROLLOUT_SCENARIO:-}" = "deadline-stale-generation" ]; then
      printf '%s\n' '{"metadata":{"name":"companion-web","namespace":"companion-np","uid":"${WEB_DEPLOY_UID}","generation":2},"spec":{"replicas":1,"template":{"spec":{"containers":[{"name":"web","image":"localhost:5104/companion/web@${WEB_DIGEST}"}]}}},"status":{"observedGeneration":1,"updatedReplicas":1,"readyReplicas":1,"availableReplicas":1,"replicas":1}}'
    else
      printf '%s\n' '{"metadata":{"name":"companion-web","namespace":"companion-np","uid":"${WEB_DEPLOY_UID}","generation":2},"spec":{"replicas":1,"template":{"spec":{"containers":[{"name":"web","image":"localhost:5104/companion/web@${WEB_DIGEST}"}]}}},"status":{"observedGeneration":2,"updatedReplicas":1,"readyReplicas":1,"availableReplicas":1,"replicas":1}}'
    fi
    exit 0 ;;
  "get deploy companion-worker -n companion-np -o json")
    printf '%s\n' '{"metadata":{"name":"companion-worker","namespace":"companion-np","uid":"${WORKER_DEPLOY_UID}","generation":2},"spec":{"replicas":1,"template":{"spec":{"containers":[{"name":"worker","image":"localhost:5104/companion/worker@${WORKER_DIGEST}"}]}}},"status":{"observedGeneration":2,"updatedReplicas":1,"readyReplicas":1,"availableReplicas":1,"replicas":1}}'
    exit 0 ;;
  "rollout status deploy/companion-web -n companion-np --timeout=600s") exit 0 ;;
  "rollout status deploy/companion-worker -n companion-np --timeout=600s") exit 0 ;;
  "get pods -n companion-np -o json")
    counter_file="${logFile}.pods-count"
    count=0
    if [ -f "$counter_file" ]; then count=$(cat "$counter_file"); fi
    count=$((count + 1))
    printf '%s' "$count" > "$counter_file"
    scenario="\${FAKE_POST_ROLLOUT_SCENARIO:-}"
    if [ "$scenario" = "terminating-disappears" ] && [ "$count" -eq 1 ]; then
      printf '%s\n' '{"items":[{"metadata":{"name":"companion-web-test-0","namespace":"companion-np","uid":"${WEB_POD_UID}","labels":{"app.kubernetes.io/name":"web","app.kubernetes.io/instance":"companion","pod-template-hash":"webhash01"},"ownerReferences":[{"apiVersion":"apps/v1","kind":"ReplicaSet","name":"companion-web-7d9c8b6f5","uid":"${WEB_RS_UID}","controller":true}]},"spec":{"containers":[{"name":"web","image":"localhost:5104/companion/web@${WEB_DIGEST}"}]},"status":{"phase":"Running","containerStatuses":[{"name":"web","ready":true,"imageID":"localhost:5104/companion/web@${WEB_DIGEST}"}]}},{"metadata":{"name":"companion-web-oldtest-0","namespace":"companion-np","uid":"${OLD_WEB_POD_UID}","deletionTimestamp":"2026-11-19T12:00:00Z","labels":{"app.kubernetes.io/name":"web","app.kubernetes.io/instance":"companion","pod-template-hash":"oldwebhash1"},"ownerReferences":[{"apiVersion":"apps/v1","kind":"ReplicaSet","name":"companion-web-5b4c3d2e1","uid":"${OLD_WEB_RS_UID}","controller":true}]},"spec":{"containers":[{"name":"web","image":"localhost:5104/companion/web@${OLD_DIGEST}"}]},"status":{"phase":"Running","containerStatuses":[{"name":"web","ready":true,"imageID":"localhost:5104/companion/web@${OLD_DIGEST}"}]}},{"metadata":{"name":"companion-worker-test-0","namespace":"companion-np","uid":"${WORKER_POD_UID}","labels":{"app.kubernetes.io/name":"worker","app.kubernetes.io/instance":"companion","pod-template-hash":"workerhash01"},"ownerReferences":[{"apiVersion":"apps/v1","kind":"ReplicaSet","name":"companion-worker-6c8d9e7f6","uid":"${WORKER_RS_UID}","controller":true}]},"spec":{"containers":[{"name":"worker","image":"localhost:5104/companion/worker@${WORKER_DIGEST}"}]},"status":{"phase":"Running","containerStatuses":[{"name":"worker","ready":true,"imageID":"localhost:5104/companion/worker@${WORKER_DIGEST}"}]}}]}'
    elif [ "$scenario" = "delayed-ready" ] && [ "$count" -eq 1 ]; then
      printf '%s\n' '{"items":[{"metadata":{"name":"companion-web-test-0","namespace":"companion-np","uid":"${WEB_POD_UID}","labels":{"app.kubernetes.io/name":"web","app.kubernetes.io/instance":"companion","pod-template-hash":"webhash01"},"ownerReferences":[{"apiVersion":"apps/v1","kind":"ReplicaSet","name":"companion-web-7d9c8b6f5","uid":"${WEB_RS_UID}","controller":true}]},"spec":{"containers":[{"name":"web","image":"localhost:5104/companion/web@${WEB_DIGEST}"}]},"status":{"phase":"Running","containerStatuses":[{"name":"web","ready":false,"imageID":""}]}},{"metadata":{"name":"companion-worker-test-0","namespace":"companion-np","uid":"${WORKER_POD_UID}","labels":{"app.kubernetes.io/name":"worker","app.kubernetes.io/instance":"companion","pod-template-hash":"workerhash01"},"ownerReferences":[{"apiVersion":"apps/v1","kind":"ReplicaSet","name":"companion-worker-6c8d9e7f6","uid":"${WORKER_RS_UID}","controller":true}]},"spec":{"containers":[{"name":"worker","image":"localhost:5104/companion/worker@${WORKER_DIGEST}"}]},"status":{"phase":"Running","containerStatuses":[{"name":"worker","ready":true,"imageID":"localhost:5104/companion/worker@${WORKER_DIGEST}"}]}}]}'
    elif [ "$scenario" = "foreign-duplicate" ]; then
      printf '%s\n' '{"items":[{"metadata":{"name":"companion-web-test-0","namespace":"companion-np","uid":"${WEB_POD_UID}","labels":{"app.kubernetes.io/name":"web","app.kubernetes.io/instance":"companion","pod-template-hash":"webhash01"},"ownerReferences":[{"apiVersion":"apps/v1","kind":"ReplicaSet","name":"companion-web-7d9c8b6f5","uid":"${WEB_RS_UID}","controller":true}]},"spec":{"containers":[{"name":"web","image":"localhost:5104/companion/web@${WEB_DIGEST}"}]},"status":{"phase":"Running","containerStatuses":[{"name":"web","ready":true,"imageID":"localhost:5104/companion/web@${WEB_DIGEST}"}]}},{"metadata":{"name":"companion-web-foreign-0","namespace":"companion-np","uid":"${FOREIGN_POD_UID}","labels":{"app.kubernetes.io/name":"web","app.kubernetes.io/instance":"companion","pod-template-hash":"webhash01"},"ownerReferences":[{"apiVersion":"apps/v1","kind":"ReplicaSet","name":"companion-web-foreign","uid":"${FOREIGN_RS_UID}","controller":true}]},"spec":{"containers":[{"name":"web","image":"localhost:5104/companion/web@${WEB_DIGEST}"}]},"status":{"phase":"Running","containerStatuses":[{"name":"web","ready":true,"imageID":"localhost:5104/companion/web@${WEB_DIGEST}"}]}},{"metadata":{"name":"companion-worker-test-0","namespace":"companion-np","uid":"${WORKER_POD_UID}","labels":{"app.kubernetes.io/name":"worker","app.kubernetes.io/instance":"companion","pod-template-hash":"workerhash01"},"ownerReferences":[{"apiVersion":"apps/v1","kind":"ReplicaSet","name":"companion-worker-6c8d9e7f6","uid":"${WORKER_RS_UID}","controller":true}]},"spec":{"containers":[{"name":"worker","image":"localhost:5104/companion/worker@${WORKER_DIGEST}"}]},"status":{"phase":"Running","containerStatuses":[{"name":"worker","ready":true,"imageID":"localhost:5104/companion/worker@${WORKER_DIGEST}"}]}}]}'
    elif [ "$scenario" = "stale-ownership" ]; then
      printf '%s\n' '{"items":[{"metadata":{"name":"companion-web-test-0","namespace":"companion-np","uid":"${WEB_POD_UID}","labels":{"app.kubernetes.io/name":"web","app.kubernetes.io/instance":"companion","pod-template-hash":"webhash01"},"ownerReferences":[{"apiVersion":"apps/v1","kind":"ReplicaSet","name":"companion-web-5b4c3d2e1","uid":"${OLD_WEB_RS_UID}","controller":true}]},"spec":{"containers":[{"name":"web","image":"localhost:5104/companion/web@${WEB_DIGEST}"}]},"status":{"phase":"Running","containerStatuses":[{"name":"web","ready":true,"imageID":"localhost:5104/companion/web@${WEB_DIGEST}"}]}},{"metadata":{"name":"companion-worker-test-0","namespace":"companion-np","uid":"${WORKER_POD_UID}","labels":{"app.kubernetes.io/name":"worker","app.kubernetes.io/instance":"companion","pod-template-hash":"workerhash01"},"ownerReferences":[{"apiVersion":"apps/v1","kind":"ReplicaSet","name":"companion-worker-6c8d9e7f6","uid":"${WORKER_RS_UID}","controller":true}]},"spec":{"containers":[{"name":"worker","image":"localhost:5104/companion/worker@${WORKER_DIGEST}"}]},"status":{"phase":"Running","containerStatuses":[{"name":"worker","ready":true,"imageID":"localhost:5104/companion/worker@${WORKER_DIGEST}"}]}}]}'
    elif [ "$scenario" = "wrong-digest" ]; then
      printf '%s\n' '{"items":[{"metadata":{"name":"companion-web-test-0","namespace":"companion-np","uid":"${WEB_POD_UID}","labels":{"app.kubernetes.io/name":"web","app.kubernetes.io/instance":"companion","pod-template-hash":"webhash01"},"ownerReferences":[{"apiVersion":"apps/v1","kind":"ReplicaSet","name":"companion-web-7d9c8b6f5","uid":"${WEB_RS_UID}","controller":true}]},"spec":{"containers":[{"name":"web","image":"localhost:5104/companion/web@${WEB_DIGEST}"}]},"status":{"phase":"Running","containerStatuses":[{"name":"web","ready":true,"imageID":"localhost:5104/companion/web@${WRONG_DIGEST}"}]}},{"metadata":{"name":"companion-worker-test-0","namespace":"companion-np","uid":"${WORKER_POD_UID}","labels":{"app.kubernetes.io/name":"worker","app.kubernetes.io/instance":"companion","pod-template-hash":"workerhash01"},"ownerReferences":[{"apiVersion":"apps/v1","kind":"ReplicaSet","name":"companion-worker-6c8d9e7f6","uid":"${WORKER_RS_UID}","controller":true}]},"spec":{"containers":[{"name":"worker","image":"localhost:5104/companion/worker@${WORKER_DIGEST}"}]},"status":{"phase":"Running","containerStatuses":[{"name":"worker","ready":true,"imageID":"localhost:5104/companion/worker@${WORKER_DIGEST}"}]}}]}'
    else
      printf '%s\n' '{"items":[{"metadata":{"name":"companion-web-test-0","namespace":"companion-np","uid":"${WEB_POD_UID}","labels":{"app.kubernetes.io/name":"web","app.kubernetes.io/instance":"companion","pod-template-hash":"webhash01"},"ownerReferences":[{"apiVersion":"apps/v1","kind":"ReplicaSet","name":"companion-web-7d9c8b6f5","uid":"${WEB_RS_UID}","controller":true}]},"spec":{"containers":[{"name":"web","image":"localhost:5104/companion/web@${WEB_DIGEST}"}]},"status":{"phase":"Running","containerStatuses":[{"name":"web","ready":true,"imageID":"localhost:5104/companion/web@${WEB_DIGEST}"}]}},{"metadata":{"name":"companion-worker-test-0","namespace":"companion-np","uid":"${WORKER_POD_UID}","labels":{"app.kubernetes.io/name":"worker","app.kubernetes.io/instance":"companion","pod-template-hash":"workerhash01"},"ownerReferences":[{"apiVersion":"apps/v1","kind":"ReplicaSet","name":"companion-worker-6c8d9e7f6","uid":"${WORKER_RS_UID}","controller":true}]},"spec":{"containers":[{"name":"worker","image":"localhost:5104/companion/worker@${WORKER_DIGEST}"}]},"status":{"phase":"Running","containerStatuses":[{"name":"worker","ready":true,"imageID":"localhost:5104/companion/worker@${WORKER_DIGEST}"}]}}]}'
    fi
    exit 0 ;;
  "get rs -n companion-np -o json")
    scenario="\${FAKE_POST_ROLLOUT_SCENARIO:-}"
    if [ "$scenario" = "terminating-disappears" ] || [ "$scenario" = "stale-ownership" ]; then
      printf '%s\n' '{"items":[{"metadata":{"name":"companion-web-5b4c3d2e1","namespace":"companion-np","uid":"${OLD_WEB_RS_UID}","labels":{"pod-template-hash":"oldwebhash1"},"annotations":{"deployment.kubernetes.io/revision":"1"},"ownerReferences":[{"apiVersion":"apps/v1","kind":"Deployment","name":"companion-web","uid":"${WEB_DEPLOY_UID}","controller":true}]},"spec":{"template":{"spec":{"containers":[{"name":"web","image":"localhost:5104/companion/web@${OLD_DIGEST}"}]}}}},{"metadata":{"name":"companion-web-7d9c8b6f5","namespace":"companion-np","uid":"${WEB_RS_UID}","labels":{"pod-template-hash":"webhash01"},"annotations":{"deployment.kubernetes.io/revision":"2"},"ownerReferences":[{"apiVersion":"apps/v1","kind":"Deployment","name":"companion-web","uid":"${WEB_DEPLOY_UID}","controller":true}]},"spec":{"template":{"spec":{"containers":[{"name":"web","image":"localhost:5104/companion/web@${WEB_DIGEST}"}]}}}},{"metadata":{"name":"companion-worker-6c8d9e7f6","namespace":"companion-np","uid":"${WORKER_RS_UID}","labels":{"pod-template-hash":"workerhash01"},"annotations":{"deployment.kubernetes.io/revision":"2"},"ownerReferences":[{"apiVersion":"apps/v1","kind":"Deployment","name":"companion-worker","uid":"${WORKER_DEPLOY_UID}","controller":true}]},"spec":{"template":{"spec":{"containers":[{"name":"worker","image":"localhost:5104/companion/worker@${WORKER_DIGEST}"}]}}}}]}'
    else
      printf '%s\n' '{"items":[{"metadata":{"name":"companion-web-7d9c8b6f5","namespace":"companion-np","uid":"${WEB_RS_UID}","labels":{"pod-template-hash":"webhash01"},"annotations":{"deployment.kubernetes.io/revision":"2"},"ownerReferences":[{"apiVersion":"apps/v1","kind":"Deployment","name":"companion-web","uid":"${WEB_DEPLOY_UID}","controller":true}]},"spec":{"template":{"spec":{"containers":[{"name":"web","image":"localhost:5104/companion/web@${WEB_DIGEST}"}]}}}},{"metadata":{"name":"companion-worker-6c8d9e7f6","namespace":"companion-np","uid":"${WORKER_RS_UID}","labels":{"pod-template-hash":"workerhash01"},"annotations":{"deployment.kubernetes.io/revision":"2"},"ownerReferences":[{"apiVersion":"apps/v1","kind":"Deployment","name":"companion-worker","uid":"${WORKER_DEPLOY_UID}","controller":true}]},"spec":{"template":{"spec":{"containers":[{"name":"worker","image":"localhost:5104/companion/worker@${WORKER_DIGEST}"}]}}}}]}'
    fi
    exit 0 ;;
esac
echo "unexpected kubectl call: $*" >&2
exit 4
`;
  writeFile(path.join(shimDir, "docker"), docker, 0o755);
  writeFile(path.join(shimDir, "helm"), helm, 0o755);
  writeFile(path.join(shimDir, "kubectl"), kubectl, 0o755);
}

function makeFixture({ identityOverrides = {}, valuesText = null, dirty = false, realRender = false } = {}) {
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
  if (realRender) {
    // Commit the repository's real chart so the immutable candidate
    // archive carries the production templates; the helm shim then
    // renders that chart with the local Helm binary. The fixture
    // values below are non-secret placeholders (existing-Secret names
    // are references only; no Secret values are ever supplied).
    fs.cpSync(path.join(repoRoot, "deploy", "helm", "companion"), path.join(repo, "deploy", "helm", "companion"), {
      recursive: true,
    });
  } else {
    writeFile(path.join(repo, "deploy/helm/companion/Chart.yaml"), "apiVersion: v2\nname: companion\nversion: 0.1.0\n");
  }
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
  // Synthetic non-secret values. The extra web/worker fields are
  // required only by the real chart render (realRender fixtures); the
  // values-parse stage in ship-deploy ignores them, so the fabricated
  // fixtures behave identically with or without them.
  const defaultValues = [
    "deployment:",
    "  purpose: non-production",
    "  namespace: companion-np",
    "web:",
    "  image:",
    "    repository: localhost:5104/companion/web",
    "  ingress:",
    "    host: app.example.com",
    "  env:",
    '    WEB_PUBLIC_URL: "https://companion.example.com"',
    '    WEB_OIDC_ISSUER_URL: "https://keycloak.example.com/realms/companion"',
    '    WEB_OIDC_CLIENT_ID: "companion-web"',
    '    WEB_OWNER_SUBJECTS: "owner-subject"',
    "  existingSecret: web-secrets",
    "  testGate:",
    "    enabled: true",
    "    port: 3100",
    "    existingSecret: web-test-gate-secrets",
    "worker:",
    "  enabled: true",
    "  image:",
    "    repository: localhost:5104/companion/worker",
    "  existingSecret: worker-secrets",
    "",
  ].join("\n");
  writeFile(path.join(repo, ".private/deploy/non-production-values.yaml"), valuesText ?? defaultValues);
  if (dirty) writeFile(path.join(repo, "dirty.txt"), "uncommitted dirty file that must not enter the build\n");
  makeShims(shimDir, logFile, { realRender });
  return { base, repo, shimDir, logFile, sha };
}

function runShipDeploy(fixture, args, extraEnv = {}) {
  const env = {
    ...process.env,
    PATH: `${fixture.shimDir}:${process.env.PATH}`,
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

function assertNoLock(fixture) {
  const lockPath = path.join(fixture.repo, ".git/ship-deploy.lock");
  assert.ok(!fs.existsSync(lockPath), "ship-deploy must never create a Ship lock");
  const deploySource = fs.readFileSync(path.join(repoRoot, "scripts", "ship-deploy"), "utf8");
  assert.ok(!deploySource.includes("ship-deploy.lock"), "ship-deploy source must not reference a Ship lock");
  assert.ok(!deploySource.includes("SHIP_DEPLOY_EXCLUSIVE_WINDOW"), "ship-deploy source must not reference a reservation gate");
}

test("ship-deploy rejects argument violations without calling tools", () => {
  const fixture = makeFixture();
  try {
    for (const args of [[], [fixture.sha, "extra"], ["abc"], [fixture.sha.toUpperCase()], ["g".repeat(40)]]) {
      const result = runShipDeploy(fixture, args);
      assert.notEqual(result.status, 0, `args ${JSON.stringify(args)} must fail`);
      assert.ok(!result.stdout.includes("SHIP_DEPLOYED_SHA="), "no success line on failure");
    }
    const unknown = runShipDeploy(fixture, ["f".repeat(40)]);
    assert.notEqual(unknown.status, 0);
    assert.match(unknown.stderr, /not a commit/);
    assert.equal(readCalls(fixture), "", "no docker/helm/kubectl shim should be called for early rejections");
    assertNoLock(fixture);
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
    assertNoLock(fixture);
  } finally {
    fs.rmSync(fixture.base, { recursive: true, force: true });
  }
});

test("ship-deploy waits for a recognized terminating old pod to disappear (strict verifier)", () => {
  const fixture = makeFixture();
  try {
    const result = runShipDeploy(fixture, [fixture.sha], { FAKE_POST_ROLLOUT_SCENARIO: "terminating-disappears" });
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    assert.equal(result.stdout, `SHIP_DEPLOYED_SHA=${fixture.sha}\n`);
    assert.match(result.stderr, /post-rollout verification waiting: web:retiring_pods_present/);
    assertNoLock(fixture);
  } finally {
    fs.rmSync(fixture.base, { recursive: true, force: true });
  }
});

test("ship-deploy waits for delayed Ready/imageID to settle (strict verifier)", () => {
  const fixture = makeFixture();
  try {
    const result = runShipDeploy(fixture, [fixture.sha], { FAKE_POST_ROLLOUT_SCENARIO: "delayed-ready" });
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    assert.equal(result.stdout, `SHIP_DEPLOYED_SHA=${fixture.sha}\n`);
    assert.match(result.stderr, /post-rollout verification waiting: web:pod_not_ready/);
    assertNoLock(fixture);
  } finally {
    fs.rmSync(fixture.base, { recursive: true, force: true });
  }
});

test("ship-deploy fails closed on foreign duplicate, stale ownership, and wrong digest with no lock", () => {
  const cases = [
    ["foreign-duplicate", "duplicate_live_pods"],
    ["stale-ownership", "pod_stale_owner"],
    ["wrong-digest", "pod_wrong_digest"],
  ];
  for (const [scenario, predicate] of cases) {
    const fixture = makeFixture();
    try {
      const result = runShipDeploy(fixture, [fixture.sha], { FAKE_POST_ROLLOUT_SCENARIO: scenario });
      assert.notEqual(result.status, 0, `scenario ${scenario} must fail`);
      assert.equal(result.stdout, "", `scenario ${scenario} must not print the success line`);
      assert.match(result.stderr, new RegExp(predicate), `scenario ${scenario} diagnostic`);
      assert.ok(!result.stderr.includes(WEB_POD_UID), `scenario ${scenario} stderr must not leak pod UIDs`);
      assert.ok(!result.stderr.includes(WEB_DIGEST), `scenario ${scenario} stderr must not leak digests`);
      assert.ok(!result.stderr.includes(WRONG_DIGEST), `scenario ${scenario} stderr must not leak digests`);
      assertNoLock(fixture);
    } finally {
      fs.rmSync(fixture.base, { recursive: true, force: true });
    }
  }
});

test("ship-deploy fails after the shared deadline on stale generation with no lock", () => {
  const fixture = makeFixture();
  try {
    const result = runShipDeploy(fixture, [fixture.sha], { FAKE_POST_ROLLOUT_SCENARIO: "deadline-stale-generation" });
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /did not settle within 30s/);
    assert.match(result.stderr, /observed_generation_stale/);
    assert.ok(!result.stderr.includes(WEB_POD_UID), "deadline stderr must not leak pod UIDs");
    assertNoLock(fixture);
  } finally {
    fs.rmSync(fixture.base, { recursive: true, force: true });
  }
});

test("ship-deploy ignores a stale pre-existing lock directory (no lock consulted)", () => {
  const fixture = makeFixture();
  try {
    fs.mkdirSync(path.join(fixture.repo, ".git/ship-deploy.lock"));
    fs.writeFileSync(path.join(fixture.repo, ".git/ship-deploy.lock/stale-owner.txt"), "stale\n");
    const result = runShipDeploy(fixture, [fixture.sha]);
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    assert.equal(result.stdout, `SHIP_DEPLOYED_SHA=${fixture.sha}\n`);
    // The stale directory is untouched and unused: success proves the
    // entry point neither consults nor requires any lock.
    assert.equal(fs.readFileSync(path.join(fixture.repo, ".git/ship-deploy.lock/stale-owner.txt"), "utf8"), "stale\n");
    assert.ok(readCalls(fixture).includes("docker build"), "must build even when a stale lock directory exists");
  } finally {
    fs.rmSync(fixture.base, { recursive: true, force: true });
  }
});

test("ship-deploy creates no lock after a Helm failure or an early build failure", () => {
  const helmFail = makeFixture();
  try {
    const result = runShipDeploy(helmFail, [helmFail.sha], { FAKE_HELM_FAIL: "1" });
    assert.notEqual(result.status, 0);
    assert.ok(!result.stdout.includes("SHIP_DEPLOYED_SHA="));
    assertNoLock(helmFail);
  } finally {
    fs.rmSync(helmFail.base, { recursive: true, force: true });
  }
  const buildFail = makeFixture();
  try {
    const result = runShipDeploy(buildFail, [buildFail.sha], { FAKE_DOCKER_BUILD_FAIL: "1" });
    assert.notEqual(result.status, 0);
    assert.ok(!result.stdout.includes("SHIP_DEPLOYED_SHA="));
    assertNoLock(buildFail);
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

// --- Real-chart render regression -------------------------------
// The fixtures above fabricate their rendered YAML. These cases run
// the repository's real Companion chart through the local Helm
// binary, guarding the shape the production chart actually renders:
// Deployments omit metadata.namespace, and only the web workload
// carries the deployment-purpose attestation and the test-entry gate.
// The pre-fix guard required an explicit companion-np namespace and
// worker COMPANION_* markers, so it rejected every real render after
// the images were pushed and before the Helm upgrade.

test(
  "ship-deploy accepts the real Helm-rendered chart (omitted namespaces, web-only markers)",
  { skip: !REAL_HELM },
  () => {
    const fixture = makeFixture({ realRender: true });
    try {
      const result = runShipDeploy(fixture, [fixture.sha]);
      assert.equal(result.status, 0, `stderr: ${result.stderr}`);
      assert.equal(result.stdout, `SHIP_DEPLOYED_SHA=${fixture.sha}\n`);
      assert.match(readCalls(fixture), /helm template companion /);
      assert.match(readCalls(fixture), /helm upgrade --install companion /);
    } finally {
      fs.rmSync(fixture.base, { recursive: true, force: true });
    }
  },
);

test(
  "ship-deploy accepts explicit companion-np namespaces in the real render",
  { skip: !REAL_HELM },
  () => {
    const fixture = makeFixture({ realRender: true });
    try {
      const result = runShipDeploy(fixture, [fixture.sha], {
        FAKE_RENDER_MUTATION: "explicit-good-namespace",
      });
      assert.equal(result.status, 0, `stderr: ${result.stderr}`);
      assert.equal(result.stdout, `SHIP_DEPLOYED_SHA=${fixture.sha}\n`);
    } finally {
      fs.rmSync(fixture.base, { recursive: true, force: true });
    }
  },
);

test(
  "ship-deploy rejects conflicting/invalid namespaces, degraded web markers, and image mismatch in the real render",
  { skip: !REAL_HELM },
  () => {
    for (const mutation of [
      "explicit-bad-namespace",
      "explicit-empty-namespace",
      "web-purpose-missing",
      "web-purpose-wrong",
      "web-namespace-missing",
      "web-namespace-wrong",
      "web-gate-missing",
      "web-gate-wrong",
      "image-mismatch",
    ]) {
      const fixture = makeFixture({ realRender: true });
      try {
        const result = runShipDeploy(fixture, [fixture.sha], { FAKE_RENDER_MUTATION: mutation });
        assert.notEqual(result.status, 0, `mutation ${mutation} must fail`);
        assert.ok(!result.stdout.includes("SHIP_DEPLOYED_SHA="), `mutation ${mutation} must not print success`);
        assert.match(result.stderr, /rendered candidate chart does not match/);
        const calls = readCalls(fixture);
        assert.match(calls, /helm template companion /, `mutation ${mutation} must reach the render check`);
        assert.ok(
          !calls.includes("helm upgrade"),
          `mutation ${mutation} must fail before the Helm upgrade (pre-Helm failure)`,
        );
        assertNoLock(fixture);
      } finally {
        fs.rmSync(fixture.base, { recursive: true, force: true });
      }
    }
  },
);
