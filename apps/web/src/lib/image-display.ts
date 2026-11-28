/**
 * Client-side image display preference for the visible conversation thread.
 *
 * Pure state/validation/projection logic — kept React-free so unit tests can
 * verify parsing, storage fallback, and message filtering directly under Node.
 */

import type { Message } from "./messages";

/** How inline thread images are rendered in the browser. */
export type ImageDisplayMode = "image" | "icon" | "none";

export const IMAGE_DISPLAY_MODES = ["image", "icon", "none"] as const;

export const DEFAULT_IMAGE_DISPLAY_MODE: ImageDisplayMode = "image";

/** localStorage key for the persisted per-browser image display preference. */
export const IMAGE_DISPLAY_STORAGE_KEY = "companion.image-display";

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Validate an untrusted or persisted value, falling back to the default mode. */
export function parseImageDisplayMode(value: unknown): ImageDisplayMode {
  return value === "image" || value === "icon" || value === "none"
    ? value
    : DEFAULT_IMAGE_DISPLAY_MODE;
}

function getBrowserStorage(): StorageLike | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

/**
 * Read the stored image display mode. Returns `null` when nothing valid is
 * stored or storage cannot be read, letting callers distinguish an unset value
 * from an explicit preference.
 */
export function readStoredImageDisplayModeOrNull(
  storage?: StorageLike | null,
): ImageDisplayMode | null {
  try {
    const target = storage === undefined ? getBrowserStorage() : storage;
    const raw = target?.getItem(IMAGE_DISPLAY_STORAGE_KEY);
    if (raw === "image" || raw === "icon" || raw === "none") {
      return raw;
    }
    return null;
  } catch {
    return null;
  }
}

/** Read the stored image display mode, defaulting to `"image"` on any miss or error. */
export function readStoredImageDisplayMode(
  storage?: StorageLike | null,
): ImageDisplayMode {
  return readStoredImageDisplayModeOrNull(storage) ?? DEFAULT_IMAGE_DISPLAY_MODE;
}

/** Persist the selected mode; storage failures (e.g. private browsing) are ignored. */
export function writeStoredImageDisplayMode(
  mode: ImageDisplayMode,
  storage?: StorageLike | null,
): boolean {
  try {
    const target = storage === undefined ? getBrowserStorage() : storage;
    if (!target) {
      return false;
    }
    target.setItem(IMAGE_DISPLAY_STORAGE_KEY, mode);
    return true;
  } catch {
    return false;
  }
}

/**
 * Project thread messages for the active image display mode before grouping:
 * - `"image"` and `"icon"` keep all messages intact (rendering differs at the
 *   image component level).
 * - `"none"` omits standalone image-only messages completely so no empty
 *   bubbles, avatars, timestamps, or orphaned day dividers appear, and strips
 *   image attachments from any message that carries both text and images.
 */
export function filterMessagesForImageDisplay(
  messages: readonly Message[],
  mode: ImageDisplayMode,
): readonly Message[] {
  if (mode !== "none") {
    return messages;
  }
  const filtered: Message[] = [];
  for (const message of messages) {
    const hasImages = (message.images?.length ?? 0) > 0;
    if (!hasImages) {
      filtered.push(message);
      continue;
    }
    const hasText = (message.text ?? "").length > 0;
    if (!hasText) {
      continue;
    }
    filtered.push({
      id: message.id,
      role: message.role,
      text: message.text,
      sentAt: message.sentAt,
    });
  }
  return filtered;
}
