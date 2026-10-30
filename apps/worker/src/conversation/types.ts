/**
 * Conversation-work domain types.
 *
 * These types are owned by the conversation domain, which is currently
 * hosted by the worker deployable. They describe the durable thread, the
 * grouped work units (turns), and the response-pattern configuration used by
 * the response-pattern decision. No identity-provider subjects, user IDs, or
 * tenant abstractions appear here (single-owner product; see the root
 * `AGENTS.md`).
 */

export type MessageRole = "user" | "assistant";

/** One message of the single continuous visible thread, in `seq` order. */
export interface ConversationMessage {
  readonly id: string;
  /** Thread position; strictly increasing in insertion order. */
  readonly seq: number;
  readonly role: MessageRole;
  readonly content: string;
  /** The turn the message was grouped into; null while unassigned. */
  readonly turnId: string | null;
  /** Caller-supplied idempotency key; null for messages ingested without one. */
  readonly clientKey: string | null;
  readonly createdAt: string;
}

export type TurnStatus = "in_flight" | "completed" | "failed";

/** One durable work unit: a group of consecutive user messages. */
export interface ConversationTurn {
  readonly id: string;
  readonly status: TurnStatus;
  /** Increments every time the turn is leased (initial claim or reclaim). */
  readonly attempt: number;
  readonly leaseOwner: string | null;
  readonly leaseExpiresAt: string | null;
  readonly selectedPatternId: string | null;
  readonly decision: unknown;
  readonly error: string | null;
  readonly createdAt: string;
  readonly completedAt: string | null;
}

/** A claimed turn plus the exact message snapshot it was claimed with. */
export interface TurnWork {
  readonly turn: ConversationTurn;
  readonly messages: readonly ConversationMessage[];
}

/**
 * Configurable response-pattern record. The two text fields are separate on
 * purpose: `selectionDescription` helps the decision model choose the
 * pattern; `responseGuidance` shapes the chat response only after the
 * selection. Both are configuration content supplied at runtime, never code
 * or documentation content.
 */
export interface ResponsePattern {
  readonly id: string;
  readonly selectionDescription: string;
  readonly responseGuidance: string;
  /** Ordering for stable presentation to the decision model. */
  readonly position: number;
}
