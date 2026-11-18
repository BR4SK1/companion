/** Snapshot helpers shared by validation, diff, and stores. */

import type { Row } from "./validation.ts";

export type { Row, Snapshot } from "./validation.ts";

/** Deep clone via JSON (snapshot rows hold only JSON values). */
export function cloneSnapshotStrict(snapshot: Record<string, readonly Row[]>): Record<string, Row[]> {
  return JSON.parse(JSON.stringify(snapshot)) as Record<string, Row[]>;
}
