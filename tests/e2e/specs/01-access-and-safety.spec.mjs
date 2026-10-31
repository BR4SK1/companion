/**
 * Access and safety journeys at the web/BFF boundary.
 *
 * Covers the test-entry gate's issuance and channel integrity, the
 * owner-only main channel, cross-channel cookie isolation, same-origin
 * protection for state-changing requests, and the worker's bearer
 * credential and unauthenticated health endpoints.
 *
 * No messages are sent in this spec; no provider traffic occurs.
 */

import { expect, test } from "@playwright/test";

import { gateOrigin, mainOrigin } from "../helpers/api.mjs";
import { config } from "../helpers/config.mjs";
import { rawRequest, workerRequest } from "../helpers/raw.mjs";

const TEST_SESSION_COOKIE = "companion_test_session";
const OWNER_SESSION_COOKIE = "companion_session";

test.describe("gate issuance", () => {
  test("first visit issues an identity-free test session and opens the thread", async ({ page, context }) => {
    await page.goto("/");
    // The page redirects through /api/test-gate/session to establish the
    // separate test session, then renders the live thread.
    await expect(page.getByRole("log", { name: "Conversation" })).toBeVisible();
    const cookies = await context.cookies(gateOrigin());
    const testCookie = cookies.find((cookie) => cookie.name === TEST_SESSION_COOKIE);
    expect(testCookie, "a test session cookie must be issued").toBeTruthy();
    expect(
      cookies.find((cookie) => cookie.name === OWNER_SESSION_COOKIE),
      "no owner session cookie may exist on the test channel",
    ).toBeUndefined();
  });

  test("the sign-in flow is not reachable on the test channel", async ({ page, context }) => {
    await page.goto("/");
    await expect(page.getByRole("log", { name: "Conversation" })).toBeVisible();
    // The callback endpoint does not exist on the test channel.
    const callback = await context.request.get(`${gateOrigin()}/api/auth/callback`);
    expect(callback.status()).toBe(404);
    // Sign-in on the test channel leads to test-session issuance, never to
    // an identity provider and never to an owner session.
    const login = await context.request.get(`${gateOrigin()}/api/auth/login`, { maxRedirects: 0 });
    expect(login.status()).toBe(303);
    const location = login.headers()["location"] ?? "";
    expect(location.startsWith(gateOrigin())).toBe(true);
    const after = await context.request.get(`${gateOrigin()}/api/auth/login`);
    expect(after.ok()).toBe(true);
    const cookies = await context.cookies(gateOrigin());
    expect(cookies.find((cookie) => cookie.name === OWNER_SESSION_COOKIE)).toBeUndefined();
  });
});

test.describe("main channel stays owner-only", () => {
  test("unauthenticated main channel shows the sign-in view and refuses the API", async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(mainOrigin());
    await expect(page.getByText("Companion is private.")).toBeVisible();
    await expect(page.getByRole("log", { name: "Conversation" })).toHaveCount(0);
    const thread = await context.request.get(`${mainOrigin()}/api/thread`);
    expect(thread.status()).toBe(401);
    await context.close();
  });

  test("a test-session cookie is worthless on the main channel", async ({ page, context }) => {
    await page.goto("/");
    await expect(page.getByRole("log", { name: "Conversation" })).toBeVisible();
    const cookies = await context.cookies(gateOrigin());
    const testCookie = cookies.find((cookie) => cookie.name === TEST_SESSION_COOKIE);
    expect(testCookie).toBeTruthy();
    // Cookies ignore ports, so the browser's own storage sends the test
    // cookie to the main listener on the same host as well; the main channel
    // must reject it (it is signed with the dedicated gate secret, carries no
    // owner identity, and the main channel never consults it).
    const thread = await context.request.get(`${mainOrigin()}/api/thread`);
    expect(thread.status()).toBe(401);
    const send = await context.request.post(`${mainOrigin()}/api/messages`, {
      headers: { origin: mainOrigin() },
      data: { text: "e2e-cross-channel", clientKey: "e2e-cross-channel" },
    });
    expect(send.status()).toBe(401);
  });
});

test.describe("gate channel integrity", () => {
  test("requests with a wrong Host header are rejected", async () => {
    const wrongHost = await rawRequest({
      port: config.gatePort,
      path: "/",
      headers: { host: "evil.example" },
    });
    expect(wrongHost.status).toBe(403);
    expect(wrongHost.body).toBe("forbidden");
    const localhostName = await rawRequest({
      port: config.gatePort,
      path: "/",
      headers: { host: `localhost:${String(config.gatePort)}` },
    });
    expect(localhostName.status).toBe(403);
  });

  test("requests carrying proxy/forwarding headers are rejected", async () => {
    const forwarded = await rawRequest({
      port: config.gatePort,
      path: "/",
      headers: { host: `127.0.0.1:${String(config.gatePort)}`, forwarded: "for=1.2.3.4" },
    });
    expect(forwarded.status).toBe(403);
    const xff = await rawRequest({
      port: config.gatePort,
      path: "/",
      headers: {
        host: `127.0.0.1:${String(config.gatePort)}`,
        "x-forwarded-for": "1.2.3.4",
      },
    });
    expect(xff.status).toBe(403);
  });
});

test.describe("same-origin protection", () => {
  test("state-changing requests from a foreign origin are refused on the test channel", async ({ page, context }) => {
    await page.goto("/");
    await expect(page.getByRole("log", { name: "Conversation" })).toBeVisible();
    const foreign = await context.request.post(`${gateOrigin()}/api/messages`, {
      headers: { origin: "https://evil.example" },
      data: { text: "e2e-forged-origin", clientKey: "e2e-forged-origin" },
    });
    expect(foreign.status()).toBe(403);
    // No Origin header at all (not a same-site browser navigation).
    const noOrigin = await context.request.post(`${gateOrigin()}/api/messages`, {
      data: { text: "e2e-no-origin", clientKey: "e2e-no-origin" },
    });
    expect(noOrigin.status()).toBe(403);
  });

  test("unauthenticated but same-origin calls are unauthorized, not open", async ({ browser }) => {
    const context = await browser.newContext();
    const thread = await context.request.get(`${gateOrigin()}/api/thread`);
    expect(thread.status()).toBe(401);
    const body = await thread.json().catch(() => null);
    expect(body === null || body?.messages === undefined).toBe(true);
    const send = await context.request.post(`${gateOrigin()}/api/messages`, {
      headers: { origin: gateOrigin() },
      data: { text: "e2e-anonymous", clientKey: "e2e-anonymous" },
    });
    expect(send.status()).toBe(401);
    await context.close();
  });
});

test.describe("worker private API boundary", () => {
  test("health and readiness are unauthenticated by design", async () => {
    const health = await workerRequest({ path: "/healthz" });
    expect(health.status).toBe(200);
    const ready = await workerRequest({ path: "/readyz" });
    expect(ready.status).toBe(200);
    expect(JSON.parse(ready.body)).toEqual({ ok: true });
  });

  test("domain endpoints refuse missing and wrong bearer credentials", async () => {
    const noToken = await workerRequest({
      method: "POST",
      path: "/v1/messages",
      json: { text: "e2e-no-token", clientKey: "e2e-no-token" },
    });
    expect(noToken.status).toBe(401);
    const wrongToken = await workerRequest({ path: "/v1/thread", token: "definitely-not-the-token" });
    expect(wrongToken.status).toBe(401);
    const thread = await workerRequest({ path: "/v1/thread" });
    expect(thread.status).toBe(401);
  });
});
