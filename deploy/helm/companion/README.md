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
- `templates/ingress.yaml` — optional Traefik Ingress; hostname and
  middlewares are per-environment values.
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
