/**
 * Snapshot hashing and field-level diffs for conflict protection and review.
 *
 * The snapshot hash is the optimistic-concurrency token: every mutation
 * must present the hash it is based on; a stale base is a 409 conflict,
 * never a silent overwrite. Diff entries expose before/after values in
 * full (prompt text included) so the operator reviews exactly what changes
 * before applying.
 */

import { createHash } from "node:crypto";

import { TABLE_BY_NAME, keyOf, keyString } from "./registry.ts";
import type { Snapshot } from "./validation.ts";

export interface DiffEntry {
  readonly table: string;
  /** Primary-key values identifying the row (stable across edits). */
  readonly key: Record<string, unknown>;
  readonly field: string;
  readonly before: unknown;
  readonly after: unknown;
  readonly change: "modified" | "created" | "deleted";
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => [k, canonical(v)]);
    return Object.fromEntries(entries);
  }
  if (typeof value === "number" && Object.is(value, -0)) return 0;
  return value;
}

function canonicalSnapshot(snapshot: Snapshot): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {};
  for (const def of [...TABLE_BY_NAME.values()].sort((a, b) => a.table.localeCompare(b.table))) {
    const rows = (snapshot[def.table] ?? []).map((row) => {
      const editable: Record<string, unknown> = {};
      for (const col of def.columns) {
        if (col.auto === true) continue;
        editable[col.name] = row[col.name] ?? null;
      }
      return canonical(editable);
    });
    rows.sort((a, b) => {
      const ja = JSON.stringify(a);
      const jb = JSON.stringify(b);
      return ja < jb ? -1 : ja > jb ? 1 : 0;
    });
    out[def.table] = rows;
  }
  return out;
}

/** Stable SHA-256 over the editable configuration content (bookkeeping excluded). */
export function snapshotHash(snapshot: Snapshot): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalSnapshot(snapshot)))
    .digest("hex");
}

export function computeDiff(before: Snapshot, after: Snapshot): DiffEntry[] {
  const diff: DiffEntry[] = [];
  for (const def of TABLE_BY_NAME.values()) {
    const beforeRows = new Map<string, Record<string, unknown>>();
    for (const row of before[def.table] ?? []) {
      beforeRows.set(keyString(keyOf(def, row)), row);
    }
    const afterRows = new Map<string, Record<string, unknown>>();
    for (const row of after[def.table] ?? []) {
      afterRows.set(keyString(keyOf(def, row)), row);
    }
    const keys = new Set([...beforeRows.keys(), ...afterRows.keys()]);
    for (const key of [...keys].sort()) {
      const oldRow = beforeRows.get(key);
      const newRow = afterRows.get(key);
      const rowKey = newRow !== undefined ? keyOf(def, newRow) : keyOf(def, oldRow!);
      for (const col of def.columns) {
        if (col.auto === true) continue;
        const oldValue = oldRow !== undefined ? (oldRow[col.name] ?? null) : null;
        const newValue = newRow !== undefined ? (newRow[col.name] ?? null) : null;
        if (JSON.stringify(canonical(oldValue)) === JSON.stringify(canonical(newValue))) continue;
        diff.push({
          table: def.table,
          key: rowKey,
          field: col.name,
          before: oldValue,
          after: newValue,
          change:
            oldRow === undefined ? "created" : newRow === undefined ? "deleted" : "modified",
        });
      }
    }
  }
  return diff;
}
