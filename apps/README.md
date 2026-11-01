# Application deployables

This area contains the application containers. All application containers run on K3s. PostgreSQL and Keycloak remain external services and are not application deployables.

The shape is a web/BFF deployable and one worker deployable. See [`web`](web/README.md) and [`worker`](worker/README.md) for responsibilities, boundaries, dependencies, scope, and unresolved decisions. The web area contains the authenticated client and BFF edge: owner-only OIDC sign-in at the boundary, the live continuous thread, and authenticated BFF routes that call the worker with a service-to-service credential. The worker area contains the implemented slice: durable grouped conversation work on PostgreSQL with OpenRouter response-pattern decisions preceding chat generation, plus the private HTTP ingest/read API the BFF calls. The deployables are not deployed with this wiring yet.
