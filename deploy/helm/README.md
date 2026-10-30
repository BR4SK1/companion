# Helm documentation

The chart area is [`companion`](companion/README.md), with [`environments`](environments/README.md) for non-production and production configuration responsibilities. All application containers deploy to K3s; PostgreSQL and Keycloak are external existing services and must not be provisioned as part of this application.

The `companion` chart is a real, installable chart (web and worker Deployments, ClusterIP Services — the worker's one cluster-internal only — and an optional Traefik Ingress for the web client). It still ships no values that name any real environment: registry paths, tags, hostnames, and model ids arrive through local-only per-environment values files, and credentials are referenced from existing Kubernetes Secrets.
