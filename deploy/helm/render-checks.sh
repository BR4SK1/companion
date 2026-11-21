#!/bin/sh
# Render-time checks for the companion Helm chart (offline, no cluster access).
set -eu

CHART_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/companion" && pwd)"

if ! command -v helm >/dev/null 2>&1; then
  echo "helm is required to run chart render checks" >&2
  exit 1
fi
if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 is required for structural manifest checks" >&2
  exit 1
fi

TMPDIR_CHECKS="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_CHECKS"' EXIT

BASE_SETS="web.image.repository=registry.example/companion/web,web.image.tag=test"
BASE_SETS="$BASE_SETS,web.existingSecret=companion-secrets"
BASE_SETS="$BASE_SETS,web.ingress.host=companion.example.com"
BASE_SETS="$BASE_SETS,web.env.WEB_PUBLIC_URL=https://companion.example.com"
BASE_SETS="$BASE_SETS,web.env.WEB_OIDC_ISSUER_URL=https://keycloak.example.com/realms/companion"
BASE_SETS="$BASE_SETS,web.env.WEB_OIDC_CLIENT_ID=companion-web"
BASE_SETS="$BASE_SETS,web.env.WEB_OWNER_SUBJECTS=owner-1"
BASE_SETS="$BASE_SETS,worker.image.repository=registry.example/companion/worker,worker.image.tag=test"
BASE_SETS="$BASE_SETS,worker.existingSecret=companion-secrets"

GATE_SETS="web.testGate.enabled=true,web.testGate.port=3100,web.testGate.existingSecret=companion-test-gate"
LB_SETS="web.loadBalancer.enabled=true,web.loadBalancer.hostPort=8443"

render_to() {
  out="$1"
  sets="$2"
  helm template companion "$CHART_DIR" -n companion-np --set "$sets" >"$out"
}

render_must_fail() {
  sets="$1"
  expected="$2"
  label="$3"
  if out="$(helm template companion "$CHART_DIR" -n companion-np --set "$sets" 2>&1)"; then
    echo "FAIL: expected helm template to fail for $label, but it succeeded" >&2
    exit 1
  fi
  case "$out" in
    *"$expected"*)
      echo "ok    - rejected: $label"
      ;;
    *)
      echo "FAIL: $label failed with unexpected message: $out" >&2
      exit 1
      ;;
  esac
}

render_to "$TMPDIR_CHECKS/disabled.yaml" "$BASE_SETS"
render_to "$TMPDIR_CHECKS/enabled.yaml" "$BASE_SETS,$GATE_SETS"
render_to "$TMPDIR_CHECKS/lb.yaml" "$BASE_SETS,$LB_SETS"
render_to "$TMPDIR_CHECKS/pinned.yaml" \
  "$BASE_SETS,web.image.digest=sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa,worker.image.digest=sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

python3 - "$TMPDIR_CHECKS/disabled.yaml" "$TMPDIR_CHECKS/enabled.yaml" "$TMPDIR_CHECKS/lb.yaml" "$TMPDIR_CHECKS/pinned.yaml" <<'PY'
import sys, yaml

disabled_path, enabled_path, lb_path, pinned_path = sys.argv[1:5]

def load(path):
    with open(path, encoding="utf-8") as fh:
        return [doc for doc in yaml.safe_load_all(fh) if doc is not None]

def by_kind_name(docs, kind, name):
    matches = [d for d in docs if d.get("kind") == kind and d.get("metadata", {}).get("name") == name]
    assert len(matches) == 1, f"expected 1 {kind}/{name}, got {len(matches)}"
    return matches[0]

def web_container(docs):
    containers = by_kind_name(docs, "Deployment", "companion-web")["spec"]["template"]["spec"]["containers"]
    assert len(containers) == 1
    return containers[0]

def lb_services(docs):
    return [d for d in docs if d.get("kind") == "Service" and d.get("spec", {}).get("type") == "LoadBalancer"]

# 1. Default (gate disabled): single port, no gate env, no LB Service.
disabled_docs = load(disabled_path)
c_dis = web_container(disabled_docs)
assert [(p["name"], p["containerPort"]) for p in c_dis["ports"]] == [("http", 3000)]
env_dis = {e["name"]: e for e in c_dis["env"]}
for forbidden in ("WEB_TEST_GATE_ENABLED", "WEB_TEST_GATE_PORT", "WEB_TEST_GATE_SESSION_SECRET"):
    assert forbidden not in env_dis, f"unexpected {forbidden}"
assert lb_services(disabled_docs) == []
print("ok    - gate-disabled Deployment and Services valid")

# 2. Gate enabled: loopback test-entry port + gate env from separate secret, still no Service/Ingress for 3100.
enabled_docs = load(enabled_path)
c_en = web_container(enabled_docs)
assert [(p["name"], p["containerPort"]) for p in c_en["ports"]] == [("http", 3000), ("test-entry", 3100)]
env_en = {e["name"]: e for e in c_en["env"]}
assert env_en["WEB_TEST_GATE_ENABLED"]["value"] == "true"
assert env_en["WEB_TEST_GATE_PORT"]["value"] == "3100"
secret_ref = env_en["WEB_TEST_GATE_SESSION_SECRET"]["valueFrom"]["secretKeyRef"]
assert secret_ref == {"name": "companion-test-gate", "key": "WEB_TEST_GATE_SESSION_SECRET"}
for svc in [d for d in enabled_docs if d.get("kind") == "Service"]:
    for p in svc["spec"].get("ports", []):
        assert p.get("port") != 3100 and p.get("targetPort") != "test-entry"
assert lb_services(enabled_docs) == []
print("ok    - gate-enabled Deployment valid and unexposed")

# 3. LoadBalancer enabled: renders companion-web-lb on hostPort 8443 -> http.
lb_docs = load(lb_path)
lbs = lb_services(lb_docs)
assert len(lbs) == 1
lb = lbs[0]
assert lb["metadata"]["name"] == "companion-web-lb"
assert lb["spec"]["ports"] == [{"name": "http", "port": 8443, "targetPort": "http"}]
print("ok    - LoadBalancer Service valid")

# 4. Digest pins render repository@digest instead of repository:tag.
pinned_docs = load(pinned_path)
web_img = web_container(pinned_docs)["image"]
worker_img = by_kind_name(pinned_docs, "Deployment", "companion-worker")["spec"]["template"]["spec"]["containers"][0]["image"]
assert web_img == "registry.example/companion/web@sha256:" + "a" * 64, web_img
assert worker_img == "registry.example/companion/worker@sha256:" + "b" * 64, worker_img
print("ok    - image digest pins render repository@digest")
PY

# Negative guards
render_must_fail "$BASE_SETS,$GATE_SETS,$LB_SETS" "cannot both be true" "gate and LoadBalancer together"
render_must_fail "$BASE_SETS,web.testGate.enabled=true,web.testGate.port=3100" "web.testGate.existingSecret is required" "gate without secret"
render_must_fail "$BASE_SETS,web.testGate.enabled=true,web.testGate.port=3100,web.testGate.existingSecret=companion-secrets" "must be a separate Secret" "gate reusing owner secret"
render_must_fail "$BASE_SETS,$GATE_SETS,web.testGate.port=3000" "must differ from web.containerPort" "gate port equals containerPort"
render_must_fail "$BASE_SETS,$GATE_SETS,web.testGate.port=70000" "between 1 and 65535" "gate port out of range"
render_must_fail "$BASE_SETS,web.env.WEB_TEST_GATE_ENABLED=true" "must not set WEB_TEST_GATE_ENABLED" "WEB_TEST_GATE_* in web.env"
render_must_fail "$BASE_SETS,web.loadBalancer.enabled=true" "web.loadBalancer.hostPort must be an integer" "LoadBalancer without hostPort"
render_must_fail "$BASE_SETS,web.loadBalancer.enabled=true,web.loadBalancer.hostPort=3000" "must differ from web.service.port" "LoadBalancer port equals service port"
render_must_fail "$BASE_SETS,web.image.digest=not-a-digest" "image digest must be sha256:" "invalid web image digest"
render_must_fail "$BASE_SETS,worker.image.digest=sha256:1234" "image digest must be sha256:" "short worker image digest"

echo "PASS: all companion Helm chart render checks passed"
