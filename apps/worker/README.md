# Background worker

## Status

First implemented slice: durable grouped conversation work on PostgreSQL, with response-pattern selection through OpenRouter's native typed Decisions API preceding chat generation. One deployable, modular responsibilities; no image-generation integration, voice, uploads, or web/BFF connection in this slice — the web preview stays disconnected from the worker.

## Responsibilities

Implemented in this slice:

- **Durable message ingestion contract.** User messages are appended to PostgreSQL; a caller-supplied idempotency key makes re-ingestion (e.g. a retried request) a no-op returning the existing message.
- **Claim-time grouping.** All pending (unassigned) user messages form a trailing run of the thread; claiming groups the entire run into one turn with one snapshot — never one message at a time.
- **Snapshot semantics.** A claimed turn processes exactly the messages grouped at claim time. Messages that arrive while the turn is in flight stay unassigned and are grouped into the next turn.
- **Prior-turn context snapshot.** The decision state and chat request are built from one coherent snapshot of prior work: the messages of every turn claimed before the processed one, in conversation order — for each turn, its grouped user messages followed by its published reply. Conversation order differs from raw `seq` order exactly where a reply was published after a later user message arrived (that message joins the next turn, so its `seq` is lower than the reply's): the reply still precedes it in context. Unassigned messages (future turns), the processed turn's own messages, and any later turns' messages are excluded — no leakage and no duplication. Because exclusion and ordering are keyed by turn association rather than a raw-`seq` cutoff or lease state, the snapshot is identical on every attempt of the same turn, including after a lease reclaim. A failed turn is terminal in this slice, but its user messages stay part of the visible thread and appear in later context without a reply.
- **Ordered persisted replies.** Processing is serialized (at most one in-flight turn with a valid lease), and each turn publishes at most one assistant reply whose thread position is assigned at publication, so reply order in the thread equals turn order.
- **Restart/lease recovery.** A turn whose lease has expired is reclaimable: the next claim resumes the same turn with a new attempt (incremented) and a fresh lease. A heartbeat renews the lease while the turn is in flight, at one third of the lease (at least 1000ms; configuration enforces a lease of at least 3 seconds so the cadence always renews before expiry — see `apps/worker/src/work/timing.ts`).
- **Fencing.** Publication, decision-diagnostics recording, and failure recording are all conditional on the turn still being in flight under the caller's lease. A stale worker that lost its lease can neither publish a reply nor overwrite the state of a reclaiming worker.
- **Idempotent publication.** Publishing completes the turn and persists the reply in one transaction; a duplicate publication attempt after success is recognized and reported as a no-op.
- **Response-pattern decision.** When enabled `response_pattern` records exist, one `choice` question is asked through the OpenRouter Decisions API (`POST /api/alpha/decisions`): options are pattern ids, each described by its **selection description**. The returned top choice selects the pattern. The choice answer is preserved as returned (including optional probabilities/confidence) and recorded on the turn as diagnostics; an answer that does not name an offered pattern is an error, not a silent fallback. With no enabled patterns, the decision step is skipped and chat runs without guidance.
- **Chat generation.** The selected pattern's **response guidance** (a separate text, never sent to the decider) is sent as the leading system message, followed by the prior-turn context snapshot (see below) and the turn's grouped messages, to OpenRouter's Chat Completions API (non-streaming).

Not implemented in this slice (by design): image generation, engagement/segmentation timers, proactive follow-up, a BFF-facing HTTP ingest API, retries for failed turns, and multi-conversation support.

## Module layout

```
src/
  main.ts                  composition edge: config → pool → migrations → engine loop
  config.ts                environment parsing and validation (no secret values here)
  conversation/
    types.ts               domain types (messages, turns, response patterns)
    migrations.ts          domain-owned SQL migrations (applied via @companion/postgres)
    store.ts               domain-owned queries: ingest, claim/group, lease, publish, fail
  work/
    decision.ts            pattern-choice decision build/select (pure)
    chat.ts                chat request assembly (pure)
    processor.ts           per-turn orchestration: decision → chat (transport-injected)
    engine.ts              loop: claim → heartbeat → process → publish/fail
```

Shared infrastructure lives in `libraries/postgres` (connection lifecycle, transactions, migration runner) and `libraries/openrouter` (transport plus typed Decisions and Chat contracts). No behavior policy lives in the shared libraries; the response-pattern table's contents are runtime configuration, and no pattern rows are seeded by migrations.

## Work model and guarantees

Turn states: `in_flight` → `completed` | `failed`.

- **Grouping rule.** `claimNextTurn` atomically (one transaction, serialized by a PostgreSQL advisory lock): reclaims the oldest expired in-flight turn if any; otherwise refuses to claim while an unexpired in-flight turn exists; otherwise groups the entire unassigned trailing run of user messages into a new in-flight turn with a fresh lease. A message ingested after the grouping `SELECT` is not part of the snapshot. Message ingestion takes the same advisory lock inside its transaction, so ingest commit order matches `seq` order (PostgreSQL sequences are not transactional) and a claim never snapshots while an ingest transaction is in flight — a later-seq message can never be claimed ahead of an earlier one. Ingestion is short; briefly waiting behind a claim transaction is acceptable.
- **Fencing rule.** Turn-state transitions and reply publication require `status = 'in_flight' AND lease_owner = <caller> AND lease_expires_at > now()` inside the publishing transaction. Expired-lease claims increment `attempt` and replace the lease owner.
- **Ordering rule.** Serialized claims mean persisted replies appear in thread order across turns; the assistant reply to an earlier group appears after any user messages that arrived while it was being generated (normal messaging semantics; the visible thread stays continuous).
- **Exactly-once honesty.** Publication and turn-state transitions are exactly-once (fenced, idempotent). External provider calls are not: a crash between a provider call and publication replays that call after reclaim. Only one reply ever survives per turn, but a replayed call can incur duplicate provider cost. Leases also mean an unclean worker restart waits up to one lease period before reclaiming its own turn (worker identity is not persisted in this slice).

## Data model

Domain-owned migration `0001_conversation_work`:

- `conversation_turn` — id, status, attempt, lease owner/expiry, selected pattern id, decision diagnostics (jsonb), error, timestamps.
- `conversation_message` — id, identity-based `seq` thread position, role (`user`/`assistant`), content, nullable idempotency `client_key` (unique), nullable `turn_id` reference. At most one assistant reply per turn (partial unique index).
- `response_pattern` — id, enabled, `selection_description` (for the decider), `response_guidance` (for chat), presentation `position`.

The schema is relational PostgreSQL only. No identity-provider subjects, user ids, or tenant identifiers appear in any table.

## Configuration

Environment variables (secrets are supplied at runtime, never committed):

| Variable | Required | Default | Meaning |
| --- | --- | --- | --- |
| `WORKER_DATABASE_URL` | yes | — | PostgreSQL connection string (non-production database for this slice) |
| `OPENROUTER_API_KEY` | yes | — | OpenRouter API key |
| `WORKER_CHAT_MODEL` | yes | — | Model id used for chat generation |
| `WORKER_DECISION_MODEL` | yes | — | Model id used for the response-pattern decision |
| `WORKER_OPENROUTER_CHAT_URL` | no | `https://openrouter.ai/api/v1/chat/completions` | Chat endpoint |
| `WORKER_OPENROUTER_DECISIONS_URL` | no | `https://openrouter.ai/api/alpha/decisions` | Decisions endpoint |
| `WORKER_LEASE_SECONDS` | no | `60` | Turn lease duration (minimum `3`: the engine heartbeat renews at lease/3, at least 1000ms, and a shorter lease would expire before its first renewal) |
| `WORKER_POLL_SECONDS` | no | `1` | Idle poll interval |
| `WORKER_CONTEXT_MESSAGE_LIMIT` | no | `50` | Prior messages sent as chat/decision context (the tail of the conversation-order prior-turn snapshot) |
| `WORKER_CHAT_TIMEOUT_MS` | no | `120000` | Chat call timeout |
| `WORKER_DECISION_TIMEOUT_MS` | no | `30000` | Decision call timeout |

The numeric defaults are provisional operating points for this slice, not settled policy; all are configurable.

## Running

```sh
pnpm --filter @companion/worker start
```

Startup validates configuration, connects to PostgreSQL, applies domain migrations (idempotent, advisory-locked), and runs the engine loop until `SIGINT`/`SIGTERM`. Shutdown is graceful: the in-flight cycle finishes (including publication) before exit. Missing configuration exits with a named-variable error.

## Verification

- `pnpm test:unit` — deterministic unit tests with no database and no network: chat contract, transport (injected fetch), decision build/selection (including the no-silent-fallback rule and guidance/selection separation), chat assembly, and configuration parsing.
- `tests/integration/worker-postgres.test.mjs` — runs only against an explicitly provided isolated non-production database (`WORKER_TEST_DATABASE_URL`) and is skipped otherwise: migration idempotency, ingest idempotency, grouping, snapshot/next-turn behavior, prior-turn context snapshots in conversation order (replies published after later messages arrived, unclaimed/current-turn exclusions, bounded tail, failed-turn messages, lease-reclaim coherence, and full decision/chat context when messages arrive during generation), ingest/claim serialization under concurrency (commit order matches `seq` order), reply ordering, lease renewal/reclaim, fencing of a stale owner, duplicate-publication no-op, and full engine cycles with fake provider calls.
- The transport/contract level is verified with fakes only; no live OpenRouter call has been made from this code, and no provider/model capability for the typed decision flow has been confirmed live.

## Open questions

- Retry policy for failed turns (currently terminal: `failed` turns are not retried) and whether transient errors should re-queue.
- Decision fallback/calibration: thresholds, top-N ranking, behavior for unusable or low-confidence answers.
- Diagnostics retention: what is kept in `conversation_turn.decision` and for how long.
- How ingestion reaches the worker when the web BFF is implemented (the store contract is the current ingest path).
- Whether response patterns and the conversation schema should move to a shared domain home when the BFF needs the same tables.
- Lease/reclaim refinements: persisted worker identity for immediate self-reclaim after restart, bounded reclaim attempts.
- Queue technology and context-window policy remain open; this slice uses PostgreSQL-backed leasing and a configurable fixed history limit.
