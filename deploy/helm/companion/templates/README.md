# Chart template boundary (planned)

If and when a real chart is authorized, this directory will hold application-only Kubernetes templates for K3s workloads. It must not declare PostgreSQL or Keycloak resources or bundle their lifecycle. Future application containers belong here only through an implemented and reviewed chart design.

This directory contains documentation only—no YAML or templates—and does not make the parent directory a usable Helm chart. Resource kinds, probes, service exposure, security context, and resource limits remain open implementation decisions.
