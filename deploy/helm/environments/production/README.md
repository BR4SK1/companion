# Production environment (planned)

## Responsibilities and boundaries

Document the future production configuration for application containers on K3s. Production must use its own database, credentials, storage, and external side-effect boundaries, separate from non-production. PostgreSQL and Keycloak are external existing services and are not provisioned by this chart or repository.

## Approval and promotion

Owner merge of the pull request is the production-approval action. The intended automation then promotes the same tested immutable artifacts used by the approved candidate; it must not rebuild or silently substitute artifacts. A merge currently does not deploy: the runner-free trigger/controller is unresolved and not running. No production access or deployment is part of this documentation scaffold.

## Scope and open questions

README only; no values, manifests, secret references, deployment controller, or release automation are included. Define artifact provenance, approval binding, migration compatibility, restart/order/idempotency verification, backup/recovery, and recovery procedures before enabling production promotion. Do not assume database rollback is transactional or guaranteed.
