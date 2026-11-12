import Box from "@mui/material/Box";

import { LiveThread } from "@/components/live-thread";
import { SignInView, UnavailableView } from "@/components/gate-views";
import { loadWebConfigSafe } from "@/lib/server/config";
import { shouldAutoRedirectToLogin } from "@/lib/server/home-page-auth";
import { nowSeconds } from "@/lib/server/respond";
import {
  resolveRequestChannel,
  TEST_ATTESTATION_HEADER,
} from "@/lib/server/test-gate";
import { SESSION_COOKIE_NAME, TEST_SESSION_COOKIE_NAME, verifySessionToken, verifyTestSessionToken } from "@/lib/server/session";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";

/**
 * The single continuous conversation, behind the BFF's owner-only edge.
 *
 * Server-rendered decision, fail-closed in both directions: without valid
 * BFF configuration the page renders a generic unavailability view rather
 * than any conversation surface. An unauthenticated owner-channel visit
 * starts the existing OIDC sign-in flow automatically; auth-flow failure
 * notices keep the generic retry view visible rather than restarting login.
 * Only a verified owner session reaches the live thread. The `?auth=` query
 * parameter's value is never interpreted beyond whether it is present.
 *
 * Non-production-only test channel: when the request is attested by the
 * loopback test listener (`TEST_ATTESTATION_HEADER` carrying the
 * process-random token that only that listener injects) and the gate is
 * configured, the page verifies the separate identity-free test session
 * instead of an owner session; without one it redirects to the gate's
 * issuance endpoint. The main channel's behavior is unchanged.
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

  const requestHeaders = await headers();
  const requestCookies = await cookies();
  const channel = resolveRequestChannel(
    config,
    requestHeaders.get(TEST_ATTESTATION_HEADER),
  );
  if (channel === "test") {
    if (config.testGate === null) {
      // Defense in depth: an attested request implies the gate is
      // configured; refuse rather than guess.
      return <UnavailableView />;
    }
    const testSession = verifyTestSessionToken(
      requestCookies.get(TEST_SESSION_COOKIE_NAME)?.value,
      config.testGate.sessionSecret,
      nowSeconds(),
    );
    if (testSession === null) {
      redirect("/api/test-gate/session");
    }
    return (
      <Box className="app-shell" sx={{ display: "flex", flexDirection: "column" }}>
        <LiveThread />
      </Box>
    );
  }

  const session = verifySessionToken(
    requestCookies.get(SESSION_COOKIE_NAME)?.value,
    config.sessionSecret,
    nowSeconds(),
  );
  if (shouldAutoRedirectToLogin(session !== null, authNotice)) {
    redirect("/api/auth/login");
  }
  if (session === null) {
    return <SignInView notice={authNotice} />;
  }
  return (
    <Box className="app-shell" sx={{ display: "flex", flexDirection: "column" }}>
      <LiveThread />
    </Box>
  );
}
