# Application deployables

This area describes the planned application containers. All future application containers run on K3s. PostgreSQL and Keycloak remain external services and are not application deployables.

The initial shape has a web/BFF and one worker deployable. See [`web`](web/README.md) and [`worker`](worker/README.md) for responsibilities, boundaries, dependencies, scope, and unresolved decisions. No executable application is present.
