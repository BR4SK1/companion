# End-to-end tests (local-only)

This directory holds the implementation-specific end-to-end suite. It is
deliberately excluded from version control: everything under `tests/e2e/`
except this README is gitignored (see the root
[`.gitignore`](../../.gitignore)).

## Why E2E is gitignored

This repository is a scaffold with no implementation details. Good end-to-end
coverage inherently depends on implementation specifics — routes, selectors,
session handling, deployment topology, and seed data — so the suite lives here
as local-only code rather than in the tracked scaffold.

## Local convention

The local suite is a Playwright project in this directory (`specs/`,
`helpers/`, `playwright.config.mjs`, and a private `package.json` providing
the `@companion/e2e` workspace package consumed by `pnpm run test:e2e`).

Boundaries for the local suite:

- Target non-production deployments only; never production.
- Never reset or modify provisioned configuration or shared state.
- Mark synthetic traffic so it is recognizable in non-production history.
