# Production environment (planned)

## Responsibilities and boundaries

Document the future production configuration for application containers on K3s. Production must use its own database, credentials, storage, and external side-effect boundaries, separate from non-production — with one narrow, owner-authorized exception, documented in [Shared provider credential](#shared-provider-credential-owner-authorized-exception) below. PostgreSQL and Keycloak are external existing services and are not provisioned by this chart or repository.

## Approval and promotion

Owner merge of the pull request is the production-approval action. The intended automation then promotes the same tested immutable artifacts used by the approved candidate; it must not rebuild or silently substitute artifacts. A merge currently does not deploy: the runner-free trigger/controller is unresolved and not running. No production access or deployment is part of this documentation scaffold.

## Scope and open questions

README only; no values, manifests, secret references, deployment controller, or release automation are included. Define artifact provenance, approval binding, application-level migration compatibility, and restart/order/idempotency verification before enabling production promotion. Operating the external PostgreSQL service — including its backup/recovery and hardening — is that service's own concern, not a gate this project performs or verifies. Do not assume database rollback is transactional or guaranteed.

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

Publishing the web client on a node host port (for example as a tunnel's
target) uses the chart's optional `web.loadBalancer` Service, which is
disabled by default and production-gated: it renders only for
`deployment.purpose: production` with an explicit
`web.loadBalancer.hostPort` (an integer from 1 to 65535 that must differ
from `web.service.port`; the chart cannot detect a host-port collision
between releases, so choose it under the hosting environment's host-port
policy and keep it unique across that environment's published services).
Enabling it bypasses the Traefik ingress and its middlewares entirely:
nothing Traefik enforces on the ingress route — rate limits, security
headers, allowlists — applies on the LoadBalancer path, the published port
is plain HTTP on the host network (TLS termination happens upstream, for
example at a tunnel), and the web BFF's owner-only authentication remains
the only access control on that path. Health there is ordinary Service
behavior: only Ready web pods (the readiness probe on `/`) receive
traffic, and there is no separate LoadBalancer health check. The worker
never gets a LoadBalancer; its Service stays cluster-internal by design.

## Shared provider credential (owner-authorized exception)

As an explicit owner decision (2026-11-01), production and non-production may
share one model-provider credential: the OpenRouter API key may hold the same
value in both environments. Each environment still delivers it only through
its own Kubernetes Secret — the Secrets themselves, their namespaces, and
their delivery stay separate; only that one key's value is the same.

This coupling is intentional and accepted, and it is the only exception to
environment credential separation:

- **Spend limits and revocation are shared.** Rate limits, quota, spend, and
  revocation/rotation apply to both environments at once: exhausting or
  revoking the key in one environment degrades or stops the other, and
  rotating it means reconfiguring both.
- **Exposure is shared.** Anyone who obtains the key from either environment
  can use it against both; the blast radius of a leak is both environments'
  provider usage. The owner has explicitly accepted this trade-off, including
  the risk that the key in use has been exposed previously.
- **Privacy posture is unchanged.** Provider-side data handling for requests
  sent with the shared key is whatever the provider's policy makes of it; the
  shared key does not change what data leaves the cluster, and non-provider
  data boundaries are unaffected.

Everything else remains strictly per-environment: databases, storage,
side-effect boundaries, and all other credentials — the OIDC client secret,
the session-signing secret, the web↔worker service tokens, and the
non-production-only test-gate secret. Reversing this exception later (for
example, issuing a distinct production key) is an owner decision and touches
only that key's value in the production Secret.
