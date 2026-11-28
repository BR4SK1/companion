"use client";

import LogoutIcon from "@mui/icons-material/Logout";
import MenuIcon from "@mui/icons-material/Menu";
import Avatar from "@mui/material/Avatar";
import Box from "@mui/material/Box";
import Divider from "@mui/material/Divider";
import FormControl from "@mui/material/FormControl";
import IconButton from "@mui/material/IconButton";
import InputLabel from "@mui/material/InputLabel";
import List from "@mui/material/List";
import ListItemButton from "@mui/material/ListItemButton";
import ListItemIcon from "@mui/material/ListItemIcon";
import ListItemText from "@mui/material/ListItemText";
import MenuItem from "@mui/material/MenuItem";
import Popover from "@mui/material/Popover";
import Select from "@mui/material/Select";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import { useState, type MouseEvent } from "react";

import {
  parseImageDisplayMode,
  type ImageDisplayMode,
} from "@/lib/image-display";

import { ThemeToggle } from "./theme-toggle";

interface AppHeaderProps {
  /** Present when the viewer is signed in; renders the sign-out control. */
  readonly onSignOut?: () => void;
  /** Current client-side image display mode; shown in the menu when provided. */
  readonly imageDisplayMode?: ImageDisplayMode;
  /** Called when the viewer picks a new image display mode. */
  readonly onImageDisplayModeChange?: (mode: ImageDisplayMode) => void;
}

/**
 * Conversation header with a right-aligned menu for client display options
 * (images and theme) and, for a signed-in owner, sign-out. Padding respects
 * the top inset on notched and rounded mobile viewports (the app runs under
 * `viewport-fit: cover`).
 */
export function AppHeader({
  onSignOut,
  imageDisplayMode,
  onImageDisplayModeChange,
}: AppHeaderProps) {
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const menuOpen = menuAnchor !== null;
  const showImageDisplay =
    imageDisplayMode !== undefined && onImageDisplayModeChange !== undefined;

  const handleMenuOpen = (event: MouseEvent<HTMLButtonElement>) => {
    setMenuAnchor(event.currentTarget);
  };

  const handleMenuClose = () => {
    setMenuAnchor(null);
  };

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
        <IconButton
          color="inherit"
          edge="end"
          aria-label="Open menu"
          aria-haspopup="true"
          aria-expanded={menuOpen}
          aria-controls={menuOpen ? "app-header-menu" : undefined}
          onClick={handleMenuOpen}
        >
          <MenuIcon fontSize="small" />
        </IconButton>
        <Popover
          id="app-header-menu"
          open={menuOpen}
          anchorEl={menuAnchor}
          onClose={handleMenuClose}
          anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
          transformOrigin={{ vertical: "top", horizontal: "right" }}
          slotProps={{
            paper: {
              sx: {
                width: 240,
                mt: 0.5,
              },
            },
          }}
        >
          {showImageDisplay && (
            <>
              <Box sx={{ px: 2, py: 1.5 }}>
                <FormControl size="small" fullWidth>
                  <InputLabel id="image-display-select-label">Images</InputLabel>
                  <Select
                    labelId="image-display-select-label"
                    id="image-display-select"
                    label="Images"
                    value={imageDisplayMode}
                    onChange={(event) => {
                      onImageDisplayModeChange(
                        parseImageDisplayMode(event.target.value),
                      );
                    }}
                  >
                    <MenuItem value="image">Image</MenuItem>
                    <MenuItem value="icon">Icon</MenuItem>
                    <MenuItem value="none">None</MenuItem>
                  </Select>
                </FormControl>
              </Box>
              <Divider />
            </>
          )}
          <List dense disablePadding>
            <ThemeToggle />
            {onSignOut && (
              <>
                <Divider />
                <ListItemButton
                  onClick={() => {
                    handleMenuClose();
                    onSignOut();
                  }}
                  sx={{ px: 2, py: 1 }}
                >
                  <ListItemIcon sx={{ minWidth: 36 }}>
                    <LogoutIcon fontSize="small" />
                  </ListItemIcon>
                  <ListItemText primary="Sign out" />
                </ListItemButton>
              </>
            )}
          </List>
        </Popover>
      </Stack>
    </Box>
  );
}
