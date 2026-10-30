# PostgreSQL integration boundary

## Responsibilities

Shared infrastructure for the existing external PostgreSQL service: connection lifecycle (`createPostgresPool`, `closePostgresPool`), transaction mechanics (`withTransaction`), and a minimal SQL migration runner (`runMigrations`). The database is relational and external to K3s; this project does not provision a database and adds no document-compatibility layer.

Domain owners own their types, schemas, migrations, constraints, and queries. Shared database infrastructure is not a generic domain repository and must not become a shared-types dumping ground. Non-production and production must use separate databases, credentials, and storage boundaries.

## Implementation notes

- The access runtime chosen for the first slice is `pg` (node-postgres) used directly with SQL strings; no ORM and no query builder. Drizzle with `pg` remains an open proposal for a future decision — this slice did not adopt it.
- Migrations are supplied by the owning domain as ordered `{ id, sql }` entries and applied idempotently. The runner records applied ids in `companion_schema_migration`, serializes concurrent migrators with a session-level advisory lock, and applies each migration atomically in its own transaction together with its bookkeeping row. A failed migration aborts the run; already-applied migrations stay applied. Ids recorded but absent from the supplied list are left untouched and reported.
- `withTransaction` guarantees atomicity of the wrapped statements only. It does not make schema migrations or external side effects rollback-safe, and no rollback/down-migration mechanism exists.

## Boundaries and dependencies

No endpoint, hostname, or credential is included; connection configuration is supplied by the caller. The migration runner knows nothing about migration content. Retry, backup/recovery, and safe-rollout policies are not implemented here.

## Open questions

Backup/recovery and safe rollout policies remain undefined. Whether the migration runner should gain checksum verification, down-migrations, or a CLI remains open. Do not imply database rollback is transactional or guaranteed without a designed mechanism.
