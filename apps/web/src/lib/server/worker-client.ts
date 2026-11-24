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

export interface WorkerMessageImage {
  readonly id: string;
  readonly mimeType: string;
  readonly width: number;
  readonly height: number;
  readonly alt: string;
}

export interface WorkerMessage {
  readonly id: string;
  readonly seq: number;
  readonly role: "user" | "assistant";
  readonly content: string;
  readonly createdAt: string;
  readonly images?: readonly WorkerMessageImage[];
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
  readonly retryAttemptId?: string;
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

export interface WorkerClient {
  readonly retryGeneration: (attemptId: string) => Promise<number>;
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
    after?: number,
  ) => Promise<GetThreadResult>;
  /** Rendered image bytes by asset id; null when unknown or unavailable. */
  readonly getImage: (
    id: string,
  ) => Promise<
    | { readonly ok: true; readonly mimeType: string; readonly data: ArrayBuffer }
    | { readonly ok: false; readonly kind: "not_found" | "unavailable" }
  >;
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

const WORKER_IMAGE_ID_PATTERN =
  /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const WORKER_IMAGE_MIME_TYPES = new Set([
  "image/webp",
  "image/png",
  "image/jpeg",
]);

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
  let images: WorkerMessageImage[] | undefined;
  if (value.images !== undefined) {
    if (!Array.isArray(value.images)) return null;
    images = [];
    for (const entry of value.images) {
      if (!isRecord(entry)) return null;
      const { id: imageId, mimeType, width, height, alt } = entry;
      if (
        typeof imageId !== "string" ||
        !WORKER_IMAGE_ID_PATTERN.test(imageId) ||
        typeof mimeType !== "string" ||
        !WORKER_IMAGE_MIME_TYPES.has(mimeType) ||
        typeof width !== "number" ||
        !Number.isInteger(width) ||
        width < 1 ||
        typeof height !== "number" ||
        !Number.isInteger(height) ||
        height < 1 ||
        typeof alt !== "string"
      ) {
        return null;
      }
      images.push({ id: imageId, mimeType, width, height, alt });
    }
  }
  return {
    id,
    seq,
    role,
    content,
    createdAt,
    ...(images !== undefined && images.length > 0 ? { images } : {}),
  };
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
    ...(typeof status.retryAttemptId === "string" ? { retryAttemptId: status.retryAttemptId } : {}),
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
    retryGeneration: async attemptId => {
      const response = await request(`/v1/thread/retry?attempt=${encodeURIComponent(attemptId)}`, { method: "POST" });
      return response && [200, 400, 409].includes(response.status) ? response.status : 502;
    },
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

    getThread: async (limit, before, after): Promise<GetThreadResult> => {
      const query = new URLSearchParams({ limit: String(limit) });
      if (after !== undefined) query.set("after", String(after));
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

    getImage: async (id) => {
      if (!WORKER_IMAGE_ID_PATTERN.test(id)) {
        return { ok: false, kind: "not_found" };
      }
      const response = await request(`/v1/images/${encodeURIComponent(id)}`, {
        method: "GET",
      });
      if (response === null) return { ok: false, kind: "unavailable" };
      if (response.status === 404) return { ok: false, kind: "not_found" };
      if (!response.ok) return { ok: false, kind: "unavailable" };
      const mimeType = response.headers.get("content-type") ?? "";
      if (!WORKER_IMAGE_MIME_TYPES.has(mimeType)) {
        return { ok: false, kind: "unavailable" };
      }
      try {
        const data = await response.arrayBuffer();
        if (data.byteLength === 0) return { ok: false, kind: "unavailable" };
        return { ok: true, mimeType, data };
      } catch {
        return { ok: false, kind: "unavailable" };
      }
    },
  };
}
