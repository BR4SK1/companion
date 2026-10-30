# Environment configuration documentation

Future non-production and production configurations are described separately in [`non-production`](non-production/README.md) and [`production`](production/README.md). This is documentation only: no values files, secret values, manifests, hostnames, or deployment mechanism are present.

The two environments must have separate databases, secrets, storage, and side-effect boundaries. PostgreSQL and Keycloak remain externally managed, outside K3s.
