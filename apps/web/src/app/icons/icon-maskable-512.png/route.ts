import { manifestIconPng } from "@/lib/icons";

/**
 * Manifest "maskable" icon (512x512, full bleed with the glyph inside the
 * safe-zone circle), generated at build time.
 *
 * Stateless and deterministic: prerendered at build time and served as a
 * static asset.
 */
export const dynamic = "force-static";

export async function GET(): Promise<Response> {
  return new Response(manifestIconPng("icon-maskable-512"), {
    headers: { "content-type": "image/png" },
  });
}
