# Web application and BFF

## Current state: local-only client preview (first slice)

`apps/web` now contains the first web-client slice: a **local-only, fixture-backed preview** of the messenger client, built with Next.js (App Router), React, and MUI. It renders the planned single continuous conversation thread in a mobile-optimized standard messenger layout.

What the preview includes:

- A continuous visible thread (fixture data): consecutive same-role messages group into clusters, calendar-day changes produce time dividers, and the thread never fragments into separate conversations.
- Inline image rendering inside the message flow (static local fixture assets, with an accessible lightbox view). No upload flow exists.
- A responsive, accessible composer: Enter sends, Shift+Enter adds a newline, the field grows to a bounded number of lines.
- Dark and light color schemes with sensible persistence: the OS preference is the default, an explicit toggle stores the choice in `localStorage`, and the scheme is resolved before first paint so there is no flash.
- Scroll anchoring: the view follows the newest message only while the reader is already near the bottom. Scrolled up into history, the viewport is never pulled away; a jump-to-latest button appears instead.
- Mobile safe areas (`viewport-fit: cover`, `env(safe-area-inset-*)`) and a dynamic-viewport app shell so browser chrome does not clip the composer.

What the preview deliberately does **not** include:

- No backend, BFF, API routes, database, queue, or live chat of any kind. Messages typed into the composer are appended to in-memory state for the current page load and are never sent or stored. Containerization and Kubernetes packaging for the app live in [`../../deploy`](../../deploy/README.md); they add no backend behavior.
- No authentication or authorization. Real owner-only authorization belongs to the future BFF edge (see [AGENTS.md](AGENTS.md)).
- No uploads, voice, or image-generation integration. Fixture images are static assets served by the app itself.

The preview is clearly labeled in the UI (a persistent notice plus the page title) so the fixture thread cannot be mistaken for live chat.

## Running the preview

From the repository root:

```sh
pnpm install                       # installs workspace packages (root tooling + apps/web)
pnpm --filter @companion/web dev   # development server
pnpm --filter @companion/web build # production build (type-checks and prerenders)
pnpm --filter @companion/web start # serve the production build
pnpm --filter @companion/web lint
pnpm --filter @companion/web typecheck
pnpm test:unit                     # repo unit tests, including the preview's pure logic
```

The app is a single page (`/`). Pure presentation logic (thread grouping, scroll anchoring, time labels, fixture sanity) lives in `src/lib` as plain TypeScript and is unit-tested from `tests/unit` with Node's built-in runner — no browser or extra test runner involved.

## Responsibilities

Planned Next.js/React/MUI application: render one continuous visible text thread and provide the backend-for-frontend (BFF) boundary for client requests. Authentication and owner-only authorization happen at this edge, using the existing external Keycloak service through an OIDC integration once selected and validated.

## Boundaries and dependencies

The BFF owns session and access enforcement, but an identity-provider subject is not a domain identity. Do not cascade owner/user IDs through domain schemas, jobs, worker calls, or functions. Web features call domain-owned contracts; domain types and persistence remain with their domain owner. PostgreSQL is external to K3s and is reached through the shared infrastructure library, not provisioned by this app.

The frontend stack for this slice is Next.js, React, and MUI with Emotion (no Tailwind). These are now approved and recorded here for the client preview; the server-side choices of this app (BFF framework details, session libraries) remain open.

## Scope

The intended initial experience is one owner and one continuous client-visible conversation. Internal sequential segments, if adopted, must not split that thread. Image generation is a separate asynchronous capability, not a blocking chat operation. Voice and uploads are out of scope. The current preview implements the client-visible surface of that experience against fixture data only.

## Open questions

- Choose and validate the OIDC/BFF libraries and session protections; define client/API contracts and error behavior.
- Decide how durable message acceptance and status are represented without exposing internal segment boundaries.
- Confirm the domain message model and how the client thread (clusters and dividers above) maps onto it; the preview's types are UI-shaped and not a domain contract.
- Time presentation is currently UTC-based for deterministic prerendering; revisit locale/timezone handling with real data.
- Whether the preview's in-memory send behavior should be kept as a UI-only affordance or removed once a real submission path exists.
