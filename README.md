# Companion

A single-user, self-hosted conversational companion project. This repository contains architecture documentation, shared-library contract and integration code, an implemented worker for durable conversation work with a private HTTP API, an authenticated web client with its BFF edge wired to the worker, and the K3s Helm chart and container definitions.

## Project map

- [`apps/web`](apps/web/README.md) — Next.js, React, and MUI web client with a backend-for-frontend (BFF): owner-only Keycloak OIDC sign-in, signed-cookie sessions, fail-closed behavior, the live continuous thread, and authenticated routes that call the worker with a service-to-service credential.
- [`apps/worker`](apps/worker/README.md) — worker deployable: durable grouped conversation work on PostgreSQL (ingestion idempotency with conflicting-reuse rejection, claim-time grouping, lease recovery, fenced publication) with OpenRouter response-pattern decisions preceding chat generation, plus the private bearer-token HTTP ingest/read API the BFF calls (cluster-internal only).
- [`apps/config-manager`](apps/config-manager/README.md) — standalone local loopback operator tool for reviewing and editing DB-backed worker configuration.
- [`libraries`](libraries/README.md) — shared infrastructure libraries for OpenRouter (transport, typed Decisions and Chat contracts) and PostgreSQL (connection lifecycle, transactions, migration runner).
- [`tests`](tests/README.md) — a Node built-in unit-test suite (`tests/unit`), database-backed integration suites (`tests/integration`), and a deployed-only Playwright end-to-end suite (`tests/e2e`) that runs live browser and API journeys against the deployed `companion-np` release via `kubectl port-forward`.
- [`docs/architecture`](docs/architecture/README.md) — system boundaries, data and work-flow direction, and open decisions.
- [`deploy/helm`](deploy/helm/README.md) — the K3s application Helm chart (web and worker) and environment configuration.
- [`.opencode`](.opencode/README.md) — project-local reusable review skills.

All application containers run on K3s. PostgreSQL and Keycloak are existing services external to K3s; this project does not provision them. The package manifests are the private root tooling package, the shared `libraries/openrouter` and `libraries/postgres` packages, the workspace `apps/web`, `apps/worker`, and `apps/config-manager` packages, and `tests/e2e`. Read each area's README for its responsibilities, boundaries, dependencies, and scope.

## Direction and delivery

The initial product direction is one owner and one continuous visible conversation thread. Owner-only authentication and authorization belong at the BFF edge; domain records do not inherit an identity-provider subject or speculative user/tenant identifiers. The worker is initially one deployable, not a collection of premature services.

The eventual delivery sequence is code and unit tests, feature-branch commit, non-production deployment, integration and end-to-end tests, pre-publication safety checks, push and pull request, then owner merge as production approval. Production is intended to promote the same tested immutable artifacts. The runner-free deployment trigger/controller is unresolved and is not running; merging now does not deploy anything.
