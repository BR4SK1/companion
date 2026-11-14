# Non-production environment

## Responsibilities and boundaries

Non-production is the candidate environment after code and unit tests and a
feature-branch commit. Integration and end-to-end tests run against the
identified candidate before publication. Candidate changes must invalidate or
rerun affected checks; concurrent candidates must be serialized or isolated so
tests cannot silently switch versions.

The non-production configuration is applied with the `companion` chart into a
dedicated non-production namespace. It uses a database, credentials, storage,
and external side-effect boundaries separate from production — with one
narrow, owner-authorized exception: the OpenRouter provider API key may hold
the same value here as in production, each environment still keeping its own
Kubernetes Secret (spend limits, revocation, and exposure of that key are
shared across both environments — an explicitly accepted owner trade-off).
External
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

## End-to-end access to the candidate (test-entry gate)

E2E testing of a non-production candidate may use the web app's
non-production-only test-entry gate: an unauthenticated full-application
surface reachable only over the operator's loopback. The values must
declare the deployment purpose and namespace (fail-closed), and enable the
gate:

```yaml
deployment:
  purpose: non-production
  namespace: companion-np
web:
  testGate:
    enabled: true
    port: 3100
    existingSecret: companion-web-test-gate-secrets
```

The namespace must be exactly `companion-np`: it is the one authorized
non-production namespace (pinned in the chart and mirrored by the
application), so no other namespace — including a production-named one —
can self-declare itself non-production and open the gate. The chart
refuses to render the gate for any other purpose or namespace (production
values with the gate enabled fail rendering), and the application
re-verifies the declared purpose and namespace against the
Kubernetes-provided pod namespace before the gate may open. The gate
Secret must exist in the release namespace with a
`WEB_TEST_GATE_SESSION_SECRET` key (a secrets-generator value, never the
owner session secret, in a Secret separate from `web.existingSecret` — the
chart fails rendering otherwise). Then access the candidate with

```sh
kubectl get pods -n <non-prod-namespace> -l app.kubernetes.io/name=web
kubectl port-forward -n <non-prod-namespace> pod/<web-pod> 3100:3100
# use the full application at http://127.0.0.1:3100
```

Keep the port-forward bound to the workstation loopback (never
`--address 0.0.0.0`) and tear the forward down when testing ends. Sending
messages through the gate is real conversation work and can incur
model/provider charges, so keep model use bounded and coordinated. Never
create a Service, Ingress, or other route for the test port, and never
enable the gate in production values (see
[`production/README.md`](production/README.md)).

## Destructive integration maintenance against the application database

The worker integration suites are a post-deployment ship-it gate. Unlike the
local Playwright stack, they use the non-production application's own database
through `WORKER_TEST_DATABASE_URL`; they destructively clear/recreate schema
and synthetic configuration. This is authorized only for this non-production
workflow. Outside that exact workflow, use only a separately verified
disposable isolated database or leave the suites skipped; never point them at
an application database. Do not use production credentials, connect to
production, or point the test variable at any other target.

Before the first destructive statement, use read-only checks to positively
verify the exact deployed candidate and the target server/database/role against
the approved non-production-only configuration. Prove production separation
from approved private environment metadata without connecting to production.
Confirm the database access/privileges and the candidate's complete migration
runner route. Locate a complete owner-approved private restoration source for
every required non-production runtime configuration. If any identity, access,
route, separation, or restoration prerequisite is missing or ambiguous, stop
before destruction.

Serialize a maintenance window for the non-production database: stop the web
and worker deployments and every other consumer, prevent new connections, and
verify that no unidentified database sessions remain. Run each integration
suite in its own `node --test` invocation, one at a time, using only the
verified non-production credentials. Keep connection strings and configuration
values out of output and logs. The E2E suite remains separate and uses only its
run-owned throwaway local PostgreSQL and fake provider.

After integration, reconstruct a clean schema using the deployed candidate's
full ordered migration composition, restore all required non-production
runtime configuration from the approved private source, and verify the
migration ledger and configuration completeness without exposing values. A
worker restart alone does not restore state. Restart and verify the same
candidate, confirm no synthetic integration data remains, and only then run the
deployed loopback gate and smoke. If reconstruction fails, keep non-production
consumers stopped and stop the ship workflow; do not continue to the gate,
smoke, push, or PR. Any task-scoped private configuration capture must be
safely handled and removed after verified restoration, not retained as a
routine snapshot. This workflow does not provision or operate the external
PostgreSQL service and does not apply to recall evaluation or other tools.

## Open items

- Provisioning the dedicated non-production PostgreSQL database/role and its
  access rules is an external, owner-owned prerequisite (this repository does
  not provision PostgreSQL).
- Candidate identification/serialization and a complete private
  non-production configuration restoration source remain hard prerequisites
  for destructive integration maintenance; stop when either is unavailable.
  The runner-free trigger/controller remains unresolved.
