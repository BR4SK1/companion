# Production environment (planned)

## Responsibilities and boundaries

Document the future production configuration for application containers on K3s. Production must use its own database, credentials, storage, and external side-effect boundaries, separate from non-production. PostgreSQL and Keycloak are external existing services and are not provisioned by this chart or repository.

## Approval and promotion

Owner merge of the pull request is the production-approval action. The intended automation then promotes the same tested immutable artifacts used by the approved candidate; it must not rebuild or silently substitute artifacts. A merge currently does not deploy: the runner-free trigger/controller is unresolved and not running. No production access or deployment is part of this documentation scaffold.

## Scope and open questions

README only; no values, manifests, secret references, deployment controller, or release automation are included. Define artifact provenance, approval binding, migration compatibility, restart/order/idempotency verification, backup/recovery, and recovery procedures before enabling production promotion. Do not assume database rollback is transactional or guaranteed.

## Production values contract

Production values must declare `deployment.purpose: production` (and the
matching `deployment.namespace`), which are required for every install.
Production values must leave `web.testGate.enabled` disabled (the chart
default): the chart refuses to render the gate for a production purpose,
and the non-production-only loopback test entry grants unauthenticated
full-application access and has no place in production. Defense in depth
if it were ever misconfigured anyway: the listener binds `127.0.0.1`
inside the pod (no Service or Ingress can reach it), the gate is
fail-closed at bind/issuance/use, the application re-verifies the declared
purpose and the downward-API pod namespace at runtime and refuses to open
the gate for a `production` deployment, and its sessions require a
dedicated secret in a separate Secret — the chart refuses to render the
gate pointing at the owner session secret.
