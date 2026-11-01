"use client";

import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Typography from "@mui/material/Typography";

import { AppHeader } from "@/components/app-header";

/**
 * Signed-out landing view: owner sign-in through the BFF's OIDC flow.
 * The failure notice is deliberately generic — it never distinguishes a
 * denied subject from any other sign-in problem.
 */
export function SignInView({ notice }: { readonly notice: boolean }) {
  return (
    <Box sx={{ display: "flex", flexDirection: "column", flexGrow: 1 }}>
      <AppHeader />
      <Box
        sx={{
          flexGrow: 1,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 2,
          px: 3,
          textAlign: "center",
        }}
      >
        <Typography variant="subtitle1">Companion is private.</Typography>
        <Typography variant="body2" color="text.secondary" sx={{ maxWidth: 340 }}>
          Sign in with your account to continue the conversation.
        </Typography>
        {notice && (
          <Typography variant="caption" color="error">
            Sign-in did not complete. You can try again.
          </Typography>
        )}
        <Button variant="contained" href="/api/auth/login">
          Sign in
        </Button>
      </Box>
    </Box>
  );
}

/**
 * Fail-closed surface for a misconfigured or unreachable backend. It
 * renders instead of any conversation content and reveals nothing about
 * what is missing.
 */
export function UnavailableView() {
  return (
    <Box sx={{ display: "flex", flexDirection: "column", flexGrow: 1 }}>
      <AppHeader />
      <Box
        sx={{
          flexGrow: 1,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 2,
          px: 3,
          textAlign: "center",
        }}
      >
        <Typography variant="subtitle1">Temporarily unavailable</Typography>
        <Typography variant="body2" color="text.secondary" sx={{ maxWidth: 340 }}>
          The service is not available right now. Please try again later.
        </Typography>
      </Box>
    </Box>
  );
}
