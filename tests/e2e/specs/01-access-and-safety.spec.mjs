/**
 * Access and safety journeys at the deployed web/BFF and worker boundaries.
 *
 * Covers test-gate session issuance, OIDC absence on the test channel,
 * owner-only main channel, cross-channel cookie isolation, Host/forwarding
 * header rejection, same-origin checks, and worker health/auth boundaries.
 */

import { expect, test } from "@playwright/test";

import { gateOrigin, gatePort, mainOrigin, rawRequest, workerRequest } from "../helpers/env.mjs";

const TEST_SESSION_COOKIE = "companion_test_session";
const OWNER_SESSION_COOKIE = "companion_session";

test.describe("gate issuance", () => {
  test("first visit issues an identity-free test session and opens the thread", async ({ page, context }) => {
    await page.goto("/");
    await expect(page.getByRole("log", { name: "Conversation" })).toBeVisible();
    const cookies = await context.cookies(gateOrigin());
    expect(cookies.find((c) => c.name === TEST_SESSION_COOKIE)).toBeTruthy();
    expect(cookies.find((c) => c.name === OWNER_SESSION_COOKIE)).toBeUndefined();
  });

  test("the sign-in flow is not reachable on the test channel", async ({ page, context }) => {
    await page.goto("/");
    await expect(page.getByRole("log", { name: "Conversation" })).toBeVisible();

    const callback = await context.request.get(`${gateOrigin()}/api/auth/callback`);
    expect(callback.status()).toBe(404);

    const login = await context.request.get(`${gateOrigin()}/api/auth/login`, { maxRedirects: 0 });
    expect(login.status()).toBe(303);
    expect((login.headers()["location"] ?? "").startsWith(gateOrigin())).toBe(true);

    const after = await context.request.get(`${gateOrigin()}/api/auth/login`);
    expect(after.ok()).toBe(true);
    const cookies = await context.cookies(gateOrigin());
    expect(cookies.find((c) => c.name === OWNER_SESSION_COOKIE)).toBeUndefined();
  });
});

test.describe("main channel stays owner-only", () => {
  test("unauthenticated main channel redirects to OIDC login and refuses the API", async ({ browser }) => {
    const context = await browser.newContext();
    const root = await context.request.get(`${mainOrigin()}/`, { maxRedirects: 0 });
    expect(root.status()).toBe(307);
    expect(root.headers()["location"]).toContain("/api/auth/login");

    const page = await context.newPage();
    await page.goto(`${mainOrigin()}/?auth=retry`);
    await expect(page.getByText("Companion is private.")).toBeVisible();
    await expect(page.getByRole("log", { name: "Conversation" })).toHaveCount(0);

    const thread = await context.request.get(`${mainOrigin()}/api/thread`);
    expect(thread.status()).toBe(401);
    await context.close();
  });

  test("a test-session cookie is rejected on the main channel", async ({ page, context }) => {
    await page.goto("/");
    await expect(page.getByRole("log", { name: "Conversation" })).toBeVisible();
    const cookies = await context.cookies(gateOrigin());
    expect(cookies.find((c) => c.name === TEST_SESSION_COOKIE)).toBeTruthy();

    const thread = await context.request.get(`${mainOrigin()}/api/thread`);
    expect(thread.status()).toBe(401);
    const send = await context.request.post(`${mainOrigin()}/api/messages`, {
      headers: { origin: mainOrigin() },
      data: { text: "e2e-cross-channel", clientKey: "e2e-cross-channel" },
    });
    // Rejected by main-channel same-origin check (403) or auth check (401).
    expect([401, 403]).toContain(send.status());
  });
});

test.describe("gate channel integrity", () => {
  test("requests with a wrong Host header are rejected", async () => {
    const wrongHost = await rawRequest({
      port: gatePort,
      path: "/",
      headers: { host: "evil.example" },
    });
    expect(wrongHost.status).toBe(403);
    expect(wrongHost.body).toBe("forbidden");

    const localhostName = await rawRequest({
      port: gatePort,
      path: "/",
      headers: { host: `localhost:${String(gatePort)}` },
    });
    expect(localhostName.status).toBe(403);
  });

  test("requests carrying proxy/forwarding headers are rejected", async () => {
    const forwarded = await rawRequest({
      port: gatePort,
      path: "/",
      headers: { host: `127.0.0.1:${String(gatePort)}`, forwarded: "for=1.2.3.4" },
    });
    expect(forwarded.status).toBe(403);

    const xff = await rawRequest({
      port: gatePort,
      path: "/",
      headers: {
        host: `127.0.0.1:${String(gatePort)}`,
        "x-forwarded-for": "1.2.3.4",
      },
    });
    expect(xff.status).toBe(403);
  });
});

test.describe("same-origin protection", () => {
  test("state-changing requests from a foreign or missing origin are refused", async ({ page, context }) => {
    await page.goto("/");
    await expect(page.getByRole("log", { name: "Conversation" })).toBeVisible();

    const foreign = await context.request.post(`${gateOrigin()}/api/messages`, {
      headers: { origin: "https://evil.example" },
      data: { text: "e2e-forged-origin", clientKey: "e2e-forged-origin" },
    });
    expect(foreign.status()).toBe(403);

    const noOrigin = await context.request.post(`${gateOrigin()}/api/messages`, {
      data: { text: "e2e-no-origin", clientKey: "e2e-no-origin" },
    });
    expect(noOrigin.status()).toBe(403);
  });

  test("unauthenticated same-origin calls are unauthorized", async ({ browser }) => {
    const context = await browser.newContext();
    const thread = await context.request.get(`${gateOrigin()}/api/thread`);
    expect(thread.status()).toBe(401);
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

    const wrongToken = await workerRequest({ path: "/v1/thread", token: "wrong-token" });
    expect(wrongToken.status).toBe(401);

    const thread = await workerRequest({ path: "/v1/thread" });
    expect(thread.status).toBe(401);
  });
});
