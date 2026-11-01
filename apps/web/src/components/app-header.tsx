"use client";

import Avatar from "@mui/material/Avatar";
import Box from "@mui/material/Box";
import IconButton from "@mui/material/IconButton";
import LogoutIcon from "@mui/icons-material/Logout";
import Stack from "@mui/material/Stack";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";

import { ThemeToggle } from "./theme-toggle";

interface AppHeaderProps {
  /** Present when the viewer is signed in; renders the sign-out control. */
  readonly onSignOut?: () => void;
}

/**
 * Conversation header. Keeps the theme toggle available and, for a signed
 * in owner, the sign-out control. Padding respects the top inset on
 * notched and rounded mobile viewports (the app runs under
 * `viewport-fit: cover`).
 */
export function AppHeader({ onSignOut }: AppHeaderProps) {
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
            Private conversation
          </Typography>
        </Box>
        {onSignOut && (
          <Tooltip title="Sign out">
            <IconButton
              aria-label="Sign out"
              onClick={onSignOut}
              size="small"
              sx={{ mr: 1 }}
            >
              <LogoutIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        )}
        <ThemeToggle />
      </Stack>
    </Box>
  );
}
