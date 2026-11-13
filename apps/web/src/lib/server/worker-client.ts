/**
 * Server-side client for the worker's private HTTP API.
 *
 * The BFF authenticates to the worker with the shared service-to-service
 * bearer token. Nothing about the browser session or its identity crosses
 * this boundary: no identity-provider subjects, session references, or user
 * identifiers are forwarded — the worker's domain is single-owner and
 * identity-free (apps/web/AGENTS.md).
 *
 * Error mapping is sanitized by construction: this module never forwards
 * worker response bodies, headers, or error text to callers. It collapses
 * every failure into a small set of kinds the BFF can map to generic client
 * responses; details are left for server-side logging at the call site.
 *
 * All worker response shapes are validated before use; anything malformed
 * is treated as an unavailable upstream rather than trusted.
 */

import { isValidInstant, isValidTimezone } from "../time.ts";

export interface WorkerMessage {
  readonly id: string;
  readonly seq: number;
  readonly role: "user" | "assistant";
  readonly content: string;
  readonly createdAt: string;
}

export interface ThreadSnapshot {
  /** Authoritative worker timezone, null only while unconfigured. */
  readonly timezone: string | null;
  readonly messages: readonly WorkerMessage[];
  readonly queued: number;
  readonly generating: boolean;
  /**
   * Highest seq the worker has allocated (committed-visible, in-flight, or
   * burned). The BFF's client uses it to detect holes in loaded history;
   * see apps/web/src/lib/thread-state.ts.
   */
  readonly highestAllocatedSeq: number;
  /** Sanitized trailing-failure flag; no error detail is ever attached. */
  readonly hasRecentFailure: boolean;
  readonly page: {
    readonly oldestSeq: number | null;
    readonly hasMore: boolean;
  };
}

export type SendMessageResult =
  | { readonly ok: true; readonly message: WorkerMessage }
  | {
      readonly ok: false;
      readonly kind: "conflict" | "unavailable" | "bad_request";
    };

export type GetThreadResult =
  | { readonly ok: true; readonly snapshot: ThreadSnapshot }
  | { readonly ok: false; readonly kind: "unavailable" | "bad_request" };

export interface WorkerEngagement {
  readonly state: "engaged" | "lull" | "idle" | "gone" | null;
  readonly lastUserMessageId: string | null;
  readonly lastUserEffectiveAt: string | null;
  readonly silenceMs: number | null;
}

export type GetEngagementResult =
  | { readonly ok: true; readonly engagement: WorkerEngagement }
  | { readonly ok: false; readonly kind: "unavailable" };

export interface WorkerClient {
  readonly sendMessage: (
    text: string,
    clientKey: string,
    clientSentAt?: number | string,
  ) => Promise<SendMessageResult>;
  /**
   * One bounded page of the thread. `before` is the exclusive seq upper
   * bound of a history page; omit it for the newest page.
   */
  readonly getThread: (
    limit: number,
    before?: number,
  ) => Promise<GetThreadResult>;
  /**
   * Engagement-domain summary: the current band recomputed from the last
   * user message (the last-activity anchor) and the deployment's configured
   * cutoffs, floored by that message's own recorded assessment.
   */
  readonly getEngagement: () => Promise<GetEngagementResult>;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface WorkerClientDeps {
  readonly baseUrl: string;
  readonly token: string;
  readonly timeoutMs: number;
  /** Injectable for tests; defaults to the runtime's fetch. */
  readonly fetchImpl?: FetchLike;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseWorkerMessage(value: unknown): WorkerMessage | null {
  if (!isRecord(value)) {
    return null;
  }
  const { id, seq, role, content, createdAt } = value;
  if (
    typeof id !== "string" ||
    id.length === 0 ||
    typeof seq !== "number" ||
    !Number.isInteger(seq) ||
    seq < 1 ||
    (role !== "user" && role !== "assistant") ||
    typeof content !== "string" ||
    typeof createdAt !== "string" ||
    !isValidInstant(createdAt)
  ) {
    return null;
  }
  return { id, seq, role, content, createdAt };
}

function parseThreadSnapshot(value: unknown): ThreadSnapshot | null {
  if (!isRecord(value)) {
    return null;
  }
  const rawMessages = value.messages;
  // Older workers predate timezone propagation. At this trusted BFF boundary,
  // absence is the explicit unconfigured state; a present malformed value is
  // still rejected below.
  const timezone = value.timezone === undefined ? null : value.timezone;
  const status = value.status;
  const page = value.page;
  if (
    !Array.isArray(rawMessages) ||
    !(timezone === null || (typeof timezone === "string" && isValidTimezone(timezone))) ||
    !isRecord(status) ||
    !isRecord(page)
  ) {
    return null;
  }
  const { queued, generating, highestAllocatedSeq, hasRecentFailure } = status;
  const { oldestSeq, hasMore } = page;
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
  const messages: WorkerMessage[] = [];
  for (const entry of rawMessages) {
    const message = parseWorkerMessage(entry);
    if (message === null) {
      return null;
    }
    messages.push(message);
  }
  return {
    timezone,
    messages,
    queued,
    generating,
    highestAllocatedSeq,
    hasRecentFailure,
    page: { oldestSeq, hasMore },
  };
}

/**
 * Create the worker client. Requests carry only the bearer token; failures
 * (network, timeout, unexpected status) collapse into sanitized kinds.
 */
export function createWorkerClient(deps: WorkerClientDeps): WorkerClient {
  const fetchImpl: FetchLike = deps.fetchImpl ?? fetch;

  async function request(
    path: string,
    init: RequestInit,
  ): Promise<Response | null> {
    try {
      return await fetchImpl(`${deps.baseUrl}${path}`, {
        ...init,
        headers: {
          authorization: `Bearer ${deps.token}`,
          ...((init.headers as Record<string, string> | undefined) ?? {}),
        },
        signal: AbortSignal.timeout(deps.timeoutMs),
        // No cookies, no credentials: a purely token-authenticated call.
        credentials: "omit",
      });
    } catch {
      return null;
    }
  }

  return {
    sendMessage: async (
      text,
      clientKey,
      clientSentAt,
    ): Promise<SendMessageResult> => {
      const response = await request("/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text,
          clientKey,
          ...(clientSentAt !== undefined ? { clientSentAt } : {}),
        }),
      });
      if (response === null) {
        return { ok: false, kind: "unavailable" };
      }
      if (response.status === 409) {
        return { ok: false, kind: "conflict" };
      }
      if (response.status === 400) {
        return { ok: false, kind: "bad_request" };
      }
      if (!response.ok) {
        return { ok: false, kind: "unavailable" };
      }
      let parsed: unknown;
      try {
        parsed = await response.json();
      } catch {
        return { ok: false, kind: "unavailable" };
      }
      if (!isRecord(parsed)) {
        return { ok: false, kind: "unavailable" };
      }
      const message = parseWorkerMessage(parsed.message);
      if (message === null) {
        return { ok: false, kind: "unavailable" };
      }
      return { ok: true, message };
    },

    getThread: async (limit, before): Promise<GetThreadResult> => {
      const query = new URLSearchParams({ limit: String(limit) });
      if (before !== undefined) {
        query.set("before", String(before));
      }
      const response = await request(`/v1/thread?${query.toString()}`, {
        method: "GET",
      });
      if (response === null) {
        return { ok: false, kind: "unavailable" };
      }
      if (response.status === 400) {
        return { ok: false, kind: "bad_request" };
      }
      if (!response.ok) {
        return { ok: false, kind: "unavailable" };
      }
      let parsed: unknown;
      try {
        parsed = await response.json();
      } catch {
        return { ok: false, kind: "unavailable" };
      }
      const snapshot = parseThreadSnapshot(parsed);
      if (snapshot === null) {
        return { ok: false, kind: "unavailable" };
      }
      return { ok: true, snapshot };
    },

    getEngagement: async (): Promise<GetEngagementResult> => {
      const response = await request("/v1/engagement", { method: "GET" });
      if (response === null) {
        return { ok: false, kind: "unavailable" };
      }
      if (response.status === 503) {
        return { ok: false, kind: "unavailable" };
      }
      if (!response.ok) {
        return { ok: false, kind: "unavailable" };
      }
      let parsed: unknown;
      try {
        parsed = await response.json();
      } catch {
        return { ok: false, kind: "unavailable" };
      }
      if (!isRecord(parsed)) {
        return { ok: false, kind: "unavailable" };
      }
      const state = parsed.state;
      const lastUserMessageId = parsed.lastUserMessageId;
      const lastUserEffectiveAt = parsed.lastUserEffectiveAt;
      const silenceMs = parsed.silenceMs;
      if (
        !(
          (state === null ||
            state === "engaged" ||
            state === "lull" ||
            state === "idle" ||
            state === "gone") &&
          (lastUserMessageId === null ||
            typeof lastUserMessageId === "string") &&
          (lastUserEffectiveAt === null ||
            (typeof lastUserEffectiveAt === "string" &&
              !Number.isNaN(Date.parse(lastUserEffectiveAt)))) &&
          (silenceMs === null ||
            (typeof silenceMs === "number" &&
              Number.isInteger(silenceMs) &&
              silenceMs >= 0))
        )
      ) {
        return { ok: false, kind: "unavailable" };
      }
      return {
        ok: true,
        engagement: {
          state,
          lastUserMessageId,
          lastUserEffectiveAt,
          silenceMs,
        },
      };
    },
  };
}
