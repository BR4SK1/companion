/**
 * Photo-worthiness gate (pure). A published turn earns an image only when
 * the turn was a photo-worthy kind of exchange: its selected response
 * pattern is in the operator-configured list, the user explicitly asked for
 * a picture, or (after reconciliation) a roleplay scene is active. Rendering
 * is the expensive GPU step, so everything else is skipped durably.
 */

const EXPLICIT_PHOTO_REQUEST =
  /\b(photo|picture|pic|selfie|snapshot|snap)\b/i;

export function hasExplicitPhotoRequest(userText: string): boolean {
  return EXPLICIT_PHOTO_REQUEST.test(userText);
}

export function isPhotoWorthy(input: {
  readonly patternId: string | null;
  readonly userText: string;
  readonly patternIds: readonly string[];
  /** Reconciled scene state, when reconciliation already ran. */
  readonly roleplayInScene?: boolean;
}): boolean {
  if (input.patternId !== null && input.patternIds.includes(input.patternId)) {
    return true;
  }
  if (hasExplicitPhotoRequest(input.userText)) return true;
  if (input.roleplayInScene === true) return true;
  return false;
}
