/**
 * Ids for locally composed preview messages.
 *
 * A module-scoped monotonic counter keeps ids unique even when several
 * messages are composed within the same millisecond (fast typing, Enter
 * repeat). The timestamp segment keeps ids readable and roughly sortable.
 */

let sequence = 0;

export function nextLocalMessageId(now: () => number = Date.now): string {
  sequence += 1;
  return `local-${now()}-${sequence}`;
}
