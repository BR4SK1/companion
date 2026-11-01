import { APPLE_ICON_SIZE, appleIconPng } from "@/lib/icons";

/**
 * iOS home-screen icon (180x180, full bleed — Apple applies its own mask),
 * generated at build time from source-defined drawing code
 * (src/lib/icons.ts) — no image binaries live in the repository.
 */
export const size = { width: APPLE_ICON_SIZE, height: APPLE_ICON_SIZE };
export const contentType = "image/png";

export default function AppleIcon(): Response {
  return new Response(appleIconPng(), {
    headers: { "content-type": contentType },
  });
}
