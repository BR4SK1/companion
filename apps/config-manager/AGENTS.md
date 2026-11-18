# Config-manager boundaries

- Standalone local operator tool: loopback listener only, launched by an
  explicit local operator action. Do not add Helm charts, containers,
  ingress, deployment triggers, or scheduled runs for it.
- The target environment and its database credential are fixed
  server-side at launch (`CONFIG_MANAGER_ENVIRONMENT`,
  `CONFIG_MANAGER_DATABASE_URL`). Never accept an environment, database
  URL, host/port, or credential from the HTTP client; reject such
  fields. Never log, return, or persist them.
- Manage only DB-backed provisioned configuration (see `README.md`).
  Never read or write deployment environment values (`WORKER_*` and
  similar), secrets, learned state, traces, or conversation records —
  even where the worker's fingerprint covers environment values.
- Prompt fields are returned in full, never truncated or masked.
- Every write path validates the merged snapshot, presents a field-level
  diff, requires typed confirmation equal to the bound environment name,
  and enforces optimistic concurrency via the snapshot hash (409 on a
  stale base). Preview never writes.
- Postgres writes must stay targeted: only rows whose editable content
  changed are inserted/updated/deleted (see `planRowChanges`), never a
  full-table delete-and-reinsert — learned-state tables hold foreign
  keys to configuration rows, and untouched rows must keep their stored
  `updated_at`/`revision`.
- Do not run this against a live database as part of routine checks;
  verification uses the in-memory store. Live-database use requires an
  explicit operator launch outside any automated suite.
