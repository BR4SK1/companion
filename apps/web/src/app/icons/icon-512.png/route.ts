import { manifestIconPng } from "@/lib/icons";

/**
 * Manifest "any" icon (512x512, rounded), generated at build time.
 *
 * Stateless and deterministic: prerendered at build time and served as a
 * static asset.
 */
export const dynamic = "force-static";

export async function GET(): Promise<Response> {
  return new Response(manifestIconPng("icon-512"), {
    headers: { "content-type": "image/png" },
  });
}
