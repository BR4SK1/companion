# Companion application chart (planned)

This directory reserves a future Helm chart boundary for the application deployables that run on K3s, initially the web/BFF and one worker. It must not include PostgreSQL or Keycloak: both are existing services outside K3s. External service credentials and endpoints must come from environment-specific secret/configuration channels, never public chart defaults.

## Planned responsibilities

A future chart may describe application workloads, service exposure, probes, resource settings, and references to externally managed dependencies. Keep deployment concerns separate from application/domain behavior. Environment documentation is under [`../environments`](../environments/README.md).

## Scope and open questions

This directory is README-only and is not a usable Helm chart: no chart metadata, values, YAML templates, resources, or deployment code are present. Decide chart ownership, workload settings, ingress/network boundaries, secret references, resource policies, and promotion mechanism before authoring manifests. Do not infer production access or provisioning authorization.
