# Deployment documentation

Application containers target K3s. The intended Helm organization is real
now at the chart level: [`helm/companion`](helm/companion) contains the
application chart (web and worker templates) with
[`helm/environments`](helm/environments) documenting environment separation
and where environment-specific values live. PostgreSQL and Keycloak are
external existing services and must never be added as chart dependencies or
provisioned by this repository.

Still absent by design: no deployment automation, trigger, or controller —
installs are performed manually from a local-only per-environment procedure,
environment-specific values and secret delivery stay outside version control,
and a merge does not deploy. Production configuration and promotion remain
unresolved (see [`helm/environments/production/README.md`](helm/environments/production/README.md)).
Container image definitions live in [`docker/`](docker/).
