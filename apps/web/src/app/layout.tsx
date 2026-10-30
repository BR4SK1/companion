import type { Metadata, Viewport } from "next";

import { AppRouterCacheProvider } from "@mui/material-nextjs/v16-appRouter";
import { InitColorSchemeScript } from "@mui/material";

import { AppProviders } from "@/theme/app-providers";
import {
  COLOR_SCHEME_STORAGE_KEY,
  MODE_STORAGE_KEY,
  SCHEME_THEME_COLORS,
} from "@/theme/theme";

import "./globals.css";

export const metadata: Metadata = {
  title: "Companion — local preview",
  description:
    "Local-only fixture-backed preview of the Companion messenger client. No backend, no authentication, nothing is sent or saved.",
  // A local preview is not meant to be indexed or shared as a page.
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // Let the layout extend under rounded corners and the home indicator.
  viewportFit: "cover",
  themeColor: [
    {
      media: "(prefers-color-scheme: light)",
      color: SCHEME_THEME_COLORS.light,
    },
    {
      media: "(prefers-color-scheme: dark)",
      color: SCHEME_THEME_COLORS.dark,
    },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>
        {/* Resolves light/dark before first paint; must share the provider's
            storage keys so the pre-hydration scheme matches the theme. */}
        <InitColorSchemeScript
          defaultMode="system"
          modeStorageKey={MODE_STORAGE_KEY}
          colorSchemeStorageKey={COLOR_SCHEME_STORAGE_KEY}
        />
        <AppRouterCacheProvider options={{ key: "mui" }}>
          <AppProviders>{children}</AppProviders>
        </AppRouterCacheProvider>
      </body>
    </html>
  );
}
