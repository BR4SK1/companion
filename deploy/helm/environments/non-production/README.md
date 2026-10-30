# Non-production environment (planned)

## Responsibilities and boundaries

Document the future non-production configuration for application containers on K3s. Use a database, credentials, storage, and external side-effect boundaries separate from production. External PostgreSQL and Keycloak are not provisioned by this project. Keep model/rendering resource use and costs bounded and coordinated with shared capacity.

## Delivery role

Non-production is the candidate environment after code and unit tests and a feature-branch commit. Integration and end-to-end tests run against the identified candidate before publication. Candidate changes must invalidate or rerun affected checks; concurrent candidates must be serialized or isolated so tests cannot silently switch versions.

## Scope and open questions

README only; no values, manifests, secrets, runner, or deployment trigger are included. Decide candidate identification/serialization, secret delivery, test data isolation, resource policy, and safe side-effect controls. The runner-free trigger/controller is unresolved and not running.
