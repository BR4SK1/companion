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

## Database integration safety

Database-backed suites that truncate domain data, synthesize runtime
configuration, exercise destructive migration paths, or inject failures are
explicit isolated-test tools, not routine ship-it gates. `WORKER_TEST_DATABASE_URL`
may point only to a positively verified disposable database dedicated to the
run. Never target an application database, including this non-production
database, with those suites. Do not stop deployed consumers, reset a schema or
migration ledger, or capture/restore provisioned configuration to satisfy a
test. Where relevant, validate changed persistence behavior on a disposable
fixture with required extensions already available; migrations do not provision
extensions.

The deployment candidate receives its ordinary forward migrations on startup.
Candidate checks then use normal application flows against the identified
non-production release and its already-provisioned identity, settings, memory,
and prompt-module configuration. Do not reseed or replace that configuration.
Check its invariance with approved metadata/fingerprints that do not expose
content. The routine deployed smoke uses uniquely attributable synthetic input
and intentionally retains its conversation, traces, and normal learned effects
as non-production history. Do not rewind cursors/counters or delete canonical,
shared, or otherwise ambiguous state. Legacy cleanup is explicit-only for
selected historical markers; it is not a routine gate and must never run
automatically. Preserve baseline memories. Stop if ownership, configuration
invariance, extension capability, or candidate isolation cannot be established.

Local E2E and deployed-smoke records must use a new, unique, task-owned
`E2E_RUNS_DIR` outside the historical `tests/e2e/.runs` tree. The local browser
stack uses a synthetic fixture identity, a fake OpenRouter chat/decision
provider, a real configured embedding service, and a run-owned disposable
PostgreSQL. It is not evidence about the maintained personality. Deployed checks
through the loopback gate use the existing provisioned configuration. Keep the
forward bound to workstation loopback and remove only task-owned resources.

## Open items

- PostgreSQL remains an external service and is not provisioned or operated by
  this repository. Candidate identification/serialization remains required so
  normal-use checks cannot silently switch versions. The runner-free
  trigger/controller remains unresolved.
