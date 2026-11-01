/*
 * Minimal offline fallback for the installed app (PWA).
 *
 * This app requires a live connection: the conversation, history, and sign-in
 * all live on the server (owner-only BFF with Keycloak OIDC). This worker
 * caches nothing except the static offline page below — it never puts
 * conversations, API responses, messages, session data, or user-specific
 * pages into CacheStorage. (The browser's ordinary HTTP cache and other site
 * storage are separate mechanisms outside this worker.)
 *
 * Precisely what this worker does:
 * - It intercepts only top-level GET navigations of this origin whose path is
 *   not /api or under /api/ (the BFF endpoints — sign-in flow, callback, test
 *   gate, thread and messages — are never intercepted, even when a user types
 *   such a URL or the OIDC callback redirects there as a navigation).
 *   Subresource requests (script/style/data fetches) are never touched.
 * - While the server is reachable it always passes navigations through to the
 *   network, so behavior is identical to a browser without this worker.
 *   HTTP error responses (404, 503, ...) are returned unchanged; only a
 *   request that cannot reach the network at all is handled.
 * - Only when a navigation cannot reach the network does it answer with the
 *   single precached, user-agnostic page /offline.html.
 * - The only CacheStorage entry it ever creates is under its own
 *   `companion-offline-` prefix, and activation cleanup deletes old caches
 *   with that prefix only, leaving unrelated caches on the origin (e.g. from
 *   other apps) untouched.
 */
const VERSION = "v1";
const CACHE_PREFIX = "companion-offline-";
const CACHE_NAME = `${CACHE_PREFIX}${VERSION}`;
const OFFLINE_URL = "/offline.html";

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      // "reload" bypasses the HTTP cache so a stale page can never be
      // precached as the offline fallback.
      await cache.add(new Request(OFFLINE_URL, { cache: "reload" }));
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
          .map((name) => caches.delete(name)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;

  // Only top-level GET navigations get an offline fallback. Everything else
  // (API routes, auth, hashed assets, data fetches) uses the network and the
  // browser's own HTTP cache exactly as before.
  if (request.mode !== "navigate" || request.method !== "GET") return;

  const url = new URL(request.url);

  // Only this origin. The worker's scope already limits control to this app,
  // so this only ever makes the rule explicit; it never rewrites or answers
  // a request for another origin.
  if (url.origin !== self.location.origin) return;

  // The BFF's API surface (OIDC sign-in flow and callback, the non-
  // production-only test-gate issuance, thread and message endpoints) is
  // never intercepted, even when it arrives as a top-level navigation.
  const { pathname } = url;
  if (pathname === "/api" || pathname.startsWith("/api/")) return;

  event.respondWith(
    (async () => {
      try {
        // Always try the real page first; cached copies of app pages are
        // never served. HTTP error responses resolve normally and are
        // returned unchanged — the fallback is for unreachable-network
        // failures (the fetch promise rejecting) only.
        return await fetch(request);
      } catch (error) {
        // Network failure (offline, server unreachable): show the static
        // fallback instead of the browser's error page.
        const cache = await caches.open(CACHE_NAME);
        const offline = await cache.match(OFFLINE_URL);
        if (offline) return offline;
        throw error;
      }
    })(),
  );
});
