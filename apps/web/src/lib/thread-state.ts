/**
 * Client-side state logic for the live thread.
 *
 * The visible thread is one continuous conversation fed by bounded page
 * reads. The key correctness rules:
 *
 * - Merges are keyed by message id, never by a pure "newer than last seen"
 *   watermark. A reply's `seq` is assigned inside the worker's publication
 *   transaction but becomes visible only at commit, so a message observed
 *   earlier can carry a higher `seq` than a reply committed later; an
 *   id-keyed merge is immune to that ordering, while a watermark read would
 *   silently drop the late-committed reply.
 * - Continuity of the loaded range is verified by GAP detection, re-derived
 *   from the loaded messages themselves on every cycle: any run of allocated
 *   seqs between two loaded messages is a gap, and a page walk downward from
 *   the gap's top recovers whatever has committed inside it. Nothing is ever
 *   discarded on a timing assumption: a seq whose transaction has not
 *   committed yet and a seq burned by a rollback look identical at every
 *   single snapshot, so no client-side deadline can distinguish them. An
 *   unresolved gap therefore keeps its (bounded, per-cycle) share of probing
 *   forever; a burned seq's cost is one cheap page read per visit, never a
 *   missed message.
 */

import type { MessageRole } from "./messages";
import { isValidInstant } from "./time.ts";

/** One live message as delivered by the BFF thread pages. */
export interface ThreadMessage {
  readonly id: string;
  readonly seq: number;
  readonly role: MessageRole;
  readonly text: string;
  readonly sentAt: string;
}

/** Generic thread work status delivered alongside each page. */
export interface ThreadStatus {
  readonly queued: number;
  readonly generating: boolean;
  /**
   * Highest seq allocated (committed-visible, in-flight, or burned). The
   * gap-based reconciliation in this module derives gaps from the loaded
   * messages and does not require this field, but the allocation invariant
   * is what makes that reasoning sound, and `mayHaveEarlierHistory` uses it
   * to resolve the empty-page ambiguity at a history cursor.
   */
  readonly highestAllocatedSeq: number;
  /** Sanitized trailing-failure flag; carries no error detail. */
  readonly hasRecentFailure: boolean;
}

/** Paging bounds delivered with each page. */
export interface ThreadPage {
  /** Smallest seq in the page; null when the page is empty. */
  readonly oldestSeq: number | null;
  /** True when committed messages exist below this page. */
  readonly hasMore: boolean;
  /**
   * The messages delivered in this page (the same array the snapshot
   * carries at top level). The gap-walk stop rule needs the page's
   * fullness (`messages.length < THREAD_PAGE_SIZE`), which the wire
   * format's bare `oldestSeq`/`hasMore` bounds cannot express.
   */
  readonly messages: readonly ThreadMessage[];
}

/**
 * Fixed thread page size — the single source of truth for the BFF's page
 * bound (apps/web/src/app/api/thread/route.ts requests it from the worker)
 * and for the page-fullness check in gap walking. Change it only here.
 */
export const THREAD_PAGE_SIZE = 100;

/**
 * One run of allocated seqs between two loaded messages that the client has
 * not observed: the seqs strictly between `after` and `before`.
 */
export interface ThreadGap {
  /** Exclusive lower neighbor: a loaded message's seq. */
  readonly after: number;
  /** Exclusive upper neighbor: a loaded message's seq. */
  readonly before: number;
}

/**
 * Interior gaps of the loaded range, ascending.
 *
 * A gap is derived from the loaded messages themselves — two loaded seqs
 * more than one apart prove the seqs between them were allocated (a
 * sequence is drawn in increasing order, so drawing `before` drew
 * everything below it) but not loaded: committed-but-unfetched, in flight,
 * or burned. Detection is O(loaded messages) with no seq-by-seq scan, so
 * long history and burn storms cost nothing extra to detect.
 *
 * Seqs above the newest loaded message are intentionally NOT reported:
 * they are in flight or burned, and any of them that commits either lands
 * in the newest-page poll (while it is within the page window) or splits an
 * interior gap that later cycles detect — so the tail needs no probing and
 * no timing assumption. The input is defensively re-sorted; callers pass
 * the seq-ordered output of `mergeThreadMessages`.
 */
export function detectThreadGaps(
  messages: readonly ThreadMessage[],
): ThreadGap[] {
  const sorted = [...messages].sort((a, b) => a.seq - b.seq);
  const gaps: ThreadGap[] = [];
  let previous: ThreadMessage | undefined;
  for (const message of sorted) {
    if (previous !== undefined) {
      const after = previous.seq;
      const before = message.seq;
      if (before - after > 1) {
        gaps.push({ after, before });
      }
    }
    previous = message;
  }
  return gaps;
}

/**
 * What one fetched page tells a gap walk. Walking continues downward (to
 * the cursor the page bottomed out at) only while the page was full and
 * still ended above the gap's lower neighbor — meaning more committed
 * messages may exist below inside the gap. Walking stops when the page
 * reached the lower neighbor (the gap is fully loaded), when the page was
 * not full (everything committed below the cursor is now loaded, so the
 * rest of the gap is in flight or burned), or when the page was empty.
 * Both stop cases resolve the WALK, not the gap: gap detection re-derives
 * from the loaded seqs every cycle, so a seq that commits later re-creates
 * a — smaller — gap and is probed again. No timing assumption anywhere.
 */
export type GapWalkStep =
  | { readonly kind: "continue"; readonly cursor: number }
  | { readonly kind: "stop" };

export function nextGapWalkStep(
  page: ThreadPage,
  gap: ThreadGap,
): GapWalkStep {
  if (
    page.oldestSeq === null ||
    page.oldestSeq <= gap.after ||
    page.messages.length < THREAD_PAGE_SIZE
  ) {
    return { kind: "stop" };
  }
  return { kind: "continue", cursor: page.oldestSeq };
}

/**
 * Whether older history may still exist below a fetched page — the rule
 * that decides whether the "load earlier" control stays visible and whether
 * a history walk continues.
 *
 * The worker's `hasMore` covers committed messages only. Because allocation
 * is contiguous from 1, seqs below a committed seq were all drawn, so when
 * a non-empty page bottoms out above seq 1 with `hasMore` false, the seqs
 * below it are drawn-but-uncommitted (in flight or burned) and may still
 * become visible: ambiguity, and therefore the control, survives until the
 * walk demonstrably reaches seq 1. For an empty page the requested cursor
 * and the allocation bound are the only signal: nothing below the cursor
 * was ever drawn only if `highestAllocatedSeq` stops short of it.
 */
export function mayHaveEarlierHistory(
  page: ThreadPage,
  highestAllocatedSeq: number,
  requestedBefore?: number,
): boolean {
  if (page.hasMore) {
    return true;
  }
  if (page.oldestSeq !== null) {
    return page.oldestSeq > 1;
  }
  if (requestedBefore === undefined) {
    return false;
  }
  return requestedBefore >= 2 && highestAllocatedSeq >= requestedBefore - 1;
}

/**
 * Merge two snapshots into one ordered thread: keyed by message id (the
 * incoming snapshot wins, since it is newer server truth), result ordered
 * by `seq`. Duplicates collapse; no message is dropped or reordered by
 * arrival time.
 */
export function mergeThreadMessages(
  previous: readonly ThreadMessage[],
  incoming: readonly ThreadMessage[],
): ThreadMessage[] {
  const byId = new Map<string, ThreadMessage>();
  for (const message of previous) {
    byId.set(message.id, message);
  }
  for (const message of incoming) {
    byId.set(message.id, message);
  }
  return [...byId.values()].sort((a, b) => a.seq - b.seq || (a.id < b.id ? -1 : 1));
}

/**
 * One locally composed message working its way to durable acceptance:
 * in flight while the POST runs, confirmed once the worker has accepted it
 * (retained until the durable thread snapshot reflects it), or failed.
 * The client key is stable for the lifetime of the entry so retries stay
 * idempotent.
 */
export interface PendingSend {
  /** Stable idempotency key for this composed message. */
  readonly clientKey: string;
  readonly text: string;
  /** When the message was composed (ISO 8601). */
  readonly sentAt: string;
  readonly kind: "in_flight" | "confirmed" | "failed";
  /** Set once the worker has accepted the message. */
  readonly serverId?: string;
  /**
   * True when the failure was a conflicting key reuse: the key is bound to
   * different content server-side, so the next retry must use a fresh key.
   */
  readonly needsNewKey: boolean;
}

/**
 * A fresh idempotency key for one composed message. Uses the platform
 * UUID where available and falls back to random hex of the same shape;
 * both satisfy the worker's client-key contract.
 */
export function createClientKey(random: () => number = Math.random): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  let key = "";
  while (key.length < 32) {
    key += Math.floor(random() * 0xffffffff).toString(16).padStart(8, "0");
  }
  return key.slice(0, 32);
}

/**
 * Validate one thread-snapshot response from the BFF. The shape is the
 * BFF's own contract, so this is crash-proofing rather than security:
 * anything malformed yields null and the caller keeps the last good state.
 */
export function parseThreadSnapshotResponse(
  raw: unknown,
): {
  messages: readonly ThreadMessage[];
  status: ThreadStatus;
  page: ThreadPage;
  timezone: string | null;
} | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  const rawMessages = record.messages;
  const timezone = record.timezone;
  const rawStatus = record.status;
  const rawPage = record.page;
  if (
    !Array.isArray(rawMessages) ||
    !(timezone === null || (typeof timezone === "string" && timezone.length > 0)) ||
    typeof rawStatus !== "object" ||
    rawStatus === null ||
    typeof rawPage !== "object" ||
    rawPage === null
  ) {
    return null;
  }
  const statusRecord = rawStatus as Record<string, unknown>;
  const pageRecord = rawPage as Record<string, unknown>;
  const { queued, generating, highestAllocatedSeq, hasRecentFailure } =
    statusRecord;
  const { oldestSeq, hasMore } = pageRecord;
  if (
    typeof queued !== "number" ||
    !Number.isInteger(queued) ||
    queued < 0 ||
    typeof generating !== "boolean" ||
    typeof highestAllocatedSeq !== "number" ||
    !Number.isInteger(highestAllocatedSeq) ||
    highestAllocatedSeq < 0 ||
    typeof hasRecentFailure !== "boolean" ||
    (oldestSeq !== null &&
      (typeof oldestSeq !== "number" ||
        !Number.isInteger(oldestSeq) ||
        oldestSeq < 1)) ||
    typeof hasMore !== "boolean"
  ) {
    return null;
  }
  const messages: ThreadMessage[] = [];
  for (const entry of rawMessages) {
    if (typeof entry !== "object" || entry === null) {
      return null;
    }
    const message = entry as Record<string, unknown>;
    const { id, seq, role, text, sentAt } = message;
    if (
      typeof id !== "string" ||
      id.length === 0 ||
      typeof seq !== "number" ||
      !Number.isInteger(seq) ||
      seq < 1 ||
      (role !== "user" && role !== "assistant") ||
      typeof text !== "string" ||
      typeof sentAt !== "string" ||
      !isValidInstant(sentAt)
    ) {
      return null;
    }
    messages.push({ id, seq, role, text, sentAt });
  }
  return {
    messages,
    status: { queued, generating, highestAllocatedSeq, hasRecentFailure },
    page: { oldestSeq, hasMore, messages },
    timezone,
  };
}

export function appendPending(
  pending: readonly PendingSend[],
  entry: PendingSend,
): PendingSend[] {
  return [...pending, entry];
}

export function updatePending(
  pending: readonly PendingSend[],
  clientKey: string,
  update: (entry: PendingSend) => PendingSend,
): PendingSend[] {
  return pending.map((entry) =>
    entry.clientKey === clientKey ? update(entry) : entry,
  );
}

export function removePending(
  pending: readonly PendingSend[],
  clientKey: string,
): PendingSend[] {
  return pending.filter((entry) => entry.clientKey !== clientKey);
}

/**
 * Drop pending entries whose durable counterpart has arrived in a thread
 * snapshot, keyed by the server message id captured at acceptance.
 */
export function dropConfirmedPending(
  pending: readonly PendingSend[],
  threadMessages: readonly ThreadMessage[],
): PendingSend[] {
  const knownIds = new Set(threadMessages.map((message) => message.id));
  return pending.filter(
    (entry) => entry.serverId === undefined || !knownIds.has(entry.serverId),
  );
}
