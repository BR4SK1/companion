/**
 * Decide whether an unauthenticated owner-channel visit should start OIDC
 * automatically. Auth-flow error pages deliberately remain available so
 * provider/callback failures do not immediately restart the same flow.
 */
export function shouldAutoRedirectToLogin(
  hasValidSession: boolean,
  hasAuthNotice: boolean,
): boolean {
  return !hasValidSession && !hasAuthNotice;
}
