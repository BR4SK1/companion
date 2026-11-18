# Companion configuration manager (standalone, local only)

A standalone, loopback-only operator tool for reviewing and editing the
Companion worker's **DB-backed configuration** — owner-authored prompts and
behavior rows — against one server-side fixed environment at a time.

It is **not** a deployable and runs nowhere automatically:

- No Helm chart, container, ingress, or deployment trigger ships with it.
- A merge never deploys it; the operator launches it locally with
  `pnpm --filter @companion/config-manager start`.
- The deployed worker and web app are untouched by its existence.

## Scope: what is editable

Exactly the tables the worker treats as provisioned configuration (the same
set the deployed-smoke configuration fingerprint covers):

| Table | Rows |
| --- | --- |
| `chat_identity` | singleton `identity` (content + revision) |
| `companion_time_settings` | singleton (timezone, hemisphere, birthday, day start) |
| `engagement_bands` | singleton (lull/idle/gone cutoffs) |
| `memory_behavior` | singleton `behavior` (day start, timezone) |
| `memory_subject` | one row per subject (role, label, evidence rule) |
| `memory_prompt` | per-kind system prompts (full text) |
| `response_pattern` | selection descriptions + guidance |
| `prompt_module` | function / HTTP-post modules, incl. full definitions |
| `routine_settings`, `routine_transition` | schedule + departure context |
| `relationship_settings`, `relationship_tier`, `relationship_question_type`, `relationship_question` | type, tiers, questions, extraction prompt |
| `article_feed`, `article_behavior`, `article_prompt` | feeds, limits, reaction prompts |

Full stored prompt visibility: every prompt field is returned verbatim in
`GET /api/config` and rendered in full in the browser (`<pre>` blocks) —
never truncated, sampled, or masked. The registry names them as
`promptFields` per table.

Excluded by design (the manager cannot read or write them):

- Deployment environment values (`WORKER_*` model ids, endpoints, timeouts,
  flags, pool sizes, and similar) and all secrets/credentials.
- The database URL/credential itself — held server-side only, never
  returned. The HTTP layer rejects any request that tries to set the
  environment, database binding, host/port, or a credential.
- Learned state (conversation records, traces, memory facts/observations,
  counters, cursors) — not configuration.

## Fixed environment bindings (server-side only)

The client never chooses the environment. Launch determines it:

```sh
CONFIG_MANAGER_ENVIRONMENT=nonprod \
CONFIG_MANAGER_DATABASE_URL=<non-production database URL> \
pnpm --filter @companion/config-manager start
```

To edit **production**, launch a separate process with
`CONFIG_MANAGER_ENVIRONMENT=production` and the production URL. There is
no in-browser environment switch, no credential field, and no way to
retarget a running process. The listener binds loopback only
(`CONFIG_MANAGER_HOST`, default `127.0.0.1`; remote binds are refused) on
`CONFIG_MANAGER_PORT` (default `4399`).

The UI and `GET /api/health` display the bound environment label so the
operator always sees what they are editing.

## Review, diff, confirmation, conflicts

1. **Read**: `GET /api/config` returns the environment label, the
   `snapshotHash` (SHA-256 over the editable content, bookkeeping
   excluded), and every row in full.
2. **Preview**: `POST /api/config/preview` with `{ baseHash, edits }`
   returns the field-level diff (`table`, row key, `field`, `before`,
   `after`, `change`) after validating the merged snapshot against the
   worker's loader rules (non-empty prompts, IANA timezones, band/tier
   ordering, prompt-module execution shape, routine slot uniqueness,
   birthday parity, FK membership). Nothing is written.
3. **Apply**: `POST /api/config/apply` repeats the same validation and
   requires `confirmation` set to the exact bound environment name
   (`nonprod` or `production` — typed, no default). Production therefore
   always gets an explicit, typed confirmation step; a missing or wrong
   value is a 400 and writes nothing.
4. **Conflict protection**: both writes present the `baseHash` they are
   based on. If the stored snapshot hash differs (another edit landed
   first), the server returns `409 conflict` and writes nothing. The
   Postgres path additionally serializes writers with a session advisory
   lock inside the applying transaction and re-checks the hash under
   the lock, so concurrent managers cannot overwrite each other.

Edits are `{ table, key, row?, delete? }` — a partial field set merged
onto the existing row, a full row to create, or `delete: true` to remove.
`updated_at` and (except for automatic bumping) `revision` are
server-managed and cannot be set by the client.

## Safety boundaries

- **No deployment**: the app has no chart, no container, no ingress, and
  no scheduled run. Starting it is a deliberate local operator action.
- **No live-database use in this change**: verification here runs against
  the in-memory store (`MemoryConfigStore`) over loopback HTTP with mock
  data. The Postgres store is implemented (parameterized, transactional,
  targeted: only rows whose editable content changed are written —
  inserts/updates parent-first, deletes children-first, with a
  post-write hash check that rolls back on any drift) but was not
  exercised against any live database in this change, and no real
  credentials are present in the repository. The row-level write plan
  itself (`planRowChanges`) is covered by unit tests.
- **Local-only values**: database URLs and any per-environment overrides
  stay in the operator's shell environment, never in the repository, and
  are never printed by the server.

## Running locally (mock verification)

```sh
pnpm install
pnpm --filter @companion/config-manager start   # needs CONFIG_MANAGER_* env
pnpm test:unit                                  # unit suite incl. config-manager mock tests
```

For offline verification without a database, unit tests construct the
server with `MemoryConfigStore` (see
`tests/unit/config-manager.test.mjs`) and exercise the full HTTP contract
over an ephemeral loopback listener.

## Unresolved choices

- Whether prompt-module `function_definition` edits need additional
  sandbox review before enabling (currently validated structurally only;
  the worker's existing executor sandbox still applies at runtime).
- Whether a future version should record an append-only audit trail of
  applies (who/when/diff) in a dedicated table. The current design
  records nothing beyond the changed rows themselves.
