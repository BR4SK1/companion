/**
 * Intrinsic dimension parsing for rendered image bytes (pure). Dimensions
 * are reserved by the web UI to avoid layout shift, so they are derived
 * from the actual bytes at render time — never assumed from the workflow.
 * Supports the formats the image domain accepts: WebP, PNG, and JPEG.
 * Returns null when the bytes do not parse as a supported image.
 */

export interface ImageDimensions {
  readonly width: number;
  readonly height: number;
}

function parseWebp(data: Buffer): ImageDimensions | null {
  if (data.length < 30) return null;
  if (data.toString("ascii", 0, 4) !== "RIFF" || data.toString("ascii", 8, 12) !== "WEBP") {
    return null;
  }
  const kind = data.toString("ascii", 12, 16);
  if (kind === "VP8X") {
    const width = 1 + data.readUIntLE(24, 3);
    const height = 1 + data.readUIntLE(27, 3);
    return { width, height };
  }
  if (kind === "VP8 ") {
    if (data.length < 30) return null;
    const width = data.readUInt16LE(26) & 0x3fff;
    const height = data.readUInt16LE(28) & 0x3fff;
    return width > 0 && height > 0 ? { width, height } : null;
  }
  if (kind === "VP8L") {
    if (data.length < 25) return null;
    const b0 = data[21]!;
    const b1 = data[22]!;
    const b2 = data[23]!;
    const b3 = data[24]!;
    const width = 1 + (((b1 & 0x3f) << 8) | b0);
    const height = 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6));
    return { width, height };
  }
  return null;
}

function parsePng(data: Buffer): ImageDimensions | null {
  if (data.length < 24) return null;
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < signature.length; i++) {
    if (data[i] !== signature[i]) return null;
  }
  const width = data.readUInt32BE(16);
  const height = data.readUInt32BE(20);
  return width > 0 && height > 0 ? { width, height } : null;
}

function parseJpeg(data: Buffer): ImageDimensions | null {
  if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < data.length) {
    if (data[offset] !== 0xff) return null;
    const marker = data[offset + 1]!;
    if (marker === 0xd9 || marker === 0xda) return null;
    const length = data.readUInt16BE(offset + 2);
    if (length < 2) return null;
    const isSof =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf);
    if (isSof) {
      const height = data.readUInt16BE(offset + 5);
      const width = data.readUInt16BE(offset + 7);
      return width > 0 && height > 0 ? { width, height } : null;
    }
    offset += 2 + length;
  }
  return null;
}

export function parseImageDimensions(
  mimeType: string,
  data: Buffer,
): ImageDimensions | null {
  if (mimeType === "image/webp") return parseWebp(data);
  if (mimeType === "image/png") return parsePng(data);
  if (mimeType === "image/jpeg") return parseJpeg(data);
  return null;
}
