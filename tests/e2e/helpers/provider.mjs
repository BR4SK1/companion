/**
 * Client for the fake provider's control API (see `fake-provider.mjs`):
 * scripted behavior modes and the recorded request bodies used for
 * assertions about what the worker actually sent.
 */

import { config } from "./config.mjs";

const baseUrl = `http://127.0.0.1:${String(config.providerPort)}`;

async function controlJson(path, init) {
  const response = await fetch(`${baseUrl}${path}`, init);
  if (!response.ok) {
    throw new Error(`provider control ${path} failed: ${String(response.status)}`);
  }
  return response.json();
}

/** Reset the recorded requests (call in each spec's beforeAll). */
export async function resetRecords() {
  await controlJson("/__control/reset", { method: "POST" });
}

/** Script endpoint behavior: {chat?, decisions?, chatLatencyMs?}. */
export async function setMode(modes) {
  return controlJson("/__control/mode", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(modes),
  });
}

/** {chat: [...], decisions: [...]} — the most recent request bodies. */
export async function getRecords() {
  return controlJson("/__control/requests");
}

export async function chatRecords() {
  return (await getRecords()).chat;
}

export async function decisionRecords() {
  return (await getRecords()).decisions;
}

/** Capability calls currently being served, per endpoint ({chat, decisions}). */
export async function providerPending() {
  return controlJson("/__control/pending");
}

/** Restore everything to the plain success mode. */
export async function resetMode() {
  await setMode({ chat: "ok", decisions: "ok", chatLatencyMs: 0 });
}

/** Script only a failure mode for one endpoint, e.g. {chat: "fail500"}. */
export async function scriptMode(modes) {
  return setMode(modes);
}

/** Set only the artificial chat latency (ms), keeping success behavior. */
export async function setChatLatency(ms) {
  await setMode({ chatLatencyMs: ms });
}

/** The reply text the most recent successful chat generation produced
 * (call only after `waitForChatCount` observed the generation). */
export async function lastReplyText() {
  const chats = await chatRecords();
  const last = chats.at(-1);
  if (last === undefined || typeof last.response !== "string") {
    throw new Error("no recorded chat response to read");
  }
  return last.response;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Number of recorded chat requests that produced a successful response. */
export async function replyCount() {
  const chats = await chatRecords();
  return chats.filter((entry) => typeof entry.response === "string").length;
}

/** Poll until at least `minCount` successful chat generations are recorded. */
export async function waitForReplyCount(minCount, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const count = await replyCount();
    if (count >= minCount) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(`reply count stayed below ${String(minCount)} (got ${String(count)})`);
    }
    await sleep(250);
  }
}

/**
 * Wait until the provider's most recent chat request is the turn that sent
 * `userText` (its last user message) and that request's response has been
 * produced, then return the exact reply text. Unlike a counted wait this
 * cannot be satisfied by an earlier, still-in-flight generation from a
 * previous test's message, and it cannot read a pending record.
 */
export async function waitForTurnReply(userText, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const chats = await chatRecords();
    const last = chats.at(-1);
    const messages = Array.isArray(last?.body?.messages) ? last.body.messages : [];
    const lastUserMessage = [...messages].reverse().find((entry) => entry?.role === "user");
    if (lastUserMessage?.content === userText && typeof last?.response === "string") {
      return last.response;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `no recorded reply for the turn sending ${JSON.stringify(userText)}`,
      );
    }
    await sleep(250);
  }
}
