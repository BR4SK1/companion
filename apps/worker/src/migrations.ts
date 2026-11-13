import { runMigrations } from "@companion/postgres";
import type { PostgresPool } from "@companion/postgres";

import { conversationMigrations } from "./conversation/migrations.ts";
import { memoryMigrations } from "./memory/migrations.ts";
import { engagementMigrations } from "./engagement/migrations.ts";
import { articleMigrations } from "./articles/migrations.ts";
import { relationshipMigrations } from "./relationship/migrations.ts";
import { routineMigrations } from "./routine/migrations.ts";
import { temporalMigrations } from "./temporal/migrations.ts";

/**
 * The single ordered migration composition used by both worker startup and
 * the migration-only maintenance command. Keep domain ordering explicit.
 */
export const workerMigrations = [
  ...conversationMigrations,
  ...memoryMigrations,
  ...engagementMigrations,
  ...articleMigrations,
  ...relationshipMigrations,
  ...routineMigrations,
  ...temporalMigrations,
] as const;

/** Apply the complete worker schema without starting runtime services. */
export function applyWorkerMigrations(pool: PostgresPool) {
  return runMigrations(pool, workerMigrations);
}
