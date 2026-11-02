# Background worker

## Status

Implemented slice: durable grouped conversation work on PostgreSQL, with response-pattern selection through OpenRouter's native typed Decisions API preceding chat generation, plus the private HTTP ingest/read API the web BFF calls. One deployable, modular responsibilities; no image-generation integration, voice, or uploads in this slice. The worker holds no identity concept: it authenticates callers with one service-to-service credential and knows nothing about users.

Worker-owned attempt tracing is implemented for conversation turns: every attempt of a turn records its input snapshot (mutable pattern configuration and exact ordered context), the native decision boundary (request before the provider call, outcome after it), and the chat boundary, in relational tables — with a read-only CLI report (`apps/worker/src/cli.ts`) that assembles a turn's full trace. The legacy `conversation_turn.decision` JSONB column is preserved untouched for pre-tracing history and is no longer written by new work.

## Responsibilities

Implemented in this slice:

- **Private HTTP API.** A cluster-internal HTTP listener (`api/server.ts`) exposes the ingest and read boundary the web BFF calls:
  - `GET /healthz` — liveness (process health only; unauthenticated).
  - `GET /readyz` — readiness (database ping; unauthenticated).
  - `POST /v1/messages` — idempotent user-message ingest. Body `{text, clientKey}`; the same key with the same content returns the existing message (idempotent replay), and the same key with different content is rejected with `409 conflict`.
  - `GET /v1/thread?limit=N[&before=seq]` — one bounded page of the thread in persisted `seq` order (default 100, maximum 500). Without `before` this is the newest page; with `before` it is the page immediately below that exclusive bound, so a caller walks the full durable history backwards via `page.oldestSeq` until `page.hasMore` is false. The response also carries a generic status object (`{queued, generating, highestAllocatedSeq, hasRecentFailure}`) with no turn, lease, key, or error internals. `highestAllocatedSeq` is the highest `seq` the thread's identity sequence has allocated — committed-visible, in-flight, or burned (a rolled-back insert never becomes visible) — and, because allocation is contiguous, it bounds what can exist below any page. Consumers reconcile by re-deriving the gaps between their loaded seqs and walking pages downward from each gap's top; the web client does this with a bounded per-cycle budget and no timing assumption (an in-flight seq and a burned seq look identical at any single snapshot, so an unresolved gap keeps its bounded share of probing instead of being discarded on a deadline). `hasRecentFailure` is a durable, sanitized trailing-failure flag — a failed turn claimed after the most recently completed one, or any failure before the first completion; the underlying error text never crosses this boundary.
  - Every API endpoint requires the `WORKER_API_TOKEN` bearer credential (constant-time comparison); there is no unauthenticated mode — the worker fails closed at startup without it. Failures are generic and sanitized (`bad_request`, `conflict`, `unauthorized`, …); internal details are logged server-side only.
- **Durable message ingestion contract.** User messages are appended to PostgreSQL; a caller-supplied idempotency key makes re-ingestion (e.g. a retried request) a no-op returning the existing message, and reuse of a key with different content raises a typed conflict (`ClientKeyConflictError`) instead of silently rebinding the key.
- **Claim-time grouping.** All pending (unassigned) user messages form a trailing run of the thread; claiming groups the entire run into one turn with one snapshot — never one message at a time.
- **Snapshot semantics.** A claimed turn processes exactly the messages grouped at claim time. Messages that arrive while the turn is in flight stay unassigned and are grouped into the next turn.
- **Prior-turn context snapshot.** The decision state and chat request are built from one coherent snapshot of prior work: the messages of every turn claimed before the processed one, in conversation order — for each turn, its grouped user messages followed by its published reply. Conversation order differs from raw `seq` order exactly where a reply was published after a later user message arrived (that message joins the next turn, so its `seq` is lower than the reply's): the reply still precedes it in context. Unassigned messages (future turns), the processed turn's own messages, and any later turns' messages are excluded — no leakage and no duplication. Because exclusion and ordering are keyed by turn association rather than a raw-`seq` cutoff or lease state, the snapshot is identical on every attempt of the same turn, including after a lease reclaim. A failed turn is terminal in this slice, but its user messages stay part of the visible thread and appear in later context without a reply.
- **Ordered persisted replies.** Processing is serialized (at most one in-flight turn with a valid lease), and each turn publishes at most one assistant reply whose thread position is assigned at publication, so reply order in the thread equals turn order.
- **Restart/lease recovery.** A turn whose lease has expired is reclaimable: the next claim resumes the same turn with a new attempt (incremented) and a fresh lease. A heartbeat renews the lease while the turn is in flight, at one third of the lease (at least 1000ms; configuration enforces a lease of at least 3 seconds so the cadence always renews before expiry — see `apps/worker/src/work/timing.ts`).
- **Attempt tracing.** Every attempt of a turn (initial claim or reclaim) gets one relational trace row, created inside the claim/reclaim transaction, with its terminal outcome (`published`, `failed`, `fenced`, or `superseded`). At meaningful boundaries the attempt records:
  - **Input snapshot** (before the decision step): the mutable response-pattern configuration as it stood (each pattern's full content, in presentation order) and the exact ordered context (prior-turn history plus the turn's grouped messages) the attempt saw. Written in its own fenced transaction, so the snapshot exists even when a later step fails; a second snapshot of the same attempt is a no-op (the first one is what the attempt actually saw).
  - **Decision boundary** (request written before the provider call, outcome written after the call and before the selection step): the native typed request as sent and, once a call resolves, the response as returned — choice, optional confidence, optional per-option probability distribution, response model/provider/id, and usage. Optional native values are nullable columns: absence stays absent, no normalization is applied. The row's `state` tracks the boundary lifecycle: `requested` before the call, then `responded` (the native response), `failed` (the actual transport error, with the truncated response body only when the transport retained one), or `invalid` (a body arrived but failed contract validation; the offending untyped value is not persisted — arbitrary provider data has no relational home) after it. The selection step outcome (`selected`, or `rejected` with its reason) is recorded separately, after the outcome, so a rejected selection still leaves the complete response behind.
  - **Chat boundary** (request written before the provider call, outcome written after the call and before publication): the native typed request (each message linked to its `conversation_message` row; the synthetic guidance system message has no source) and the response as returned — response id/model, choices, usage, and the generated reply content. The row's `state` tracks the boundary lifecycle: `requested` before the call, then `responded`, `failed` (the actual transport error), or `invalid` (a body arrived but failed contract validation) after it. A `responded` record carries the application usability verdict separately from the transport outcome: `application_rejection` names the reason the application rejected an arrived response (for example, no choices returned) while the response itself is still recorded in full — the trace stays unambiguous about whether the response arrived and whether the application accepted it. Absent raw data stays absent — an error trace records the real error kind/message/body, never invented content.
  A fenced-out attempt (whose lease was lost to a reclaiming worker) cannot record any trace boundary; the reclaiming worker's claim transaction closes the stale attempt as `superseded` in the same transaction as the lease replacement, so a crashed old worker is counted without depending on its own self-report (a late self-report is a no-op). Trace writes are fenced and idempotent per attempt, and a duplicate record of the same boundary overwrites harmlessly. A fenced write is not ignorable: the composition edge turns the store's `false` result into `TraceWriteFencedError`, so a stale attempt stops processing at the first fenced boundary — no further provider calls, and no selection or publication based on an unrecorded boundary — while the engine handles the lost lease through its existing fenced failure path. The trace is feature-specific and relational: no generic JSONB payload, document facade, or EAV.
- **Read-only trace report.** `apps/worker/src/cli.ts` (`node src/cli.ts <turnId> [--json]`, requires `WORKER_DATABASE_URL`, no provider credentials) assembles a turn's human-readable (or JSON) report: the turn plus every recorded attempt with all boundary records — and, for turns created before tracing, presents the legacy `conversation_turn.decision` JSONB clearly marked as legacy. The report is assembled inside one read-only repeatable-read transaction on a single pooled client, so the turn row and every attempt and boundary row come from one consistent committed snapshot even while publication or failure finalization commits concurrently; the server enforces read-only, so the report can never write. Publication is reported only from the turn's actual status (`reply published: yes/no`), never from a boundary record; the chat boundary's reply content is rendered as the *generated* reply, with any application rejection shown separately. The CLI only ever reads.
- **Fencing.** Publication, decision-diagnostics recording, and failure recording are all conditional on the turn still being in flight under the caller's lease. A stale worker that lost its lease can neither publish a reply nor overwrite the state of a reclaiming worker.
- **Idempotent publication.** Publishing completes the turn and persists the reply in one transaction; a duplicate publication attempt after success is recognized and reported as a no-op.
- **Response-pattern decision.** When enabled `response_pattern` records exist, one `choice` question is asked through the OpenRouter Decisions API (`POST /api/alpha/decisions`): options are pattern ids, each described by its **selection description**. The returned top choice selects the pattern. The choice answer is preserved as returned (including optional probabilities/confidence) and recorded on the turn as diagnostics; an answer that does not name an offered pattern is an error, not a silent fallback. With no enabled patterns, the decision step is skipped and chat runs without guidance.
- **Chat generation.** The selected pattern's **response guidance** (a separate text, never sent to the decider) is sent as the leading system message, followed by the prior-turn context snapshot (see below) and the turn's grouped messages, to OpenRouter's Chat Completions API (non-streaming).

Not implemented in this slice (by design): image generation, engagement/segmentation timers, proactive follow-up, retries for failed turns, and multi-conversation support.

## Module layout

```
src/
  main.ts                  composition edge: config → pool → migrations → private API → engine loop
  cli.ts                   read-only trace report CLI: turn trace report (human-readable or --json)
  config.ts                environment parsing and validation (no secret values here)
  api/
    server.ts              private HTTP API: bearer auth, ingest, paged thread reads, health
  conversation/
    types.ts               domain types (messages, turns, response patterns, trace records)
    migrations.ts          domain-owned SQL migrations (applied via @companion/postgres)
    store.ts               domain-owned queries: ingest, claim/group, lease, publish, fail, thread reads, trace recording/reporting
  work/
    decision.ts            pattern-choice decision build/select (pure)
    chat.ts                chat request assembly (pure)
    processor.ts           per-turn orchestration: snapshot → decision → chat (transport-injected)
    engine.ts              loop: claim → heartbeat → process → publish/fail
```

Shared infrastructure lives in `libraries/postgres` (connection lifecycle, transactions, migration runner) and `libraries/openrouter` (transport plus typed Decisions and Chat contracts). No behavior policy lives in the shared libraries; the response-pattern table's contents are runtime configuration, and no pattern rows are seeded by migrations.

## Work model and guarantees

Turn states: `in_flight` → `completed` | `failed`.

- **Grouping rule.** `claimNextTurn` atomically (one transaction, serialized by a PostgreSQL advisory lock): reclaims the oldest expired in-flight turn if any; otherwise refuses to claim while an unexpired in-flight turn exists; otherwise groups the entire unassigned trailing run of user messages into a new in-flight turn with a fresh lease. A message ingested after the grouping `SELECT` is not part of the snapshot. Message ingestion takes the same advisory lock inside its transaction, so ingest commit order matches `seq` order (PostgreSQL sequences are not transactional) and a claim never snapshots while an ingest transaction is in flight — a later-seq message can never be claimed ahead of an earlier one. Ingestion is short; briefly waiting behind a claim transaction is acceptable.
- **Fencing rule.** Publication, decision-diagnostics recording, trace recording, and failure recording are all fenced: turn-state transitions and reply publication require `status = 'in_flight' AND lease_owner = <caller> AND lease_expires_at > now()` inside the publishing transaction. Expired-lease claims increment `attempt` and replace the lease owner.
- **Ordering rule.** Serialized claims mean persisted replies appear in thread order across turns; the assistant reply to an earlier group appears after any user messages that arrived while it was being generated (normal messaging semantics; the visible thread stays continuous).
- **Exactly-once honesty.** Publication and turn-state transitions are exactly-once (fenced, idempotent). External provider calls are not: a crash between a provider call and publication replays that call after reclaim. Only one reply ever survives per turn, but a replayed call can incur duplicate provider cost. Leases also mean an unclean worker restart waits up to one lease period before reclaiming its own turn (worker identity is not persisted in this slice).

## Data model

Domain-owned migration `0001_conversation_work`:

- `conversation_turn` — id, status, attempt, lease owner/expiry, selected pattern id, decision diagnostics (jsonb, legacy), error, timestamps.
- `conversation_message` — id, identity-based `seq` thread position, role (`user`/`assistant`), content, nullable idempotency `client_key` (unique; a key is bound to exactly one content — reuse with different content is rejected as a conflict), nullable `turn_id` reference. At most one assistant reply per turn (partial unique index).
- `response_pattern` — id, enabled, `selection_description` (for the decider), `response_guidance` (for chat), presentation `position`.

Domain-owned migration `0002_conversation_tracing` (attempt tracing; relational, feature-specific — no generic JSONB payload, document facade, or EAV):

- `trace_attempt` — one row per attempt of a turn (initial claim or reclaim), created inside the claim/reclaim transaction; `claimed_at`, nullable `finished_at`/`outcome` (`published` | `failed` | `fenced` | `superseded` via a check constraint), and the `snapshot_recorded_at` marker. A reclaim marks the previous open attempt `superseded` atomically with the lease replacement. Unique per `(turn_id, attempt)`.
- `trace_attempt_context` — the exact ordered context the attempt saw, by `conversation_message` id reference, in position order.
- `trace_attempt_pattern` — the mutable response-pattern configuration as it stood at the snapshot: each pattern's full `selection_description`/`response_guidance` content and presentation position.
- `trace_attempt_decision` — the attempt's decision boundary: a `state` (`requested` before the provider call; `responded`, `failed`, or `invalid` after it), question id/type, request model, instructions as sent, the returned choice (nullable: absent when the selection was rejected or never resolved), nullable confidence, a `probabilities_present` marker that keeps a present-but-empty native probability distribution (zero child rows) distinguishable from an absent one (no distribution at all), the recorded selection outcome (`selected`/`rejected`) with its rejection reason, nullable response model/provider/id and usage columns, and nullable error kind/message/body for the `failed`/`invalid` states (the actual transport or contract error; error body only when the transport retained one, and never for `invalid`); absence of optional native values stays absent.
- `trace_attempt_decision_probability` — the optional per-option probability distribution the provider returned, one row per option (no rows means none was returned).
- `trace_attempt_chat` / `trace_attempt_chat_message` / `trace_attempt_chat_choice` — the chat boundary: request model/temperature/max_tokens and a `state` (`requested` before the provider call; `responded`, `failed`, or `invalid` after it), response id/model, usage, nullable error kind/message/body (the actual transport or contract error; error body only when the transport retained one), the exact ordered request messages (each linked to its `conversation_message` row; the synthetic guidance system message's source is null), each returned choice, and the reply content (null until the response succeeded). A `responded` row additionally carries `application_rejection` — the reason the application rejected an arrived response (e.g. no usable choices) — recorded separately from the transport outcome so the trace stays unambiguous about what arrived and whether the application accepted it.

The legacy `conversation_turn.decision` JSONB column is preserved untouched for pre-tracing history and is no longer written by new work; the trace tables above are the new home for decision diagnostics. The report presents both, clearly marked.

The schema is relational PostgreSQL only. No identity-provider subjects, user ids, or tenant identifiers appear in any table. Traced content is recorded as returned — there is no platform-wide filtering or expiration of recorded conversation content.

## Configuration

Environment variables (secrets are supplied at runtime, never committed):

| Variable | Required | Default | Meaning |
| --- | --- | --- | --- |
| `WORKER_DATABASE_URL` | yes | — | PostgreSQL connection string (non-production database for this slice) |
| `OPENROUTER_API_KEY` | yes | — | OpenRouter API key |
| `WORKER_CHAT_MODEL` | yes | — | Model id used for chat generation |
| `WORKER_DECISION_MODEL` | yes | — | Model id used for the response-pattern decision |
| `WORKER_API_TOKEN` | yes | — | Bearer credential for the private HTTP API; the web BFF holds the same value as `WEB_WORKER_TOKEN`. No unauthenticated mode exists. |
| `WORKER_HTTP_HOST` | no | `0.0.0.0` | Private API listener host (cluster-internal only) |
| `WORKER_HTTP_PORT` | no | `8080` | Private API listener port |
| `WORKER_OPENROUTER_CHAT_URL` | no | `https://openrouter.ai/api/v1/chat/completions` | Chat endpoint |
| `WORKER_OPENROUTER_DECISIONS_URL` | no | `https://openrouter.ai/api/alpha/decisions` | Decisions endpoint |
| `WORKER_LEASE_SECONDS` | no | `60` | Turn lease duration (minimum `3`: the engine heartbeat renews at lease/3, at least 1000ms, and a shorter lease would expire before its first renewal) |
| `WORKER_POLL_SECONDS` | no | `1` | Idle poll interval |
| `WORKER_CONTEXT_MESSAGE_LIMIT` | no | `50` | Prior messages sent as chat/decision context (the tail of the conversation-order prior-turn snapshot) |
| `WORKER_CHAT_TIMEOUT_MS` | no | `120000` | Chat call timeout |
| `WORKER_DECISION_TIMEOUT_MS` | no | `30000` | Decision call timeout |

The numeric defaults are provisional operating points for this slice, not settled policy; all are configurable. Message input bounds (20,000-character content, 64 KiB bodies, client-key shape) are contract constants in `api/server.ts`, not configuration.

## Running

```sh
pnpm --filter @companion/worker start
```

Startup validates configuration, connects to PostgreSQL, applies domain migrations (idempotent, advisory-locked), starts the private HTTP API (which requires its service credential), and runs the engine loop until `SIGINT`/`SIGTERM`. Shutdown is graceful and ordered: the engine loop stops taking new claims and finishes the in-flight cycle (including publication), the HTTP listener drains in-flight requests, and only then is the connection pool closed. Missing configuration exits with a named-variable error.

## Verification

- `pnpm test:unit` — deterministic unit tests with no database and no external network: chat contract, transport (injected fetch), decision build/selection (including the no-silent-fallback rule and guidance/selection separation), chat assembly, configuration parsing (including fail-closed API-token handling), and the private HTTP API contract over an ephemeral loopback listener with a fake store (auth, ingest idempotency and conflict mapping, cursor-paged thread reads with cursor validation, sanitized status including the trailing-failure flag, sanitized errors, route/method rules).
- `tests/integration/worker-postgres.test.mjs` and `tests/integration/worker-http.test.mjs` — run only against an explicitly provided disposable isolated non-production database (`WORKER_TEST_DATABASE_URL`; the suites truncate the domain tables, so never point that variable at a real application database) and are skipped otherwise: migration idempotency, ingest idempotency and conflicting-key rejection, grouping, snapshot/next-turn behavior, prior-turn context snapshots in conversation order, ingest/claim serialization under concurrency, reply ordering, lease renewal/reclaim, fencing, duplicate-publication no-op, full engine cycles with fake provider calls (including trace recording and legacy-JSONB preservation), and the same flows end to end through the HTTP API — including cursor-paged history walks, allocated-seq reconciliation with in-flight and burned seqs, and the scoped trailing-failure flag.
- Attempt tracing is covered by the same integration suites: decision-then-chat failure leaves the full decision boundary (including the recorded selection) and a `failed` chat row carrying the actual error, with a `failed` attempt outcome; a decision transport failure records the request before the provider call and a `failed` decision outcome carrying the real error (with no invented response data); a malformed decision body records an `invalid` decision outcome with the validation error and no persisted offending value; the chat request is recorded in `requested` state before the provider call and transitions to `responded`, `failed`, or `invalid` after it; a provider response with no choices fails the chat contract and is traced as `invalid` with the real validation error (no invented reply content); an application rejection on an arrived response is persisted separately from the transport outcome on a `responded` row; each attempt's pattern snapshot is preserved when the mutable pattern configuration changes between attempts; a rejected selection still leaves the complete decision response behind (the boundary is written before the selection step); a lease reclaim marks the previous attempt `superseded` atomically with the lease replacement, and the stale worker's late self-report is a no-op; a misaligned trace write fails its own transaction leaving no partial rows; a legacy pre-tracing turn and its decision JSONB survive the tracing migration untouched; and the assembled turn trace report (and the CLI rendering it) carries every recorded boundary — publication is rendered only from the turn's actual status, and the CLI's render functions are covered by hermetic unit tests for all new states (including decision failure/invalid states and application rejections).
- The transport/contract level is verified with fakes only; no live OpenRouter call has been made from this code, and no provider/model capability for the typed decision flow has been confirmed live.

## Open questions

- Retry policy for failed turns (currently terminal: `failed` turns are not retried) and whether transient errors should re-queue.
- Decision fallback/calibration: thresholds, top-N ranking, behavior for unusable or low-confidence answers.
- Trace retention: what is kept in the `trace_attempt*` tables and for how long (currently no platform-wide filtering or expiration), and the legacy `conversation_turn.decision` JSONB column's eventual disposition.
- Whether response patterns and the conversation schema should move to a shared domain home as more of the thread surface needs the same tables.
- Lease/reclaim refinements: persisted worker identity for immediate self-reclaim after restart, bounded reclaim attempts.
- Queue technology and context-window policy remain open; this slice uses PostgreSQL-backed leasing and a configurable fixed history limit.
- TLS between the BFF and the worker's private listener (currently plain HTTP inside the cluster boundary, guarded by the bearer token) if that boundary ever leaves the cluster network.
