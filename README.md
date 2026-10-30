# Companion

A single-user, self-hosted conversational companion project. This repository contains architecture documentation, shared-library contract and integration code, a first worker slice for durable conversation work, and a local-only web-client preview; it is not yet a deployable release.

## Project map

- [`apps/web`](apps/web/README.md) — Next.js, React, and MUI web client with a backend-for-frontend (BFF). Contains a first client slice: a local-only, fixture-backed messenger preview (no backend, authentication, uploads, or live chat yet).
- [`apps/worker`](apps/worker/README.md) — first worker slice: durable grouped conversation work on PostgreSQL (ingestion idempotency, claim-time grouping, lease recovery, fenced publication) with OpenRouter response-pattern decisions preceding chat generation. Not connected to the web preview and not deployed.
- [`libraries`](libraries/README.md) — shared infrastructure libraries for OpenRouter (transport, typed Decisions and Chat contracts) and PostgreSQL (connection lifecycle, transactions, migration runner).
- [`tests`](tests/README.md) — a Node built-in unit-test harness (`tests/unit`: a harness placeholder plus the OpenRouter Decisions contract tests) plus planned Vitest integration and Playwright end-to-end coverage.
- [`docs/architecture`](docs/architecture/README.md) — system boundaries, data and work-flow direction, and open decisions.
- [`deploy/helm`](deploy/helm/README.md) — documentation for a future application Helm chart and environment configuration.
- [`.opencode`](.opencode/README.md) — project-local reusable review skills.

All future application containers are intended to run on K3s. PostgreSQL and Keycloak are existing services external to K3s; this project does not provision them. Nothing is deployed. The web client area contains a local-only preview slice that runs entirely in the browser against fixture data; the worker slice runs against a non-production PostgreSQL and OpenRouter credentials supplied at runtime and is not wired to the preview. The package manifests are the private root tooling package described in [`CONTRIBUTING.md`](CONTRIBUTING.md) (which also carries the TypeScript devDependency used for type checking), the shared `libraries/openrouter` and `libraries/postgres` packages, and the workspace `apps/web` and `apps/worker` packages. Read each area’s README for its responsibilities, boundaries, dependencies, scope, and open questions.

## Direction and delivery

The initial product direction is one owner and one continuous visible conversation thread. Owner-only authentication and authorization belong at the BFF edge; domain records do not inherit an identity-provider subject or speculative user/tenant identifiers. The worker is initially one deployable, not a collection of premature services.

The eventual delivery sequence is code and unit tests, feature-branch commit, non-production deployment, integration and end-to-end tests, pre-publication safety checks, push and pull request, then owner merge as production approval. Production is intended to promote the same tested immutable artifacts. The runner-free deployment trigger/controller is unresolved and is not running; merging now does not deploy anything.

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for contribution tooling (pnpm setup and pinned version, Conventional Commits validation, hook limitations and bypass). See [`AGENTS.md`](AGENTS.md) for repository guardrails. The first worker slice selected `pg` used directly (no ORM) with SQL-file-style TypeScript migrations; Drizzle with `pg` remains an open proposal, and other choices (queue technology, retry/fallback policy) remain open in the area READMEs.
