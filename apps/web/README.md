# Web application and BFF

## Current state: authenticated live client with the BFF wired to the worker

`apps/web` contains the web client and the backend-for-frontend (BFF) boundary: a Next.js (App Router), React, and MUI messenger client rendering the single continuous conversation, backed by the worker's durable thread through authenticated BFF routes. Owner-only authorization happens at the BFF edge with OpenID Connect against the existing external Keycloak service.

What is implemented:

- **Owner-only OIDC sign-in.** Authorization code flow with PKCE, `state`, and `nonce` via [`openid-client`](https://github.com/panva/openid-client) (the certified Node.js OpenID Connect relying-party library — the recorded, approved library choice for this edge). After the exchange, the identity-provider subject must be on the explicit owner allowlist (`WEB_OWNER_SUBJECTS`); a denied subject receives the same generic failure as any other error and no session exists. The BFF holds all credentials server-side; nothing secret reaches the browser.
- **Signed-cookie sessions.** The session is an HMAC-SHA256-signed, HttpOnly, SameSite=Lax cookie (`Secure` when the public URL is https) carrying only the subject and expiry — authentication identity at this edge, never a domain identifier. The in-flight login's state/nonce/PKCE verifier travel in a separate short-lived signed cookie.
- **Fail-closed everywhere.** Missing or malformed BFF configuration renders a generic "temporarily unavailable" surface, refuses to start sign-in, and answers API calls with `503`; it never degrades to open access. API routes require a verified session (`401` otherwise), and state-changing requests must present a same-origin `Origin` header (`403` otherwise) on top of the SameSite cookie policy.
- **Authenticated BFF API.** `GET /api/thread` opens the newest 100 messages. Exclusive `after` and `before` cursors page forward and backward. `POST /api/messages` sends a stable client key and original send time. `POST /api/thread?attempt=<id>` requests another generation for the latest failed attempt. Both mutations require a same-origin request and an authorized session. `GET /api/images/<asset-id>` serves one rendered image (owner- or test-session authenticated like the thread read; the worker's bytes and token never reach the browser beyond the image itself).
- **Non-production-only loopback test entry.** An optional, fail-closed gate adds a `127.0.0.1`-bound listener inside the pod for E2E access without sign-in, with its own identity-free session kind, secret, and cookie; see the dedicated section below. The owner-only paths are unchanged when the gate is off (the default).
- **Live thread UI.** The visible page polls forward from its last committed sequence every two seconds and fetches additional pages to catch up. “Load earlier” walks backwards on demand. A missing or unreadable send acknowledgment offers retry with the original key. A key conflict requires a fresh key. The owner can retry the latest failed generation without sending the message again.
- **Installable PWA shell.** A web app manifest (`/manifest.webmanifest`, static user-agnostic values) with the Companion name, `standalone` display, and icons generated at build time from source-defined drawing code; Apple home-screen metadata and a 180×180 `apple-touch-icon`; a minimal production-only service worker that serves one static offline fallback page and caches nothing else (see the PWA section below).
- **Single continuous thread.** Clusters, authoritative local-day dividers, scroll anchoring, and the composer carry over from the first client slice; internal turns and work grouping never fragment the visible thread. The BFF relays the worker's startup-captured IANA timezone with each page, and the browser does not infer a zone from its own environment. If the worker has no configured zone, or a browser's ICU data cannot format that zone, clocks fall back to explicitly labeled UTC and local-day dividers are omitted rather than guessed.

Not implemented (by design): uploads, voice, message editing/deletion, and any multi-user or tenant concept. Generated images arrive from the worker's image domain (see [`../worker/README.md`](../worker/README.md)): thread messages carry image refs that the BFF maps to `/api/images/<asset-id>`, an owner-authenticated proxy of the worker's private image route, and the standalone image message renders as an image-only bubble with a lightbox. The header menu includes a browser-persisted **Images** display preference (`Image`, `Icon`, or `None`) alongside theme and sign-out controls: `Image` (default) shows inline thumbnails, `Icon` shows a bare clickable generic image icon that fetches and opens the asset in the lightbox only when clicked, and `None` omits image components (and standalone image-only messages) dynamically from the thread view.

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

For local development against a local worker, set `WEB_WORKER_URL=http://127.0.0.1:8080` and run the worker with a matching `WORKER_API_TOKEN`. Sign-in requires a reachable Keycloak realm and a registered confidential client whose allowed redirect URI is `${WEB_PUBLIC_URL}/api/auth/callback` — an owner-provided external prerequisite this repository does not provision.

## Progressive Web App (PWA)

The app is installable as a standalone application. The manifest (`app/manifest.ts`, served at `/manifest.webmanifest`) carries static, user-agnostic values only — the route is publicly reachable and must never contain user data. Icons are a provisional design (a speech bubble on the app theme's light primary color) produced from source-defined drawing code in `src/lib/icons.ts` — a dependency-free rasterizer plus minimal PNG encoder — by the `app/icon.ts` and `app/apple-icon.ts` conventions (favicon and iOS home-screen icon) and the `/icons/*` route handlers (the manifest icons). Next statically prerenders these routes at build time, so the bytes are deterministic functions of the source and no generated image binaries are kept in the repository; rebranding means editing the drawing module, and the tests verify the delivered formats, dimensions, and maskable safe-zone placement. The Apple metadata (`capable`, title, status-bar style) and the icon link tags come from the root layout's metadata and the icon conventions.

- **Install.** On iOS/iPadOS use Safari's Share → "Add to Home Screen"; on Android and desktop Chromium browsers use the browser's "Install app" entry. Installation and service worker registration require a **secure context**: the app must be served over HTTPS (`localhost` also qualifies for development). The chart's web Ingress terminates TLS for the release host, so the deployed releases are installable through it; any origin served over plain HTTP (for example the optional production-only LoadBalancer Service path, which bypasses the ingress) cannot install the app or register the worker.
- **Offline behavior is intentionally minimal.** The service worker (`public/sw.js`) serves a static, user-agnostic "You're offline" page (`public/offline.html`) only when a top-level GET navigation of this origin cannot reach the server. It caches nothing except that one page, it never puts conversations, API responses, messages, session data, or user-specific pages into its storage, and HTTP error responses (404, 503, …) pass through unchanged — the fallback is only for unreachable-network failures. Sign-in, history, and sending all require a live connection either way. The worker's only cache is under its own `companion-offline-` prefix (bump the version inside `sw.js` when the fallback page changes); activation cleanup deletes only old caches with that prefix, never unrelated caches on the origin.
- **The BFF's API surface is never intercepted.** Paths under `/api` (the OIDC sign-in flow and callback, the non-production-only test-gate issuance, and the thread/message endpoints) are excluded even when they arrive as top-level navigations (typed URLs, callback redirects), and non-GET requests and subresource requests are never touched.
- **Registration is production-only.** The service worker registers through a small client component (`src/components/register-service-worker.tsx`) that runs in production builds only and is best-effort (a failed registration never surfaces), so `pnpm dev` is unaffected.
- **iOS specifics.** An installed Home Screen web app keeps its own storage separate from Safari: cookies are not shared with the browser, so the owner must sign in again inside the installed app (the OIDC redirect URI is the public origin, so the flow itself works there unchanged). The status bar uses the `default` style and the existing safe-area handling (the header pads by `env(safe-area-inset-top)` under `viewport-fit: cover`) applies in standalone mode as in the browser.

## Non-production-only test-entry gate (E2E)

The production build is served through a small custom server (`server.mjs`, used by `pnpm start` and the container): it runs the Next production server on the main listener, and — only when `WEB_TEST_GATE_ENABLED=true` is explicitly configured with its dedicated port and session secret — one additional listener bound strictly to `127.0.0.1` inside the container's network namespace. That second listener is the **test entry**: unauthenticated full-application access (reading and sending the real conversation, which can incur model/provider costs) for end-to-end testing of a non-production candidate.

Security model, in layers:

- **Loopback-only socket boundary.** The test listener binds strictly to `127.0.0.1`, so nothing outside the pod's network namespace can connect to it — not the ClusterIP Service, not the Ingress, not other pods or nodes. The intended path is `kubectl port-forward`, which dials `127.0.0.1` inside the pod's network namespace. Binding and reachability are never configurable.
- **Explicit opt-in and Helm guards.** Enabling the gate requires `WEB_TEST_GATE_ENABLED=true`, a distinct port, and a separate `WEB_TEST_GATE_SESSION_SECRET` (never inferred from `NODE_ENV`). In Helm, `web.testGate.enabled` defaults to `false`, is mutually exclusive with `web.loadBalancer.enabled`, requires a separate Kubernetes Secret, and rejects `WEB_TEST_GATE_*` in `web.env`. Production deployments must leave `web.testGate.enabled` disabled.
- **Host integrity and no proxy path.** The listener requires every request's peer address to be loopback, its `Host` header to be exactly `127.0.0.1:<gate port>`, and refuses requests carrying forwarding/proxy headers (`Forwarded`, `X-Forwarded-*`), preventing DNS-rebinding or proxied access.
- **In-memory channel attestation.** Every request accepted by the test listener is stamped with a process-random attestation token verified by route handlers against the in-memory value. Requests on the main listener can never pose as test-channel requests.
- **Separate, identity-free test session.** Test sessions are HMAC-signed with the dedicated gate secret and carried in a dedicated `companion_test_session` cookie with no subject or identity. Owner session cookies are never accepted on the test channel and test cookies are never accepted on the main channel.
- **No owner-session impersonation and no OIDC on the test channel.** The Keycloak login flow never runs on the test channel: `/api/auth/login` redirects to test-session issuance and `/api/auth/callback` returns `404`. Same-origin protection is preserved per channel (`WEB_PUBLIC_URL` on main, `http://127.0.0.1:<gate port>` on the test channel).

Invalid gate configuration fails startup or fails the BFF configuration closed (everything answers `503`) rather than falling back to a partially open state.

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

Notes: the test entry exists to test the deployed non-production candidate; sending messages through it is real conversation work and can incur provider charges, so coordinate model use. Chart guards require a separate secret and port and prevent configuring the gate through `web.env`; production deployments must leave `web.testGate.enabled` disabled (see [`../deploy/helm/companion/README.md`](../../deploy/helm/companion/README.md)). In local development (`next dev`) there is no custom server and therefore no test entry; the gate only runs with the production build via `pnpm start` or the container.

## Responsibilities

The BFF owns owner authentication and authorization at the request boundary and reduces the worker's domain-shaped HTTP surface to the client-facing fields. An identity-provider subject is not a domain identity: it is held in the session cookie and checked against the allowlist, and it is never propagated into domain records, worker calls, or functions. Web features call domain-owned contracts; domain types and persistence remain with their domain owner (the worker, see [`../worker/README.md`](../worker/README.md)).

The frontend stack is Next.js, React, and MUI with Emotion (no Tailwind). The recorded server-side choices for this edge: OIDC via `openid-client` and dependency-free HMAC-signed cookies for session and flow state. Anything beyond that (e.g. a session store, token refresh, IdP end-session flow) remains open.

## Scope

The experience is one owner and one continuous client-visible conversation. Internal sequential segments, if adopted, must not split that thread. Image generation is a separate asynchronous capability, not a blocking chat operation. Voice and uploads are out of scope.

## Open questions

- Session hardening beyond the signed cookie (rotation, revocation list, IdP back-channel logout) when the threat model calls for it.
- Token refresh and keep-alive of the IdP session; currently the BFF session simply expires.
- Thread date/time labels and day dividers use the worker's authoritative IANA
  timezone through the authenticated BFF response. A worker timezone change is
  captured on worker restart; until configured, UTC is explicitly labeled and
  day dividers are omitted. The BFF maps an absent timezone field from an older
  worker to the explicit unconfigured (`null`) state, but rejects malformed
  values when the field is present. If a browser cannot format an otherwise
  validated zone due to older ICU data, it falls back to explicitly labeled UTC
  without local-day dividers.
- A residual compatibility risk remains: the BFF strictly validates against
  its own Luxon/ICU timezone data, so a worker/BFF timezone-data mismatch could
  make the BFF reject a zone valid to the worker and return an unavailable
  thread page. Keep their runtime timezone data compatible; strict validation
  is not bypassed.
- Whether the fixed 100-message page size should become configurable.
- Rate limiting and abuse controls at the BFF edge (currently none beyond authentication, origin checks, and input bounds).
