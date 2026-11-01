# Deployment documentation

Application containers target K3s. The Helm organization is
[`helm/companion`](helm/companion) — the application chart (web and worker
Deployments, ClusterIP Services, optional web Ingress) with
[`helm/environments`](helm/environments) documenting environment separation
and where environment-specific values live. PostgreSQL and Keycloak are
external existing services and must never be added as chart dependencies or
provisioned by this repository. The worker has no ingress at all: it is
reachable only through its cluster-internal Service, guarded by a
service-to-service bearer token shared with the web BFF.

Still absent by design: no deployment automation, trigger, or controller —
installs are performed manually from a local-only per-environment procedure,
environment-specific values and secret delivery stay outside version control,
and a merge does not deploy. Production configuration and promotion remain
unresolved (see [`helm/environments/production/README.md`](helm/environments/production/README.md)).
Container image definitions live in [`docker/`](docker/).
