/**
 * Client-side message model for the local preview slice.
 *
 * Deliberately minimal and UI-shaped: the real domain model (durable
 * segments, grouping, persistence) is owned by the chat domain and the
 * worker, not by this preview. These types only describe what the preview
 * renders. No identity-provider subjects, owner IDs, or tenant identifiers
 * appear here (apps/web/AGENTS.md).
 */

export type MessageRole = "user" | "assistant";

/** A locally stored fixture image attached to a message. Uploads are out of scope. */
export interface MessageImage {
  /** Static asset path served by this app (e.g. "/fixtures/example.svg"). */
  readonly src: string;
  /** Human-readable description announced to assistive technology. */
  readonly alt: string;
  /** Intrinsic pixel dimensions, used to reserve layout space before load. */
  readonly width: number;
  readonly height: number;
}

export interface Message {
  /** Stable identifier, unique within the fixture thread. */
  readonly id: string;
  readonly role: MessageRole;
  /** Optional text body. A message is text, images, or both. */
  readonly text?: string;
  /** Optional inline images rendered inside the bubble. */
  readonly images?: readonly MessageImage[];
  /** ISO 8601 timestamp of when the fixture message was "sent". */
  readonly sentAt: string;
}

/** Rendered unit: consecutive messages from one role, not interrupted by the other role. */
export interface MessageCluster {
  readonly kind: "cluster";
  readonly role: MessageRole;
  readonly messages: readonly Message[];
}

/** Rendered unit: a divider shown between clusters that are far apart in time. */
export interface TimeDivider {
  readonly kind: "divider";
  /** ISO 8601 timestamp the divider describes (start of the following group). */
  readonly at: string;
}

export type ThreadItem = MessageCluster | TimeDivider;
