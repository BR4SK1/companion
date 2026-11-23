import assert from "node:assert/strict";
import test from "node:test";

import { workerMigrations } from "../../apps/worker/src/migrations.ts";
import { memoryMigrations } from "../../apps/worker/src/memory/migrations.ts";
import { articleMigrations } from "../../apps/worker/src/articles/migrations.ts";

test("worker startup and migration-only command share the complete ordered schema", () => {
  assert.deepEqual(
    workerMigrations.map(({ id }) => id),
    [
      "0001_conversation_work",
      "0002_conversation_tracing",
      "0004_chat_identity",
      "0005_message_timing",
      "0006_conversation_thread_order",
      "0024_response_pattern_initiative",
      "0003_memory_work",
      "0004_memory_semantic_shadow",
      "0021_memory_operation_turn_attribution",
      "0006_engagement_assessment",
      "0007_article_work",
      "0008_article_share_and_evidence",
      "0009_article_observation_claim",
      "0010_relationship_familiarity",
      "0011_relationship_chat_chunk",
      "0012_routine_schedule",
      "0013_routine_chat_chunk",
      "0014_routine_announcement",
      "0015_routine_announcement_period_id",
      "0026_routine_external_provider",
      "0028_routine_hold_revision",
      "0016_authoritative_temporal_context",
      "0017_trace_attempt_temporal_context",
      "0020_companion_time_day_start_hour",
      "0018_generic_prompt_modules",
      "0019_prompt_module_chat_attribution",
      "0022_prompt_module_activation_modes",
      "0023_prompt_module_http_post",
      "0027_prompt_module_engagement_and_hold",
      "0029_prompt_module_routine_metadata",
      "0025_time_chat_chunk",
    ],
  );
  assert.equal(new Set(workerMigrations.map(({ id }) => id)).size, workerMigrations.length);
});

test("batch memory-operation attribution preserves the monotonic ingest cursor", () => {
  const migration = memoryMigrations.find(
    ({ id }) => id === "0021_memory_operation_turn_attribution",
  );
  assert.ok(migration);
  assert.match(migration.sql, /CREATE TABLE memory_operation_turn/);
  assert.match(migration.sql, /operation_id uuid NOT NULL REFERENCES memory_operation \(id\) ON DELETE CASCADE/);
  assert.match(migration.sql, /turn_id uuid NOT NULL REFERENCES conversation_turn \(id\)/);
  assert.match(migration.sql, /DROP CONSTRAINT memory_ingest_state_watermark_turn_id_fkey/);
  assert.doesNotMatch(migration.sql, /UPDATE memory_ingest_state|DELETE FROM memory_ingest_state|TRUNCATE/i);
});

test("semantic migration leaves the shared operation-kind constraint to the article migration", () => {
  const semanticSql = memoryMigrations.find(({ id }) => id === "0004_memory_semantic_shadow").sql;
  const articleSql = articleMigrations.find(({ id }) => id === "0008_article_share_and_evidence").sql;
  assert.doesNotMatch(semanticSql, /memory_operation_kind_check|ALTER\s+TABLE\s+memory_operation/i);
  assert.match(articleSql, /'article_ingestion'[\s\S]*'article_memory_share'/);
  assert.match(semanticSql, /memory_semantic_shadow_attempt/);
  assert.match(semanticSql, /REFERENCES memory_operation \(id\)/);
});
