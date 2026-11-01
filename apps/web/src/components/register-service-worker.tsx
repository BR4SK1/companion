"use client";

import { useEffect } from "react";

/**
 * Registers the offline-fallback service worker (public/sw.js) in production
 * builds only. Registration is skipped in development so `next dev` is never
 * affected by worker caching. The worker is deliberately minimal: it never
 * caches app pages, API responses, or conversation data — it only shows a
 * static offline page when a top-level navigation cannot reach the server.
 * See public/sw.js for the rules.
 */
export function RegisterServiceWorker() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (!("serviceWorker" in navigator)) return;

    const register = () => {
      // Best-effort: the app works normally if registration fails.
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    };

    if (document.readyState === "complete") {
      register();
    } else {
      window.addEventListener("load", register, { once: true });
    }
  }, []);

  return null;
}
