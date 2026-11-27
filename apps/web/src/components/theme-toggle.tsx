"use client";

import DarkModeIcon from "@mui/icons-material/DarkMode";
import LightModeIcon from "@mui/icons-material/LightMode";
import ListItemButton from "@mui/material/ListItemButton";
import ListItemIcon from "@mui/material/ListItemIcon";
import ListItemText from "@mui/material/ListItemText";
import Switch from "@mui/material/Switch";
import { useColorScheme } from "@mui/material/styles";

/**
 * Light/dark toggle row for the header menu.
 *
 * The first press stores an explicit light or dark choice; until then the OS
 * preference is followed.
 */
export function ThemeToggle() {
  const { mode, setMode, systemMode } = useColorScheme();

  const applied = mode === "system" ? systemMode : mode;
  const isDark = applied === "dark";

  const handleClick = () => {
    setMode(isDark ? "light" : "dark");
  };

  return (
    <ListItemButton
      role="switch"
      aria-checked={isDark}
      onClick={handleClick}
      sx={{ px: 2, py: 1 }}
    >
      <ListItemIcon sx={{ minWidth: 36 }}>
        <LightModeIcon className="theme-icon-light" fontSize="small" />
        <DarkModeIcon className="theme-icon-dark" fontSize="small" />
      </ListItemIcon>
      <ListItemText primary="Dark mode" />
      <Switch
        size="small"
        edge="end"
        checked={isDark}
        onChange={() => {}}
        tabIndex={-1}
        slotProps={{ input: { "aria-hidden": true, tabIndex: -1 } }}
        sx={{ pointerEvents: "none" }}
      />
    </ListItemButton>
  );
}
