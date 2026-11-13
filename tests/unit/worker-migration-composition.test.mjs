import assert from "node:assert/strict";
import test from "node:test";

import { workerMigrations } from "../../apps/worker/src/migrations.ts";

test("worker startup and migration-only command share the complete ordered schema", () => {
  assert.deepEqual(
    workerMigrations.map(({ id }) => id),
    [
      "0001_conversation_work",
      "0002_conversation_tracing",
      "0004_chat_identity",
      "0005_message_timing",
      "0006_conversation_thread_order",
      "0003_memory_work",
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
      "0016_authoritative_temporal_context",
      "0017_trace_attempt_temporal_context",
    ],
  );
  assert.equal(new Set(workerMigrations.map(({ id }) => id)).size, workerMigrations.length);
});
