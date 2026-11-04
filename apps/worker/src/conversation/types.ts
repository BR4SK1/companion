/**
 * Conversation-work domain types.
 *
 * These types are owned by the conversation domain, which is currently
 * hosted by the worker deployable. They describe the durable thread, the
 * grouped work units (turns), the response-pattern configuration used by
 * the response-pattern decision, and the attempt tracing records (defined
 * below). No identity-provider subjects, user IDs, or tenant
 * abstractions appear here (single-owner product; see the root `AGENTS.md`).
 */

import type {
  DecisionsRequest,
  DecisionsResponse,
} from "@companion/openrouter";
import type { ChatRequest, ChatResponse } from "@companion/openrouter/chat";

export type MessageRole = "user" | "assistant";

/**
 * Which assembly chunk a chat-request message belongs to. Synthetic system
 * messages are classified by their source (identity, generated subject
 * profiles, temporal memory, long-term recall, selected response-pattern
 * guidance); every conversation message is `conversation`. The classification
 * is trace metadata only — the rendered text itself is already recorded in
 * the chat boundary as sent.
 */
export type ChatChunkName =
  | "identity"
  | "profiles"
  | "temporal"
  | "recall"
  | "guidance"
  | "conversation";

/**
 * The owner-authored chat identity/persona as provisioned in the
 * `chat_identity` table (singleton row, runtime configuration like
 * `response_pattern`). The content is configuration text supplied at
 * runtime, never code or repository content; `revision` is the owner-managed
 * counter recorded on each chat boundary trace.
 */
export interface ChatIdentity {
  readonly content: string;
  readonly revision: number;
}

/**
 * The chat identity is required configuration: a missing or empty identity
 * is a configuration error, never a silently-degraded prompt or an invented
 * persona.
 */
export class IdentityConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IdentityConfigurationError";
  }
}

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
  /**
   * The client-reported send time as received, when the caller supplied one
   * and it was representable as a timestamp; null when absent or unparseable.
   * Preserved raw for provenance regardless of whether it was trusted.
   */
  readonly clientSentAt: string | null;
  /**
   * The trusted working time chosen at ingest: the original client time when
   * it was valid and consistent with the thread's user-message order, the
   * server receive time otherwise. Best effort — see `timeSource` for which
   * clock it came from; this is not a claim of the perfect original send
   * time.
   */
  readonly effectiveAt: string;
  /** Which clock the effective time came from: `client` or `server`. */
  readonly timeSource: "client" | "server";
  /**
   * Why the effective time was chosen: `absent` (no client time supplied),
   * `valid` (client time used), `future_skew` (client time too far ahead of
   * the server clock), `out_of_order` (client time below the monotonically
   * tracked acceptance/order bound), or `invalid` (unparseable client
   * value). Every non-valid status falls back to the actual recorded server
   * receive time, identical to `serverReceivedAt`.
   */
  readonly clientTimeStatus:
    | "absent"
    | "valid"
    | "future_skew"
    | "out_of_order"
    | "invalid";
  /** The server receive time recorded at ingest (the fallback clock). */
  readonly serverReceivedAt: string;
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

// ---------------------------------------------------------------------------
// Attempt tracing payloads (written at meaningful boundaries)
// ---------------------------------------------------------------------------

/**
 * The attempt's input snapshot, taken before the decision step: the mutable
 * response-pattern configuration and the exact ordered context (prior-turn
 * history plus this turn's grouped messages) the attempt saw. Written in its
 * own fenced transaction before anything else is recorded for the attempt,
 * so it exists even when a later step fails.
 */
export interface AttemptSnapshotPayload {
  readonly context: readonly ConversationMessage[];
  readonly patterns: readonly ResponsePattern[];
}

/**
 * The decision request boundary record, written before the provider call: the
 * validated native typed request as sent, with the question it asks. No
 * normalization is applied. Written before the call so the exact request
 * exists even when the provider gives no usable response.
 */
export interface DecisionRequestTracePayload {
  readonly questionId: string;
  readonly request: DecisionsRequest;
}

/**
 * The validated decision exchange — request and native typed response as
 * returned. Recorded after the call succeeded and the exchange validated, and
 * before the selection step: no normalization is applied; optional native
 * values (confidence, probabilities, provider, id, usage cost) stay optional
 * and absent values stay absent. Because it is written before
 * `selectResponsePattern` runs, the full response survives even when the
 * selection is rejected.
 */
export interface DecisionTracePayload {
  readonly questionId: string;
  readonly request: DecisionsRequest;
  readonly response: DecisionsResponse;
}

/**
 * The available decision outcome after the provider call, recorded before the
 * selection step in its own fenced transaction:
 * - `responded` — the native typed response as returned and validated;
 * - `failed` — the provider call failed before a usable body arrived: the
 *   actual transport error kind and message, plus the truncated response body
 *   when the transport retained one (never fabricated);
 * - `invalid` — a body arrived but failed the Decisions contract validation:
 *   the validation error message. The offending value is not persisted because
 *   it is arbitrary untyped data with no relational home.
 */
export type DecisionOutcomeTrace =
  | { readonly kind: "responded"; readonly trace: DecisionTracePayload }
  | {
      readonly kind: "failed";
      readonly errorKind: string;
      readonly message: string;
      readonly body: string | null;
    }
  | { readonly kind: "invalid"; readonly message: string };

/** The full decision boundary record after the call: request plus outcome. */
export interface DecisionOutcomeTracePayload {
  readonly trace: DecisionRequestTracePayload;
  readonly outcome: DecisionOutcomeTrace;
}

/**
 * The outcome of the selection step, recorded separately from the decision
 * boundary: either the selected pattern, or the rejection with its reason
 * (the `UnusableDecisionError` message). `rejected` never overwrites or
 * invents the boundary above; it only records how the selection step resolved.
 */
export type DecisionSelectionTrace =
  | { readonly kind: "selected"; readonly patternId: string }
  | { readonly kind: "rejected"; readonly reason: string };

/**
 * The chat request record, written before the provider call: the native typed
 * request as sent. `messageSources` is aligned index-by-index with the request
 * messages; a source is null for the synthetic guidance system message and the
 * conversation_message id for every other message.
 */
export interface ChatRequestTracePayload {
  readonly request: ChatRequest;
  readonly messageSources: readonly (string | null)[];
  /**
   * Chunk classification per request message, index-aligned with
   * `messageSources`. Synthetic messages carry their chunk name; every
   * conversation message is `conversation`.
   */
  readonly messageChunks: readonly ChatChunkName[];
  /** The `chat_identity` revision the request carried. */
  readonly identityRevision: number;
}

/**
 * The available chat outcome after the provider call, recorded before
 * publication in its own fenced transaction:
 * - `responded` — the native typed response as returned, and the reply content
 *   that will be published;
 * - `failed` — the provider call failed before a usable body arrived: the
 *   actual transport error kind and message, plus the truncated response body
 *   when the transport retained one (never fabricated);
 * - `invalid` — a body arrived but failed the chat contract validation: the
 *   validation error message. The offending value is not persisted because it
 *   is arbitrary untyped data with no relational home.
 */
export type ChatOutcomeTrace =
  | {
      readonly kind: "responded";
      readonly response: ChatResponse;
      readonly replyContent: string | null;
      readonly applicationRejection: string | null;
    }
  | {
      readonly kind: "failed";
      readonly errorKind: string;
      readonly message: string;
      readonly body: string | null;
    }
  | { readonly kind: "invalid"; readonly message: string };

/** The full chat boundary record after the call: request plus outcome. */
export interface ChatOutcomeTracePayload {
  readonly request: ChatRequest;
  readonly messageSources: readonly (string | null)[];
  readonly messageChunks: readonly ChatChunkName[];
  readonly identityRevision: number;
  readonly outcome: ChatOutcomeTrace;
}

// ---------------------------------------------------------------------------
// Attempt tracing report (read-only assembly)
// ---------------------------------------------------------------------------

/** One prior-turn history or turn message in the attempt's context snapshot. */
export interface TraceContextMessage {
  readonly position: number;
  readonly messageId: string;
  readonly seq: number;
  readonly role: MessageRole;
  readonly content: string;
  /** True when this message belongs to the traced turn itself. */
  readonly fromTurn: boolean;
}

/** One mutable pattern row as captured in the attempt's pattern snapshot. */
export interface TracePatternSnapshot {
  readonly position: number;
  readonly patternId: string;
  readonly selectionDescription: string;
  readonly responseGuidance: string;
}

/** One option probability the provider returned for the decision. */
export interface TraceDecisionProbability {
  readonly optionId: string;
  readonly value: number;
}

/** The native decision request/response boundary for one attempt. */
export interface TraceDecision {
  readonly questionId: string;
  readonly questionType: string;
  readonly requestModel: string;
  readonly instructions: string;
  readonly choice: string | null;
  readonly confidence: number | null;
  /**
   * Whether the provider returned a probability distribution at all — kept
   * distinct from the rows themselves so a present-but-empty native
   * distribution (zero rows) stays distinguishable from an absent one.
   */
  readonly probabilitiesPresent: boolean;
  /** Selection step outcome, recorded separately: null when not yet recorded. */
  readonly selection: string | null;
  readonly rejectionReason: string | null;
  readonly state: string | null;
  readonly responseModel: string | null;
  readonly responseProvider: string | null;
  readonly responseId: string | null;
  readonly usageInputTokens: number | null;
  readonly usageOutputTokens: number | null;
  readonly usageCost: number | null;
  readonly errorKind: string | null;
  readonly errorMessage: string | null;
  readonly errorBody: string | null;
  readonly probabilities: readonly TraceDecisionProbability[];
  readonly recordedAt: string;
}

/** One message sent in the attempt's chat request. */
export interface TraceChatMessage {
  readonly position: number;
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
  readonly sourceMessageId: string | null;
  /** Assembly-chunk classification; null for rows recorded pre-0004. */
  readonly chunk: ChatChunkName | null;
}

/** One choice returned by the attempt's chat response. */
export interface TraceChatChoice {
  readonly position: number;
  readonly finishReason: string | null;
  readonly content: string;
}

/** The native chat request/response boundary for one attempt. */
export interface TraceChat {
  readonly requestModel: string;
  readonly temperature: number | null;
  readonly maxTokens: number | null;
  /** The `chat_identity` revision the request carried; null pre-0004. */
  readonly identityRevision: number | null;
  readonly responseId: string | null;
  readonly state: string | null;
  readonly responseModel: string | null;
  readonly replyContent: string | null;
  readonly applicationRejection: string | null;
  readonly errorKind: string | null;
  readonly errorMessage: string | null;
  readonly errorBody: string | null;
  readonly usagePromptTokens: number | null;
  readonly usageCompletionTokens: number | null;
  readonly usageTotalTokens: number | null;
  readonly messages: readonly TraceChatMessage[];
  readonly choices: readonly TraceChatChoice[];
  readonly recordedAt: string;
}

/** One recorded attempt of a turn, with its full boundary records. */
export interface TurnAttemptTrace {
  readonly id: string;
  readonly turnId: string;
  readonly attempt: number;
  readonly leaseOwner: string;
  readonly claimedAt: string;
  readonly finishedAt: string | null;
  readonly outcome: "published" | "failed" | "fenced" | "superseded" | null;
  readonly snapshotRecordedAt: string | null;
  readonly context: readonly TraceContextMessage[];
  readonly patterns: readonly TracePatternSnapshot[];
  readonly decision: TraceDecision | null;
  readonly chat: TraceChat | null;
}

/** A turn's tracing report: the turn plus every recorded attempt. */
export interface TurnTraceReport {
  readonly turn: ConversationTurn;
  readonly attempts: readonly TurnAttemptTrace[];
}
