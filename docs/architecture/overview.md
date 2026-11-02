# Architecture overview

## Product and interaction shape

The initial direction is a single-owner conversational application with one continuous visible text thread. Internal processing or history boundaries must not fragment the thread. Deployment-specific behavior policies and rule content are not specified by this public scaffold; none is implemented here.

Owner-only authorization belongs at the web BFF edge and is separate from domain identity. Keycloak is an existing external identity service; no identity service is provisioned by this project. Do not cascade identity-provider subjects or speculative user/tenant IDs through domain records, jobs, or APIs.

## Component boundaries

- **Web/BFF:** Next.js, React, and MUI client and authenticated request boundary. It presents the continuous thread and enforces owner-only access at the BFF edge: OIDC authorization-code flow (PKCE, state, nonce) against the existing external Keycloak service through `openid-client`, signed-cookie sessions holding only the identity-provider subject, an explicit owner subject allowlist, and fail-closed behavior when configuration is missing. `apps/web` implements this edge and the live client; the BFF calls the worker's private HTTP API with a service-to-service credential and forwards no identity information.
- **Worker:** one deployable for durable background responsibilities. A first slice is implemented in `apps/worker` (see its README): durable grouped conversation work on PostgreSQL with OpenRouter response-pattern decisions preceding chat generation, plus the private HTTP ingest/read API the web BFF calls — cluster-internal only, bearer-token authenticated, with idempotent message acceptance (conflicting key reuse rejected) and cursor-paged thread reads in persisted `seq` order (the status carries the allocation invariant — allocation is contiguous, so seqs below a committed seq are committed, in flight, or burned; the web client reconciles by re-deriving gaps between loaded seqs and walking pages downward with a bounded per-cycle budget and no timing assumption — and a sanitized trailing-failure flag that surfaces failed generations without error detail). Logical capabilities stay modular; premature service splits are avoided.
- **Shared libraries:** reusable OpenRouter transport/capability adapters and PostgreSQL access concerns. Implemented so far: shared OpenRouter transport with typed Decisions and Chat contracts (`libraries/openrouter`), and PostgreSQL connection lifecycle, transactions, and a minimal migration runner over `pg` (`libraries/postgres`). Domain types, schemas, and queries stay with their domain owners; there is no generic shared-types library.
- **Tests:** Node built-in unit coverage, database-backed worker integration suites (domain store and HTTP API) run against an explicitly provided disposable isolated non-production database, and implemented Playwright end-to-end coverage over a run-owned disposable local stack (throwaway PostgreSQL, local fake provider, the web production build with its loopback test gate) with run-owned cleanup; the deployed non-production smoke against the real provider is a separate, explicitly acknowledged flow. All of it is isolated from production.

The web client and worker are now connected through the BFF and the worker's private HTTP API; nothing is deployed with this wiring yet. No queue library is used; durable work is implemented with PostgreSQL-backed leasing, and no model, hostname, or credential is committed.

## Data and model direction

PostgreSQL is the relational system of record and is external to K3s. Do not add document compatibility. Durable grouped messaging is required: work survives browser disconnects and process restarts, and consecutive user messages from the same sender are grouped rather than processing a stale backlog one message at a time.

The first worker slice implements this with claim-time grouping: pending (unassigned) user messages form a trailing run of the thread; claiming groups the entire run into one turn with one snapshot; messages arriving during an in-flight turn are grouped into the next turn; replies are persisted in thread order; leases with heartbeats and reclaim-by-attempt provide restart recovery; and fenced, idempotent publication prevents a stale worker from overwriting a reclaiming worker's result. Publication and turn-state transitions are exactly-once; external provider calls are not (a crash between call and publication replays the call after reclaim). Retry policy for failed turns, fallback/calibration for unusable decisions, and diagnostics retention remain open.

OpenRouter shared transport remains separate from typed chat and decision adapters. The transport and both typed contracts are implemented in [`libraries/openrouter`](../../libraries/openrouter/README.md): the decision contract uses OpenRouter's native typed question and answer variants — `choice`, `noul`, and `score` — and preserves them as returned; the chat contract covers non-streaming text completions. Choice answers carry the selected option with optional per-option probabilities; score answers carry the probability-weighted position on an ordered scale with the optional level legend and distribution; a noul probability stays a number and is never coerced to a Boolean. Optional fields stay optional and validation adds no defaults, normalization, thresholds, or fallback. Shared libraries define capability contracts and transport; application-owned choices and deployment-configured policy are outside this public infrastructure description. Provider/model support for the typed decision flow is unverified live; fallback behavior, error handling, and diagnostics retention remain to be settled.

Image generation is an independent asynchronous capability and must not block ordinary chat. The existing shared ComfyUI rendering backend is external to this application; no integration is implemented here. Design durable request/result states, restart reconciliation, context association, and late-result presentation before implementation. Voice and uploads are out of scope.

## Runtime and external services

All future application containers deploy to K3s. PostgreSQL and Keycloak already exist outside K3s and must not be provisioned by this repository or included as chart dependencies. Other integrations, credentials, endpoints, and access mechanisms are intentionally unspecified. No production access is required for documentation or future non-production scaffolding.

## Environment separation and delivery

Non-production and production must have separate databases, secrets, storage, and external side-effect boundaries. Account for resource use and shared service capacity. Non-production candidates need safe serialization or equivalent isolation so concurrent deployments cannot change the candidate while integration/E2E tests approve it.

The agreed eventual sequence is:

1. Implement code and unit tests.
2. Commit on a feature branch.
3. Deploy to non-production.
4. Run integration and end-to-end tests.
5. Perform pre-publication safety checks.
6. Push and open a pull request.
7. Owner merge is the production-approval action.
8. Automatically promote the same tested immutable artifacts to production.

The runner-free trigger/controller for this flow is unresolved and is not running. Merging now does not deploy. Candidate/source/artifact traceability and invalidation or rerun of tests after candidate changes are required. Protect deployments and tests from untrusted pull-request execution. Define schema migration compatibility and restart/order/idempotency tests before production use; backup/recovery and hardening of the external PostgreSQL service are that service's own operating concern, not gates this project performs. Do not promise transactional database rollback without a designed mechanism.

## Open decisions

- Queue technology (a dedicated queue library remains unused; PostgreSQL-backed leasing is the current approach) and remaining turn behavior: retry policy for failed turns, cancellation of in-flight provider calls.
- Image-generation request/result lifecycle, context snapshot, reconciliation, and late-result UI behavior (still unimplemented and independent of chat).
- Decision fallback and calibration: thresholds, top-N ranking, unusable or low-confidence answers.
- Whether to retain decision diagnostics beyond the per-turn record, and for how long.
- Database access library (Drizzle with `pg` remains a proposal; the first slice uses `pg` directly) and migration-runner tooling beyond the minimal runner (checksum verification, down-migrations, a CLI). Backup/recovery for the external PostgreSQL service is that service's operating concern, not a project decision.
- How shared infrastructure libraries map to deployment ownership.
- Where deployment-specific behavior policies belong without embedding policy content in shared libraries.
- Deployment trigger/controller, candidate serialization/isolation, and immutable artifact promotion mechanism.
- BFF session hardening (rotation, revocation, IdP back-channel logout) and rate limiting at the BFF edge; TLS for the in-cluster BFF→worker hop if that boundary ever leaves the cluster network.
- Whether the response-pattern/conversation schema should move to a shared domain home as more components need the same tables.
