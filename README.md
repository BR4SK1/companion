# Companion

A single-user, self-hosted conversational companion project. This repository contains architecture documentation, shared-library contract and integration code, an implemented worker slice for durable conversation work with a private HTTP API, and an authenticated web client with its BFF edge wired to the worker; it is not yet a deployable release.

## Project map

- [`apps/web`](apps/web/README.md) — Next.js, React, and MUI web client with a backend-for-frontend (BFF): owner-only Keycloak OIDC sign-in, signed-cookie sessions, fail-closed behavior, the live continuous thread, and authenticated routes that call the worker with a service-to-service credential.
- [`apps/worker`](apps/worker/README.md) — implemented worker slice: durable grouped conversation work on PostgreSQL (ingestion idempotency with conflicting-reuse rejection, claim-time grouping, lease recovery, fenced publication) with OpenRouter response-pattern decisions preceding chat generation, plus the private bearer-token HTTP ingest/read API the BFF calls (cluster-internal only).
- [`libraries`](libraries/README.md) — shared infrastructure libraries for OpenRouter (transport, typed Decisions and Chat contracts) and PostgreSQL (connection lifecycle, transactions, migration runner).
- [`tests`](tests/README.md) — a Node built-in unit-test harness (`tests/unit`: contracts, transport, worker turn logic and HTTP API contract, web presentation/state/BFF server-side logic) plus database-backed integration suites and implemented Playwright end-to-end coverage over a run-owned disposable local stack, plus an explicitly authorized deployed-non-production smoke (one synthetic message against the real provider, requiring its billable-call and exclusive-dev-access acknowledgements in every context — within the ship-it flow under the owner's standing authorization — with race-safe targeted cleanup and an idempotent recovery path).
- [`docs/architecture`](docs/architecture/README.md) — system boundaries, data and work-flow direction, and open decisions.
- [`deploy/helm`](deploy/helm/README.md) — the K3s application Helm chart (web and worker) and environment configuration.
- [`.opencode`](.opencode/README.md) — project-local reusable review skills.

All application containers run on K3s. PostgreSQL and Keycloak are existing services external to K3s; this project does not provision them. The web/worker integration is implemented and verified with tests, but nothing is deployed with it yet. The package manifests are the private root tooling package described in [`CONTRIBUTING.md`](CONTRIBUTING.md) (which also carries the TypeScript devDependency used for type checking), the shared `libraries/openrouter` and `libraries/postgres` packages, and the workspace `apps/web` and `apps/worker` packages. Read each area’s README for its responsibilities, boundaries, dependencies, scope, and open questions.

## Direction and delivery

The initial product direction is one owner and one continuous visible conversation thread. Owner-only authentication and authorization belong at the BFF edge; domain records do not inherit an identity-provider subject or speculative user/tenant identifiers. The worker is initially one deployable, not a collection of premature services.

The eventual delivery sequence is code and unit tests, feature-branch commit, non-production deployment, integration and end-to-end tests, pre-publication safety checks, push and pull request, then owner merge as production approval. Production is intended to promote the same tested immutable artifacts. The runner-free deployment trigger/controller is unresolved and is not running; merging now does not deploy anything.

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for contribution tooling (pnpm setup and pinned version, Conventional Commits validation, hook limitations and bypass). See [`AGENTS.md`](AGENTS.md) for repository guardrails. The first worker slice selected `pg` used directly (no ORM) with SQL-file-style TypeScript migrations; Drizzle with `pg` remains an open proposal, and other choices (queue technology, retry/fallback policy) remain open in the area READMEs.
