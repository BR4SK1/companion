# Repository working guardrails

The [architecture overview](docs/architecture/overview.md) describes the web/BFF, worker domains, local configuration manager, shared libraries, K3s deployment and required non-production E2E. The [chart](deploy/helm/README.md) uses local environment values and external secrets. A merge does not deploy. Proceed only within the scope authorized for the current task. Keep unresolved choices explicit and update the relevant documentation when decisions are made.

## Boundaries

- All future application containers target K3s. PostgreSQL and Keycloak are existing services external to K3s; never add them as chart dependencies or provision them here.
- Keep the product owner-only: authorize the owner at the web BFF, separately from domain identity. Do not introduce tenant abstractions or cascade identity-provider/user IDs through domain records and work.
- Preserve a single continuous visible thread. Internal sequential segments may support processing/history without fragmenting the UI.
- Domain types, schemas, and queries belong to their owning domain. Shared infrastructure libraries expose integration boundaries; do not create a generic shared-types library.
- Keep shared OpenRouter transport separate from typed chat and decision adapters. Decisions use OpenRouter's native typed question/answer variants — `choice`, `noul`, and `score` — preserved as returned: optional native probability distributions on choice and score answers, and a noul probability that stays a number rather than being coerced to a Boolean (see [`libraries/openrouter/README.md`](libraries/openrouter/README.md)). Shared libraries define transport and capability contracts, not deployment-specific policy or rule content.
- Use relational PostgreSQL as the data model; do not add a document-compatibility layer. Durable grouped messaging is a requirement, but queue technology and detailed turn/retry policy remain open.
- New implementations that produce traceable decisions or events should use typed relational owned data and trace correlation, following the established feature-owned attempt-tracing pattern (see [`apps/worker/README.md`](apps/worker/README.md) for the reference implementation) — no generic JSONB payloads, document facades, or EAV. This does not impose a requirement to trace every internal action. Domain ownership is preserved: domain data stays with its owning domain, rather than being mandated into worker storage for non-worker domains. Any exception to the established pattern must be explicitly called out and discussed with the user before proceeding.
- Image generation is independent of ordinary chat and uses the existing shared rendering backend as an external dependency; do not implement that integration here. Voice and uploads are out of scope.
- One worker deployable may host several logical responsibilities initially. Do not add separate service placeholders or prematurely split services.
- Deployment-specific behavior policies are not implemented or prescribed by this scaffold. Keep configurable policy content outside shared infrastructure libraries and public documentation.

## Local infrastructure guidance

Before any database connection or infrastructure work, read the local guide under `.private/infrastructure/`. If it is unavailable or insufficient for the task, stop and ask; do not assume it exists in other checkouts or worktrees.

## Public-content and safety rules

- Keep public documentation standalone, generic, and safe to publish. Do not include copied source, private infrastructure identifiers, sensitive usage descriptions, personal details, credentials, or links to non-public documents.
- Keep local planning and configuration private. Local-only planning files are excluded from version control. Ignore rules are not a security boundary; review public content and secrets before any future publication.
- Do not add secrets — including generated secret keys and credentials — local environment files, or deployment credentials to the repository. Generated artifacts, AI-generated code, and product image assets are not categorically prohibited by this rule.
