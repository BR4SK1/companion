# Repository working guardrails

This repository contains an architecture scaffold — architecture documentation plus the first shared-library contract code — and a private root contribution-tooling package (pnpm, Husky, commitlint; see [`CONTRIBUTING.md`](CONTRIBUTING.md)). No application code, controllers, or infrastructure are present. That describes the current state, not a permanent implementation ban. Do not infer authorization for future implementation from documented designs or scaffold contents: proceed only within the scope explicitly authorized for the current task. Keep unresolved choices explicit and update relevant documentation when a decision is actually made.

## Boundaries

- All future application containers target K3s. PostgreSQL and Keycloak are existing services external to K3s; never add them as chart dependencies or provision them here.
- Keep the product owner-only: authorize the owner at the web BFF, separately from domain identity. Do not introduce tenant abstractions or cascade identity-provider/user IDs through domain records and work.
- Preserve a single continuous visible thread. Internal sequential segments may support processing/history without fragmenting the UI.
- Domain types, schemas, and queries belong to their owning domain. Shared infrastructure libraries expose integration boundaries; do not create a generic shared-types library.
- Keep shared OpenRouter transport separate from typed chat and decision adapters. Decisions use OpenRouter's native typed question/answer variants — `choice`, `noul`, and `score` — preserved as returned: optional native probability distributions on choice and score answers, and a noul probability that stays a number rather than being coerced to a Boolean (see [`libraries/openrouter/README.md`](libraries/openrouter/README.md)). Shared libraries define transport and capability contracts, not deployment-specific policy or rule content.
- Use relational PostgreSQL as the data model; do not add a document-compatibility layer. Durable grouped messaging is a requirement, but queue technology and detailed turn/retry policy remain open.
- Image generation is independent of ordinary chat and uses the existing shared rendering backend as an external dependency; do not implement that integration here. Voice and uploads are out of scope.
- One worker deployable may host several logical responsibilities initially. Do not add separate service placeholders or prematurely split services.
- Deployment-specific behavior policies are not implemented or prescribed by this scaffold. Keep configurable policy content outside shared infrastructure libraries and public documentation.

## Public-content and safety rules

- Keep public documentation standalone, generic, and safe to publish. Do not include copied source, private infrastructure identifiers, sensitive usage descriptions, personal details, credentials, or links to non-public documents.
- Keep local planning and configuration private. Local-only planning files are excluded from version control. Ignore rules are not a security boundary; review public content and secrets before any future publication.
- Do not add secret values, local environment files, generated artifacts, or deployment credentials to the repository.

## Delivery constraints

- pnpm is selected as the repository package manager for contribution tooling, pinned in the root `package.json` (`packageManager` field) and in the committed `pnpm-lock.yaml`. Drizzle with `pg` remains a proposal. No ORM, queue library, numeric policy, database endpoint, or hostname is selected by this scaffold.
- Conventional Commits are validated locally by a `commit-msg` hook (commitlint via Husky, locally installed dependencies only). Validation is local-only: it does not cover squash merge titles, hooks-free clones, or remote enforcement, and no CI or branch protection exists. See [`CONTRIBUTING.md`](CONTRIBUTING.md).
- The future sequence is code/unit tests → feature-branch commit → non-production deployment → integration/end-to-end tests → pre-publication safety checks → push/pull request → owner merge as production approval → automatic production promotion of the same tested immutable artifacts.
- Non-production and production require separate databases, secrets, storage, and side-effect boundaries. Account for restart/order/idempotency testing, migration compatibility and recovery, and serialization or isolation of concurrent non-production candidates.
- A runner-free deployment trigger/controller is unresolved and not running. A merge does not currently deploy. Never claim a deployment or production approval occurred unless verified.
- No production access or production provisioning is required for scaffold or contract-level work.

## Delegation and handoff

- The active primary agent owns user clarification and authorization. A delegated agent continues routine work within its authorized scope; it does not start a separate user conversation.
- Return blockers, consequential product/design/deployment choices, scope changes, and access requirements to the primary agent for resolution before continuing the affected work. Do not make those decisions or grant approvals on the primary's behalf.
- Skills provide reusable guidance only; they do not replace repository instructions, permissions, credentials, or explicit task authorization.

## Process adherence

- Follow the defined process exactly. Do not improvise around, bypass, or substitute required steps, and never claim a step was completed if it was not.
- If a required step is unclear, blocked, inapplicable, or conflicts with other instructions, stop the affected work and ask the user before deviating.
