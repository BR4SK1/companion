# Test areas

Test coverage is organized by boundary:

- [`unit`](unit/README.md) — Node built-in test runner (`pnpm run test:unit`) covering shared OpenRouter contracts and transport, worker pure logic and private HTTP API, web presentation/state/BFF logic, `config-manager` mock HTTP and write-plan tests, and hermetic `scripts/ship-deploy` tests.
- [`integration`](integration/README.md) — component and persistence tests against verified disposable databases (`WORKER_TEST_DATABASE_URL`) or the configured embedding service. Destructive database-backed suites are explicit isolated tools and never target an application database.
- [`e2e`](e2e/README.md) — deployed-only Playwright suite (`pnpm run test:e2e`) running live browser and API journeys against the deployed `companion-np` release via temporary loopback `kubectl port-forward` tunnels.

Unit and integration tests use Node's built-in `node:test` runner; Vitest remains unselected. Future tests must use non-production data and isolated side effects, never production access or application-database resets.
