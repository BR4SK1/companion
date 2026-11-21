# End-to-end tests

Deployed-only Playwright suite (`@companion/e2e`) exercising the live non-production Kubernetes deployment (`companion-np`, release `companion`) through temporary loopback `kubectl port-forward` tunnels.

## Running

The E2E toolchain is pinned to the Node.js version in the repository root [`.nvmrc`](../../.nvmrc) (`22.23.4`):

```sh
nvm use
pnpm --filter @companion/e2e install:chromium   # first time only
pnpm run test:e2e
```

`run-e2e.mjs` finds the Ready `web` and `worker` pods in `companion-np`, opens loopback-only `kubectl port-forward` tunnels (`127.0.0.1:3100` for the web test-entry gate, plus ephemeral local ports for the web main listener and worker API), runs Playwright sequentially against those endpoints, and closes the tunnels on exit.

Optional environment overrides: `E2E_NAMESPACE` (default `companion-np`), `E2E_RELEASE` (default `companion`), `E2E_GATE_PORT` (default `3100`, must match the pod's `WEB_TEST_GATE_PORT`).

## Coverage

1. `01-access-and-safety.spec.mjs` — test-gate session issuance, OIDC absence on the test channel, owner-only main channel redirect and API refusal, cross-channel cookie isolation, Host and forwarding-header rejections on the gate listener, same-origin checks, and worker health/readiness + bearer-token boundaries.
2. `02-pwa.spec.mjs` — public PWA assets (`manifest.webmanifest`, `sw.js`, `offline.html`, generated PNG icons) on both channels, document head metadata, service worker registration and offline-page-only caching, offline navigation fallback and recovery, `/api` exclusion, and HTTP error preservation.
3. `03-live-chat.spec.mjs` — real end-to-end browser chat turn through the composer -> web BFF -> worker -> PostgreSQL -> live OpenRouter reply -> reload persistence.

## Boundaries

- Targets `companion-np` only (never production) and never resets or modifies provisioned configuration.
- `03-live-chat.spec.mjs` sends one synthetic message through the live non-production stack, which performs real model calls and retains that synthetic turn in non-production history.
