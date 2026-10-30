/**
 * Pure scroll-anchoring helpers for the thread viewport.
 *
 * Goal: never pull the owner away from older messages. The list auto-scrolls
 * to the newest message only when the reader is already at (or near) the
 * bottom; otherwise the viewport stays put and a "jump to latest" affordance
 * appears. Keeping the logic pure makes it unit-testable without a browser.
 * (Thread itself pins to `scrollTop = scrollHeight` when following, so no
 * append-position helper is needed.)
 */

export interface ScrollGeometry {
  readonly scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
}

/** Distance in pixels between the bottom edge of the viewport and the content end. */
export function distanceFromBottom(geometry: ScrollGeometry): number {
  const { scrollTop, scrollHeight, clientHeight } = geometry;
  if (scrollHeight <= 0 || clientHeight <= 0) {
    return 0;
  }
  return Math.max(0, scrollHeight - clientHeight - scrollTop);
}

/**
 * True when the viewport is close enough to the bottom that appending a
 * message should keep the newest content in view.
 */
export function isFollowingBottom(
  geometry: ScrollGeometry,
  thresholdPx = 96,
): boolean {
  return distanceFromBottom(geometry) <= thresholdPx;
}
