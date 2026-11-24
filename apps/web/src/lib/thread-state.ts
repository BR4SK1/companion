/** Client thread pages and optimistic send state. */
import type { MessageRole } from "./messages";
import { isValidInstant } from "./time.ts";

/** One inline image as delivered by the BFF (served from `/api/images/<id>`). */
export interface ThreadMessageImage {
  readonly src: string;
  readonly alt: string;
  readonly width: number;
  readonly height: number;
}

/** One live message as delivered by the BFF thread pages. */
export interface ThreadMessage {
  readonly id: string;
  readonly seq: number;
  readonly role: MessageRole;
  readonly text: string;
  readonly sentAt: string;
  readonly images?: readonly ThreadMessageImage[];
}

/** Generic thread work status delivered alongside each page. */
export interface ThreadStatus {
  readonly queued: number;
  readonly generating: boolean;
  /** Allocation metadata retained for wire compatibility. */
  readonly highestAllocatedSeq: number;
  /** Sanitized trailing-failure flag; carries no error detail. */
  readonly hasRecentFailure: boolean;
  readonly retryAttemptId?: string;
}

/** Paging bounds delivered with each page. */
export interface ThreadPage {
  /** Smallest seq in the page; null when the page is empty. */
  readonly oldestSeq: number | null;
  /** True when more committed messages exist in the requested direction. */
  readonly hasMore: boolean;
  /** Messages in this page. */
  readonly messages: readonly ThreadMessage[];
}

/** BFF page bound in either direction. */
export const THREAD_PAGE_SIZE = 100;

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
    let images: ThreadMessageImage[] | undefined;
    if (message.images !== undefined) {
      if (!Array.isArray(message.images)) return null;
      images = [];
      for (const imageEntry of message.images) {
        if (typeof imageEntry !== "object" || imageEntry === null) return null;
        const image = imageEntry as Record<string, unknown>;
        const { src, alt, width, height } = image;
        if (
          typeof src !== "string" ||
          !src.startsWith("/api/images/") ||
          typeof alt !== "string" ||
          typeof width !== "number" ||
          !Number.isInteger(width) ||
          width < 1 ||
          typeof height !== "number" ||
          !Number.isInteger(height) ||
          height < 1
        ) {
          return null;
        }
        images.push({ src, alt, width, height });
      }
    }
    messages.push({
      id,
      seq,
      role,
      text,
      sentAt,
      ...(images !== undefined && images.length > 0 ? { images } : {}),
    });
  }
  return {
    messages,
    status: { queued, generating, highestAllocatedSeq, hasRecentFailure,
      ...(typeof statusRecord.retryAttemptId === "string" ? { retryAttemptId: statusRecord.retryAttemptId } : {}),
    },
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
