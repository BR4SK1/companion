# Application deployables

This area describes the planned application containers. All future application containers run on K3s. PostgreSQL and Keycloak remain external services and are not application deployables.

The initial shape has a web/BFF and one worker deployable. See [`web`](web/README.md) and [`worker`](worker/README.md) for responsibilities, boundaries, dependencies, scope, and unresolved decisions. The web area currently contains a first client slice: a local-only, fixture-backed messenger preview with no backend, authentication, or live chat behind it. The worker area contains a first implemented slice: durable grouped conversation work on PostgreSQL with OpenRouter response-pattern decisions preceding chat generation; it is not connected to the web preview and is not deployed.
