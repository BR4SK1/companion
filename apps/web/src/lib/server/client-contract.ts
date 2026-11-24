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

/**
 * Content marker of the worker's standalone image message. In the browser
 * the image itself renders; the marker and any model-imitated `*sends a picture*`
 * or `*takes picture*` action tags are stripped from assistant message text.
 */
const IMAGE_MESSAGE_MARKER = "*sends a picture*";
const IMAGE_ACTION_MARKER_PATTERN =
  /\*\s*(?:sends|takes|snaps)\s+(?:a\s+)?(?:picture|photo|selfie)\s*\*/gi;

function stripAssistantImageActionMarkers(text: string): string {
  if (!text.includes("*")) return text;
  const cleanedLines = text
    .split("\n")
    .map((line) => {
      const hadMarker = IMAGE_ACTION_MARKER_PATTERN.test(line);
      IMAGE_ACTION_MARKER_PATTERN.lastIndex = 0;
      if (!hadMarker) return line;
      return line
        .replace(IMAGE_ACTION_MARKER_PATTERN, "")
        .replace(/[ \t]{2,}/g, " ")
        .trim();
    });
  return cleanedLines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Reduce one validated worker message to the client-facing shape. */
export function toClientMessage(message: WorkerMessage): ThreadMessage {
  const images =
    message.images !== undefined && message.images.length > 0
      ? message.images.map((image) => ({
          src: `/api/images/${image.id}`,
          alt: image.alt,
          width: image.width,
          height: image.height,
        }))
      : undefined;
  const text =
    images !== undefined && message.content === IMAGE_MESSAGE_MARKER
      ? ""
      : message.role === "assistant"
      ? stripAssistantImageActionMarkers(message.content)
      : message.content;
  return {
    id: message.id,
    seq: message.seq,
    role: message.role,
    text,
    sentAt: message.createdAt,
    ...(images !== undefined ? { images } : {}),
  };
}
