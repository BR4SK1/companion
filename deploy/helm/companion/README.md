# Companion application chart

The `companion` chart describes the application deployables that run on K3s:
the web client and the worker. It must not include PostgreSQL or Keycloak:
both are existing services outside K3s. Their endpoints arrive through
environment-specific configuration, and credentials are referenced from
existing Kubernetes Secrets — never chart defaults, never committed values.

## What the chart contains

- `templates/web.yaml` — web Deployment (HTTP readiness/liveness probes on
  `/`) and ClusterIP Service.
- `templates/ingress.yaml` — optional Traefik Ingress; hostname and
  middlewares are per-environment values.
- `templates/worker.yaml` — worker Deployment only (no Service, no HTTP
  probes; the worker has no HTTP listener). Secrets come from an existing
  Secret referenced by `worker.existingSecret`; see
  [`examples/companion-secrets.example.yaml`](examples/companion-secrets.example.yaml)
  for the expected keys (`WORKER_DATABASE_URL`, `OPENROUTER_API_KEY`). The
  example must be copied to a local version-control-excluded location and
  filled in before enabling the worker.
- [`templates/README.md`](templates/README.md) — template boundary details.

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
