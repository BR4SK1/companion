# Test areas

Planned test coverage is organized by boundary: unit tests are part of the code implementation workflow; [`integration`](integration/README.md) validates component and service interactions; [`e2e`](e2e/README.md) exercises user-visible flows with Playwright. These folders document intended ownership only; no runner, fixtures, code, or test configuration exists.

Vitest and Playwright are preferences for the test stack, not installed or finalized dependencies. Future tests must use non-production data and isolated side effects, never production access.
