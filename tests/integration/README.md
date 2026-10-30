# Integration tests

## Responsibilities

Checks of interactions between domain components and their infrastructure boundaries: relational persistence, durable grouped work, typed provider adapters, and recovery/error paths.

The first integration suites are [`worker-postgres.test.mjs`](worker-postgres.test.mjs) (database-backed coverage of the worker's durable conversation work: migration idempotency, ingest idempotency and conflicting-key rejection, claim-time grouping, snapshot/next-turn behavior, prior-turn context snapshots in conversation order — including replies published after later messages arrived, exclusions, and lease-reclaim coherence — ingest/claim serialization under concurrency, reply ordering, lease renewal/reclaim, stale-owner fencing, duplicate-publication idempotency, and full engine cycles with fake provider calls) and [`worker-http.test.mjs`](worker-http.test.mjs) (the worker's private HTTP API over the real store: bearer-token enforcement, idempotent and conflicting ingestion through HTTP, generic thread status, cursor-paged thread reads in persisted seq order with backward `before`-cursor walks, allocated-seq reconciliation — in-flight and burned seqs observed through a held-open insert — the scoped, sanitized trailing-failure flag, and the full accept → process → publish → poll path with fake provider calls). Both run on Node's built-in test runner and connect only when `WORKER_TEST_DATABASE_URL` names an explicitly provided disposable isolated non-production database; otherwise the suites are skipped, so `pnpm test:unit` stays deterministic with no database. Provider calls are fake functions — no network, and no live model calls from tests.

## Boundaries and dependencies

Tests must use an explicitly disposable isolated non-production database and test credentials/configuration. The suites below TRUNCATE the worker's domain tables on every test: `WORKER_TEST_DATABASE_URL` must never name a real application database — use a throwaway, isolated database only. Because they share (and truncate) the same database, run the database-backed suites one at a time, not concurrently in a single `node --test` invocation. Do not connect to production or invoke uncontrolled external side effects (provider calls are fakes; no live model calls are made from tests). Keep test data generic and free of personal or secret values.

## Scope

Vitest remains the preferred direction for future integration coverage, not an approved or installed dependency; the current suite uses Node's built-in test runner like the unit suite. Decide later whether to migrate; do not introduce a second runner casually.

## Open questions

Decide how test dependencies are isolated, how external provider behavior is stubbed or safely exercised, and which restart/order/idempotency and migration compatibility cases are release gates.
