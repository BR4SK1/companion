# Background worker

## Responsibilities

Planned single worker deployable for durable background processing. Logical responsibilities may include grouped conversational work, chat and typed decision calls, and separately queued image-generation requests. These are architecture directions, not implemented handlers.

## Boundaries and dependencies

The worker uses domain-owned types, schemas, and queries, with shared libraries for OpenRouter and PostgreSQL infrastructure. It runs in K3s; PostgreSQL and the existing shared ComfyUI rendering backend are external dependencies. Chat and decision capabilities remain distinct even when composed in one worker. Image generation must not block ordinary chat and must reconcile pending, completed, or uncertain work after restarts.

## Scope

Start with one deployable rather than separate service placeholders. Durable work must survive browser disconnects and process restarts; consecutive user messages from the same sender should be grouped into a turn rather than draining a stale backlog one message at a time. Application-specific behavior policy is outside the scope of this public infrastructure description. Do not implement an image integration, voice, or uploads in this scaffold.

## Open questions

Define in-flight turn behavior, cancellation, ordering, retries, idempotency, restart recovery, and durable queue selection. Specify image request/result states, context association, and late-result presentation. Define migration and restart testing before implementation. No queue library or numeric policy is selected.
