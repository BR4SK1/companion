/**
 * BFF API helpers driven through a Playwright browser context's request
 * (which shares the context's cookies, i.e. the issued test session).
 *
 * Same-origin protection is part of the application contract, so
 * state-changing calls carry the test channel's loopback origin unless a
 * test deliberately sends a different one.
 */

import { config } from "./config.mjs";

export const gateOrigin = () => `http://127.0.0.1:${String(config.gatePort)}`;
export const mainOrigin = () => `http://127.0.0.1:${String(config.webPort)}`;

/** GET /api/thread through the browser context (shares the session cookie). */
export async function threadGet(context, { before } = {}) {
  const query = before === undefined ? "" : `?before=${String(before)}`;
  const response = await context.request.get(`${gateOrigin()}/api/thread${query}`);
  return { status: response.status(), body: response.status() === 200 ? await response.json() : null };
}

/** POST /api/messages through the browser context. */
export async function messagePost(context, text, clientKey, { origin = gateOrigin() } = {}) {
  const response = await context.request.post(`${gateOrigin()}/api/messages`, {
    headers: origin === null ? {} : { origin },
    data: { text, clientKey },
  });
  return { status: response.status(), body: response.status() === 200 ? await response.json() : null };
}

export function uniqueKey(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
