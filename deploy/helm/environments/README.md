# Environment configuration

Non-production and production responsibilities are described separately in
[`non-production`](non-production/README.md) and
[`production`](production/README.md). The two environments must have separate
databases, secrets, storage, and side-effect boundaries — with one narrow,
owner-authorized exception: the OpenRouter provider API key may hold the same
value in both environments, each still delivered only through that
environment's own Kubernetes Secret. That key's spend limits, revocation, and
exposure are thereby shared between the environments, and the owner has
explicitly accepted that trade-off, including the risk that the key in use
has been exposed previously; every other credential stays per-environment.
PostgreSQL and
Keycloak remain externally managed, outside K3s.

Environment-specific values — registry paths, image tags, ingress hostnames,
middleware names, model ids — are private configuration. They are kept in
local-only values files excluded from version control (the repository
`.gitignore` excludes `.private/` and `.secrets/`), not committed here, so
this directory stays documentation-only and safe to publish. Secret values
are never stored in values files at all; the chart references an existing
Kubernetes Secret whose contents are supplied locally
(see [`../companion/examples/companion-secrets.example.yaml`](../companion/examples/companion-secrets.example.yaml)).

A `helm` release is installed per environment into that environment's own
namespace. There is still no deployment trigger or controller: installs are
manual, and a merge does not deploy.
