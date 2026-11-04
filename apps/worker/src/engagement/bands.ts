/**
 * Engagement-band configuration loading.
 *
 * The band boundaries are locally configurable deployment configuration —
 * behavior policy, not code or repository content — so they live in the
 * `engagement_bands` table, provisioned per deployment exactly like
 * `memory_behavior` and `chat_identity`, and are never seeded by migrations.
 *
 * Loading is fail-closed with a safe no-op: a missing row means the
 * deployment has not provisioned engagement, and the worker runs the
 * engagement domain as a no-op (no assessments, no reads, no API surface)
 * instead of failing or inventing defaults. Provision the row and restart
 * the worker to enable. An invalid row cannot exist through the CHECK
 * constraints (monotone bands), but the loader still validates what it
 * reads, and any other failure (e.g. an unreachable database) is a startup
 * error.
 */

import type { PostgresPool } from "@companion/postgres";

import type { EngagementBandMs } from "./types.ts";

export class EngagementBandsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EngagementBandsError";
  }
}

/**
 * Validate the band cutoffs. The state machine requires exactly THREE
 * strictly increasing positive cutoffs — `lullMs` < `idleMs` < `goneMs` —
 * delimiting the four half-open bands. (The table CHECKs enforce the same
 * shape; this guards programmatic callers too.)
 */
export function validateEngagementBands(bands: EngagementBandMs): void {
  if (
    !(
      Number.isFinite(bands.lullMs) &&
      Number.isFinite(bands.idleMs) &&
      Number.isFinite(bands.goneMs) &&
      bands.lullMs > 0 &&
      bands.idleMs > bands.lullMs &&
      bands.goneMs > bands.idleMs
    )
  ) {
    throw new EngagementBandsError(
      `engagement band cutoffs must be strictly increasing and positive (` +
        `lull ${String(bands.lullMs)} < idle ${String(bands.idleMs)} < ` +
        `gone ${String(bands.goneMs)})`,
    );
  }
}

interface BandsRow {
  lull_ms: string;
  idle_ms: string;
  gone_ms: string;
}

/**
 * Load the provisioned band cutoffs. Returns null when the
 * `engagement_bands` row is absent — the unprovisioned-deployment no-op —
 * and throws `EngagementBandsError` on any other failure.
 */
export async function loadEngagementBands(
  pool: PostgresPool,
): Promise<EngagementBandMs | null> {
  const result = await pool.query<BandsRow>(
    `SELECT lull_ms, idle_ms, gone_ms FROM engagement_bands`,
  );
  const row = result.rows[0];
  if (row === undefined) {
    return null;
  }
  const bands: EngagementBandMs = {
    lullMs: Number(row.lull_ms),
    idleMs: Number(row.idle_ms),
    goneMs: Number(row.gone_ms),
  };
  validateEngagementBands(bands);
  return bands;
}
