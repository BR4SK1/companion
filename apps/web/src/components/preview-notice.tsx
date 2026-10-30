"use client";

import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";

/**
 * Persistent one-line disclosure that this screen is a local, fixture-backed
 * preview: no backend, no authentication, nothing sent or saved. It must
 * stay visible so the fixture conversation is never mistaken for live chat.
 */
export function PreviewNotice() {
  return (
    <Box
      role="note"
      aria-label="Preview notice"
      sx={{
        px: 2,
        py: 0.75,
        bgcolor: "action.selected",
        borderBottom: 1,
        borderColor: "divider",
      }}
    >
      <Typography variant="caption" color="text.secondary">
        Local preview — static fixture data. Messages are not sent or saved.
      </Typography>
    </Box>
  );
}
