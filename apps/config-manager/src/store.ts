/**
 * Configuration storage boundary.
 *
 * The HTTP layer depends on this narrow interface only, so verification
 * runs against the in-memory implementation with zero database access.
 * The Postgres implementation is the production-binding path used solely
 * when the manager is launched locally with a server-side fixed database
 * URL — its credentials never leave the server process and are never
 * returned in any response.
 */

import { randomUUID } from "node:crypto";

import {
  createPostgresPool,
  withTransaction,
  type PostgresPool,
} from "@companion/postgres";

import { snapshotHash } from "./diff.ts";
import { keyOf, TABLE_BY_NAME, TABLE_ORDER, keyString } from "./registry.ts";
import { cloneSnapshotStrict, type Row, type Snapshot } from "./snapshot.ts";

export class ConflictError extends Error {
  constructor(message = "configuration changed since the base snapshot") {
    super(message);
    this.name = "ConflictError";
  }
}

export interface ConfigStore {
  loadSnapshot(): Promise<Snapshot>;
  /**
   * Atomically replace the affected rows with `merged`, failing with
   * {@link ConflictError} when the stored snapshot no longer hashes to
   * `expectedHash`. Implementations must hold a write lock across the
   * check-and-replace so concurrent managers cannot interleave.
   */
  applySnapshot(merged: Snapshot, expectedHash: string): Promise<string>;
}

function stableKeyOf(table: string, row: Row): string {
  const def = TABLE_BY_NAME.get(table)!;
  const key: Record<string, unknown> = {};
  for (const col of def.primaryKey) key[col] = row[col] ?? null;
  return keyString(key);
}

/** Deterministic row order used by both implementations. */
export function sortRows(table: string, rows: Row[]): Row[] {
  return [...rows].sort((a, b) => {
    const ka = stableKeyOf(table, a);
    const kb = stableKeyOf(table, b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}

export function sortedSnapshot(snapshot: Snapshot): Snapshot {
  const out: Record<string, Row[]> = {};
  for (const table of TABLE_ORDER) {
    out[table] = sortRows(table, [...(snapshot[table] ?? [])]);
  }
  return out;
}

/**
 * In-memory implementation for tests and offline verification.
 * Applies the same conflict rule as Postgres: the stored hash must match
 * the expected base, otherwise nothing is written.
 */
export class MemoryConfigStore implements ConfigStore {
  readonly environment: string;
  private current: Snapshot;

  constructor(initial: Snapshot, environment: string = "nonprod") {
    this.environment = environment;
    this.current = sortedSnapshot(cloneSnapshotStrict(initial));
  }

  async loadSnapshot(): Promise<Snapshot> {
    return cloneSnapshotStrict(this.current);
  }

  async applySnapshot(merged: Snapshot, expectedHash: string): Promise<string> {
    if (snapshotHash(this.current) !== expectedHash) {
      throw new ConflictError();
    }
    this.current = sortedSnapshot(cloneSnapshotStrict(merged));
    return snapshotHash(this.current);
  }
}

/** One planned row change for a single table. */
export interface PlannedRowUpdate {
  /** Primary-key values of the stored row. */
  readonly key: Record<string, unknown>;
  /** Editable columns whose values differ, in registry order. */
  readonly changed: readonly string[];
  /** The merged row (bookkeeping aside). */
  readonly row: Row;
}

export interface PlannedTableChange {
  readonly table: string;
  /** Rows present in `next` but not in `current`, in stable-key order. */
  readonly inserted: readonly Row[];
  /** Rows present in both whose editable content changed, in stable-key order. */
  readonly updated: readonly PlannedRowUpdate[];
  /** Rows present in `current` but not in `next`, in stable-key order. */
  readonly deleted: readonly Row[];
}

function editableEquals(a: unknown, b: unknown): boolean {
  // Stored values are JSON primitives; `?? null` normalizes missing keys and
  // JSON.stringify makes the comparison type-strict (1 ≠ "1") and -0-proof.
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/**
 * Totally-ordered row-level plan: the only rows a write may touch.
 *
 * Comparison is by primary key over editable columns only — identical rows
 * (bookkeeping aside, exactly like the snapshot hash) produce no write, so
 * an apply never rewrites, re-stamps, or deletes untouched configuration.
 * A primary-key rename is a delete plus an insert, never an in-place update.
 * Tables are reported in FK-safe parent-first order; the caller applies
 * inserts and updates parent-first and deletes children-first.
 */
export function planRowChanges(current: Snapshot, next: Snapshot): PlannedTableChange[] {
  const plan: PlannedTableChange[] = [];
  for (const table of TABLE_ORDER) {
    const def = TABLE_BY_NAME.get(table)!;
    const beforeByKey = new Map<string, Row>();
    for (const row of current[table] ?? []) {
      beforeByKey.set(keyString(keyOf(def, row)), row);
    }
    const afterByKey = new Map<string, Row>();
    for (const row of next[table] ?? []) {
      afterByKey.set(keyString(keyOf(def, row)), row);
    }
    const inserted: Row[] = [];
    const updated: PlannedRowUpdate[] = [];
    const deleted: Row[] = [];
    for (const key of [...afterByKey.keys()].sort()) {
      const oldRow = beforeByKey.get(key);
      const newRow = afterByKey.get(key)!;
      if (oldRow === undefined) {
        inserted.push(newRow);
        continue;
      }
      const changed = def.columns
        .filter((col) => col.auto !== true)
        .filter((col) => !editableEquals(oldRow[col.name], newRow[col.name]))
        .map((col) => col.name);
      if (changed.length > 0) {
        updated.push({ key: keyOf(def, newRow), changed, row: newRow });
      }
    }
    for (const key of [...beforeByKey.keys()].sort()) {
      if (!afterByKey.has(key)) deleted.push(beforeByKey.get(key)!);
    }
    plan.push({ table, inserted, updated, deleted });
  }
  return plan;
}

/** Fixed advisory-lock key serializing config-manager writes per database. */
const CONFIG_LOCK_KEY = 913_441_772;

function normalizePgRow(table: string, raw: Record<string, unknown>): Row {
  const def = TABLE_BY_NAME.get(table)!;
  const row: Row = {};
  for (const col of def.columns) {
    if (col.auto === true && col.name === "updated_at") {
      row[col.name] = raw[col.name] instanceof Date
        ? (raw[col.name] as Date).toISOString()
        : (raw[col.name] as string) ?? null;
      continue;
    }
    const value = raw[col.name];
    if (value === null || value === undefined) {
      row[col.name] = null;
      continue;
    }
    if (col.type === "integer" || col.type === "number") {
      row[col.name] = typeof value === "number" ? value : Number(value);
    } else if (col.type === "boolean") {
      row[col.name] = Boolean(value);
    } else {
      row[col.name] = typeof value === "string" ? value : String(value);
    }
  }
  return row;
}

async function loadPostgresSnapshot(pool: PostgresPool): Promise<Snapshot> {
  const snapshot: Record<string, Row[]> = {};
  for (const table of TABLE_ORDER) {
    const def = TABLE_BY_NAME.get(table)!;
    const columns = def.columns.map((c) => c.name).join(", ");
    const orderBy = def.primaryKey.join(", ");
    const result = await pool.query<Record<string, unknown>>(
      `SELECT ${columns} FROM ${table} ORDER BY ${orderBy}`,
    );
    snapshot[table] = sortRows(
      table,
      result.rows.map((raw) => normalizePgRow(table, raw)),
    );
  }
  return snapshot;
}

/**
 * Postgres implementation. All statements are parameterized; no value is
 * ever interpolated into SQL text. Writes run under a session advisory
 * lock inside one transaction, re-check the snapshot hash under the lock,
 * and only then write the row-level changes from {@link planRowChanges} —
 * inserts and updates parent-first, deletes children-first — so untouched
 * rows are never deleted, re-inserted, or re-stamped, and foreign keys
 * from learned-state tables referencing configuration rows always hold
 * throughout. After writing, the transaction reloads the snapshot and
 * verifies its hash equals the merged intent: any drift or short write
 * throws {@link ConflictError} and rolls everything back.
 */
export class PostgresConfigStore implements ConfigStore {
  private readonly pool: PostgresPool;

  constructor(pool: PostgresPool) {
    this.pool = pool;
  }

  async loadSnapshot(): Promise<Snapshot> {
    return loadPostgresSnapshot(this.pool);
  }

  async applySnapshot(merged: Snapshot, expectedHash: string): Promise<string> {
    return withTransaction(this.pool, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock($1)", [CONFIG_LOCK_KEY]);
      const current = await loadPostgresSnapshot(client as unknown as PostgresPool);
      if (snapshotHash(current) !== expectedHash) {
        throw new ConflictError();
      }
      const next = sortedSnapshot(merged);
      // Targeted writes only: the row-level diff, never a full-table wipe.
      const plan = planRowChanges(current, next);

      // 1. Inserts, parents first.
      for (const change of plan) {
        for (const row of change.inserted) {
          const def = TABLE_BY_NAME.get(change.table)!;
          const statementColumns = def.columns.map((c) => c.name);
          const placeholders = statementColumns.map((_, i) => `$${i + 1}`);
          const values = def.columns.map((col) => {
            const value = row[col.name] ?? null;
            if (col.auto === true && col.name === "updated_at") return new Date().toISOString();
            if (col.auto === true && col.name === "revision") return 1;
            if (col.name === "id" && row[col.name] === null) return randomUUID();
            return value;
          });
          await client.query(
            `INSERT INTO ${change.table} (${statementColumns.join(", ")}) VALUES (${placeholders.join(", ")})`,
            values,
          );
        }
      }

      // 2. Updates, parents first; stored rows are matched by primary key.
      for (const change of plan) {
        const def = TABLE_BY_NAME.get(change.table)!;
        for (const update of change.updated) {
          const setColumns: string[] = update.changed.map(
            (col, i) => `${col} = $${i + 1}`,
          );
          const values: unknown[] = update.changed.map((col) => update.row[col] ?? null);
          for (const col of def.columns) {
            if (col.auto !== true) continue;
            if (col.name === "updated_at") {
              setColumns.push(`updated_at = $${values.length + 1}`);
              values.push(new Date().toISOString());
            } else if (col.name === "revision") {
              // Revision bumps only when the row's `content` changed; the
              // previous value comes from the pre-write snapshot row.
              const prevRow = current[change.table]?.find(
                (r) => stableKeyOf(change.table, r) === stableKeyOf(change.table, update.row),
              );
              const prevRevision = Number(prevRow?.["revision"] ?? 1);
              const bumped = update.changed.includes("content") ? prevRevision + 1 : prevRevision;
              setColumns.push(`revision = $${values.length + 1}`);
              values.push(bumped);
            }
          }
          // PK placeholders follow all SET values.
          const pkPlaceholders = def.primaryKey.map(
            (_, i) => `$${values.length + i + 1}`,
          );
          const where = def.primaryKey
            .map((col, i) => `${col} IS NOT DISTINCT FROM ${pkPlaceholders[i]}`)
            .join(" AND ");
          const pkValues = def.primaryKey.map((col) => update.key[col] ?? null);
          await client.query(
            `UPDATE ${change.table} SET ${setColumns.join(", ")} WHERE ${where}`,
            [...values, ...pkValues],
          );
        }
      }

      // 3. Deletes, children first (reverse parent order).
      for (const change of [...plan].reverse()) {
        const def = TABLE_BY_NAME.get(change.table)!;
        for (const row of change.deleted) {
          const where = def.primaryKey
            .map((col, i) => `${col} IS NOT DISTINCT FROM $${i + 1}`)
            .join(" AND ");
          await client.query(`DELETE FROM ${change.table} WHERE ${where}`, [
            ...def.primaryKey.map((col) => row[col] ?? null),
          ]);
        }
      }

      // Verify the final state matches the merged intent, bookkeeping
      // aside (the hash excludes it). Any drift or short write rolls back.
      const final = await loadPostgresSnapshot(client as unknown as PostgresPool);
      if (snapshotHash(final) !== snapshotHash(next)) {
        throw new ConflictError("configuration did not converge after writing");
      }
      return snapshotHash(final);
    });
  }
}

/** Create the Postgres store from a server-side connection string. */
export function createPostgresConfigStore(connectionString: string): PostgresConfigStore {
  const pool = createPostgresPool({ connectionString });
  return new PostgresConfigStore(pool);
}

/** True when the value is a plain object (not null/array). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
