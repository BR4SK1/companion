# End-to-end tests

## Responsibilities

Implemented Playwright coverage of user-visible behavior through the web/BFF
boundary, exercising the real applications — the web production build with its
BFF edge and loopback test-entry gate, and the real worker (private HTTP API,
durable work, response-pattern decisions, chat generation) — against a local
fake OpenRouter provider, a configured real embedding service, and a disposable
throwaway PostgreSQL.

The Playwright/E2E toolchain is pinned to Node.js **22.23.4** in
[`.nvmrc`](.nvmrc) and in this package's `engines` field. Its test,
smoke, and browser-install package scripts fail closed unless the active Node
runtime is exactly that version; this does not change the root project's Node
requirement or any application container/runtime. Select Node 22.23.4 when
running these commands (for example, from this directory with `nvm use`). Keep
the ordinary root install and web production build on the project's normal
runtime:

```sh
pnpm install                                      # installs the pinned Playwright
pnpm --filter @companion/web build                # the suite serves the production build
pnpm --filter @companion/e2e install:chromium     # installs the pinned browser build (Node 22.23.4)
E2E_RUNS_DIR="$(mktemp -d)" pnpm --filter @companion/e2e test # isolated disposable-stack Playwright suite (Node 22.23.4)
```

Give every stack, stack-operations, and deployed-smoke invocation a new
`E2E_RUNS_DIR` outside the historical `tests/e2e/.runs` tree. Keep that
run-owned directory until cleanup is verified; remove only that exact directory
when no recovery marker or owned resource remains.

The stack requires the existing `WORKER_MEMORY_EMBEDDING_BASE_URL` environment
setting to identify the approved internal embedding service. Source it from
private local infrastructure configuration; do not add its value to this
README or any tracked fixture. For isolated maintenance/testing, set
`E2E_RUNS_DIR` to a new task-owned directory so startup reconciliation and
cleanup cannot inspect historical `.runs` entries.

### Request scope: full E2E versus local-only

An unqualified request to "run E2E" means a **full E2E run**: this disposable
local stack **plus** deployed non-production validation, which includes the
[guarded deployed smoke](#guarded-deployed-non-production-smoke), which may
invoke external providers and incur charges. The command above runs only the
local Playwright stack: chat/decision calls use a fake provider, while synthetic
embedding requests use the configured embedding service. It
never includes the deployed smoke, which runs only through its own documented
command. A request explicitly scoped to local-only validation (for example
"run the local e2e suite") covers exactly this local coverage and nothing
deployed. The deployed smoke is also a valid request on its own, independent of
a full E2E run.

The stack supervisor (`stack.mjs`, started by Playwright as its web server)
uses these dependencies:

1. a **fake provider** (`fake-provider.mjs`, in-process): the two OpenRouter
   endpoints the worker is configured to call, deterministic, with a control
   API the tests use to script behavior (success, HTTP 500, hang, latency)
   and to read recorded request bodies for assertions. It requires the
   bearer credential the worker was configured with. Chat and decision calls
   remain fake-only.
2. a **throwaway pgvector-ready PostgreSQL** in a dedicated Docker container
   (pinned image, loopback-only port, per-run random user/password, `--rm`).
   The supervisor enables the vector extension only in this disposable E2E
   database; application migrations never install it.
3. the **configured real embedding service**, supplied through the existing
   `WORKER_MEMORY_EMBEDDING_BASE_URL` setting from approved private local
   infrastructure configuration. The URL is not stored in source, run records,
   or public documentation; the supervisor does not start, stop, or proxy that
   service. Embedding requests use only synthetic E2E data.
4. the **worker** (`apps/worker`) against that throwaway database, fake
   provider, and real embedding service (all URLs are explicit configuration;
   no provider fallback exists), with a per-run random service token. The
   first start applies migrations; the supervisor provisions a synthetic
   `America/Los_Angeles` timezone only in this disposable database, then
   gracefully restarts the worker before exposing the stack so its
   startup-captured setting is active for the whole run. The history fixture
   uses 00:30 UTC instants to test Pacific local-day dividers rather than
   accidentally testing UTC grouping.
5. the **web production build** (`apps/web/server.mjs`) with the
   non-production-only loopback test gate explicitly enabled in
   `trusted-local` mode — the documented path for a run outside Kubernetes.
   The OIDC configuration values are synthetic placeholders that the test
   channel never contacts; the main channel stays owner-only and is used by
   the suite to verify exactly that.

## Boundaries and safety

- The Playwright suite never touches an application database: its only
  database is the throwaway container the E2E run itself created, and the
  supervisor removes that container with the run. Its chat identity, timezone,
  response patterns, and conversation rows are disposable synthetic fixtures;
  they are not the maintained non-production personality or configuration.
  Database-backed integration tools are separately restricted to verified
  disposable targets; no destructive suite is authorized against an
  application database. The Playwright suite's own scenario data is synthetic
  (generated `e2e-*` strings, fixture response patterns, and completed past
  turns).
- The local fake remains the only chat/decision provider, and no production
  access occurs. The configured embedding service is real and may run inference
  on synthetic E2E data; it is an external dependency and is never managed by
  the stack. Unimplemented capabilities (image generation, uploads, voice,
  real Keycloak MFA) are not claimed or exercised anywhere.
- Application/database ports default to `4620`–`4624` on `127.0.0.1` and are
  overridable via `E2E_*` variables (see `helpers/config.mjs`). The embedding
  service uses its configured base URL and has no local test listener. The
  supervisor refuses to start when a configured port is already taken — it
  never hijacks one.
- Secrets (worker token, session secrets, database password) are generated
  per run, kept in the supervisor's process environment only, and never
  logged, written to run records, or committed.

## Cleanup ownership

Every run records what it created — its own supervisor PID with the `/proc`
start time, each child PID with its start time, and the container name — in
`$E2E_RUNS_DIR/<run-id>/state.json` (gitignored):

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
   configured Los Angeles local-day dividers (three seeded dates produce two
   divider boundaries), scroll anchoring while new messages arrive away from
   the bottom, and jump-to-latest. The spec numbering is the execution
   order (files run alphabetically with one worker): the history seed must
   land before any spec sends live messages.
3. `03-chat-decision` — composed message accepted, durably persisted, and
   answered through the real engine with the seeded response patterns
   (decision options and selection description verified from the provider's
   recorded request; chat assertions verify identity first, a separate
   structural temporal-context chunk, and selected response guidance after
   it); persistence across reload; follow-up context
   in conversation order; poll-driven updates of the open UI; the composing
   indicator; idempotent replay and conflicting-key 409 at the BFF; input
   bounds.
4. `04-no-pattern` — with no enabled patterns the decision step is skipped
   (no decision call) and chat runs without pattern guidance while retaining
   identity and temporal context.
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
Prompt-module applicability include/skip and isolated function behavior are
covered in hermetic worker unit tests with injected decisions. The disposable
browser suite does not enable or rewrite prompt-module definitions; behavior of
the maintained provisioned modules is exercised only through deployed normal
usage with the existing configuration intact.

## Guarded deployed non-production smoke

`deployed-dev-smoke.mjs` is deliberately separate from the local Playwright
suite, which uses a disposable stack and fake chat/decision providers. The
smoke drives the **actual running non-production deployment** through its
loopback test-entry gate (`kubectl port-forward` to the pod-local gate listener
— the gate is never exposed through a Service), submits a synthetic message,
and may invoke configured external providers that incur charges.

- Run the smoke only within an explicitly requested and authorized delivery
  workflow or on a standalone explicit request. It refuses to run without BOTH
  `E2E_DEPLOYED_SMOKE_ALLOWED=1` (acknowledges the external provider use and
  non-production write) and `E2E_DEPLOYED_SMOKE_EXCLUSIVE_DEV_ACCESS=1` (the
  operator's assertion of exclusive access for that run). Both variables are
  required in every context; they are safeguards, not a substitute for
  authorization.
- Exclusivity is an operator assertion, not a system enforcement. The script
  performs a pre-send state check and post-send overlap accounting, but cannot
  guarantee that no concurrent access occurs. External provider charges and
  replay behavior depend on deployed configuration and are not hard-capped by
  the script.
- Read-only preflight before anything is sent verifies the deployed image,
  the gate's non-production attestation/enablement, a free local forward port,
  scenario linkage, provisioned-configuration fingerprint, thread quiescence,
  and no unsettled prior smoke marker. Completed intentionally retained runs
  are allowed; each new exact marker is checked before send. Memory ingest/recall and an embedding
  endpoint must be configured with bounded convergence. Enabled relationship
  questions, cursor initialization/catch-up, and runnable consolidation or
  promotion are normal behavior, not readiness failures.
- The synthetic marker is the user message content (the web BFF assigns its
  own opaque `client_key`). The smoke verifies the linked completed turn,
  persisted reply, refresh behavior, turn trace and provider request
  boundaries, memory extraction/cache, semantic-shadow comparison metadata,
  and chat-context chunk labels. Semantic-shadow query/candidate content is
  never emitted or injected into the response context. The smoke does not
  delete the conversation, traces, learned memory, relationship answers,
  cursor/counters, or normal shared derived-state changes: this run is
  intentional non-production history.
- Configuration fingerprints are checked before send, after the reply, and
  after background convergence. They cover provisioned identity, prompts,
  modules, settings, and environment values without outputting their content;
  learned conversation and derived state are intentionally outside that
  invariant. Relationship-answer rows have no turn-level provenance in this
  schema, so their aggregate count/update window is reported without claiming
  exact row-to-turn attribution.
- Thread quiescence and pre-send checks detect observed overlap but cannot
  guarantee exclusivity. Unexpected overlap, failed turns, missing association,
  failed semantic-shadow comparisons, configuration drift, or non-converged
  background work remain failures with all generated data retained. Bounded
  convergence waits stop after the configured timeout; they do not block
  forever. Provider costs/replay are not hard-capped by the script.
- Evidence is bounded and content-free: ids, seqs, counts, statuses, attempt
  counts, timings, outcomes, and a marker fingerprint — never message or
  relationship-answer content, the marker itself, or secrets (database
  credentials stay inside the worker pod's environment). All errors are
  sanitized (step label + error kind + first line only, secrets redacted).
  The deployed UI is checked structurally (`[data-last-bubble]`) with
  Node-side comparisons so matched text and page snapshots never enter errors.
- An operator may opt into an additional generic HTTP-module assertion by
  supplying both `E2E_DEPLOYED_EXPECT_HTTP_MODULE_ID` and
  `E2E_DEPLOYED_EXPECT_HTTP_MODULE_FINGERPRINT` from private run configuration.
  Treat both values as private: do not commit or print them. With neither set,
  the ordinary smoke behavior is unchanged; setting only one or supplying an
  invalid value fails closed. The read-only preflight requires that exact
  provisioned module to be enabled for HTTP POST with every-turn activation.
  After the synthetic turn, its unique published attempt must show successful
  execution, no selected or used fallback, and included output attributed to
  the exact `prompt_module` chat message. Missing, skipped, failed, ambiguous,
  fallback, or unattributed execution fails the smoke while retaining all
  generated history. Evidence reports only a generic pass/fail result and a
  content-free reason; the module identifier, fingerprint, endpoint, and
  response are not emitted. This check never changes provisioned configuration.
- SIGINT/SIGTERM abort the journey gracefully and retained-state verification
  runs before the process exits non-zero; a second signal exits immediately.
  SIGKILL cannot be handled — the ownership marker persisted before send
  (`$E2E_RUNS_DIR/deployed-smoke-last-marker.txt`) is the recovery trail.
- Legacy `--recover` is explicit-only for an interrupted or selected
  historical marker. It may use the old narrow cleanup flow, but refuses a
  record tagged `intentional-retention`; the ordinary smoke never invokes
  recovery or any delete action. The local ownership
  record and marker live under the task's unique `E2E_RUNS_DIR`; clean that
  local task directory after retaining any needed evidence.


Run (both variables required in every context — see the authorization note
above):

```sh
E2E_RUNS_DIR="$(mktemp -d)" \
E2E_DEPLOYED_SMOKE_ALLOWED=1 E2E_DEPLOYED_SMOKE_EXCLUSIVE_DEV_ACCESS=1 \
  pnpm --filter @companion/e2e test:deployed-smoke
```

Recover an interrupted run's synthetic data (idempotent):

```sh
E2E_RUNS_DIR="<the-original-task-runs-directory>" E2E_DEPLOYED_SMOKE_ALLOWED=1 \
  pnpm --filter @companion/e2e test:deployed-smoke -- --recover
# or with an explicit marker (or a path to a marker/ownership file):
E2E_RUNS_DIR="<the-original-task-runs-directory>" E2E_DEPLOYED_SMOKE_ALLOWED=1 \
  pnpm --filter @companion/e2e test:deployed-smoke -- --recover <marker>
```

Regression tests for this smoke's core (decision state machine, output
redaction, graceful shutdown, generated pod-script integrity, and the
delete-vs-claim race against a disposable local PostgreSQL) run with:

```sh
pnpm --filter @companion/e2e test:smoke
```

## Limits and open questions

- The local suite exercises the committed candidate's locally built source,
  not deployed immutable artifacts, and its fixture identity/settings are not
  evidence about the maintained non-production personality. Deployed gate and
  smoke checks separately verify the exact deployed candidate through normal
  usage with the existing provisioned configuration.
- Failed turns are terminal in this slice; retry policy, provider
  fallback behavior, and session-expiry journeys are not covered.
- `stack-ops.test.mjs` drives real stacks (throwaway container, worker, web
  build) and is intentionally not part of the hermetic unit suite; like the
  Playwright suite it is local-only and never touches a deployed database.
- The deployed smoke deliberately adds synthetic conversation history and
  retains its resulting conversation and normal learned state. No automatic
  cleanup or broad database reset is part of the routine gate.
