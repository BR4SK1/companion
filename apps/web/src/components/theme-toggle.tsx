"use client";

import DarkModeIcon from "@mui/icons-material/DarkMode";
import LightModeIcon from "@mui/icons-material/LightMode";
import IconButton from "@mui/material/IconButton";
import { useColorScheme } from "@mui/material/styles";

/**
 * Light/dark toggle for the preview.
 *
 * The correct icon is picked pre-hydration by CSS rules on the html color
 * scheme attribute (see app/globals.css), so there is no hydration mismatch
 * and no flash of the wrong icon. The first press stores an explicit
 * light or dark choice; until then the OS preference is followed.
 */
export function ThemeToggle() {
  const { mode, setMode, systemMode } = useColorScheme();

  const applied = mode === "system" ? systemMode : mode;

  const handleClick = () => {
    setMode(applied === "dark" ? "light" : "dark");
  };

  return (
    <IconButton
      color="inherit"
      aria-label="Toggle dark mode"
      onClick={handleClick}
      edge="end"
    >
      <LightModeIcon className="theme-icon-light" fontSize="small" />
      <DarkModeIcon className="theme-icon-dark" fontSize="small" />
    </IconButton>
  );
}
