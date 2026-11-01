# Companion application chart

The `companion` chart describes the application deployables that run on K3s:
the web client and the worker. It must not include PostgreSQL or Keycloak:
both are existing services outside K3s. Their endpoints arrive through
environment-specific configuration, and credentials are referenced from
existing Kubernetes Secrets — never chart defaults, never committed values.

## What the chart contains

- `templates/web.yaml` — web Deployment (HTTP readiness/liveness probes on
  `/`) and ClusterIP Service. The web BFF is the owner-only authentication
  edge; its configuration is required at render time: `web.existingSecret`
  must provide `WEB_OIDC_CLIENT_SECRET`, `WEB_SESSION_SECRET`, and
  `WEB_WORKER_TOKEN` keys, and `web.env` must provide `WEB_PUBLIC_URL`,
  `WEB_OIDC_ISSUER_URL`, `WEB_OIDC_CLIENT_ID`, and `WEB_OWNER_SUBJECTS`
  (comma-separated owner subjects). `WEB_WORKER_URL` is derived from the
  worker Service when the worker is enabled, or must be supplied via
  `web.env` otherwise.
- `web.testGate` — the non-production-only test-entry gate (default off).
  When `web.testGate.enabled` is true, the web Deployment receives
  `WEB_TEST_GATE_ENABLED=true`, `WEB_TEST_GATE_PORT`, and a
  `WEB_TEST_GATE_SESSION_SECRET` key ref from a dedicated existing Secret
  (`web.testGate.existingSecret`), plus an informational `test-entry`
  container port. Rendering fails unless a separate Secret is provided,
  fails when that Secret equals `web.existingSecret` (the test gate must
  never sign sessions with the owner session secret), fails on a gate port
  colliding with the container or service port, fails on a gate port
  outside 1–65535, fails if `WEB_TEST_GATE_*` or `COMPANION_*` variables
  are smuggled through `web.env`, and — critically — fails unless
  `deployment.purpose` is exactly `non-production` AND
  `deployment.namespace` is the one authorized non-production namespace
  (`companion-np`, pinned in the chart and mirrored by the application):
  the gate can never render for a production deployment, and no other
  namespace may self-declare itself non-production. The listener itself
  additionally requires the Host header `127.0.0.1:<gate port>` on every
  request and refuses forwarding/proxy headers (DNS-rebinding defense).
  The chart deliberately creates no Service, Ingress, or other route for
  the test listener: it is bound to `127.0.0.1` inside the pod and
  reachable only through `kubectl port-forward` (see apps/web/README.md
  for the security model and the safe access procedure). Never enable this
  for production.

Every release must also declare the deployment-purpose attestation the
application re-verifies at runtime:

- `deployment.purpose` — exactly `non-production` or `production`
  (required; anything else fails rendering).
- `deployment.namespace` — the exact namespace the release is installed
  into (required; rendering fails when it differs from the release
  namespace). Both values are injected into the web container together
  with the pod's actual namespace via the Kubernetes downward API
  (`metadata.namespace`), and the application opens the test-entry gate
  only when the declared purpose is `non-production` and the declared
  namespace equals the kubelet-provided pod namespace.
- `templates/ingress.yaml` — optional Traefik Ingress; hostname and
  middlewares are per-environment values.
- `templates/web-loadbalancer.yaml` — optional, **production-gated** K3s
  ServiceLB (LoadBalancer) Service for the web client, disabled by default.
  It renders only when `web.loadBalancer.enabled` is true AND
  `deployment.purpose` is exactly `production`: any other purpose fails
  rendering, so a non-production release can never publish the web client
  on a host port (its only public route there is the Traefik Ingress). It
  requires an explicit `web.loadBalancer.hostPort` — no default, an integer
  from 1 to 65535 that must differ from `web.service.port` — because the
  host port is environment-specific infrastructure; choose it under the
  hosting environment's host-port policy and keep it unique across that
  environment's published services (the chart cannot detect a host-port
  collision between releases). The Service carries the web Service's
  release-scoped selector, so it can only ever select its own release's web
  pods. Because the non-production-only test gate requires a
  non-production purpose, the gate and this Service can never render in the
  same release. The worker never gets a LoadBalancer: its Service stays
  cluster-internal by design.
- `templates/worker.yaml` — worker Deployment plus a **cluster-internal**
  ClusterIP Service (the web BFF's service-to-service boundary; there is
  deliberately no Ingress, LoadBalancer, or public route to the worker) with
  HTTP probes on `/readyz` (readiness; database ping) and `/healthz`
  (liveness). Secrets come from an existing Secret referenced by
  `worker.existingSecret`; see
  [`examples/companion-secrets.example.yaml`](examples/companion-secrets.example.yaml)
  for the expected keys (`WORKER_DATABASE_URL`, `OPENROUTER_API_KEY`,
  `WORKER_API_TOKEN`, plus the web keys when one shared Secret is used).
  `WORKER_API_TOKEN` is the private service-to-service credential and must
  equal the web deployment's `WEB_WORKER_TOKEN`. The example must be copied
  to a local version-control-excluded location and filled in before
  enabling the deployables.

Template boundary details:

- Resource names derive from the Helm release name (`_helpers.tpl`), so one
  release per environment yields one coherent set of resources in that
  release's namespace. The chart does not manage namespaces.
- The chart creates only application workloads: Deployments, ClusterIP
  Services, and an optional Ingress for the web client. It never creates
  Secrets, namespaces, or external services (PostgreSQL and Keycloak are
  existing external services).
- The worker's Service is cluster-internal by design: the web BFF reaches it
  through in-cluster DNS, and there is no Ingress, LoadBalancer, or public
  route to the worker. Its API requires the shared service-to-service bearer
  token (`WORKER_API_TOKEN` secret key, mirrored as `WEB_WORKER_TOKEN` on the
  web deployment).
- Probes: the web serves HTTP readiness/liveness on `/`; the worker serves
  `/readyz` (database ping) for readiness and `/healthz` (process health) for
  liveness.
- Secret values are never templated. Both deployables reference an existing
  Secret by name and fail (at startup or render time) when configuration is
  incomplete.
- The optional web LoadBalancer path bypasses Traefik entirely: K3s
  ServiceLB binds the configured host port on every node and forwards
  straight to the web pods, so nothing enforced by Traefik middlewares
  (rate limits, security headers, allowlists) applies on that path. The web
  BFF's owner-only authentication remains the only access control there,
  and the published port is plain HTTP on the host network (TLS
  termination happens upstream, for example at a tunnel). Health on that
  path is ordinary Service behavior: only Ready endpoints (the web
  readiness probe on `/`) receive traffic, and there is no separate
  LoadBalancer health check. The worker has no such path at all.

Template boundary details:

- Resource names derive from the Helm release name (`_helpers.tpl`), so one
  release per environment yields one coherent set of resources in that
  release's namespace. The chart does not manage namespaces.
- The chart creates only application workloads: Deployments, ClusterIP
  Services, and an optional Ingress for the web client. It never creates
  Secrets, namespaces, or external services (PostgreSQL and Keycloak are
  existing external services).
- The worker's Service is cluster-internal by design: the web BFF reaches it
  through in-cluster DNS, and there is no Ingress, LoadBalancer, or public
  route to the worker. Its API requires the shared service-to-service bearer
  token (`WORKER_API_TOKEN` secret key, mirrored as `WEB_WORKER_TOKEN` on the
  web deployment).
- Probes: the web serves HTTP readiness/liveness on `/`; the worker serves
  `/readyz` (database ping) for readiness and `/healthz` (process health) for
  liveness.
- Secret values are never templated. Both deployables reference an existing
  Secret by name and fail (at startup or render time) when configuration is
  incomplete.

Default values are generic and publishable. Registry paths, image tags,
ingress hostnames, middleware names, and model ids are environment-specific
and supplied through a per-environment values file that this repository keeps
outside version control (see [`../environments/README.md`](../environments/README.md)).
Missing required values fail rendering instead of producing broken resources.

Render-time checks for the chart guards — including the structural
Deployment validation (ports vs env shapes, attestation injection) and the
purpose/namespace negatives — run without cluster access:

```sh
deploy/helm/render-checks.sh
```

## Scope and boundaries

- One Helm release per environment, installed into that environment's own
  namespace. The chart does not manage namespaces; the release namespace is
  chosen at install time.
- The worker uses a `Recreate` rollout strategy: conversation claims are
  serialized by design, so at most one worker should run at a time.
- No production values file exists in this repository. Production
  configuration, approval binding, and promotion are still open (see
  [`../environments/production/README.md`](../environments/production/README.md)).
- The chart creates no deployment automation: there is no trigger or
  controller, and installs are performed manually from the local-only
  per-environment procedure.
- Container image definitions live in [`../../docker/`](../../docker/).
