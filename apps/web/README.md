# Web application and BFF

## Responsibilities

Planned Next.js/React/MUI application: render one continuous visible text thread and provide the backend-for-frontend boundary for client requests. Authentication and owner-only authorization happen at this edge, using the existing external Keycloak service through an OIDC integration once selected and validated.

## Boundaries and dependencies

The BFF owns session and access enforcement, but an identity-provider subject is not a domain identity. Do not cascade owner/user IDs through domain schemas, jobs, worker calls, or functions. Web features call domain-owned contracts; domain types and persistence remain with their domain owner. PostgreSQL is external to K3s and is reached through the shared infrastructure library, not provisioned by this app.

## Scope

The intended initial experience is one owner and one continuous client-visible conversation. Internal sequential segments, if adopted, must not split that thread. Image generation is a separate asynchronous capability, not a blocking chat operation. Voice and uploads are out of scope. This README does not define a working authentication flow or application behavior.

## Open questions

Choose and validate the OIDC/BFF libraries and session protections; define client/API contracts and error behavior; decide how durable message acceptance and status are represented without exposing internal segment boundaries. Next.js, React, and MUI are the recorded frontend direction, not installed dependencies.
