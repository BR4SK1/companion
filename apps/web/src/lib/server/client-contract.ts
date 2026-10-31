/**
 * The BFF's client-facing message contract.
 *
 * The worker's private API speaks its domain shape (`content`, `createdAt` —
 * validated and reduced by `worker-client.ts`). The browser contract is the
 * one `parseThreadSnapshotResponse` (apps/web/src/lib/thread-state.ts)
 * accepts: `text` and `sentAt`. This module is the single reduction point
 * between the two shapes: every BFF route that returns a worker message maps
 * it through `toClientMessage`, so the client never sees worker-domain field
 * names and no worker-only fields can leak into a response.
 *
 * The returned type is the client parser's own message type, so a drift
 * between the two shapes is a compile error rather than a runtime failure.
 */

import type { ThreadMessage } from "@/lib/thread-state";

import type { WorkerMessage } from "./worker-client";

/** Reduce one validated worker message to the client-facing shape. */
export function toClientMessage(message: WorkerMessage): ThreadMessage {
  return {
    id: message.id,
    seq: message.seq,
    role: message.role,
    text: message.content,
    sentAt: message.createdAt,
  };
}
