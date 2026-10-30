"use client";

import Avatar from "@mui/material/Avatar";
import Box from "@mui/material/Box";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";

import { ThemeToggle } from "./theme-toggle";

/**
 * Conversation header. Labels the app as a local preview and keeps the
 * theme toggle available. Padding respects the top inset on notched and
 * rounded mobile viewports (the app runs under `viewport-fit: cover`).
 */
export function AppHeader() {
  return (
    <Box
      component="header"
      sx={{
        pt: `calc(env(safe-area-inset-top, 0px) + 8px)`,
        px: 2,
        pb: 1,
        bgcolor: "background.paper",
        borderBottom: 1,
        borderColor: "divider",
      }}
    >
      <Stack
        direction="row"
        spacing={1.5}
        sx={{ alignItems: "center", width: "100%", maxWidth: 860, mx: "auto" }}
      >
        <Avatar sx={{ bgcolor: "primary.main", width: 40, height: 40 }}>
          C
        </Avatar>
        <Box sx={{ minWidth: 0, flexGrow: 1 }}>
          <Typography variant="subtitle1" component="h1" noWrap>
            Companion
          </Typography>
          <Typography variant="caption" component="p" noWrap color="text.secondary">
            Local preview · fixture thread
          </Typography>
        </Box>
        <ThemeToggle />
      </Stack>
    </Box>
  );
}
