---
name: repository-architecture-review
description: Review Companion architecture or implementation against current repository decisions, ownership boundaries, and evidence. Read-only by default; distinguish constraints from proposals and open choices.
---

# Repository architecture review

Perform a scoped, evidence-based review. This workflow does not authorize implementation.

## Workflow

1. **Establish scope.** Restate the requested review target and question. Identify relevant paths and requested depth. If scope is unclear or evidence is unavailable, state the limitation rather than silently broadening the review.
2. **Read current repository decisions.** Inspect applicable root and scoped agent instructions, architecture documents, relevant area READMEs, and current implementation/configuration where present. Treat explicit repository constraints as constraints, but distinguish them from documented direction, proposals, and unresolved decisions. Re-check current sources on each review; do not turn a proposal or an old review into a settled requirement. If documentation conflicts, report the conflict and its source rather than choosing silently.
3. **Inspect implementation evidence.** Read relevant source, tests, configuration, and dependency declarations as needed. Trace ownership and important call/data boundaries across concrete paths. This scaffold may contain documentation only: do not claim planned components, integrations, or deployment flows work unless actual evidence establishes that.
4. **Evaluate fit.** Compare the reviewed scope with applicable constraints and current decisions. Use this Companion-specific checklist where relevant; it is a review aid, not a demand that every future capability be implemented in every initial slice:
   - **Product and identity:** the initial direction is one owner and one continuous visible thread. Internal sequential segments may exist only when justified and must not become separate visible threads. Keep domain identity separate; use only justified domain IDs and do not cascade identity-provider subjects or speculative user/tenant IDs through records, jobs, or APIs. Do not introduce multi-tenancy without an explicit decision.
   - **Web/BFF:** the planned web boundary is Next.js, React, and MUI, with owner authentication and authorization at the BFF edge. Treat this as documented direction, not proof that a web app exists or blanket authorization to add dependencies.
   - **Worker and durable work:** the initial worker is one deployable with modular responsibilities. Its design owns durable grouped-turn lifecycle concerns, including relevant context snapshots, ordering, timing, retry, idempotency, restart recovery, and stale-state handling. Check that consecutive messages from the same sender are grouped rather than drained as stale backlog. Detailed policies and queue technology remain open unless a current decision settles them.
   - **Independent rendering:** image rendering is an asynchronous capability independent of ordinary chat, using the existing shared rendering service as an external dependency. Do not make it block chat or imply the integration is implemented. Voice and uploads are out of scope unless repository decisions change.
   - **Domain ownership:** types, schemas, and queries stay with their owning domain. Shared libraries provide reusable infrastructure and integration boundaries, not a generic shared-types dumping ground or deployment-specific policy content.
   - **OpenRouter capabilities:** keep shared transport separate from typed chat and native decision adapters; do not treat a decision as an ordinary chat call. Decision outputs are probability distributions over offered choices, not independent scores. Verify claims about native support and semantics against the actual selected provider/model contract and implementation evidence; if none is selected or verifiable, mark that behavior unresolved rather than assuming it.
   - **Data and services:** PostgreSQL is the relational system of record and an existing service external to K3s; do not add a document-compatibility layer. Keycloak is also external. K3s is the target for future application containers, not a reason to provision either external service in this repository.
   - **Environment and delivery:** non-production and production need separate databases, secrets, storage, and side-effect boundaries. The intended flow promotes the same tested immutable artifacts; owner merge is the production-approval gate. The runner-free deployment trigger/controller remains unresolved and is not implemented or running. Do not claim a merge deploys.
   - **Keep proposals open:** pnpm and Drizzle with `pg` are proposals, not settled choices. Queue technology and detailed turn, retry, and in-flight response policy are also open unless a current decision says otherwise. Do not report proposals as approved requirements.

   Evaluate whether responsibilities have clear owners, dependencies cross boundaries for justified reasons, abstractions remove real duplication without hiding domain distinctions, and a simpler structure meets the stated needs. Do not treat novelty or a preferred architecture as a defect on its own.
5. **Report actionable findings.** Lead with findings, ordered by severity. For each, give severity, concrete path(s) and concise evidence, the applicable constraint or decision (or identify it as a proposal/open choice), and a practical corrective option. Clearly label recommendations as proposals, not existing decisions. Separate verified observations from interpretation and note material uncertainty or areas not examined.
6. **Keep the review read-only.** Do not edit files, refactor, add dependencies, or run state-changing operations unless a separate explicit request authorizes bounded implementation. A review recommendation is not that authorization.

## Output

Provide a short scope statement, then severity-ranked findings with evidence and action. If no material findings are supported, say so and describe the inspected areas and remaining limits. Do not claim comprehensive coverage from a partial inspection or present planned capabilities as working code.
