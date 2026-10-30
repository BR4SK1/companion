/**
 * Pure grouping logic for the visible thread.
 *
 * The visible thread stays one continuous conversation: clusters and time
 * dividers are presentation-level render units, not separate threads or
 * exposed processing segments (apps/web/AGENTS.md).
 */

import { isDifferentUtcDay } from "./time.ts";
import type { Message, MessageCluster, ThreadItem } from "./messages";

/** Consecutive messages from the same role within this window group into one cluster. */
export const CLUSTER_GAP_MINUTES = 5;

const MINUTE_MS = 60_000;

function parseIso(value: string): number {
  const time = Date.parse(value);
  if (Number.isNaN(time)) {
    throw new Error(`Invalid ISO timestamp: ${value}`);
  }
  return time;
}

/**
 * Split a flat message list into render units: consecutive same-role messages
 * cluster together unless a large time gap separates them; a UTC day change
 * additionally emits a {@link TimeDivider} and starts a new cluster (for
 * either role). Divider labels are then unique per calendar day, so the
 * thread never shows two identical full-date dividers.
 *
 * Message order is preserved and no message is dropped or reordered.
 */
export function groupThread(messages: readonly Message[]): ThreadItem[] {
  const items: ThreadItem[] = [];
  let cluster: Message[] | undefined;
  let previous: Message | undefined;
  let previousAt = 0;

  for (const message of messages) {
    // Parsed unconditionally so malformed fixture input is rejected up front
    // instead of rendering "Invalid Date" labels.
    const at = parseIso(message.sentAt);
    const gap = previous ? (at - previousAt) / MINUTE_MS : 0;

    if (previous && isDifferentUtcDay(previous.sentAt, message.sentAt)) {
      items.push({ kind: "divider", at: message.sentAt });
      cluster = undefined;
    }

    if (cluster && cluster[0].role === message.role && gap <= CLUSTER_GAP_MINUTES) {
      cluster.push(message);
    } else {
      cluster = [message];
      items.push({
        kind: "cluster",
        role: message.role,
        messages: cluster,
      } satisfies MessageCluster);
    }

    previous = message;
    previousAt = at;
  }

  return items;
}
