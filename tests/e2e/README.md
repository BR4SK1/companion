# End-to-end tests

## Responsibilities

Implemented Playwright coverage of user-visible behavior through the web/BFF
boundary, exercising the real applications — the web production build with its
BFF edge and loopback test-entry gate, and the real worker (private HTTP API,
durable work, response-pattern decision, chat generation) — against a local
fake OpenRouter provider and a disposable throwaway PostgreSQL.

Run from this directory (or `pnpm --filter @companion/e2e test` after
`pnpm install` and `pnpm --filter @companion/web build`):

```sh
pnpm install                      # installs the pinned Playwright
pnpm exec playwright install chromium   # the pinned browser build
pnpm --filter @companion/web build      # the suite serves the production build
pnpm exec playwright test
```

### Request scope: full E2E versus local-only

An unqualified request to "run E2E" means a **full E2E run**: this disposable
local stack **plus** deployed non-production validation, which includes the
[deployed smoke](#deployed-non-production-smoke-explicitly-acknowledged-real-billable-provider)
and its real, billable provider calls. The command above runs only the
fake-provider Playwright suite — it never includes the smoke, which runs only
through its own documented command. A request explicitly scoped to local-only
validation (for example "run the local e2e suite") covers exactly this
fake-provider coverage and nothing deployed. The deployed smoke is also a
valid request on its own, independent of a full E2E run.

The stack supervisor (`stack.mjs`, started by Playwright as its web server)
brings up, in order:

1. a **fake provider** (`fake-provider.mjs`, in-process): the two OpenRouter
   endpoints the worker is configured to call, deterministic, with a control
   API the tests use to script behavior (success, HTTP 500, hang, latency)
   and to read recorded request bodies for assertions. It requires the
   bearer credential the worker was configured with. No external network
   calls are made and no live model is called anywhere.
2. a **throwaway PostgreSQL** in a dedicated Docker container (pinned image,
   loopback-only port, per-run random user/password, `--rm`).
3. the **worker** (`apps/worker`) against that throwaway database and the
   fake provider (the provider URLs are configuration; no provider fallback
   exists), with a per-run random service token.
4. the **web production build** (`apps/web/server.mjs`) with the
   non-production-only loopback test gate explicitly enabled in
   `trusted-local` mode — the documented path for a run outside Kubernetes.
   The OIDC configuration values are synthetic placeholders that the test
   channel never contacts; the main channel stays owner-only and is used by
   the suite to verify exactly that.

## Boundaries and safety

- The tests never touch a real application database: the only database they
  can reach is the throwaway container the run itself created, and it is
  destroyed with the run. The suite's own data is synthetic (generated
  `e2e-*` strings; seeded response patterns and completed past turns).
- No live model calls and no production access; the only provider is the
  local fake. Unimplemented capabilities (image generation, uploads, voice,
  real Keycloak MFA) are not claimed or exercised anywhere.
- Ports default to `4620`–`4624` on `127.0.0.1` and are overridable via
  `E2E_*` variables (see `helpers/config.mjs`). The supervisor refuses to
  start when a configured port is already taken — it never hijacks one.
- Secrets (worker token, session secrets, database password) are generated
  per run, kept in the supervisor's process environment only, and never
  logged, written to run records, or committed.

## Cleanup ownership

Every run records what it created — its own supervisor PID with the `/proc`
start time, each child PID with its start time, and the container name — in
`.runs/<run-id>/state.json` (gitignored):

- On normal exit, failure, `SIGINT`, or `SIGTERM` (including Playwright's own
  teardown and a parent-death watch for a hard-killed runner) the supervisor
  tears down exactly its own stack: graceful worker stop first, then the web
  server, the provider listener, and the container. The outcome is verified:
  a teardown that cannot finish (for example `docker rm` failing) reports the
  failure visibly, exits non-zero, and **keeps the ownership record**, so the
  run stays re-cleanable instead of becoming an unattributable orphan. Only a
  verified-complete teardown removes the record.
- If a run was interrupted hard, the next run (or `node stack.mjs clean
  [--run-id <id>]`) reconciles — but only runs whose recorded supervisor
  identity is verifiably dead (the recorded `/proc` start time makes PID
  reuse detectable). **Active runs — a live supervisor, possibly a concurrent
  suite on other ports — and unreadable or identity-less records are reported
  and never touched.** Cleanup removes exactly the recorded container (and
  only if it matches the run-scoped `companion-e2e-pg-<run-id>` naming) and
  stops exactly the recorded, identity-verified processes. A partially failed
  reconciliation keeps the record for a retry; `clean` is idempotent and
  exits non-zero when it cannot finish.
- Startup reconciles **before** checking ports: a stale run's left-over port
  holders are cleaned automatically instead of blocking every later start. A
  port that remains busy after reconciliation belongs to something this tool
  does not own and is refused — no hijacking.

The supervisor's own behavior is covered by `stack-ops.test.mjs` (plain
`node:test`, not Playwright specs; run with `pnpm --filter @companion/e2e
test:stack`): completed teardown + idempotent second clean, failed-cleanup
record retention and retry (fault-injected through a `docker` shim on
`PATH`), active-run and unverifiable-record safety with a concurrent run on
distinct ports, startup reconciliation before port claims, parent-death
self-cleanup, and SIGTERM teardown.

## Coverage

Ordered spec files, one worker, no retries (they share one continuous
conversation on purpose; each file's `beforeAll` establishes exactly the seed
state it needs, so runs are repeatable). Every provider-scripting or
pattern-table change is preceded by an observed quiescence wait — no queued
or in-flight turn at the worker, no unfinished call at the provider — so
scripting never races a turn that is still in flight, and reply waits anchor
on the turn's own recorded request rather than on request counts:

1. `01-access-and-safety` — gate session issuance and its identity-free
   nature; the main channel stays owner-only; cross-channel cookie isolation;
   the gate's Host/forwarding-header rejections; same-origin protection on
   both channels; the worker's bearer credential and unauthenticated
   health/readiness endpoints.
2. `02-history` — the bounded newest page, the "Load earlier messages"
   control and the bounded automatic backfill over seeded completed turns,
   UTC day dividers (the seed spans three days, since a divider renders at
   each UTC-day change), scroll anchoring while new messages arrive away
   from the bottom, and jump-to-latest. The spec numbering is the execution
   order (files run alphabetically with one worker): the history seed must
   land before any spec sends live messages.
3. `03-chat-decision` — composed message accepted, durably persisted, and
   answered through the real engine with the seeded response patterns
   (decision options and selection description verified from the provider's
   recorded request; the selected pattern's response guidance verified as the
   leading chat system message); persistence across reload; follow-up context
   in conversation order; poll-driven updates of the open UI; the composing
   indicator; idempotent replay and conflicting-key 409 at the BFF; input
   bounds.
4. `04-no-pattern` — with no enabled patterns the decision step is skipped
   (no decision call) and chat runs without guidance.
5. `05-failures` — a failed chat generation and a failed decision surfaced as
   sanitized notices with the message persisted and unanswered, conversation
   continuity with the failed message still in later context, connection-error
   state and recovery while the worker is paused, and a send that failed
   while the worker was unreachable retried idempotently.
6. `06-pwa` — the PWA static assets (manifest, service worker, offline page,
   icons) publicly reachable and user-agnostic on both channels, the
   document head's manifest link and Apple metadata, service worker
   registration in the production build with its cache holding exactly the
   one offline page under its own prefix, the offline fallback shown for a
   failed top-level navigation and recovery once back online, the BFF's
   `/api` surface never intercepted (subresource fetches and top-level
   navigations alike), and HTTP error responses preserved. No messages are
   sent; no provider traffic occurs.

## Deployed non-production smoke (explicitly acknowledged; real billable provider)

`deployed-dev-smoke.mjs` is deliberately separate from everything above: the
Playwright suite runs against a disposable local stack and a fake provider,
while this script drives the **actual running non-production deployment**
through its loopback test-entry gate (`kubectl port-forward` to the pod-local
gate listener — the gate is never exposed through a Service) and makes **one
synthetic user message's worth of real, billable OpenRouter calls**.

- It refuses to run without BOTH `E2E_DEPLOYED_SMOKE_ALLOWED=1` (acknowledges
  the billable provider call and the non-production database write) and
  `E2E_DEPLOYED_SMOKE_EXCLUSIVE_DEV_ACCESS=1` (the operator's explicit
  acknowledgement that the dev stack is exclusively theirs for this run):
  running it is always an explicitly acknowledged act. The owner expects
  this smoke's billable real-provider calls whenever a full E2E run is
  requested, and an explicitly requested standalone run of this smoke is
  equally in scope — they validate the live provider configuration before
  production — so no separate per-run approval is required merely because
  the calls are billable, and no per-run re-approval is needed where the
  owner's standing authorization applies (recorded 2026-11-01 in
  [`../../.opencode/skills/ship-it/SKILL.md`](../../.opencode/skills/ship-it/SKILL.md),
  covering this smoke's billable non-production provider calls and its
  non-production database write and resting on the owner's affirmation that
  the non-production environment and the accounts associated with this
  project belong to the owner and are not shared). Both variables remain
  required in every context, and nothing in the script's guards changes
  with context.
- Exclusivity is an operator assertion, NOT a system enforcement. The
  system cannot prevent another user's message from being ingested before or
  during the run, and the worker's chat request includes the thread's
  visible history — **unrelated conversation can enter the provider
  context**, and provider call costs and any replay behavior are NOT
  hard-capped by the script (the one-call expectation is derived from
  deployed configuration: with zero enabled patterns the decision call is
  skipped, so one message means one chat call). Overlap is detected
  conservatively: a pre-send state check aborts before anything is sent if
  the thread changed since preflight, and post-send accounting flags any
  unexpected message growth.
- Read-only preflight before anything is sent, any doubt stops the run:
  deployed image identity, the gate's `companion-np` non-production
  attestation shape, gate enablement, a free local forward port, the
  database's cleanup linkage (unique `client_key` index, one reply per turn),
  thread quiescence (no queued user message, no in-flight turn), and zero
  leftover `e2e-deployed-smoke-` rows.
- Attribution and cleanup are exact and race-safe: the synthetic message's
  unique marker content identifies the row (the web BFF assigns its own
  opaque client_key, so attribution is by exact content equality). A still-
  queued message is removed by a single atomic guarded delete
  (`… AND turn_id IS NULL`) that can never delete a row the worker has
  claimed or is claiming — if it affects no row the run re-probes and
  decides again. A settled exclusive turn (reply, message, turn) is removed
  in one transaction that locks the turn row `FOR UPDATE` and re-verifies
  composition and status inside the transaction (a mismatch rolls back and
  retains). A turn shared with unrelated traffic leaves everything but this
  run's own message row (turn-scoped, id- and content-guarded), reported as
  a residual. Any uncertain state — unreadable turn row, in-flight turn past
  the bounded wait, shutdown during a wait, failed transaction verification —
  RETAINS everything and reports. There is no broad database reset anywhere.
- Evidence is bounded and content-free: ids, seqs, counts, statuses, attempt
  counts, timings, and a marker fingerprint — never message content (ours
  or anyone else's), never the marker itself, never secrets (the database
  credentials stay inside the worker pod's environment; cleanup runs there
  via `kubectl exec` with parameterized queries only). All errors are
  sanitized (step label + error kind + first line only, secrets redacted):
  Playwright timeout errors would otherwise embed matched text and page
  snapshots, so content-based locators are never used on the deployed UI —
  DOM checks are structural (`[data-last-bubble]`) with Node-side
  comparisons.
- Signals: SIGINT/SIGTERM abort the journey gracefully and the awaited
  cleanup still runs before the process exits non-zero; a second signal
  exits immediately. SIGKILL cannot be handled — the ownership marker
  persisted before the send (`.runs/deployed-smoke-last-marker.txt`) is the
  recovery trail, and a failed/retained cleanup also writes an ownership
  record (`.runs/deployed-smoke-ownership-<fingerprint>.json`).
- Recovery is idempotent and verified, with no browser, no provider calls,
  and no port-forward: an already-cleaned marker verifies as
  nothing-to-clean. Cleanup and post-state verification run even when the
  browser journey fails.

Run (both variables required in every context — see the authorization note
above):

```sh
E2E_DEPLOYED_SMOKE_ALLOWED=1 E2E_DEPLOYED_SMOKE_EXCLUSIVE_DEV_ACCESS=1 \
  node tests/e2e/deployed-dev-smoke.mjs
```

Recover an interrupted run's synthetic data (idempotent):

```sh
E2E_DEPLOYED_SMOKE_ALLOWED=1 node tests/e2e/deployed-dev-smoke.mjs --recover
# or with an explicit marker (or a path to a marker/ownership file):
E2E_DEPLOYED_SMOKE_ALLOWED=1 node tests/e2e/deployed-dev-smoke.mjs --recover <marker>
```

Regression tests for this smoke's core (decision state machine, output
redaction, graceful shutdown, generated pod-script integrity, and the
delete-vs-claim race against a disposable local PostgreSQL) run with:

```sh
node --test tests/e2e/deployed-smoke.test.mjs
```

## Limits and open questions

- The suite exercises locally built source (the current working tree's
  production build), not deployed immutable artifacts; binding results to an
  exact deployed candidate remains an open deployment question.
- End-to-end tests against a real deployed non-production candidate (through
  `kubectl port-forward` to the loopback gate) are not automated here; the
  same suite structure is intended to be reusable there.
- Failed turns are terminal in this slice; retry policy, provider
  fallback behavior, and session-expiry journeys are not covered.
- `stack-ops.test.mjs` drives real stacks (throwaway container, worker, web
  build) and is intentionally not part of the hermetic unit suite; like the
  Playwright suite it is local-only and never touches a deployed database.
- The deployed-dev smoke's cleanup deletes its own rows, which leaves
  permanent `seq` gaps in the dev thread; the client's gap handling treats
  those like burned seqs (bounded probing, never a missed message) by
  design, and dev conversations are disposable.
