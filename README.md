# Companion

A single-user, self-hosted conversational companion project. This repository is an architecture scaffold — architecture documentation plus early shared-library contract code; it is not yet an application or deployable release.

## Project map

- [`apps/web`](apps/web/README.md) — planned Next.js, React, and MUI web client with a backend-for-frontend (BFF).
- [`apps/worker`](apps/worker/README.md) — planned single deployable for durable background work.
- [`libraries`](libraries/README.md) — shared infrastructure libraries for OpenRouter and PostgreSQL.
- [`tests`](tests/README.md) — a Node built-in unit-test harness (`tests/unit`: a harness placeholder plus the OpenRouter Decisions contract tests) plus planned Vitest integration and Playwright end-to-end coverage.
- [`docs/architecture`](docs/architecture/README.md) — system boundaries, data and work-flow direction, and open decisions.
- [`deploy/helm`](deploy/helm/README.md) — documentation for a future application Helm chart and environment configuration.
- [`.opencode`](.opencode/README.md) — project-local reusable review skills.

All future application containers are intended to run on K3s. PostgreSQL and Keycloak are existing services external to K3s; this project does not provision them. No application code, executable application tooling, Kubernetes manifest, usable Helm chart, or deployment automation is included yet. The package manifests are the private root tooling package described in [`CONTRIBUTING.md`](CONTRIBUTING.md) (which also carries the TypeScript devDependency used for type checking) and the private `libraries/openrouter` contract package; neither contains runtime application dependencies. Read each area’s README for its responsibilities, boundaries, dependencies, scope, and open questions.

## Direction and delivery

The initial product direction is one owner and one continuous visible conversation thread. Owner-only authentication and authorization belong at the BFF edge; domain records do not inherit an identity-provider subject or speculative user/tenant identifiers. The worker is initially one deployable, not a collection of premature services.

The eventual delivery sequence is code and unit tests, feature-branch commit, non-production deployment, integration and end-to-end tests, pre-publication safety checks, push and pull request, then owner merge as production approval. Production is intended to promote the same tested immutable artifacts. The runner-free deployment trigger/controller is unresolved and is not running; merging now does not deploy anything.

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for contribution tooling (pnpm setup and pinned version, Conventional Commits validation, hook limitations and bypass). See [`AGENTS.md`](AGENTS.md) for repository guardrails. Implementation choices such as Drizzle with `pg` remain proposals, not approved dependencies.
