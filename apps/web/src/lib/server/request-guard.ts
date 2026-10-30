/**
 * State-changing request guard: same-origin verification.
 *
 * Defense in depth against cross-site request forgery on the BFF's
 * state-changing endpoints, on top of SameSite=Lax session cookies: a
 * modifiable request must carry an `Origin` header whose origin equals the
 * configured public origin of this app. Cross-site attackers cannot forge
 * that header from a browser, and requests without one are rejected rather
 * than given the benefit of the doubt.
 *
 * Pure and framework-free so the rule is directly unit-testable.
 */

function originOf(value: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  return parsed.origin;
}

/**
 * True when the request may modify state: it presents an `Origin` header
 * matching the app's public origin (case-normalized through URL parsing).
 */
export function isSameOriginRequest(
  originHeader: string | null | undefined,
  publicOrigin: string,
): boolean {
  if (originHeader === null || originHeader === undefined || originHeader.length === 0) {
    return false;
  }
  const requestOrigin = originOf(originHeader);
  if (requestOrigin === null) {
    return false;
  }
  return requestOrigin === originOf(publicOrigin);
}
