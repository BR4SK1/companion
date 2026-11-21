import { runMigrations } from "@companion/postgres";
import type { Migration, PostgresPool } from "@companion/postgres";

import { conversationMigrations } from "./conversation/migrations.ts";
import { memoryMigrations } from "./memory/migrations.ts";
import { engagementMigrations } from "./engagement/migrations.ts";
import { articleMigrations } from "./articles/migrations.ts";
import { relationshipMigrations } from "./relationship/migrations.ts";
import { routineMigrations } from "./routine/migrations.ts";
import { temporalMigrations } from "./temporal/migrations.ts";
import { promptModuleMigrations } from "./prompt-modules/migrations.ts";

/**
 * Decouples wall-clock `time` from recent `temporal` memory summaries in the
 * chat trace chunk check. Placed after `promptModuleMigrations` so fresh
 * databases apply it after `0018_generic_prompt_modules`.
 */
const TIME_CHAT_CHUNK_MIGRATION: Migration = {
  id: "0025_time_chat_chunk",
  sql: `
    ALTER TABLE trace_attempt_chat_message
      DROP CONSTRAINT trace_attempt_chat_message_chunk_check;
    ALTER TABLE trace_attempt_chat_message
      ADD CONSTRAINT trace_attempt_chat_message_chunk_check
      CHECK (chunk IN (
        'identity', 'profiles', 'temporal', 'time', 'recall', 'article',
        'relationship', 'routine', 'guidance', 'prompt_module', 'conversation'
      ));
  `,
};

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
  ...promptModuleMigrations,
  TIME_CHAT_CHUNK_MIGRATION,
] as const;

/** Apply the complete worker schema without starting runtime services. */
export function applyWorkerMigrations(pool: PostgresPool) {
  return runMigrations(pool, workerMigrations);
}
