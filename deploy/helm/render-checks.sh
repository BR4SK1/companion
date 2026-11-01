#!/bin/sh
# Render-time checks for the companion chart's guards (no cluster access).
#
# Structural checks (offline, schema-aware — parsed with PyYAML, since no
# kube schema validator binary is required):
#   0. both the gate-disabled and gate-enabled Deployments parse into the
#      expected container shape: `ports` holds exactly the expected port
#      objects (name + integer containerPort, never env-shaped entries) and
#      `env` holds exactly the expected variables (name + value or
#      name + valueFrom), including the deployment-purpose attestation
#      (declared purpose/namespace plus the downward-API pod namespace) and
#      — when the gate is enabled — the gate variables from the separate
#      secret. No LoadBalancer Service renders by default (gate-disabled,
#      gate-enabled, or plain production); with the optional web
#      LoadBalancer enabled for a production purpose, exactly one
#      LoadBalancer Service renders, named `*-web-lb`, web-labeled, with a
#      release-scoped selector and the configured host port → the web
#      targetPort — and it is the only LoadBalancer Service in the render.
# Render-guard checks (helm fails rendering):
#   1. missing/unknown deployment purpose or namespace, and a declared
#      namespace differing from the release namespace, fail rendering;
#   2. the test gate may only render for a declared non-production
#      deployment in the one authorized non-production namespace
#      (companion-np): a production purpose or any other namespace fails
#      rendering (no namespace may self-declare itself non-production);
#   3. a production deployment renders normally without the gate;
#   4. reusing the web Secret for the gate fails rendering;
#   5. a gate port colliding with the container/service port fails
#      rendering, and the port must be an integer between 1 and 65535
#      (0, negative, and > 65535 fail; 1 and 65535 are accepted);
#   6. sneaking WEB_TEST_GATE_* or COMPANION_* variables through web.env
#      fails rendering;
#   7. the optional web LoadBalancer Service is production-gated (it fails
#      to render for a non-production purpose), requires an explicit host
#      port, rejects out-of-range ports (1 and 65535 render) and a host
#      port equal to the ClusterIP service port.
#
# Usage: deploy/helm/render-checks.sh   (requires `helm` and `python3` with
# PyYAML)
set -eu

cd "$(dirname "$0")/companion"
RELEASE_NAMESPACE="companion-np"

BASE_SETS='deployment.purpose=non-production,deployment.namespace=companion-np,web.image.repository=registry.example/companion/web,web.image.tag=candidate,web.existingSecret=web-secrets,web.ingress.host=app.example.com,web.env.WEB_PUBLIC_URL=https://companion.example.com,web.env.WEB_OIDC_ISSUER_URL=https://keycloak.example.com/realms/companion,web.env.WEB_OIDC_CLIENT_ID=companion-web,web.env.WEB_OWNER_SUBJECTS=owner-subject,worker.image.repository=registry.example/companion/worker,worker.image.tag=candidate,worker.existingSecret=worker-secrets'

GATE_SETS='web.testGate.enabled=true,web.testGate.existingSecret=web-test-gate-secrets'

# Production-flavored base set (same values, purpose=production).
PROD_SETS="$(printf '%s' "$BASE_SETS" | sed 's/deployment.purpose=non-production/deployment.purpose=production/')"

# Test value for the optional web LoadBalancer host port. Arbitrary
# render-check value, not any real environment's assignment.
LB_TEST_PORT=5150

LB_SETS="web.loadBalancer.enabled=true,web.loadBalancer.hostPort=$LB_TEST_PORT"

pass() { echo "ok    - $1"; }
fail() { echo "FAIL  - $1"; exit 1; }

render() { helm template companion . --namespace "$RELEASE_NAMESPACE" --set "$1"; }
render_must_fail() {
  if render "$1" >/dev/null 2>&1; then return 1; fi
  return 0
}

TMPDIR_CHECK="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_CHECK"' EXIT

# 0a. Gate-disabled render (declared non-production deployment).
render "$BASE_SETS" > "$TMPDIR_CHECK/disabled.yaml"
# 0b. Gate-enabled render.
render "$BASE_SETS,$GATE_SETS" > "$TMPDIR_CHECK/enabled.yaml"
# 0c. Production render without the gate.
render "$PROD_SETS" > "$TMPDIR_CHECK/production.yaml"
# 0d. Production render with the optional web LoadBalancer Service enabled.
render "$PROD_SETS,$LB_SETS" > "$TMPDIR_CHECK/lb.yaml"

python3 - "$TMPDIR_CHECK/disabled.yaml" "$TMPDIR_CHECK/enabled.yaml" "$TMPDIR_CHECK/production.yaml" "$TMPDIR_CHECK/lb.yaml" <<'PYEOF'
import sys

import yaml

disabled_path, enabled_path, production_path, lb_path = sys.argv[1:5]


def load(path):
    with open(path, encoding="utf-8") as handle:
        docs = [doc for doc in yaml.safe_load_all(handle) if doc]
    return docs


def web_deployment(docs):
    matches = [
        doc
        for doc in docs
        if doc.get("kind") == "Deployment"
        and doc["metadata"]["name"].endswith("-web")
    ]
    assert len(matches) == 1, f"expected exactly one web Deployment, got {len(matches)}"
    return matches[0]


def container_of(deployment):
    containers = deployment["spec"]["template"]["spec"]["containers"]
    assert len(containers) == 1, f"expected exactly one container, got {len(containers)}"
    return containers[0]


def loadbalancer_services(docs):
    return [
        doc
        for doc in docs
        if doc.get("kind") == "Service"
        and doc.get("spec", {}).get("type") == "LoadBalancer"
    ]


def check_ports(container, expected):
    ports = container["ports"]
    assert len(ports) == len(expected), f"ports: expected {expected}, got {ports}"
    for port, (name, container_port) in zip(ports, expected):
        # Schema-aware: a port object may only carry the fields the
        # ContainerPort schema knows (the bug class where env entries leak
        # into the ports list shows up as a `value` key or a missing
        # integer containerPort).
        assert set(port.keys()) <= {"name", "containerPort", "protocol", "hostPort"}, (
            f"port object has unexpected keys: {port}"
        )
        assert port.get("name") == name, f"port name mismatch: {port} vs {name}"
        assert isinstance(port.get("containerPort"), int), f"port containerPort must be an integer: {port}"
        assert port["containerPort"] == container_port, f"port mismatch: {port} vs {container_port}"
        assert "value" not in port, f"env-shaped entry inside ports: {port}"


def check_env(container, expected_names, forbidden_prefixes, purpose, namespace):
    env = container["env"]
    names = [entry["name"] for entry in env]
    assert len(names) == len(set(names)), f"duplicate env names: {names}"
    for entry in env:
        # Schema-aware: an env entry is a name plus exactly one of
        # value / valueFrom, never port-shaped.
        assert set(entry.keys()) <= {"name", "value", "valueFrom"}, f"env entry has unexpected keys: {entry}"
        assert isinstance(entry.get("name"), str) and entry["name"], f"env entry without name: {entry}"
        assert ("value" in entry) != ("valueFrom" in entry), f"env entry needs exactly one of value/valueFrom: {entry}"
    for prefix in forbidden_prefixes:
        leaked = [name for name in names if name.startswith(prefix)]
        assert not leaked, f"env must not contain {prefix}*: {leaked}"
    missing = [name for name in expected_names if name not in names]
    assert not missing, f"env is missing expected variables: {missing}"
    by_name = {entry["name"]: entry for entry in env}
    purpose_entry = by_name["COMPANION_DEPLOYMENT_PURPOSE"]
    assert purpose_entry.get("value") == purpose, f"declared purpose mismatch: {purpose_entry}"
    namespace_entry = by_name["COMPANION_DEPLOYMENT_NAMESPACE"]
    assert namespace_entry.get("value") == namespace, f"declared namespace mismatch: {namespace_entry}"
    pod_namespace = by_name["COMPANION_POD_NAMESPACE"]
    value_from = pod_namespace.get("valueFrom")
    assert value_from, f"pod namespace must come from the downward API: {pod_namespace}"
    field_ref = value_from.get("fieldRef", {})
    assert field_ref.get("fieldPath") == "metadata.namespace", f"pod namespace must use metadata.namespace: {pod_namespace}"
    return by_name


with open(disabled_path, encoding="utf-8") as handle:
    disabled_docs = list(yaml.safe_load_all(handle))
disabled = container_of(web_deployment(disabled_docs))
check_ports(disabled, [("http", 3000)])
check_env(
    disabled,
    [
        "PORT", "WEB_PUBLIC_URL", "WEB_OIDC_ISSUER_URL", "WEB_OIDC_CLIENT_ID",
        "WEB_OWNER_SUBJECTS", "WEB_WORKER_URL",
        "WEB_OIDC_CLIENT_SECRET", "WEB_SESSION_SECRET", "WEB_WORKER_TOKEN",
        "COMPANION_DEPLOYMENT_PURPOSE", "COMPANION_DEPLOYMENT_NAMESPACE", "COMPANION_POD_NAMESPACE",
    ],
    ["WEB_TEST_GATE_"],
    "non-production",
    "companion-np",
)
print("ok    - gate-disabled Deployment: ports and env structurally valid, attestation present, no gate variables")

enabled_docs = load(enabled_path)
enabled = container_of(web_deployment(enabled_docs))
check_ports(enabled, [("http", 3000), ("test-entry", 3100)])
env_by_name = check_env(
    enabled,
    [
        "PORT", "WEB_PUBLIC_URL", "WEB_OIDC_ISSUER_URL", "WEB_OIDC_CLIENT_ID",
        "WEB_OWNER_SUBJECTS", "WEB_WORKER_URL",
        "WEB_OIDC_CLIENT_SECRET", "WEB_SESSION_SECRET", "WEB_WORKER_TOKEN",
        "COMPANION_DEPLOYMENT_PURPOSE", "COMPANION_DEPLOYMENT_NAMESPACE", "COMPANION_POD_NAMESPACE",
        "WEB_TEST_GATE_ENABLED", "WEB_TEST_GATE_PORT", "WEB_TEST_GATE_SESSION_SECRET",
    ],
    [],
    "non-production",
    "companion-np",
)
assert env_by_name["WEB_TEST_GATE_ENABLED"].get("value") == "true", env_by_name["WEB_TEST_GATE_ENABLED"]
assert env_by_name["WEB_TEST_GATE_PORT"].get("value") == "3100", env_by_name["WEB_TEST_GATE_PORT"]
secret_ref = env_by_name["WEB_TEST_GATE_SESSION_SECRET"].get("valueFrom", {}).get("secretKeyRef", {})
assert secret_ref.get("name") == "web-test-gate-secrets", secret_ref
assert secret_ref.get("key") == "WEB_TEST_GATE_SESSION_SECRET", secret_ref
print("ok    - gate-enabled Deployment: ports and env structurally valid, gate env from the separate secret")

production_docs = load(production_path)
production = container_of(web_deployment(production_docs))
check_ports(production, [("http", 3000)])
check_env(
    production,
    [
        "PORT", "WEB_PUBLIC_URL", "WEB_OIDC_ISSUER_URL", "WEB_OIDC_CLIENT_ID",
        "WEB_OWNER_SUBJECTS", "WEB_WORKER_URL",
        "WEB_OIDC_CLIENT_SECRET", "WEB_SESSION_SECRET", "WEB_WORKER_TOKEN",
        "COMPANION_DEPLOYMENT_PURPOSE", "COMPANION_DEPLOYMENT_NAMESPACE", "COMPANION_POD_NAMESPACE",
    ],
    ["WEB_TEST_GATE_"],
    "production",
    "companion-np",
)
print("ok    - production Deployment: renders normally with purpose=production and no gate variables")

# No LoadBalancer Service renders by default, whatever the purpose or gate.
for label, docs in (
    ("gate-disabled", disabled_docs),
    ("gate-enabled", enabled_docs),
    ("production", production_docs),
):
    assert loadbalancer_services(docs) == [], (
        f"{label} render must contain no LoadBalancer Service by default"
    )
print("ok    - no LoadBalancer Service renders by default (gate-disabled, gate-enabled, production)")

# With the LoadBalancer explicitly enabled for a production purpose,
# exactly one narrow LoadBalancer Service renders next to the ClusterIP.
lb_docs = load(lb_path)
lb_services = loadbalancer_services(lb_docs)
assert len(lb_services) == 1, f"expected exactly one LoadBalancer Service, got {len(lb_services)}"
lb = lb_services[0]
assert lb["metadata"]["name"].endswith("-web-lb"), f"LoadBalancer Service name: {lb['metadata']['name']}"
lb_labels = lb["metadata"].get("labels", {})
assert (
    lb_labels.get("app.kubernetes.io/name") == "web"
    and lb_labels.get("app.kubernetes.io/component") == "web"
), f"LoadBalancer Service labels: {lb_labels}"
# Release-scoped selector: this Service can only ever select this release's
# own web pods, never another release's (selectors never cross namespaces).
assert lb["spec"]["selector"] == {
    "app.kubernetes.io/instance": "companion",
    "app.kubernetes.io/name": "web",
}, f"LoadBalancer selector must be release-scoped to the web pods: {lb['spec']['selector']}"
lb_ports = lb["spec"]["ports"]
assert len(lb_ports) == 1, f"expected exactly one LoadBalancer port, got {lb_ports}"
lb_port = lb_ports[0]
assert set(lb_port.keys()) <= {"name", "port", "targetPort", "protocol"}, (
    f"LoadBalancer port object has unexpected keys: {lb_port}"
)
assert lb_port.get("name") == "http", lb_port
assert lb_port.get("port") == 5150, lb_port
assert lb_port.get("targetPort") == "http", lb_port
# The LoadBalancer is additive: the web ClusterIP Service still renders.
clusterips = [
    doc
    for doc in lb_docs
    if doc.get("kind") == "Service"
    and doc.get("spec", {}).get("type", "ClusterIP") == "ClusterIP"
    and doc["metadata"]["name"].endswith("-web")
]
assert len(clusterips) == 1, f"expected the web ClusterIP Service to still render, got {len(clusterips)}"
print("ok    - LoadBalancer Service: exactly one, web-labeled, release-scoped selector, host port -> targetPort http, alongside the ClusterIP")
PYEOF
pass "structural Deployment checks (ports vs env, attestation injection) passed for disabled/enabled/production renders"

# 1. Deployment-purpose attestation is required and exact.
render_must_fail "$(printf '%s' "$BASE_SETS" | sed 's/deployment.purpose=non-production,//')"
pass "a missing deployment.purpose fails rendering"
render_must_fail "$(printf '%s' "$BASE_SETS" | sed 's/deployment.purpose=non-production/deployment.purpose=canary/')"
pass "an unknown deployment.purpose fails rendering"
render_must_fail "$(printf '%s' "$BASE_SETS" | sed 's/deployment.namespace=companion-np,//')"
pass "a missing deployment.namespace fails rendering"
render_must_fail "$(printf '%s' "$BASE_SETS" | sed 's/deployment.namespace=companion-np/deployment.namespace=other-ns/')"
pass "a declared namespace differing from the release namespace fails rendering"

# 2. The gate only renders for a declared non-production deployment in
#    the authorized namespace.
render_must_fail "$(printf '%s' "$BASE_SETS" | sed 's/deployment.purpose=non-production/deployment.purpose=production/'),$GATE_SETS"
pass "the test gate fails to render for a production deployment purpose"
render_must_fail "$(printf '%s' "$BASE_SETS" | sed 's/deployment.namespace=companion-np/deployment.namespace=companion-dev/'),$GATE_SETS"
pass "the test gate fails to render in an unauthorized non-production namespace"
render_must_fail "$(printf '%s' "$BASE_SETS" | sed 's/deployment.namespace=companion-np/deployment.namespace=companion-prod/'),$GATE_SETS"
pass "the test gate fails to render in a production-named namespace even with a non-production purpose"

# 3. Reusing the web Secret for the gate must fail.
render_must_fail "$BASE_SETS,web.testGate.enabled=true,web.testGate.existingSecret=web-secrets"
pass "reusing the web Secret for the gate fails rendering"

# 4. Port collisions and the 1-65535 range must fail; the boundaries
#    themselves must render.
render_must_fail "$BASE_SETS,$GATE_SETS,web.testGate.port=3000"
pass "a gate port colliding with the container/service port fails rendering"
for bad_port in 0 -1 65536 70000; do
  render_must_fail "$BASE_SETS,$GATE_SETS,web.testGate.port=$bad_port"
  pass "an out-of-range gate port ($bad_port) fails rendering"
done
for boundary_port in 1 65535; do
  render "$BASE_SETS,$GATE_SETS,web.testGate.port=$boundary_port" > /dev/null
  pass "the range boundary gate port ($boundary_port) renders"
done

# 5. The gate and the purpose attestation are chart-owned.
render_must_fail "$BASE_SETS,web.env.WEB_TEST_GATE_ENABLED=true"
pass "WEB_TEST_GATE_* variables through web.env fail rendering"
render_must_fail "$BASE_SETS,web.env.COMPANION_DEPLOYMENT_PURPOSE=non-production"
pass "COMPANION_* variables through web.env fail rendering"

# 5a. The optional web LoadBalancer Service is production-gated and explicit.
render_must_fail "$BASE_SETS,$LB_SETS"
pass "the web LoadBalancer Service fails to render for a non-production deployment purpose"
render_must_fail "$PROD_SETS,web.loadBalancer.enabled=true"
pass "an enabled web LoadBalancer without an explicit hostPort fails rendering"
render "$PROD_SETS,web.loadBalancer.hostPort=$LB_TEST_PORT" > /dev/null
pass "a web LoadBalancer hostPort without enabled=true renders nothing (still disabled by default)"
render_must_fail "$PROD_SETS,web.loadBalancer.enabled=true,web.loadBalancer.hostPort=3000"
pass "a web LoadBalancer hostPort equal to web.service.port fails rendering"
for bad_lb_port in 0 -1 65536 70000; do
  render_must_fail "$PROD_SETS,web.loadBalancer.enabled=true,web.loadBalancer.hostPort=$bad_lb_port"
  pass "an out-of-range web LoadBalancer hostPort ($bad_lb_port) fails rendering"
done
for boundary_lb_port in 1 65535; do
  render "$PROD_SETS,web.loadBalancer.enabled=true,web.loadBalancer.hostPort=$boundary_lb_port" > /dev/null
  pass "the range boundary web LoadBalancer hostPort ($boundary_lb_port) renders"
done
render_must_fail "$PROD_SETS,$GATE_SETS,$LB_SETS"
pass "the test gate and the web LoadBalancer can never render in the same release"

# 6. Defaults without purpose/namespace fail (the contract is required).
render_must_fail 'web.image.repository=registry.example/companion/web'
pass "rendering without the deployment-purpose attestation fails"

echo "all chart render checks passed"
