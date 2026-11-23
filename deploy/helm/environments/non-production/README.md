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

- The chart and container image definitions exist. The chart itself has no
  deployment trigger or controller; non-production ship installs run
  through the repo-owned `scripts/ship-deploy` entry point on push
  (exact-SHA, digest-pinned), and other installs are performed manually.
- Environment-specific values (registry path, image tag, ingress hostname,
  middleware names, model ids) are maintained in a local-only values file
  excluded from version control, per [`../README.md`](../README.md).
- Secret delivery is via a locally applied Secret; no secret values are
  committed anywhere in this repository.

## End-to-end access to the candidate (test-entry gate)

E2E testing of a non-production candidate uses the web app's
non-production-only test-entry gate: an unauthenticated full-application
surface reachable only over the operator's loopback. Enable it in
non-production values only:

```yaml
web:
  testGate:
    enabled: true
    port: 3100
    existingSecret: companion-web-test-gate-secrets
```

The gate Secret must exist in the release namespace with a
`WEB_TEST_GATE_SESSION_SECRET` key (never the owner session secret, in a
Secret separate from `web.existingSecret` — the chart fails rendering
otherwise). `web.testGate.enabled` and `web.loadBalancer.enabled` are
mutually exclusive. Then access the candidate with:

```sh
kubectl get pods -n companion-np -l app.kubernetes.io/name=web
kubectl port-forward -n companion-np pod/<web-pod> 3100:3100
# use the full application at http://127.0.0.1:3100
```

Keep the port-forward bound to the workstation loopback (never
`--address 0.0.0.0`) and tear the forward down when testing ends. Sending
messages through the gate is real conversation work and can incur
model/provider charges, so keep model use bounded and coordinated. Never
create a Service, Ingress, or other route for the test port, and never
enable the gate in production values (see
[`production/README.md`](../production/README.md)).

## Database integration safety

Database-backed suites that truncate domain data, synthesize runtime
configuration, exercise destructive migration paths, or inject failures are
explicit isolated-test tools, not routine shipping gates. `WORKER_TEST_DATABASE_URL`
may point only to a positively verified disposable database dedicated to the
run. Never target an application database, including this non-production
database, with those suites. Do not stop deployed consumers, reset a schema or
migration ledger, or capture/restore provisioned configuration to satisfy a
test. Where relevant, validate changed persistence behavior on a disposable
fixture with required extensions already available; migrations do not provision
extensions.

The deployment candidate receives its ordinary forward migrations on startup.
Candidate E2E checks (`pnpm run test:e2e`) then run Playwright against the
live `companion-np` release via temporary loopback `kubectl port-forward`
tunnels, using normal application flows and uniquely attributable synthetic
messages while leaving existing provisioned configuration untouched.

## Open items

- PostgreSQL remains an external service and is not provisioned or operated by
  this repository. Candidate identification so normal-use checks cannot
  silently switch versions remains required. The runner-free
  trigger/controller remains unresolved.
