# Web application and BFF

## Current state: authenticated live client with the BFF wired to the worker

`apps/web` contains the web client and the backend-for-frontend (BFF) boundary: a Next.js (App Router), React, and MUI messenger client rendering the single continuous conversation, backed by the worker's durable thread through authenticated BFF routes. Owner-only authorization happens at the BFF edge with OpenID Connect against the existing external Keycloak service.

What is implemented:

- **Owner-only OIDC sign-in.** Authorization code flow with PKCE, `state`, and `nonce` via [`openid-client`](https://github.com/panva/openid-client) (the certified Node.js OpenID Connect relying-party library — the recorded, approved library choice for this edge). After the exchange, the identity-provider subject must be on the explicit owner allowlist (`WEB_OWNER_SUBJECTS`); a denied subject receives the same generic failure as any other error and no session exists. The BFF holds all credentials server-side; nothing secret reaches the browser.
- **Signed-cookie sessions.** The session is an HMAC-SHA256-signed, HttpOnly, SameSite=Lax cookie (`Secure` when the public URL is https) carrying only the subject and expiry — authentication identity at this edge, never a domain identifier. The in-flight login's state/nonce/PKCE verifier travel in a separate short-lived signed cookie.
- **Fail-closed everywhere.** Missing or malformed BFF configuration renders a generic "temporarily unavailable" surface, refuses to start sign-in, and answers API calls with `503`; it never degrades to open access. API routes require a verified session (`401` otherwise), and state-changing requests must present a same-origin `Origin` header (`403` otherwise) on top of the SameSite cookie policy.
- **Authenticated BFF API.** `GET /api/thread` (one bounded thread page — the BFF-fixed newest page by default, or the page below a validated `before` seq cursor — plus generic `{queued, generating, highestAllocatedSeq, hasRecentFailure}` status and `{oldestSeq, hasMore}` paging bounds) and `POST /api/messages` (idempotent accept with a client-supplied stable key; an optional client-reported send time `clientSentAt` from the live thread is passed through to the worker for original-timing provenance) proxy the worker's private HTTP API with the shared service-to-service bearer token. Responses are sanitized: no upstream bodies, headers, stack traces, or configuration details pass through.
- **Non-production-only loopback test entry.** An optional, fail-closed gate adds a `127.0.0.1`-bound listener inside the pod for E2E access without sign-in, with its own identity-free session kind, secret, and cookie; see the dedicated section below. The owner-only paths are unchanged when the gate is off (the default).
- **Live thread UI.** The page is server-rendered fail-closed (unavailable → automatic sign-in for signed-out visits, with a generic retry view after auth errors → live thread), then a client component polls the BFF's newest page and merges it by message id. It walks history backwards (up to five pages per cycle until the bottom; an interrupted walk resumes where it stopped on a later cycle; older history behind a "Load earlier messages" control, which stays visible while allocated-but-uncommitted seqs may exist below the loaded bottom). Reconciliation has no timing assumptions: the client re-derives the gaps between its loaded seqs every cycle and spends a bounded page budget (three pages per cycle, round-robin across gaps, walk cursors persist between cycles) walking each gap downward — recovering late-committed messages buried under later traffic and waiting out in-flight transactions for as long as they take; a seq burned by a rolled-back insert never resolves, and its cost is bounded probing, never a missed message. Retried sends reuse the same idempotency key; a conflicting key reuse (409) recovers with a fresh key. Loading, connection-error (automatic retry plus an explicit retry control), ended-session, per-message failure states, and a sanitized notice when the trailing conversation includes a failed generation (no error detail) are all visible.
- **Installable PWA shell.** A web app manifest (`/manifest.webmanifest`, static user-agnostic values) with the Companion name, `standalone` display, and icons generated at build time from source-defined drawing code; Apple home-screen metadata and a 180×180 `apple-touch-icon`; a minimal production-only service worker that serves one static offline fallback page and caches nothing else (see the PWA section below).
- **Single continuous thread.** Clusters, UTC day dividers, scroll anchoring, and the composer carry over from the first client slice unchanged; internal turns and work grouping never fragment the visible thread.

Not implemented (by design): uploads, voice, image-generation integration, message editing/deletion, and any multi-user or tenant concept. Images exist only as presentation support in the message model; no backend produces them. The BFF's worker client also exposes an engagement-summary read (`getEngagement`, the worker's `GET /v1/engagement`) for future consumers, but no browser-facing engagement route or UI exists yet in this slice — the method is currently unused by any route.

## Running locally

```sh
pnpm install                       # installs workspace packages (root tooling + apps/web)
pnpm --filter @companion/web dev   # development server
pnpm --filter @companion/web build # production build (type-checks and prerenders)
pnpm --filter @companion/web start # serve the production build
pnpm --filter @companion/web lint
pnpm --filter @companion/web typecheck
pnpm test:unit                     # repo unit tests, including the web app's pure logic
```

The BFF requires its configuration to serve anything; without it the app renders the generic unavailable view. Environment variables (secrets are supplied at runtime, never committed):

| Variable | Required | Default | Meaning |
| --- | --- | --- | --- |
| `WEB_PUBLIC_URL` | yes | — | Public origin of this app (used for the redirect URI and origin checks) |
| `WEB_OIDC_ISSUER_URL` | yes | — | Keycloak realm issuer URL, exactly as registered |
| `WEB_OIDC_CLIENT_ID` | yes | — | Confidential OIDC client id |
| `WEB_OIDC_CLIENT_SECRET` | yes | — | Confidential OIDC client secret |
| `WEB_SESSION_SECRET` | yes | — | HMAC secret for session/login-flow cookies (≥ 32 chars) |
| `WEB_OWNER_SUBJECTS` | yes | — | Comma-separated identity-provider subjects of the owner (fail-closed allowlist) |
| `WEB_WORKER_URL` | yes | — | Base URL of the worker's private HTTP API (e.g. `http://companion-worker:8080` in-cluster) |
| `WEB_WORKER_TOKEN` | yes | — | Service-to-service credential; must equal the worker's `WORKER_API_TOKEN` |
| `WEB_SESSION_TTL_SECONDS` | no | `43200` | Session lifetime |
| `WEB_WORKER_TIMEOUT_MS` | no | `10000` | BFF→worker request timeout |
| `WEB_TEST_GATE_ENABLED` | no | unset (off) | Exact string `true` enables the non-production-only test-entry gate; never inferred from `NODE_ENV` |
| `WEB_TEST_GATE_PORT` | when the gate is enabled | — | Loopback-only test listener port inside the container (must differ from `PORT`) |
| `WEB_TEST_GATE_SESSION_SECRET` | when the gate is enabled | — | Dedicated HMAC secret for test sessions (≥ 32 chars, must differ from `WEB_SESSION_SECRET`) |
| `WEB_TEST_GATE_SESSION_TTL_SECONDS` | no | `3600` | Test-session lifetime |
| `WEB_TEST_GATE_TRUSTED_LOCAL` | no | unset (off) | Exact string `true` attests an explicit local run outside Kubernetes; honored only when no chart-injected deployment attestation is present and no Kubernetes context indicator (`KUBERNETES_SERVICE_HOST`/`KUBERNET_SERVICE_PORT`) is set |
| `COMPANION_DEPLOYMENT_PURPOSE` | chart-injected | — | Declared deployment purpose (`non-production`/`production`); chart-owned, never set through `web.env` |
| `COMPANION_DEPLOYMENT_NAMESPACE` | chart-injected | — | Declared release namespace; chart-owned, must equal the pod's actual namespace for the gate |
| `COMPANION_POD_NAMESPACE` | chart-injected | — | The pod's actual namespace via the Kubernetes downward API (`metadata.namespace`) |

For local development against a local worker, set `WEB_WORKER_URL=http://127.0.0.1:8080` and run the worker with a matching `WORKER_API_TOKEN`. Sign-in requires a reachable Keycloak realm and a registered confidential client whose allowed redirect URI is `${WEB_PUBLIC_URL}/api/auth/callback` — an owner-provided external prerequisite this repository does not provision.

## Progressive Web App (PWA)

The app is installable as a standalone application. The manifest (`app/manifest.ts`, served at `/manifest.webmanifest`) carries static, user-agnostic values only — the route is publicly reachable and must never contain user data. Icons are a provisional design (a speech bubble on the app theme's light primary color) produced from source-defined drawing code in `src/lib/icons.ts` — a dependency-free rasterizer plus minimal PNG encoder — by the `app/icon.ts` and `app/apple-icon.ts` conventions (favicon and iOS home-screen icon) and the `/icons/*` route handlers (the manifest icons). Next statically prerenders these routes at build time, so the bytes are deterministic functions of the source and no generated image binaries are kept in the repository; rebranding means editing the drawing module, and the tests verify the delivered formats, dimensions, and maskable safe-zone placement. The Apple metadata (`capable`, title, status-bar style) and the icon link tags come from the root layout's metadata and the icon conventions.

- **Install.** On iOS/iPadOS use Safari's Share → "Add to Home Screen"; on Android and desktop Chromium browsers use the browser's "Install app" entry. Installation and service worker registration require a **secure context**: the app must be served over HTTPS (`localhost` also qualifies for development). The chart's web Ingress terminates TLS for the release host, so the deployed releases are installable through it; any origin served over plain HTTP (for example the optional production-only LoadBalancer Service path, which bypasses the ingress) cannot install the app or register the worker.
- **Offline behavior is intentionally minimal.** The service worker (`public/sw.js`) serves a static, user-agnostic "You're offline" page (`public/offline.html`) only when a top-level GET navigation of this origin cannot reach the server. It caches nothing except that one page, it never puts conversations, API responses, messages, session data, or user-specific pages into its storage, and HTTP error responses (404, 503, …) pass through unchanged — the fallback is only for unreachable-network failures. Sign-in, history, and sending all require a live connection either way. The worker's only cache is under its own `companion-offline-` prefix (bump the version inside `sw.js` when the fallback page changes); activation cleanup deletes only old caches with that prefix, never unrelated caches on the origin.
- **The BFF's API surface is never intercepted.** Paths under `/api` (the OIDC sign-in flow and callback, the non-production-only test-gate issuance, and the thread/message endpoints) are excluded even when they arrive as top-level navigations (typed URLs, callback redirects), and non-GET requests and subresource requests are never touched.
- **Registration is production-only.** The service worker registers through a small client component (`src/components/register-service-worker.tsx`) that runs in production builds only and is best-effort (a failed registration never surfaces), so `pnpm dev` is unaffected.
- **iOS specifics.** An installed Home Screen web app keeps its own storage separate from Safari: cookies are not shared with the browser, so the owner must sign in again inside the installed app (the OIDC redirect URI is the public origin, so the flow itself works there unchanged). The status bar uses the `default` style and the existing safe-area handling (the header pads by `env(safe-area-inset-top)` under `viewport-fit: cover`) applies in standalone mode as in the browser.

## Non-production-only test-entry gate (E2E)

The production build is served through a small custom server (`server.mjs`, used by `pnpm start` and the container): it runs the exact same Next production server on the main listener, and — only when the gate is explicitly enabled **and** a valid non-production deployment-purpose attestation is present — one additional listener bound strictly to `127.0.0.1` inside the container's network namespace. That second listener is the **test entry**: unauthenticated full-application access (reading and sending the real conversation, which can incur model/provider costs) for end-to-end testing of a non-production candidate.

Security model, in layers:

- **Genuine network boundary.** The test listener's socket is bound to `127.0.0.1`, so nothing outside the pod's network namespace can connect to it — not the ClusterIP Service (endpoints target the pod IP, never a peer's loopback), not the Ingress, not other pods or nodes. The only intended path is `kubectl port-forward`, which the kubelet performs by dialing `127.0.0.1` inside the pod's network namespace. Binding and reachability are never configurable.
- **Deployment-purpose attestation (non-production only, authorized namespace).** The chart requires every release to declare an exact purpose (`deployment.purpose`: `non-production` or `production`) and its exact namespace (`deployment.namespace`, which must equal the release namespace), and refuses to render the gate for anything but a declared non-production deployment **in the one authorized non-production namespace** (`companion-np`, pinned in the chart and mirrored by the application): purpose and downward-API agreement alone would let any namespace self-declare itself non-production, so an unauthorized namespace — including a production-named one — fails rendering and, if it somehow reached a running process anyway, fails at startup. The declared purpose and namespace are injected into the container (chart-rendered, never operator `web.env` values — `COMPANION_*` through `web.env` fails rendering) together with the pod's actual namespace via the Kubernetes downward API, and the application re-verifies all three at runtime. Production, unknown, missing, mismatched, and unauthorized-namespace attestations are startup errors, never silent fallbacks, and none of this is inferred from `NODE_ENV`, hosts, or request headers. A run outside Kubernetes (a developer's own machine) is supported explicitly through `WEB_TEST_GATE_TRUSTED_LOCAL=true`, honored only when no chart-injected attestation is present **and no Kubernetes context indicator is present** (`KUBERNETES_SERVICE_HOST`/`KUBERNET_SERVICE_PORT` are set by the kubelet in every pod, so a pod cannot pass itself off as a local run). Trust limits: the chart-rendered attestation is trusted because it is injected by the version-controlled chart template and operator values cannot inject or override it; the local declaration trusts whoever controls the process environment on a machine outside Kubernetes. An actor able to alter the rendered Deployment or the pod's environment already holds cluster-level access, which is outside this model.
- **Host integrity and no proxy path (DNS-rebinding defense).** The listener requires every request's Host header to be exactly `127.0.0.1:<gate port>` and refuses any request carrying forwarding/proxy headers (`Forwarded`, `X-Forwarded-*`), answering a generic rejection — never a redirect to a sensitive endpoint. A page served from an attacker-controlled domain that re-resolves to `127.0.0.1` (DNS rebinding) arrives with the attacker's Host and is rejected before session issuance or any route can act on it. This check only ever rejects: it is not an authorization factor, and Host/forwarding headers are never consulted for any access decision anywhere in the application.
- **No spoofable channel marker.** Every request the test listener accepts is checked again at the socket layer (loopback peer address, gate still enabled) and then marked with a process-random attestation token that only that listener injects into request headers. Route handlers verify the token against the in-memory value; it is never logged, configured, or exposed. Requests on the main listener can therefore never pose as test-channel requests, and Host/forwarding headers are never consulted for any decision.
- **Separate, identity-free test session.** Test sessions are HMAC-signed with the dedicated gate secret and carried in a dedicated `companion_test_session` cookie; the payload has no subject and no identity of any kind. Owner session cookies are never accepted on the test channel and test cookies are never accepted on the main channel.
- **No owner-session impersonation and no OIDC on the test channel.** The Keycloak login flow never runs on the test channel: `/api/auth/login` there leads to test-session issuance and `/api/auth/callback` answers a generic 404, so an owner session can never be minted through the loopback entry. Same-origin protection for state-changing requests is preserved per channel: the main channel requires the configured public origin, the test channel requires exactly `http://127.0.0.1:<gate port>`.

All of it is re-checked at listener bind, on every request, at session issuance, and on every session use; an enabled gate with an invalid attestation or values fails the whole BFF configuration (everything answers 503) or refuses to start — it never silently falls back to a partially open state.

Safe access procedure (non-production candidate only; from the operator's workstation):

```sh
# find a web pod of the non-production release
kubectl get pods -n <non-prod-namespace> -l app.kubernetes.io/name=web
# forward the loopback-only test port; 127.0.0.1 is the default and must
# not be widened (never --address 0.0.0.0). Keep the local port equal to
# the gate port: the listener requires the Host header to be exactly
# 127.0.0.1:<gate port>
kubectl port-forward -n <non-prod-namespace> pod/<web-pod> 3100:3100
# then use the full application at http://127.0.0.1:3100 (the first visit
# establishes the test session automatically). Address it as 127.0.0.1 —
# `localhost` or any other name is refused by the listener's Host check.
```

Notes: the test entry exists to test the deployed non-production candidate; sending messages through it is real conversation work and can incur provider charges, so coordinate model use. Chart guards require a separate secret and port and prevent configuring the gate through `web.env`; production deployments must leave `web.testGate.enabled` disabled (see [`../deploy/helm/companion/README.md`](../deploy/helm/companion/README.md)). In local development (`next dev`) there is no custom server and therefore no test entry; the gate only runs with the production build via `pnpm start` or the container.

## Responsibilities

The BFF owns owner authentication and authorization at the request boundary and reduces the worker's domain-shaped HTTP surface to the client-facing fields. An identity-provider subject is not a domain identity: it is held in the session cookie and checked against the allowlist, and it is never propagated into domain records, worker calls, or functions. Web features call domain-owned contracts; domain types and persistence remain with their domain owner (the worker, see [`../worker/README.md`](../worker/README.md)).

The frontend stack is Next.js, React, and MUI with Emotion (no Tailwind). The recorded server-side choices for this edge: OIDC via `openid-client` and dependency-free HMAC-signed cookies for session and flow state. Anything beyond that (e.g. a session store, token refresh, IdP end-session flow) remains open.

## Scope

The experience is one owner and one continuous client-visible conversation. Internal sequential segments, if adopted, must not split that thread. Image generation is a separate asynchronous capability, not a blocking chat operation. Voice and uploads are out of scope.

## Open questions

- Session hardening beyond the signed cookie (rotation, revocation list, IdP back-channel logout) when the threat model calls for it.
- Token refresh and keep-alive of the IdP session; currently the BFF session simply expires.
- Locale/timezone handling: thread labels are UTC-based for determinism; revisit with the owner's timezone preference.
- Whether the fixed page size (currently 100 messages, BFF-fixed) and the automatic history backfill bound (currently 5 pages) should become configurable once history grows.
- Rate limiting and abuse controls at the BFF edge (currently none beyond authentication, origin checks, and input bounds).
