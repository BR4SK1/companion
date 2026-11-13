/**
 * The no-pattern decision path: with no enabled response patterns the worker
 * skips the decision step entirely and runs chat without pattern guidance — no
 * silent fallback, and no decision call at all.
 */

import { expect, test } from "@playwright/test";

import { threadGet } from "../helpers/api.mjs";
import { disablePatterns, seedIdentity, E2E_IDENTITY, PATTERNS } from "../helpers/db.mjs";
import { config } from "../helpers/config.mjs";
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

test("without enabled patterns chat skips decisions and pattern guidance", async ({ page, context }) => {
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
  // Identity leads the system chunks and current temporal context remains
  // present. The skipped decision contributes none of the fixture's pattern
  // guidance; avoid assuming temporal context is the only other system chunk.
  const systemMessages = chat.messages.filter((message) => message.role === "system");
  expect(systemMessages[0]).toEqual({ role: "system", content: E2E_IDENTITY });
  const temporal = systemMessages.find(
    (message) => message.content.startsWith("Current local date and time:"),
  );
  expect(temporal).toBeTruthy();
  expect(temporal.content).toContain(`(${config.temporalTimezone},`);
  expect(temporal.content).toMatch(/Meteorological season(?::| is unspecified)/);
  expect(systemMessages.some((message) =>
    PATTERNS.some((pattern) => message.content === pattern.responseGuidance),
  )).toBe(false);
  expect(chat.messages.some((message) => message.role === "user" && message.content === text)).toBe(true);

  const thread = await threadGet(context);
  expect(thread.body.status.hasRecentFailure).toBe(false);
  const userMessage = thread.body.messages.find((message) => message.text === text);
  expect(userMessage).toBeTruthy();
});
