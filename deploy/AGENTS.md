# Deployment boundaries

- Target application containers to K3s, with non-production and production targets explicit and isolated. Keep their databases, credentials/secrets, storage, and external side-effect boundaries separate. PostgreSQL and Keycloak are existing external services; do not provision them here.
- Before enabling a release flow, identify the non-production candidate and ensure tests apply to that exact candidate. Production approval is the owner's merge; intended promotion uses the same tested immutable artifacts, without rebuilding or silently substituting them.
- Protect secret delivery and keep secret values out of source, public documentation, logs, and generated artifacts. Ignore rules are not a security boundary.
- Plan migration compatibility, restart/order/idempotency verification, backup and recovery before production use. Do not assume database rollback is safe, transactional, or guaranteed.
- The deployment trigger/controller is unresolved and not running. Do not claim that a merge deploys, that a release occurred, or that production was approved without verification. No production access or provisioning is implied.
- Follow the root `AGENTS.md` for repository-wide scope, public-content, and delegation rules. Documented future designs do not by themselves authorize implementation.
