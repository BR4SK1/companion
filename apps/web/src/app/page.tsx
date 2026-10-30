import Box from "@mui/material/Box";

import { LiveThread } from "@/components/live-thread";
import { SignInView, UnavailableView } from "@/components/gate-views";
import { loadWebConfigSafe } from "@/lib/server/config";
import { nowSeconds } from "@/lib/server/respond";
import { SESSION_COOKIE_NAME, verifySessionToken } from "@/lib/server/session";
import { cookies } from "next/headers";

/**
 * The single continuous conversation, behind the BFF's owner-only edge.
 *
 * Server-rendered decision, fail-closed in both directions: without valid
 * BFF configuration the page renders a generic unavailability view rather
 * than any conversation surface, and without a verified session it renders
 * the sign-in view. Only a verified owner session reaches the live thread.
 * The `?auth=` query parameter (set by the sign-in flow on failure) toggles
 * the one generic retry notice; its value is never interpreted further.
 */
export const dynamic = "force-dynamic";

export default async function HomePage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const authNotice = typeof params.auth === "string" && params.auth.length > 0;

  const configResult = loadWebConfigSafe(process.env);
  if (!configResult.ok) {
    return <UnavailableView />;
  }
  const config = configResult.config;
  const session = verifySessionToken(
    (await cookies()).get(SESSION_COOKIE_NAME)?.value,
    config.sessionSecret,
    nowSeconds(),
  );
  if (session === null) {
    return <SignInView notice={authNotice} />;
  }
  return (
    <Box className="app-shell" sx={{ display: "flex", flexDirection: "column" }}>
      <LiveThread />
    </Box>
  );
}
