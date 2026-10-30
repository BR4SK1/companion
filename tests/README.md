# Test areas

Test coverage is organized by boundary: [`unit`](unit/README.md) tests run on Node's built-in test runner via `pnpm test:unit` and currently contain the placeholder harness test plus the OpenRouter Decisions contract tests; [`integration`](integration/README.md) validates component and service interactions; [`e2e`](e2e/README.md) exercises user-visible flows with Playwright. The integration and e2e folders document intended ownership only; no runner, fixtures, code, or test configuration exists for them.

Vitest and Playwright are preferences for the integration and e2e stack, not installed or finalized dependencies. Unit tests use Node's built-in `node:test` runner with no added dependency; revisiting that choice belongs to any future test-stack decision. Future tests must use non-production data and isolated side effects, never production access.
