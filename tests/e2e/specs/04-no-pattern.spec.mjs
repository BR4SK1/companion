/**
 * The no-pattern decision path: with no enabled response patterns the worker
 * skips the decision step entirely and runs chat without guidance — no
 * silent fallback, and no decision call at all.
 */

import { expect, test } from "@playwright/test";

import { threadGet } from "../helpers/api.mjs";
import { disablePatterns, seedIdentity, E2E_IDENTITY } from "../helpers/db.mjs";
import { waitForQuiescent } from "../helpers/quiesce.mjs";
import {
  chatRecords,
  decisionRecords,
  resetMode,
  resetRecords,
  waitForTurnReply,
} from "../helpers/provider.mjs";

test.beforeAll(async () => {
  // Quiescence first: disabling the pattern table must not race a turn
  // that is still deciding.
  await waitForQuiescent();
  await resetMode();
  await disablePatterns();
  await seedIdentity();
  await resetRecords();
});

test("without enabled patterns chat runs without decision calls or guidance", async ({ page, context }) => {
  await page.goto("/");
  const text = `e2e-no-pattern-${Date.now().toString(36)}`;
  await page.getByPlaceholder("Message").fill(text);
  await page.getByRole("button", { name: "Send message" }).click();

  // The reply still arrives — the decision path is skipped, not broken.
  const reply = await waitForTurnReply(text);
  await expect(
    page.getByRole("log", { name: "Conversation" }).getByText(reply, { exact: true }),
  ).toBeVisible({ timeout: 20_000 });

  const decisions = await decisionRecords();
  expect(decisions.length).toBe(0);

  const chats = await chatRecords();
  expect(chats.length).toBeGreaterThanOrEqual(1);
  const chat = chats.at(-1).body;
  // The only system message is the seeded identity; no guidance chunk is
  // sent because no pattern was selected.
  const systemMessages = chat.messages.filter((message) => message.role === "system");
  expect(systemMessages).toEqual([{ role: "system", content: E2E_IDENTITY }]);
  expect(chat.messages.some((message) => message.role === "user" && message.content === text)).toBe(true);

  const thread = await threadGet(context);
  expect(thread.body.status.hasRecentFailure).toBe(false);
  const userMessage = thread.body.messages.find((message) => message.text === text);
  expect(userMessage).toBeTruthy();
});
