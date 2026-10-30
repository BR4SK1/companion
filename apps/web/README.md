# Web application and BFF

## Current state: authenticated live client with the BFF wired to the worker

`apps/web` contains the web client and the backend-for-frontend (BFF) boundary: a Next.js (App Router), React, and MUI messenger client rendering the single continuous conversation, backed by the worker's durable thread through authenticated BFF routes. Owner-only authorization happens at the BFF edge with OpenID Connect against the existing external Keycloak service.

What is implemented:

- **Owner-only OIDC sign-in.** Authorization code flow with PKCE, `state`, and `nonce` via [`openid-client`](https://github.com/panva/openid-client) (the certified Node.js OpenID Connect relying-party library — the recorded, approved library choice for this edge). After the exchange, the identity-provider subject must be on the explicit owner allowlist (`WEB_OWNER_SUBJECTS`); a denied subject receives the same generic failure as any other error and no session exists. The BFF holds all credentials server-side; nothing secret reaches the browser.
- **Signed-cookie sessions.** The session is an HMAC-SHA256-signed, HttpOnly, SameSite=Lax cookie (`Secure` when the public URL is https) carrying only the subject and expiry — authentication identity at this edge, never a domain identifier. The in-flight login's state/nonce/PKCE verifier travel in a separate short-lived signed cookie.
- **Fail-closed everywhere.** Missing or malformed BFF configuration renders a generic "temporarily unavailable" surface, refuses to start sign-in, and answers API calls with `503`; it never degrades to open access. API routes require a verified session (`401` otherwise), and state-changing requests must present a same-origin `Origin` header (`403` otherwise) on top of the SameSite cookie policy.
- **Authenticated BFF API.** `GET /api/thread` (one bounded thread page — the BFF-fixed newest page by default, or the page below a validated `before` seq cursor — plus generic `{queued, generating, highestAllocatedSeq, hasRecentFailure}` status and `{oldestSeq, hasMore}` paging bounds) and `POST /api/messages` (idempotent accept with a client-supplied stable key) proxy the worker's private HTTP API with the shared service-to-service bearer token. Responses are sanitized: no upstream bodies, headers, stack traces, or configuration details pass through.
- **Live thread UI.** The page is server-rendered fail-closed (unavailable → sign-in → live thread), then a client component polls the BFF's newest page and merges it by message id. It walks history backwards (up to five pages per cycle until the bottom; an interrupted walk resumes where it stopped on a later cycle; older history behind a "Load earlier messages" control, which stays visible while allocated-but-uncommitted seqs may exist below the loaded bottom). Reconciliation has no timing assumptions: the client re-derives the gaps between its loaded seqs every cycle and spends a bounded page budget (three pages per cycle, round-robin across gaps, walk cursors persist between cycles) walking each gap downward — recovering late-committed messages buried under later traffic and waiting out in-flight transactions for as long as they take; a seq burned by a rolled-back insert never resolves, and its cost is bounded probing, never a missed message. Retried sends reuse the same idempotency key; a conflicting key reuse (409) recovers with a fresh key. Loading, connection-error (automatic retry plus an explicit retry control), ended-session, per-message failure states, and a sanitized notice when the trailing conversation includes a failed generation (no error detail) are all visible.
- **Single continuous thread.** Clusters, UTC day dividers, scroll anchoring, and the composer carry over from the first client slice unchanged; internal turns and work grouping never fragment the visible thread.

Not implemented (by design): uploads, voice, image-generation integration, message editing/deletion, and any multi-user or tenant concept. Images exist only as presentation support in the message model; no backend produces them.

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

For local development against a local worker, set `WEB_WORKER_URL=http://127.0.0.1:8080` and run the worker with a matching `WORKER_API_TOKEN`. Sign-in requires a reachable Keycloak realm and a registered confidential client whose allowed redirect URI is `${WEB_PUBLIC_URL}/api/auth/callback` — an owner-provided external prerequisite this repository does not provision.

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
