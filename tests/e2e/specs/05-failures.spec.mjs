/**
 * Failure paths, all against the run's own disposable stack:
 * - a failed chat generation is surfaced as a sanitized notice, the message
 *   stays persisted without a reply, and the conversation continues with
 *   the failed message still in later context;
 * - a failed decision likewise fails the turn without a chat attempt;
 * - a paused worker produces a visible connection-error state that recovers,
 *   and a send attempted while the worker is unreachable fails visibly and
 *   can be retried idempotently once the worker is back.
 *
 * The worker is paused and resumed with signals (SIGSTOP/SIGCONT) addressed
 * to the run-recorded PID after /proc identity verification; every test
 * ensures resumption afterwards so the stack is never left paused.
 */

import { expect, test } from "@playwright/test";

import { messagePost, threadGet, uniqueKey } from "../helpers/api.mjs";
import { seedPatterns, seedIdentity } from "../helpers/db.mjs";
import { waitForQuiescent } from "../helpers/quiesce.mjs";
import {
  chatRecords,
  decisionRecords,
  resetMode,
  resetRecords,
  scriptMode,
  waitForTurnReply,
} from "../helpers/provider.mjs";
import { signalWorker } from "../helpers/state.mjs";

test.beforeAll(async () => {
  // Quiescence first: seeding patterns or scripting failure modes must not
  // race a turn that is still deciding or generating.
  await waitForQuiescent();
  await resetMode();
  await seedPatterns();
  await seedIdentity();
  await resetRecords();
});

test.afterEach(async () => {
  // Never leave the stack paused or scripted-to-fail, whatever the outcome.
  try {
    signalWorker("SIGCONT");
  } catch {
    // Worker already gone or never paused.
  }
  // Give a resumed worker a moment to finish whatever its pause interrupted
  // before the mode is reset. Best effort: the stack may already be gone,
  // and in-flight provider calls read their behavior at request start, so a
  // late mode reset cannot corrupt them either way.
  try {
    await waitForQuiescent(8_000);
  } catch {
    // Quiescence not reachable in time — proceed with the reset anyway.
  }
  await resetMode();
});

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("log", { name: "Conversation" })).toBeVisible();
});

async function sendViaComposer(page, text) {
  await page.getByPlaceholder("Message").fill(text);
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByPlaceholder("Message")).toHaveValue("");
}

const FAILURE_NOTICE = "Some recent messages could not get a reply.";

test.describe("failed generation", () => {
  test("a chat failure is surfaced sanitized and leaves the message unanswered", async ({ page, context }) => {
    await scriptMode({ chat: "fail500" });
    const chatsBefore = (await chatRecords()).length;
    const text = `e2e-fail-chat-${uniqueKey("msg")}`;
    await sendViaComposer(page, text);

    // The user message is durably accepted; the turn then fails.
    await expect(page.getByText(FAILURE_NOTICE)).toBeVisible({ timeout: 25_000 });

    const thread = await threadGet(context);
    expect(thread.body.status.hasRecentFailure).toBe(true);
    const index = thread.body.messages.findIndex((message) => message.text === text);
    expect(index).toBeGreaterThanOrEqual(0);
    expect(thread.body.messages[index].role).toBe("user");
    // No reply was published for it: nothing after it in the thread yet.
    expect(thread.body.messages.slice(index + 1)).toEqual([]);

    // The worker did attempt the provider call before failing.
    const chats = await chatRecords();
    expect(chats.length).toBe(chatsBefore + 1);
    expect(chats.at(-1).body.messages.some((message) => message.content === text)).toBe(true);

    // The notice carries no error detail.
    await expect(page.getByText(/error|exception|stack/i)).toHaveCount(0);
  });

  test("the conversation continues and the failed message stays in context", async ({ page, context }) => {
    await resetMode();
    // The previous turn's failed chat request stays recorded without a
    // response, so the record-count assertion below counts all requests
    // while the wait anchors on this turn's own generation.
    const chatsBefore = (await chatRecords()).length;
    const failedTextPrefix = "e2e-fail-chat-";
    const recovered = `e2e-after-failure-${uniqueKey("msg")}`;

    await sendViaComposer(page, recovered);
    const reply = await waitForTurnReply(recovered);
    await expect(
      page.getByRole("log", { name: "Conversation" }).getByText(reply, { exact: true }),
    ).toBeVisible({ timeout: 20_000 });

    // A completed turn claimed after the failed one clears the flag.
    const thread = await threadGet(context);
    expect(thread.body.status.hasRecentFailure).toBe(false);

    const chats = await chatRecords();
    expect(chats.length).toBe(chatsBefore + 1);
    const request = chats.at(-1).body;
    const contents = request.messages.map((message) => message.content);
    const failedIndex = contents.findIndex(
      (content) => typeof content === "string" && content.startsWith(failedTextPrefix),
    );
    expect(failedIndex).toBeGreaterThan(0); // present in prior context after the system chunks
    // The failed message's own turn has no reply: the next entry after it in
    // conversation order is this turn's user message, not an assistant reply.
    expect(request.messages[failedIndex + 1].role).toBe("user");
    expect(request.messages[failedIndex + 1].content).toBe(recovered);
  });
});

test.describe("failed decision", () => {
  test("a decision failure fails the turn without a chat attempt", async ({ page, context }) => {
    await scriptMode({ decisions: "fail500" });
    const chatsBefore = (await chatRecords()).length;
    const text = `e2e-fail-decision-${uniqueKey("msg")}`;
    await sendViaComposer(page, text);

    await expect(page.getByText(FAILURE_NOTICE)).toBeVisible({ timeout: 25_000 });

    // The decision call happened; no chat call followed for that turn.
    const decisions = await decisionRecords();
    expect(decisions.length).toBeGreaterThanOrEqual(1);
    expect((await chatRecords()).length).toBe(chatsBefore);

    const thread = await threadGet(context);
    expect(thread.body.status.hasRecentFailure).toBe(true);
    const index = thread.body.messages.findIndex((message) => message.text === text);
    expect(thread.body.messages.slice(index + 1)).toEqual([]);
  });
});

test.describe("worker unavailability", () => {
  test("a paused worker shows a connection problem that recovers", async ({ page }) => {
    signalWorker("SIGSTOP");
    // The UI's next poll hits the BFF's worker timeout and the state shows.
    await expect(
      page.getByText("Connection problem — messages may be delayed. Retrying automatically."),
    ).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("button", { name: "Retry now" })).toBeVisible();

    signalWorker("SIGCONT");
    await expect(
      page.getByText("Connection problem — messages may be delayed. Retrying automatically."),
    ).toBeHidden({ timeout: 20_000 });
    // The thread is live again: a normal exchange works, anchored on this
    // turn's own generation.
    const text = `e2e-recovered-${uniqueKey("msg")}`;
    await sendViaComposer(page, text);
    const reply = await waitForTurnReply(text);
    await expect(
      page.getByRole("log", { name: "Conversation" }).getByText(reply, { exact: true }),
    ).toBeVisible({ timeout: 20_000 });
  });

  test("a send while the worker is unreachable fails visibly and retries idempotently", async ({ page }) => {
    signalWorker("SIGSTOP");
    const text = `e2e-retry-send-${uniqueKey("msg")}`;
    await sendViaComposer(page, text);

    // The BFF cannot reach the worker: the send fails and stays visible.
    await expect(page.getByText("A message could not be sent.")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Discard" })).toBeVisible();

    signalWorker("SIGCONT");
    // Retrying reuses the same idempotency key: the message is accepted and
    // answered once the worker is back. The wait anchors on this retried
    // message's own generation, however the interrupted first send settles.
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(
      page.getByRole("log", { name: "Conversation" }).getByText(text, { exact: true }),
    ).toBeVisible({ timeout: 20_000 });
    const reply = await waitForTurnReply(text);
    await expect(
      page.getByRole("log", { name: "Conversation" }).getByText(reply, { exact: true }),
    ).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("A message could not be sent.")).toHaveCount(0);

    // Exactly one durable copy exists.
    const thread = await threadGet(page.context());
    const matches = thread.body.messages.filter((message) => message.text === text);
    expect(matches.length).toBe(1);
  });
});
