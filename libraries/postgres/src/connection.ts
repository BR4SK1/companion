/**
 * Shared PostgreSQL connection lifecycle and transaction mechanics.
 *
 * This is shared infrastructure: it owns how connections are created and how
 * transactions are scoped. It never owns domain schemas, queries, or policy —
 * those belong to their owning domains (see `libraries/postgres/README.md`).
 *
 * No endpoint, hostname, or credential is included; configuration is supplied
 * by the caller (application configuration), never hardcoded here.
 */

import pg from "pg";

export type PostgresPool = pg.Pool;
export type PostgresPoolClient = pg.PoolClient;

/** Connection options passed through to `pg`; only supplied keys are set. */
export interface PostgresConnectionConfig {
  /** libpq connection string, e.g. supplied from application configuration. */
  readonly connectionString?: string;
  readonly host?: string;
  readonly port?: number;
  readonly database?: string;
  readonly user?: string;
  readonly password?: string;
  /** Maximum pool size. Provisional default is `pg`'s own (10). */
  readonly max?: number;
}

/**
 * Create a connection pool. The caller owns the pool lifecycle and must call
 * `closePostgresPool` when done.
 */
export function createPostgresPool(
  config: PostgresConnectionConfig,
): PostgresPool {
  return new pg.Pool({
    ...(config.connectionString !== undefined
      ? { connectionString: config.connectionString }
      : {}),
    ...(config.host !== undefined ? { host: config.host } : {}),
    ...(config.port !== undefined ? { port: config.port } : {}),
    ...(config.database !== undefined ? { database: config.database } : {}),
    ...(config.user !== undefined ? { user: config.user } : {}),
    ...(config.password !== undefined ? { password: config.password } : {}),
    ...(config.max !== undefined ? { max: config.max } : {}),
  });
}

/** Close a pool created by `createPostgresPool`, waiting for idle clients. */
export async function closePostgresPool(pool: PostgresPool): Promise<void> {
  await pool.end();
}

/**
 * Run `work` inside one transaction on one pooled client. Commits on
 * success; rolls back and rethrows on failure. The client is always
 * returned to the pool.
 *
 * This guarantees atomicity of the wrapped statements only. It does not make
 * schema migrations or external side effects rollback-safe; see the library
 * README for the recovery stance.
 */
export async function withTransaction<T>(
  pool: PostgresPool,
  work: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    try {
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  } finally {
    client.release();
  }
}
