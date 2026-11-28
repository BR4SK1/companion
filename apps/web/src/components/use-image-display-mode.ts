"use client";

import { useCallback, useSyncExternalStore } from "react";

import {
  DEFAULT_IMAGE_DISPLAY_MODE,
  IMAGE_DISPLAY_STORAGE_KEY,
  readStoredImageDisplayModeOrNull,
  writeStoredImageDisplayMode,
  type ImageDisplayMode,
} from "@/lib/image-display";

const listeners = new Set<() => void>();

/**
 * In-memory fallback used when `localStorage` is unavailable or throws (e.g.
 * restricted browser contexts), so switching modes still works dynamically for
 * the open session.
 */
let fallbackMode: ImageDisplayMode | null = null;

function emitChange(): void {
  for (const listener of listeners) {
    listener();
  }
}

function subscribe(callback: () => void): () => void {
  listeners.add(callback);
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === IMAGE_DISPLAY_STORAGE_KEY) {
      fallbackMode = null;
      callback();
    }
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(callback);
    window.removeEventListener("storage", onStorage);
  };
}

function getClientSnapshot(): ImageDisplayMode {
  const stored = readStoredImageDisplayModeOrNull();
  if (stored !== null) {
    return stored;
  }
  return fallbackMode ?? DEFAULT_IMAGE_DISPLAY_MODE;
}

function getServerSnapshot(): ImageDisplayMode {
  return DEFAULT_IMAGE_DISPLAY_MODE;
}

/**
 * Reactive browser-persisted image display mode.
 *
 * Uses `useSyncExternalStore` so the persisted `localStorage` preference is
 * read synchronously on hydration before any thread snapshot arrives — no
 * thumbnail flash occurs when `"icon"` or `"none"` is stored — and changes
 * stay in sync across tabs via the `storage` event.
 */
export function useImageDisplayMode(): readonly [
  ImageDisplayMode,
  (mode: ImageDisplayMode) => void,
] {
  const mode = useSyncExternalStore(
    subscribe,
    getClientSnapshot,
    getServerSnapshot,
  );

  const setMode = useCallback((next: ImageDisplayMode) => {
    fallbackMode = next;
    writeStoredImageDisplayMode(next);
    emitChange();
  }, []);

  return [mode, setMode] as const;
}
