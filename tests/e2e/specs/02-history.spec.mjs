/**
 * History and scrolling: seeded durable history (completed past turns,
 * spread over three configured Los Angeles calendar days) is paged, the
 * automatic bounded backfill stops short of the bottom and the "Load earlier
 * messages" control covers the rest, local-day dividers mark those dates, and
 * scroll anchoring / jump-to-latest behavior keeps the reader in control.
 *
 * The seed is sized against the client's actual walk: the automatic
 * backfill runs once (up to five pages) and does not resume on later
 * cycles — the control is the only way further down. Sized so the walk
 * stops exactly one page short, the control is reliably offered and the
 * bottom is one click away, which makes the control's disappearance a
 * definite bottom-reached signal.
 */

import { expect, test } from "@playwright/test";

import { gateOrigin, messagePost, threadGet, uniqueKey } from "../helpers/api.mjs";
import { seedHistory } from "../helpers/db.mjs";
import { config } from "../helpers/config.mjs";

const HISTORY_TURNS = 350; // 700 messages: newest page + one 5-page walk + one load-earlier click reach the bottom.
let expectedLocalDayLabels = [];

test.beforeAll(async () => {
  const seededInstants = await seedHistory(HISTORY_TURNS);
  const label = new Intl.DateTimeFormat("en-US", {
    timeZone: config.temporalTimezone,
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  expect(seededInstants).toHaveLength(3);
  expectedLocalDayLabels = seededInstants.map((instant) => label.format(new Date(instant)));
  expect(new Set(expectedLocalDayLabels).size).toBe(3);
});

/**
 * Walk to the bottom of the history the way a reader would: wait for the
 * automatic backfill to stop (the control is then offered), and keep using
 * the control until the bottom is reached. While a page loads the button is
 * replaced by a progress spinner, so "gone" only counts as done when
 * neither is present anymore.
 */
async function walkToBottom(page) {
  const loadEarlier = page.getByRole("button", { name: "Load earlier messages" });
  const loadingEarlier = page.getByRole("progressbar", { name: "Loading earlier messages" });
  await expect(loadEarlier).toBeVisible({ timeout: 15_000 });
  await expect
    .poll(
      async () => {
        if (await loadEarlier.isVisible().catch(() => false)) {
          await loadEarlier.click().catch(() => {});
        }
        return (await loadEarlier.count()) === 0 && (await loadingEarlier.count()) === 0;
      },
      { timeout: 60_000 },
    )
    .toBe(true);
}

test("the BFF newest page is bounded and reports more history", async ({ context }) => {
  // This spec runs before any browser test in a run, so this context has no
  // test session yet; the issuance endpoint establishes one for the context.
  const issuance = await context.request.get(`${gateOrigin()}/api/test-gate/session`);
  expect(issuance.ok()).toBe(true);
  const thread = await threadGet(context);
  expect(thread.status).toBe(200);
  expect(thread.body.timezone).toBe(config.temporalTimezone);
  expect(thread.body.messages.length).toBe(100);
  expect(thread.body.page.hasMore).toBe(true);
  expect(
    thread.body.messages.some(
      (message) => message.text === `e2e-history-user-${String(HISTORY_TURNS)}`,
    ),
  ).toBe(true);
});

test("older history is reachable through the load-earlier control", async ({ page }) => {
  await page.goto("/");
  const log = page.getByRole("log", { name: "Conversation" });

  // The newest seeded turn is visible; the oldest is far below.
  await expect(log.getByText(`e2e-history-user-${String(HISTORY_TURNS)}`, { exact: true })).toBeVisible();
  await expect(log.getByText("e2e-history-user-1", { exact: true })).toHaveCount(0);

  // The first automatic backfill walk is bounded (five pages) and stops one
  // page short of the bottom with this seed, so the control is offered.
  // Walk to the bottom through the control like a reader would.
  await walkToBottom(page);

  // The oldest seeded message is now visible and the control is gone.
  await expect(log.getByText("e2e-history-user-1", { exact: true })).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByRole("button", { name: "Load earlier messages" })).toHaveCount(0);
});

test("configured local-day dividers mark the seeded dates", async ({ page }) => {
  await page.goto("/");
  // Walk to the bottom so all seeded dates are loaded. The synthetic events
  // are at 00:30 UTC, which is the preceding Los Angeles date; expected labels
  // are independently derived from that configured zone rather than UTC.
  await walkToBottom(page);
  // Divider chips render a <time> inside a chip label; message clock times
  // are plain <time> elements, so scope to the chip labels.
  const dividers = page.locator(".MuiChip-label time");
  await expect(dividers.first()).toBeVisible();
  const labels = [];
  const count = await dividers.count();
  for (let index = 0; index < count; index += 1) {
    labels.push(await dividers.nth(index).textContent());
  }
  // Three seeded dates produce dividers only at the two later date boundaries.
  expect(labels).toEqual(expectedLocalDayLabels.slice(1));
  expect(labels).toHaveLength(2);
  expect(labels.every((label) => !label.includes("UTC"))).toBe(true);
});

test("scrolling up shows jump-to-latest and returns to the newest message", async ({ page }) => {
  await page.goto("/");
  const log = page.getByRole("log", { name: "Conversation" });
  await expect(log.getByText(`e2e-history-user-${String(HISTORY_TURNS)}`, { exact: true })).toBeVisible();

  // Scroll away from the bottom: the reader must not be dragged along.
  await log.evaluate((element) => {
    element.scrollTop = 0;
  });
  const jump = page.getByRole("button", { name: "Jump to latest messages" });
  await expect(jump).toBeVisible();

  await jump.click();
  await expect
    .poll(
      async () =>
        log.evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight),
      { timeout: 10_000 },
    )
    .toBeLessThanOrEqual(40);
});

test("a reader scrolled away from the bottom is not dragged by new messages", async ({ page, context }) => {
  await page.goto("/");
  const log = page.getByRole("log", { name: "Conversation" });
  await expect(log.getByText(`e2e-history-user-${String(HISTORY_TURNS)}`, { exact: true })).toBeVisible();

  // The reader scrolls up into history: anchoring must keep them there.
  await log.evaluate((element) => {
    element.scrollTop = 0;
  });
  const jump = page.getByRole("button", { name: "Jump to latest messages" });
  await expect(jump).toBeVisible();

  // A new message arrives while the reader is away from the bottom.
  const text = `e2e-anchor-${uniqueKey("msg")}`;
  const sent = await messagePost(context, text, uniqueKey("key"));
  expect(sent.status).toBe(200);

  // It reaches the open UI through polling — rendered in the document, but
  // NOT dragged into the viewport: the reader stays where they were.
  await expect(log.getByText(text, { exact: true })).toBeAttached({ timeout: 15_000 });
  await expect(jump).toBeVisible();
  const distanceFromBottom = await log.evaluate(
    (element) => element.scrollHeight - element.scrollTop - element.clientHeight,
  );
  expect(distanceFromBottom).toBeGreaterThan(100);

  // Jump-to-latest still returns the reader to the newest message.
  await jump.click();
  await expect
    .poll(
      async () =>
        log.evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight),
      { timeout: 10_000 },
    )
    .toBeLessThanOrEqual(40);
});
