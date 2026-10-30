# Worker boundaries

- Keep the initial worker as one deployable with modular logical responsibilities; do not add premature service placeholders or split deployables without an authorized design decision.
- Durable grouped work must handle ordering, idempotency, restarts, and stale state explicitly. Consecutive messages from the same sender should be grouped rather than draining an accumulated stale backlog one at a time.
- Decouple slow external jobs, such as image generation, from ordinary chat. Preserve durable status and recovery/reconciliation needs without assuming a queue technology or detailed retry policy that has not been selected.
- Domain types, schemas, and queries remain owned by their domains. Keep application behavior policy out of shared infrastructure libraries and public documentation.
- Follow the root `AGENTS.md` for repository-wide scope, public-content, and delegation rules. Documented future designs do not by themselves authorize implementation.
