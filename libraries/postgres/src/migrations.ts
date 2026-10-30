/**
 * Minimal SQL migration runner for domain-owned schema migrations.
 *
 * Design (deliberately small, no migration framework):
 * - Migrations are supplied by the owning domain as ordered `{ id, sql }`
 *   entries; this module knows nothing about their content.
 * - Applied migration ids are recorded in `companion_schema_migration`.
 * - Application is serialized across concurrent processes with a session-level
 *   PostgreSQL advisory lock, so two workers starting simultaneously cannot
 *   apply the same migration twice.
 * - Each migration runs in its own transaction together with its bookkeeping
 *   row, so a migration is applied atomically or not at all. A failed
 *   migration aborts the run; already-applied migrations stay applied.
 * - Re-running is idempotent: applied ids are skipped, in the supplied order.
 * - A migration id recorded in the table but absent from the supplied list is
 *   left untouched (forward compatibility); this is reported, not an error.
 *
 * This runner does not provide rollback, down-migrations, or checksum
 * verification of applied migrations. Those recovery properties remain open
 * design work (see `libraries/postgres/README.md`); do not describe database
 * rollback as transactional or guaranteed.
 */

import type { PostgresPool } from "./connection.ts";

export interface Migration {
  /** Stable identifier recorded in the migrations table, e.g. `0001_init`. */
  readonly id: string;
  /** SQL applied in one transaction. May contain multiple statements. */
  readonly sql: string;
}

export interface MigrationRunResult {
  /** Ids applied by this run, in application order. */
  readonly applied: readonly string[];
  /** Ids already recorded before this run (skipped). */
  readonly alreadyApplied: readonly string[];
  /** Ids recorded in the table but not present in the supplied list. */
  readonly unrecognized: readonly string[];
}

const MIGRATION_TABLE = "companion_schema_migration";

/**
 * Arbitrary but fixed advisory-lock key for migration serialization.
 * Chosen once; changing it would break serialization between versions.
 */
const MIGRATION_LOCK_KEY = 721834965012;

export async function runMigrations(
  pool: PostgresPool,
  migrations: readonly Migration[],
): Promise<MigrationRunResult> {
  const seen = new Set<string>();
  for (const migration of migrations) {
    if (seen.has(migration.id)) {
      throw new Error(`duplicate migration id: ${migration.id}`);
    }
    seen.add(migration.id);
  }

  const client = await pool.connect();
  try {
    // Session-level lock: held until the client is released below, so
    // concurrent migrators wait instead of racing.
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
    await client.query(
      `CREATE TABLE IF NOT EXISTS ${MIGRATION_TABLE} (
         id text PRIMARY KEY,
         applied_at timestamptz NOT NULL DEFAULT now()
       )`,
    );
    const appliedRows = await client.query<{ id: string }>(
      `SELECT id FROM ${MIGRATION_TABLE}`,
    );
    const applied = new Set<string>(
      appliedRows.rows.map((row) => row.id as string),
    );

    const appliedNow: string[] = [];
    for (const migration of migrations) {
      if (applied.has(migration.id)) {
        continue;
      }
      try {
        await client.query("BEGIN");
        await client.query(migration.sql);
        await client.query(
          `INSERT INTO ${MIGRATION_TABLE} (id) VALUES ($1)`,
          [migration.id],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
          `migration ${migration.id} failed and was not applied: ${message}`,
          { cause: error },
        );
      }
      appliedNow.push(migration.id);
      applied.add(migration.id);
    }

    const unrecognized = [...applied].filter((id) => !seen.has(id));
    return {
      applied: appliedNow,
      alreadyApplied: migrations
        .map((migration) => migration.id)
        .filter((id) => applied.has(id) && !appliedNow.includes(id)),
      unrecognized,
    };
  } finally {
    try {
      await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]);
    } catch {
      // The connection teardown below releases session locks anyway.
    }
    client.release();
  }
}
