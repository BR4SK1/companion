import assert from "node:assert/strict";
import test from "node:test";

import { createConversationStore } from "../../apps/worker/src/conversation/store.ts";

test("previous assistant reply lookup is keyed by durable thread order and published turn state", async () => {
  let statement;
  let parameters;
  const store = createConversationStore({
    query: async (sql, values) => {
      statement = String(sql);
      parameters = values;
      return { rows: [{ content: "previous published reply" }] };
    },
  });

  assert.equal(
    await store.getPreviousPublishedAssistantReply("current-turn-id"),
    "previous published reply",
  );
  assert.deepEqual(parameters, ["current-turn-id"]);
  assert.match(statement, /prior_turn\.thread_order < current_turn\.thread_order/);
  assert.match(statement, /prior_turn\.status = 'completed'/);
  assert.match(statement, /reply\.turn_id = prior_turn\.id AND reply\.role = 'assistant'/);
  assert.match(statement, /ORDER BY prior_turn\.thread_order DESC, reply\.seq DESC/);
  assert.match(statement, /LIMIT 1/);
  assert.doesNotMatch(statement, /reply\.turn_id IS NULL/);
});

test("previous assistant reply lookup returns null when no earlier published turn reply exists", async () => {
  const store = createConversationStore({ query: async () => ({ rows: [] }) });
  assert.equal(await store.getPreviousPublishedAssistantReply("current-turn-id"), null);
});
