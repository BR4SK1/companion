/**
 * PWA journeys against the deployed production build:
 * - static PWA assets (manifest, service worker, offline page, icons) are
 *   publicly reachable and user-agnostic on both channels;
 * - document head carries the manifest link and Apple home-screen metadata;
 * - the service worker registers, precaches only `/offline.html`, serves it
 *   on offline navigations, never intercepts `/api` or subresources, and
 *   preserves HTTP error responses.
 */

import { expect, test } from "@playwright/test";

import { gateOrigin, mainOrigin } from "../helpers/env.mjs";

const OFFLINE_CACHE = "companion-offline-v1";

test.afterEach(async ({ context }) => {
  await context.setOffline(false);
});

test.describe("PWA assets", () => {
  test("are publicly reachable and user-agnostic on the test channel", async ({ request }) => {
    const manifest = await request.get(`${gateOrigin()}/manifest.webmanifest`);
    expect(manifest.status()).toBe(200);
    const manifestBody = await manifest.json();
    expect(manifestBody.name).toBe("Companion");
    expect(manifestBody.short_name).toBe("Companion");
    expect(manifestBody.start_url).toBe("/");
    expect(manifestBody.scope).toBe("/");
    expect(manifestBody.display).toBe("standalone");
    expect(manifestBody.background_color).toMatch(/^#[0-9a-f]{6}$/);
    const sources = manifestBody.icons.map((icon) => icon.src);
    expect(sources).toEqual(
      expect.arrayContaining([
        "/icons/icon-192.png",
        "/icons/icon-512.png",
        "/icons/icon-maskable-512.png",
      ]),
    );
    expect(JSON.stringify(manifestBody)).not.toMatch(/token|secret|cookie|session/i);

    const worker = await request.get(`${gateOrigin()}/sw.js`);
    expect(worker.status()).toBe(200);
    expect(worker.headers()["content-type"]).toContain("javascript");

    const offline = await request.get(`${gateOrigin()}/offline.html`);
    expect(offline.status()).toBe(200);
    expect(await offline.text()).toContain("You're offline");

    for (const icon of [
      "/icons/icon-192.png",
      "/icons/icon-512.png",
      "/icons/icon-maskable-512.png",
      "/icon",
      "/apple-icon",
    ]) {
      const response = await request.get(`${gateOrigin()}${icon}`);
      expect(response.status(), icon).toBe(200);
      expect(response.headers()["content-type"], icon).toContain("image/png");
    }
  });

  test("are reachable on the owner-only main channel too", async ({ request }) => {
    const manifest = await request.get(`${mainOrigin()}/manifest.webmanifest`);
    expect(manifest.status()).toBe(200);
    expect((await manifest.json()).name).toBe("Companion");
    expect((await request.get(`${mainOrigin()}/sw.js`)).status()).toBe(200);
    expect((await request.get(`${mainOrigin()}/offline.html`)).status()).toBe(200);
  });
});

test.describe("document head metadata", () => {
  test("carries the manifest link and Apple home-screen metadata", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator('link[rel="manifest"]')).toHaveAttribute("href", "/manifest.webmanifest");
    await expect(page.locator('meta[name="apple-mobile-web-app-title"]')).toHaveAttribute("content", "Companion");
    await expect(page.locator('meta[name="apple-mobile-web-app-status-bar-style"]')).toHaveCount(1);
    await expect(
      page.locator('meta[name="apple-mobile-web-app-capable"], meta[name="mobile-web-app-capable"]'),
    ).not.toHaveCount(0);
    await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveCount(1);
    await expect(page.locator('meta[name="theme-color"]')).not.toHaveCount(0);
  });
});

test.describe("service worker", () => {
  async function waitForControlledPage(page) {
    await page.goto("/");
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload();
    await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
  }

  test("registers and caches only the offline page", async ({ page }) => {
    await waitForControlledPage(page);
    const cacheState = await page.evaluate(async (cacheName) => {
      const names = await caches.keys();
      const cache = await caches.open(cacheName);
      return { names, entries: [...(await cache.keys())].map((r) => r.url) };
    }, OFFLINE_CACHE);
    expect(cacheState.names).toEqual([OFFLINE_CACHE]);
    expect(cacheState.entries).toEqual([`${gateOrigin()}/offline.html`]);
  });

  test("serves the offline page for a failed navigation and recovers online", async ({ page, context }) => {
    await waitForControlledPage(page);
    await context.setOffline(true);
    await page.goto("/");
    await expect(page.locator("h1")).toHaveText("You're offline");

    await context.setOffline(false);
    await page.goto("/");
    await expect(page.getByRole("log", { name: "Conversation" })).toBeVisible();
  });

  test("never intercepts the BFF API surface, POSTs, or subresources", async ({ page, context }) => {
    await waitForControlledPage(page);
    await context.setOffline(true);
    const outcome = await page.evaluate(async () => {
      const attempt = (path, init) =>
        fetch(path, init).then(
          (response) => `resolved ${response.status}`,
          () => "rejected",
        );
      return {
        thread: await attempt("/api/thread"),
        send: await attempt("/api/messages", { method: "POST" }),
        gate: await attempt("/api/test-gate/session"),
        subresource: await attempt("/sw.js"),
      };
    });
    expect(outcome).toEqual({
      thread: "rejected",
      send: "rejected",
      gate: "rejected",
      subresource: "rejected",
    });
    await expect(page.goto("/api/thread")).rejects.toThrow();
  });

  test("preserves HTTP error responses instead of substituting the fallback", async ({ page }) => {
    await waitForControlledPage(page);
    const response = await page.goto("/definitely-not-a-page");
    expect(response?.status()).toBe(404);
    expect(await page.content()).not.toContain("You're offline");
  });
});
