# Architecture overview

## Product and interaction shape

The initial direction is a single-owner conversational application with one continuous visible text thread. Internal processing or history boundaries must not fragment the thread. Deployment-specific behavior policies and rule content are not specified by this public scaffold; none is implemented here.

Owner-only authorization belongs at the web BFF edge and is separate from domain identity. Keycloak is an existing external identity service; no identity service is provisioned by this project. Do not cascade identity-provider subjects or speculative user/tenant IDs through domain records, jobs, or APIs.

## Component boundaries

- **Web/BFF:** planned Next.js, React, and MUI client and authenticated request boundary. It presents the continuous thread and enforces owner-only access.
- **Worker:** one initial deployable for durable background responsibilities. Keep logical capabilities modular without prematurely creating multiple service placeholders.
- **Shared libraries:** reusable OpenRouter transport/capability adapters and PostgreSQL access concerns. Domain types, schemas, and queries stay with their domain owners; there is no generic shared-types library.
- **Tests:** planned Vitest-oriented integration coverage and Playwright-oriented end-to-end coverage, isolated from production.

These are documentation boundaries, not implemented services. pnpm and Drizzle with `pg` remain proposals. No queue library, model, endpoint, numeric policy, hostname, or database connection is selected.

## Data and model direction

PostgreSQL is the relational system of record and is external to K3s. Do not add document compatibility. Durable grouped messaging is required: work survives browser disconnects and process restarts, and consecutive user messages from the same sender are grouped rather than processing a stale backlog one message at a time.

OpenRouter shared transport must remain separate from typed chat and decision adapters. The decision contract is defined and implemented in [`libraries/openrouter`](../../libraries/openrouter/README.md): it uses OpenRouter's native typed question and answer variants — `choice`, `noul`, and `score` — and preserves them as returned. Choice answers carry the selected option with optional per-option probabilities; score answers carry the probability-weighted position on an ordered scale with the optional level legend and distribution; a noul probability stays a number and is never coerced to a Boolean. Optional fields stay optional and validation adds no defaults, normalization, thresholds, or fallback. Shared libraries define capability contracts and transport; application-owned choices and deployment-configured policy are outside this public infrastructure description. Provider/model support, fallback behavior, error handling, and diagnostics remain to be settled.

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

The runner-free trigger/controller for this flow is unresolved and is not running. Merging now does not deploy. Candidate/source/artifact traceability and invalidation or rerun of tests after candidate changes are required. Protect deployments and tests from untrusted pull-request execution. Define schema migration compatibility, backup/recovery, restart/order/idempotency tests, and safe recovery before production use; do not promise transactional database rollback without a designed mechanism.

## Open decisions

- Queue technology and turn behavior during in-flight responses: cancellation, retries, ordering, idempotency, and restart recovery.
- Image-generation request/result lifecycle, context snapshot, reconciliation, and late-result UI behavior.
- Provider/model support for typed decisions; fallback and calibration for failures or unusable answers.
- Whether to retain decision diagnostics, and what/for how long.
- Database access/migration approach and recovery strategy.
- How shared infrastructure libraries map to deployment ownership.
- Where deployment-specific behavior policies belong without embedding policy content in shared libraries.
- Deployment trigger/controller, candidate serialization/isolation, and immutable artifact promotion mechanism.
