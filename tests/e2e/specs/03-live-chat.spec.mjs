/**
 * End-to-end live conversation journey against the deployed non-production
 * stack (web BFF + worker + PostgreSQL + live OpenRouter model calls):
 *
 * 1. Opens the thread through the loopback test gate.
 * 2. Sends a message via the real UI composer.
 * 3. Waits for the worker to persist the user message and publish a live
 *    assistant reply.
 * 4. Reloads the page and verifies both messages persist across reloads.
 */

import crypto from "node:crypto";

import { expect, test } from "@playwright/test";

import { gateOrigin } from "../helpers/env.mjs";

test("live chat round-trip persists user message and assistant reply across reload", async ({ page, context }) => {
  await page.goto("/");
  const log = page.getByRole("log", { name: "Conversation" });
  await expect(log).toBeVisible();

  const beforeRes = await context.request.get(`${gateOrigin()}/api/thread`);
  expect(beforeRes.status()).toBe(200);
  const before = await beforeRes.json();
  const prevMaxSeq = before.messages.reduce((max, m) => Math.max(max, m.seq), 0);

  const marker = `e2e-${crypto.randomBytes(4).toString("hex")}`;
  const promptText = `[${marker}] Reply with one short sentence confirming you received this check.`;

  const composer = page.getByPlaceholder("Message");
  await expect(composer).toBeVisible();
  // Forward the real write, then simulate a lost acknowledgment body. The
  // browser must offer a same-key retry even when polling already saw the row.
  let originalKey;
  await page.route("**/api/messages", async route => {
    originalKey = route.request().postDataJSON().clientKey;
    const accepted = await route.fetch();
    expect(accepted.status()).toBe(200);
    await route.fulfill({ status: 200, contentType: "application/json", body: "{" });
  }, { times: 1 });
  await composer.fill(promptText);
  await page.getByRole("button", { name: "Send message" }).click();

  const replay = page.waitForRequest(request => request.url().endsWith("/api/messages") && request.method() === "POST");
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  expect((await replay).postDataJSON().clientKey).toBe(originalKey);

  // User message appears in the live UI.
  await expect(log).toContainText(marker);

  // Poll the real BFF thread endpoint until the user message and a subsequent
  // assistant reply are both committed and generation has settled.
  let assistantReply = null;
  await expect
    .poll(
      async () => {
        const res = await context.request.get(`${gateOrigin()}/api/thread`);
        if (res.status() !== 200) return false;
        const snapshot = await res.json();
        const sent = snapshot.messages.find(
          (m) => m.role === "user" && m.seq > prevMaxSeq && typeof m.text === "string" && m.text.includes(marker),
        );
        if (!sent) return false;
        expect(snapshot.messages.filter(m => m.role === "user" && m.text === promptText)).toHaveLength(1);
        const reply = snapshot.messages.find(
          (m) => m.role === "assistant" && m.seq > sent.seq && typeof m.text === "string" && m.text.trim().length > 0,
        );
        if (!reply) return false;
        assistantReply = reply;
        return !snapshot.status.generating;
      },
      { timeout: 120_000, intervals: [1_000, 2_000, 3_000] },
    )
    .toBe(true);

  expect(assistantReply).toBeTruthy();
  const replySnippet = assistantReply.text.trim().slice(0, 60);
  await expect(log).toContainText(replySnippet);

  // Reload the page and verify durable persistence of both turns.
  await page.reload();
  await expect(log).toBeVisible();
  await expect(log).toContainText(marker);
  await expect(log).toContainText(replySnippet);
});
