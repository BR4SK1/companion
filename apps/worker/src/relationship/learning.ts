import { setTimeout as delay } from "node:timers/promises";
import { withTransaction, type PostgresPool } from "@companion/postgres";
import type { MemoryLlmCaller, TaskPreset } from "../memory/llm.ts";
import type { RelationshipExtractionItem } from "./types.ts";
import type { RelationshipStore } from "./store.ts";

/** Process the next committed reply. Cursor and answer updates commit together. */
export async function learnNextReply(
  pool: PostgresPool,
  store: RelationshipStore,
  callLlm: MemoryLlmCaller,
  taskPreset: TaskPreset,
): Promise<boolean> {
  const { rows: [reply] } = await pool.query<{
    cursor: string; seq: string; turn_id: string; content: string;
  }>(
    `SELECT c.reply_seq AS cursor, m.seq, m.turn_id, m.content
     FROM relationship_learning_cursor c
     JOIN conversation_message m ON m.seq > c.reply_seq
     WHERE m.role = 'assistant' AND m.turn_id IS NOT NULL
     ORDER BY m.seq LIMIT 1`,
  );
  if (!reply) return false;
  const { rows } = await pool.query<{ content: string }>(
    "SELECT content FROM conversation_message WHERE turn_id = $1 AND role = 'user' ORDER BY seq",
    [reply.turn_id],
  );
  const userText = rows.map(row => row.content.trim()).filter(Boolean).join("\n");
  let answers: readonly RelationshipExtractionItem[] = [];
  if (userText && reply.content.trim()) {
    try {
      answers = await store.extractAnswers({ userText, assistantText: reply.content, callLlm, taskPreset });
    } catch {
      // This enrichment is best effort. One unusable turn should never block
      // learning from later replies or trigger repeated paid provider calls.
      console.warn(`[RELATIONSHIP] skipped extraction for turn ${reply.turn_id}`);
    }
  }
  await withTransaction(pool, async client => {
    const advanced = await client.query(
      "UPDATE relationship_learning_cursor SET reply_seq = $1 WHERE reply_seq = $2",
      [reply.seq, reply.cursor],
    );
    if (advanced.rowCount) await store.recordAnswers(client, answers);
  });
  return true;
}

export async function startRelationshipLearning(
  pool: PostgresPool,
  store: RelationshipStore,
  callLlm: MemoryLlmCaller,
  taskPreset: TaskPreset,
) {
  // First activation starts with new turns. Restarts resume the saved cursor.
  await pool.query(
    `INSERT INTO relationship_learning_cursor (reply_seq)
     SELECT COALESCE(max(seq), 0) FROM conversation_message
     ON CONFLICT (singleton) DO NOTHING`,
  );
  const stop = new AbortController();
  async function run() {
    while (!stop.signal.aborted) {
      let waitMs = 5_000;
      try {
        if (await learnNextReply(pool, store, callLlm, taskPreset)) continue;
      } catch {
        console.warn("[RELATIONSHIP] background learning failed; retrying the pending turn");
        waitMs = 60_000;
      }
      await delay(waitMs, undefined, { signal: stop.signal }).catch(() => {});
    }
  }
  const running = run();
  return { async close() { stop.abort(); await running; } };
}
