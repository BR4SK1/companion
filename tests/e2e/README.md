# End-to-end tests

## Responsibilities

Planned Playwright coverage of user-visible behavior through the web/BFF boundary, especially the single continuous text thread, owner-only access, durable message acceptance/status, and non-blocking asynchronous image results if that capability enters scope.

## Boundaries and dependencies

Run only against an identified non-production candidate with separate database, secrets, storage, and side-effect controls. Protect execution from untrusted pull-request content. No production access is required or allowed for these checks.

## Scope

Playwright is the recorded preference, not an installed dependency. This directory is documentation only: no browser setup, test code, credentials, fixtures, runner, or deployment trigger is provided.

## Open questions

Define test identity, isolation/reset strategy, candidate serialization, and how test results are bound to the exact immutable artifacts eligible for promotion.
