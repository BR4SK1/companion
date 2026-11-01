import type { MetadataRoute } from "next";

/*
 * Installable web app (PWA) manifest. Static, user-agnostic values only:
 * this route is publicly reachable and must never contain user data.
 *
 * The app is owner-only and requires a live connection; the manifest makes
 * it installable while the service worker (public/sw.js) provides only a
 * static offline fallback — never cached conversation or user data.
 *
 * `background_color`/`theme_color` match the light scheme's background in
 * src/theme/theme.ts; the runtime theme-color <meta> tags override it per
 * applied scheme while the app is running.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "Companion",
    short_name: "Companion",
    description:
      "Private companion conversation. Owner sign-in required; the thread is served only to the authenticated owner.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#f4f3f9",
    theme_color: "#f4f3f9",
    icons: [
      {
        src: "/icons/icon-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icons/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icons/icon-maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
