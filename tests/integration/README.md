# Integration tests

## Responsibilities

Checks of interactions between domain components and their infrastructure boundaries: relational persistence, durable grouped work, typed provider adapters, and recovery/error paths.

The first integration suite is [`worker-postgres.test.mjs`](worker-postgres.test.mjs): database-backed coverage of the worker's durable conversation work (migration idempotency, ingest idempotency, claim-time grouping, snapshot/next-turn behavior, prior-turn context snapshots in conversation order — including replies published after later messages arrived, exclusions, and lease-reclaim coherence — ingest/claim serialization under concurrency, reply ordering, lease renewal/reclaim, stale-owner fencing, duplicate-publication idempotency, and full engine cycles with fake provider calls). It runs on Node's built-in test runner and connects only when `WORKER_TEST_DATABASE_URL` names an explicitly provided isolated non-production database; otherwise the suite is skipped, so `pnpm test:unit` stays deterministic with no database. Provider calls are fake functions — no network.

## Boundaries and dependencies

Tests must use an explicitly isolated non-production database and test credentials/configuration. Do not connect to production or invoke uncontrolled external side effects. Keep test data generic and free of personal or secret values.

## Scope

Vitest remains the preferred direction for future integration coverage, not an approved or installed dependency; the current suite uses Node's built-in test runner like the unit suite. Decide later whether to migrate; do not introduce a second runner casually.

## Open questions

Decide how test dependencies are isolated, how external provider behavior is stubbed or safely exercised, and which restart/order/idempotency and migration compatibility cases are release gates.
