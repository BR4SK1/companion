/**
 * The core conversation journey: a message composed in the UI is accepted,
 * durably persisted, answered through the real worker engine (response-pattern
 * decision over the seeded patterns, then chat generation against the fake
 * provider), and survives a reload. Follow-up turns carry prior context in
 * conversation order, API-sent messages appear in the open UI via polling,
 * and idempotent ingest behavior is verified at the BFF boundary.
 */

import { expect, test } from "@playwright/test";

import { gateOrigin, messagePost, threadGet, uniqueKey } from "../helpers/api.mjs";
import { PATTERNS, seedPatterns, seedIdentity, E2E_IDENTITY } from "../helpers/db.mjs";
import { waitForQuiescent } from "../helpers/quiesce.mjs";
import {
  chatRecords,
  decisionRecords,
  resetMode,
  resetRecords,
  setChatLatency,
  waitForTurnReply,
} from "../helpers/provider.mjs";

const greetingGuidance = PATTERNS[0].responseGuidance;

test.beforeAll(async () => {
  // Never script the provider or touch the pattern table while a turn from
  // a previous spec could still be in flight: quiescence is observed, not
  // assumed.
  await waitForQuiescent();
  await resetMode();
  await seedPatterns();
  await seedIdentity();
  await resetRecords();
});

test.beforeEach(async ({ page }) => {
  await page.goto("/");
});

async function sendViaComposer(page, text) {
  const composer = page.getByPlaceholder("Message");
  await composer.fill(text);
  await page.getByRole("button", { name: "Send message" }).click();
  // The composer clears once the send is dispatched.
  await expect(composer).toHaveValue("");
}

test.describe("accept, answer, persist", () => {
  test("a composed message is accepted and answered with pattern-guided generation", async ({ page, context }) => {
    const text = `e2e-hello-${uniqueKey("msg")}`;
    await sendViaComposer(page, text);

    // The reply arrives through the real worker engine: wait for this very
    // turn's generation — the anchor is the recorded request whose last
    // user message is this text, so an older reply or a still-pending
    // record can never satisfy the wait — then require its exact text.
    const reply = await waitForTurnReply(text);
    await expect(
      page.getByRole("log", { name: "Conversation" }).getByText(reply, { exact: true }),
    ).toBeVisible({ timeout: 20_000 });

    // Durable acceptance: the message is in the thread API (and therefore
    // persisted in the worker's database).
    const thread = await threadGet(context);
    expect(thread.status).toBe(200);
    const userMessage = thread.body.messages.find((message) => message.text === text);
    expect(userMessage).toBeTruthy();
    expect(userMessage.role).toBe("user");
    const assistantMessages = thread.body.messages.filter((message) => message.role === "assistant");
    expect(assistantMessages.length).toBeGreaterThanOrEqual(1);
    expect(thread.body.status.hasRecentFailure).toBe(false);
    expect(thread.body.status.highestAllocatedSeq).toBeGreaterThan(0);

    // The decision step ran against the seeded patterns.
    const decisions = await decisionRecords();
    expect(decisions.length).toBeGreaterThanOrEqual(1);
    const decision = decisions.at(-1).body;
    expect(decision.questions.response_pattern.type).toBe("choice");
    const offeredOptions = Object.keys(decision.questions.response_pattern.criteria);
    expect(offeredOptions).toEqual(PATTERNS.map((pattern) => pattern.id));
    expect(decision.questions.response_pattern.criteria["e2e-greeting"]).toBe(PATTERNS[0].selectionDescription);
    expect(decision.questions.response_pattern.criteria["e2e-detail"]).toBe(PATTERNS[1].selectionDescription);
    expect(decision.questions.response_pattern.instructions).toBeTruthy();

    // The chat generation carries the seeded identity as the leading system
    // message and the selected pattern's response guidance as the second
    // (the provider answers with the first offered option, i.e. the first
    // seeded pattern).
    const chats = await chatRecords();
    expect(chats.length).toBeGreaterThanOrEqual(1);
    const chat = chats.at(-1).body;
    expect(chat.messages[0]).toEqual({ role: "system", content: E2E_IDENTITY });
    expect(chat.messages[1]).toEqual({ role: "system", content: greetingGuidance });
    expect(chat.messages.some((message) => message.role === "user" && message.content === text)).toBe(true);
    expect(chat.model).toBe("e2e-fake-chat-model");
  });

  test("the conversation persists across a reload", async ({ page, context }) => {
    const threadBefore = await threadGet(context);
    expect(threadBefore.status).toBe(200);
    const userTexts = threadBefore.body.messages
      .filter((message) => message.role === "user")
      .map((message) => message.text);

    await page.reload();
    await expect(page.getByRole("log", { name: "Conversation" })).toBeVisible();
    for (const text of userTexts.slice(-3)) {
      await expect(
        page.getByRole("log", { name: "Conversation" }).getByText(text, { exact: true }),
      ).toBeVisible();
    }
    // No pending failure state after a clean reload.
    await expect(page.getByText("A message could not be sent.")).toHaveCount(0);
  });

  test("a follow-up turn carries the prior conversation in context order", async ({ page }) => {
    const chatsBefore = (await chatRecords()).length;
    const first = `e2e-followup-a-${uniqueKey("msg")}`;
    const second = `e2e-followup-b-${uniqueKey("msg")}`;
    // Send sequentially and wait for each turn's own reply: the first turn
    // must complete before the second message is composed, so the two
    // messages end up in separate turns (arriving while a turn is in flight
    // would legitimately group them into one).
    await sendViaComposer(page, first);
    const firstReply = await waitForTurnReply(first);
    await expect(
      page.getByRole("log", { name: "Conversation" }).getByText(firstReply, { exact: true }),
    ).toBeVisible({ timeout: 20_000 });
    await sendViaComposer(page, second);
    const secondReply = await waitForTurnReply(second);
    await expect(
      page.getByRole("log", { name: "Conversation" }).getByText(secondReply, { exact: true }),
    ).toBeVisible({ timeout: 20_000 });

    const chats = await chatRecords();
    expect(chats.length).toBe(chatsBefore + 2);
    const secondTurnRequest = chats.at(-1).body;
    const roles = secondTurnRequest.messages.map((message) => message.role);
    // Leading identity, then guidance, then prior context and this turn's
    // message.
    expect(roles[0]).toBe("system");
    expect(secondTurnRequest.messages[0].content).toBe(E2E_IDENTITY);
    expect(secondTurnRequest.messages[1].content).toBe(greetingGuidance);
    const contents = secondTurnRequest.messages.map((message) => message.content);
    const firstIndex = contents.indexOf(first);
    const replyAfterFirstIndex = roles.findIndex(
      (role, index) => index > firstIndex && role === "assistant",
    );
    const secondIndex = contents.indexOf(second);
    expect(firstIndex).toBeGreaterThan(1);
    expect(replyAfterFirstIndex).toBeGreaterThan(firstIndex);
    expect(secondIndex).toBeGreaterThan(replyAfterFirstIndex);
  });
});

test.describe("open UI stays live", () => {
  test("a message sent through the API appears in the open UI without reload", async ({ page, context }) => {
    const text = `e2e-from-api-${uniqueKey("msg")}`;
    const sent = await messagePost(context, text, uniqueKey("key"));
    expect(sent.status).toBe(200);
    expect(sent.body.message.text).toBe(text);

    // The already-open page picks it up on a later poll cycle (2s cadence).
    await expect(
      page.getByRole("log", { name: "Conversation" }).getByText(text, { exact: true }),
    ).toBeVisible({ timeout: 15_000 });
  });

  test("the composing indicator is visible while generation is in flight", async ({ page }) => {
    await setChatLatency(6000);
    const text = `e2e-slow-${uniqueKey("msg")}`;
    try {
      await sendViaComposer(page, text);
      await expect(page.getByText("Companion is composing…")).toBeVisible({ timeout: 12_000 });
      // Wait for this very turn's generation: the previous test's API-sent
      // message may still be generating, so a counted wait could be
      // satisfied by that earlier reply and a "latest record" read could
      // hit this turn's own still-pending request.
      const reply = await waitForTurnReply(text);
      await expect(
        page.getByRole("log", { name: "Conversation" }).getByText(reply, { exact: true }),
      ).toBeVisible({ timeout: 30_000 });
    } finally {
      // Never leak the latency into later tests, whatever the outcome.
      await setChatLatency(0);
    }
  });
});

test.describe("idempotent ingest at the BFF boundary", () => {
  test("a retried send with the same key returns the same message", async ({ context }) => {
    const text = `e2e-idempotent-${uniqueKey("msg")}`;
    const key = uniqueKey("key");
    const first = await messagePost(context, text, key);
    expect(first.status).toBe(200);
    const replay = await messagePost(context, text, key);
    expect(replay.status).toBe(200);
    expect(replay.body.message.id).toBe(first.body.message.id);
    expect(replay.body.message.seq).toBe(first.body.message.seq);

    const thread = await threadGet(context);
    const matches = thread.body.messages.filter((message) => message.text === text);
    expect(matches.length).toBe(1);
  });

  test("reusing a key with different content is rejected as a conflict", async ({ context }) => {
    const key = uniqueKey("key");
    const first = await messagePost(context, `e2e-conflict-a-${uniqueKey("msg")}`, key);
    expect(first.status).toBe(200);
    const conflict = await messagePost(context, `e2e-conflict-b-${uniqueKey("msg")}`, key);
    expect(conflict.status).toBe(409);
  });

  test("oversized and empty content are rejected before crossing the boundary", async ({ context }) => {
    const oversized = await messagePost(context, "x".repeat(20_001), uniqueKey("key"));
    expect(oversized.status).toBe(400);

    // The composer refuses to send blank input at all.
    const page = await context.newPage();
    await page.goto(gateOrigin());
    await expect(page.getByRole("log", { name: "Conversation" })).toBeVisible();
    await page.getByPlaceholder("Message").fill("   ");
    await expect(page.getByRole("button", { name: "Send message" })).toBeDisabled();
    await page.close();
  });
});
