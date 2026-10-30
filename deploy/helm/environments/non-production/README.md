# Non-production environment

## Responsibilities and boundaries

Non-production is the candidate environment after code and unit tests and a
feature-branch commit. Integration and end-to-end tests run against the
identified candidate before publication. Candidate changes must invalidate or
rerun affected checks; concurrent candidates must be serialized or isolated so
tests cannot silently switch versions.

The non-production configuration is applied with the `companion` chart into a
dedicated non-production namespace. It uses a database, credentials, storage,
and external side-effect boundaries separate from production. External
PostgreSQL and Keycloak are not provisioned by this project: the deployables
require a dedicated non-production database and an OIDC confidential client
(redirect URI `${WEB_PUBLIC_URL}/api/auth/callback`) to be provided before
they can run, and credentials arrive through Kubernetes Secrets applied
locally (see
[`../../companion/examples/companion-secrets.example.yaml`](../../companion/examples/companion-secrets.example.yaml)
for the expected keys, including the worker/web shared service token and the
owner subject allowlist). Keep model/resource use and costs bounded and
coordinated with shared capacity.

## Current state

- The chart and container image definitions exist; there is still no
  deployment trigger or controller, so installs are performed manually.
- Environment-specific values (registry path, image tag, ingress hostname,
  middleware names, model ids) are maintained in a local-only values file
  excluded from version control, per [`../README.md`](../README.md).
- Secret delivery is via a locally applied Secret; no secret values are
  committed anywhere in this repository.

## Open items

- Provisioning the dedicated non-production PostgreSQL database/role and its
  access rules is an external, owner-owned prerequisite (this repository does
  not provision PostgreSQL).
- Candidate identification/serialization for concurrent non-production
  candidates, integration/E2E coverage against the deployed candidate, and a
  runner-free trigger/controller remain unresolved.
