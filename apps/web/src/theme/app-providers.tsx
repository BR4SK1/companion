"use client";

import CssBaseline from "@mui/material/CssBaseline";
import { ThemeProvider, useColorScheme } from "@mui/material/styles";
import { useEffect } from "react";

import {
  COLOR_SCHEME_STORAGE_KEY,
  MODE_STORAGE_KEY,
  SCHEME_THEME_COLORS,
  theme,
} from "./theme";

/**
 * Keeps `<meta name="theme-color">` in sync with the *applied* scheme.
 *
 * The static viewport export renders media-scoped metas keyed to the OS
 * preference, which diverges from the page once the owner stores an explicit
 * light/dark choice. After mount this consolidates them into a single meta
 * that follows the applied scheme (including live OS changes while in
 * system mode). No-JS visitors keep the static media-scoped metas.
 */
function SchemeMetaColor() {
  const { mode, systemMode } = useColorScheme();
  const applied = mode === "system" ? systemMode : mode;

  useEffect(() => {
    if (applied !== "light" && applied !== "dark") {
      return;
    }
    const color = SCHEME_THEME_COLORS[applied];
    const metas = Array.from(
      document.head.querySelectorAll('meta[name="theme-color"]'),
    );
    const unscoped = metas.find((meta) => !meta.hasAttribute("media"));
    if (unscoped) {
      unscoped.setAttribute("content", color);
      return;
    }
    metas.forEach((meta) => meta.remove());
    const meta = document.createElement("meta");
    meta.name = "theme-color";
    meta.content = color;
    document.head.appendChild(meta);
  }, [applied]);

  return null;
}

/**
 * Client provider wrapper for the app.
 *
 * MUI's theme object contains functions, so it must be created inside the
 * client bundle — the server layout cannot pass it across the RSC boundary.
 * All scheme persistence options are pinned here so InitColorSchemeScript
 * (rendered by the server layout) and the provider agree on storage keys.
 */
export function AppProviders({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider
      theme={theme}
      defaultMode="system"
      modeStorageKey={MODE_STORAGE_KEY}
      colorSchemeStorageKey={COLOR_SCHEME_STORAGE_KEY}
    >
      <CssBaseline enableColorScheme />
      <SchemeMetaColor />
      {children}
    </ThemeProvider>
  );
}
