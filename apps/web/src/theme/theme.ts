/**
 * Preview theme: one MUI theme with light and dark color schemes.
 *
 * The applied scheme is resolved before hydration by InitColorSchemeScript
 * (see app/layout.tsx) and persisted to localStorage under the keys defined
 * there. The default is the operating-system preference; an explicit toggle
 * stores light or dark. CSS variables keep both schemes renderable at SSR
 * time so there is no flash and no hydration mismatch.
 */

import { createTheme } from "@mui/material/styles";

/** localStorage key for the persisted mode ("light" | "dark" | "system"). */
export const MODE_STORAGE_KEY = "companion.mode";
/** localStorage key for the resolved color scheme, used by MUI's script. */
export const COLOR_SCHEME_STORAGE_KEY = "companion.color-scheme";

/**
 * Browser-chrome (theme-color) tint per applied scheme. Shared by the static
 * `viewport` export and the client effect that keeps the meta in sync once a
 * persisted choice diverges from the OS preference.
 */
export const SCHEME_THEME_COLORS = {
  light: "#f4f3f9",
  dark: "#121218",
} as const;

const systemFontStack = [
  "system-ui",
  "-apple-system",
  "Segoe UI",
  "Roboto",
  "Helvetica Neue",
  "Arial",
  "sans-serif",
].join(", ");

export const theme = createTheme({
  cssVariables: {
    // Scope the generated CSS variables to the exact attribute that
    // InitColorSchemeScript sets before first paint
    // (`<html data-mui-color-scheme="dark">`). With the default 'media'
    // selector, MUI would key dark styles to the OS preference only and the
    // persisted light/dark choice would not apply. The bare 'data' value
    // generates a valueless attribute (`[data-dark]`), which does not match
    // the script — the full attribute name is required.
    colorSchemeSelector: "data-mui-color-scheme",
  },
  colorSchemes: {
    light: {
      palette: {
        primary: { main: "#5b4bc4" },
        background: { default: "#f4f3f9", paper: "#ffffff" },
        divider: "rgba(43, 38, 76, 0.16)",
      },
    },
    dark: {
      palette: {
        primary: { main: "#a493f5" },
        background: { default: "#121218", paper: "#1b1b23" },
        divider: "rgba(233, 231, 245, 0.14)",
      },
    },
  },
  typography: {
    fontFamily: systemFontStack,
  },
  shape: {
    borderRadius: 12,
  },
});
