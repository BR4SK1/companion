/**
 * Owner-only authorization decision for the BFF edge.
 *
 * The product is single-owner: the caller is authorized only when the
 * identity-provider subject of an authenticated session is on the explicit
 * allowlist. The decision happens here, at the web BFF, and is decoupled
 * from domain identity — the subject never becomes a domain identifier and
 * is never forwarded to the worker or persisted in domain records
 * (apps/web/AGENTS.md).
 *
 * The allowlist is fail-closed: an empty list denies every subject.
 */

export function isOwnerSubject(
  subject: string | undefined,
  allowlist: readonly string[],
): boolean {
  if (subject === undefined || subject.length === 0) {
    return false;
  }
  return allowlist.includes(subject);
}
