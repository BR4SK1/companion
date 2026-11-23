# Architecture overview

Companion serves one owner and presents one continuous conversation. The Next.js web app and a single worker run on K3s. PostgreSQL and Keycloak are existing services. The browser talks to the web app, the web backend calls the private worker API, and the worker owns the conversation and its background processing.

## Request and publication

1. The web backend authenticates the owner through Keycloak OIDC and checks the session and origin on mutations. A separate service token authenticates its requests to the worker. Domain records carry no identity-provider subject.
2. The browser assigns each composed message a stable key. The worker commits the message before acknowledging it. Replaying the same key and text returns the original row, including when the browser lost the first acknowledgment.
3. The worker groups pending messages into a turn. Messages arriving during generation wait for the next turn. When engagement session boundaries are configured, a claim stops at the next session. A lease and heartbeat support crash recovery. Each claim or reclaim creates a traceable attempt.
4. The worker assembles the configured identity, conversation history and applicable context. Required response-pattern selection uses native OpenRouter Decisions. An unusable optional article answer is recorded and omitted. The main chat response must contain visible text. Typed relational traces capture the provider boundaries and the application's verdict.
5. The current lease holder commits the reply and completes the turn in one transaction. An owner can retry the latest failed attempt against its existing grouped messages. Duplicate or stale retry requests cannot start another generation. Each turn can publish one reply. An interrupted external call can incur provider cost again after recovery.
6. User messages, generated replies and scheduled notices all take the conversation transaction lock before allocating a message sequence. Committed rows can therefore be read forward by sequence. The browser opens on the newest page, catches up with an exclusive forward cursor and loads earlier history on demand. Rollbacks and idempotent inserts may leave unused sequence numbers.

## Worker responsibilities

Conversation processing, memory, engagement, relationship learning, routines, temporal context, article ingestion and optional prompt modules share one deployable. Their schemas, queries and behavior belong to their respective domains. Optional capabilities depend on provisioned configuration. The worker can retrieve configured feeds, call configured services and use embedding inference for semantic memory. Relationship learning consumes published turn replies in the background and commits answer updates with its progress cursor. Image generation remains a separate future integration. [Worker implementation and configuration](../../apps/worker/README.md)

The shared OpenRouter library separates HTTP transport from native Decisions and Chat contracts. The PostgreSQL library supplies pool management, transactions and migration execution over pg. Worker startup and the migration-only command apply the same sequence of domain migrations. The local configuration manager is an operator-launched loopback tool bound to one environment. [Libraries](../../libraries/README.md) · [Configuration manager](../../apps/config-manager/README.md)

## Delivery and verification

Unit tests run without live dependencies. Database integration tests use dedicated disposable fixtures. Required Playwright E2E runs against the real non-production release through temporary port-forwards. Its loopback test listener uses a separate test session so an agent can exercise the application without interactive owner sign-in. The live-chat journey calls the configured provider and retains its uniquely marked synthetic conversation. [Verification](../../tests/README.md) · [E2E procedure](../../tests/e2e/README.md)

The non-production deployment script builds from a clean candidate commit, pushes images, deploys digest-pinned artifacts with Helm and verifies the ready pods. Values and credentials are supplied locally. Production promotion is a separate delivery decision. Merging a change does not trigger deployment in this repository. [Deployment entry point](../../scripts/ship-deploy) · [Chart and environments](../../deploy/helm/README.md)

## Open decisions

Automatic retries for transient main-chat model failures (decision calls support configured multi-model round-robin failover with a bounded retry pass on retryable transport errors), provider-call cancellation, diagnostic retention, image-generation recovery and production promotion remain open. Deployment-specific prompts, credentials and behavior configuration stay outside public documentation.
