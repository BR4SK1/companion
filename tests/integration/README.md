# Integration tests

## Responsibilities

Planned checks of interactions between domain components and their infrastructure boundaries: relational persistence, durable grouped work, typed provider adapters, and recovery/error paths as those are implemented.

## Boundaries and dependencies

Tests must use an explicitly isolated non-production database and test credentials/configuration. Do not connect to production or invoke uncontrolled external side effects. Keep test data generic and free of personal or secret values.

## Scope

Vitest is the preferred direction, not an approved or installed dependency. This directory is a documentation placeholder; it contains no test code, runner setup, fixtures, services, or deployment configuration.

## Open questions

Decide how test dependencies are isolated, how external provider behavior is stubbed or safely exercised, and which restart/order/idempotency and migration compatibility cases are release gates.
