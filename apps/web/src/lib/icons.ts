/**
 * Source-defined icon assets for the app and the PWA manifest.
 *
 * Every icon is a deterministic function of this source: a speech-bubble
 * glyph on the app theme's light primary color, rasterized with fixed
 * supersampling and encoded as PNG with Node's zlib. Nothing is stored as a
 * binary in the repository — the image conventions (`app/icon.ts`,
 * `app/apple-icon.ts`) and the manifest icon routes (`app/icons/*`) produce
 * the bytes, which Next statically prerenders at build time.
 *
 * Server/build-time only (uses `node:zlib`); never import from a client
 * component.
 */

import { deflateSync } from "node:zlib";

// Brand colors from the app theme (src/theme/theme.ts): the light scheme's
// primary color as the background, white as the glyph color. Kept in sync
// with the theme deliberately — importing the theme module here would pull
// MUI into every consumer (including tests) for two color constants.
const BACKGROUND = [0x5b, 0x4b, 0xc4] as const; // #5b4bc4 (palette.primary.main, light)
const FOREGROUND = [0xff, 0xff, 0xff] as const; // white

// Corner radius (fraction of icon size) for "any"-purpose icons. Maskable and
// Apple icons are full-bleed squares because the OS applies its own mask.
const CORNER_RADIUS = 0.225;

// Glyph: a filled speech bubble (rounded rectangle plus a triangular tail)
// in design space [0,1]x[0,1] (y grows downward), centered at (0.5, 0.5) and
// sized to stay inside the maskable safe-zone circle (radius 0.4 around the
// center).
const BUBBLE = { x0: 0.24, y0: 0.22, x1: 0.76, y1: 0.58, radius: 0.08 } as const;
// Tail triangle: starts on the bubble's bottom edge (slightly overlapping
// it so the union has no seam) and points down-left.
const TAIL = [0.3, 0.54, 0.44, 0.54, 0.3, 0.72] as const;

/** Maskable icons keep the glyph inside this radius around the center. */
export const MASKABLE_SAFE_RADIUS = 0.4;

function insideRoundedRect(
  u: number,
  v: number,
  rect: { readonly x0: number; readonly y0: number; readonly x1: number; readonly y1: number; readonly radius: number },
): boolean {
  if (u < rect.x0 || u > rect.x1 || v < rect.y0 || v > rect.y1) return false;
  const cx = Math.min(Math.max(u, rect.x0 + rect.radius), rect.x1 - rect.radius);
  const cy = Math.min(Math.max(v, rect.y0 + rect.radius), rect.y1 - rect.radius);
  const dx = u - cx;
  const dy = v - cy;
  return dx * dx + dy * dy <= rect.radius * rect.radius;
}

function insideTriangle(u: number, v: number, triangle: readonly number[]): boolean {
  const [ax, ay, bx, by, cx, cy] = triangle;
  const d1 = (u - bx) * (ay - by) - (ax - bx) * (v - by);
  const d2 = (u - cx) * (by - cy) - (bx - cx) * (v - cy);
  const d3 = (u - ax) * (cy - ay) - (cx - ax) * (v - ay);
  const hasNegative = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPositive = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNegative && hasPositive);
}

function insideGlyph(u: number, v: number): boolean {
  return insideRoundedRect(u, v, BUBBLE) || insideTriangle(u, v, TAIL);
}

function insideIconShape(u: number, v: number): boolean {
  // The "any" icons are rounded squares; the maskable and Apple icons are
  // full-bleed squares.
  return insideRoundedRect(u, v, {
    x0: 0,
    y0: 0,
    x1: 1,
    y1: 1,
    radius: CORNER_RADIUS,
  });
}

/**
 * Renders the icon to RGBA pixels. Anti-aliased with 4x4 supersampling.
 * Exposed for verification; the delivered assets are the PNG factories.
 */
export function renderRgba(
  size: number,
  options: { readonly fullBleed?: boolean } = {},
): { width: number; height: number; data: Uint8Array } {
  const fullBleed = options.fullBleed ?? false;
  const samples = 4;
  const total = samples * samples;
  const data = new Uint8Array(size * size * 4);

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let insideShape = 0;
      let insideGlyphSamples = 0;
      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const u = (px + (sx + 0.5) / samples) / size;
          const v = (py + (sy + 0.5) / samples) / size;
          if (!fullBleed && !insideIconShape(u, v)) continue;
          insideShape++;
          if (insideGlyph(u, v)) insideGlyphSamples++;
        }
      }
      const offset = (py * size + px) * 4;
      if (insideShape === 0) continue; // fully transparent pixel
      const t = insideGlyphSamples / insideShape;
      for (let c = 0; c < 3; c++) {
        data[offset + c] = Math.round(
          BACKGROUND[c] + (FOREGROUND[c] - BACKGROUND[c]) * t,
        );
      }
      data[offset + 3] = Math.round((insideShape / total) * 255);
    }
  }

  return { width: size, height: size, data };
}

// ---------------------------------------------------------------------------
// Minimal PNG encoder (RGBA, 8-bit, filter 0 scanlines, zlib IDAT).
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

function crc32(buffer: Uint8Array): number {
  let crc = -1;
  for (let i = 0; i < buffer.length; i++) {
    crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ -1) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([length, typeAndData, crc]);
}

function encodePng(image: { width: number; height: number; data: Uint8Array }): Uint8Array<ArrayBuffer> {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(image.width, 0);
  ihdr.writeUInt32BE(image.height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  const stride = image.width * 4;
  const raw = Buffer.alloc((stride + 1) * image.height);
  for (let y = 0; y < image.height; y++) {
    raw[y * (stride + 1)] = 0; // filter type: none
    raw.set(
      image.data.subarray(y * stride, (y + 1) * stride),
      y * (stride + 1) + 1,
    );
  }
  const idat = deflateSync(raw, { level: 9 });
  const out = Buffer.concat([
    signature,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
  // Copy into a plain ArrayBuffer-backed view: Buffer is ArrayBufferLike, and
  // Response's BodyInit requires an ArrayBuffer-backed view. The images are
  // a few kilobytes, so the copy is negligible.
  const body = new Uint8Array(out.length);
  body.set(out);
  return body;
}

// ---------------------------------------------------------------------------
// Delivered assets.
// ---------------------------------------------------------------------------

/** Favicon rendered from the icon file convention: 32x32, rounded corners. */
export const APP_ICON_SIZE = 32;

/** iOS home-screen icon: 180x180, full bleed (Apple applies its own mask). */
export const APPLE_ICON_SIZE = 180;

/** The manifest icon variants and their exact production parameters. */
export type ManifestIconVariant = "icon-192" | "icon-512" | "icon-maskable-512";

export const MANIFEST_ICONS = {
  "icon-192": { size: 192, fullBleed: false },
  "icon-512": { size: 512, fullBleed: false },
  "icon-maskable-512": { size: 512, fullBleed: true },
} as const satisfies Record<ManifestIconVariant, { size: number; fullBleed: boolean }>;

/** The favicon asset served by the `app/icon.ts` convention. */
export function appIconPng(): Uint8Array<ArrayBuffer> {
  return encodePng(renderRgba(APP_ICON_SIZE));
}

/** The iOS home-screen asset served by the `app/apple-icon.ts` convention. */
export function appleIconPng(): Uint8Array<ArrayBuffer> {
  return encodePng(renderRgba(APPLE_ICON_SIZE, { fullBleed: true }));
}

/** A manifest icon asset served by its `/icons/<variant>.png` route. */
export function manifestIconPng(variant: ManifestIconVariant): Uint8Array<ArrayBuffer> {
  const spec = MANIFEST_ICONS[variant];
  return encodePng(renderRgba(spec.size, { fullBleed: spec.fullBleed }));
}

/** Reads width/height from an encoded PNG (IHDR), for verification. */
export function pngDimensions(png: Uint8Array): { width: number; height: number } {
  return {
    width: png[16] * 2 ** 24 + png[17] * 2 ** 16 + png[18] * 2 ** 8 + png[19],
    height: png[20] * 2 ** 24 + png[21] * 2 ** 16 + png[22] * 2 ** 8 + png[23],
  };
}
