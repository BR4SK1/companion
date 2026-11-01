import { APP_ICON_SIZE, appIconPng } from "@/lib/icons";

/**
 * Favicon (32x32, rounded), generated at build time from source-defined
 * drawing code (src/lib/icons.ts) — no image binaries live in the repository.
 */
export const size = { width: APP_ICON_SIZE, height: APP_ICON_SIZE };
export const contentType = "image/png";

export default function Icon(): Response {
  return new Response(appIconPng(), {
    headers: { "content-type": contentType },
  });
}
