/**
 * Engagement-domain types.
 *
 * These types are owned by the engagement domain, which is currently hosted
 * by the worker deployable as a domain peer to memory. The engagement state
 * is a deterministic function of the last user message's effective time and
 * that message's own recorded assessment: it advances during silence from
 * the last user message, is floored by the last assessment (a single return
 * message never resets the state to `engaged`), never resets on assistant
 * messages or idempotent replays, and never triggers proactive behavior on
 * its own.
 *
 * No identity-provider subjects, user IDs, or tenant abstractions appear
 * here (single-owner product; see the root `AGENTS.md`).
 */

/** The engagement bands. */
export type EngagementState =
  | "engaged"
  | "lull"
  | "idle"
  | "gone";

export const ENGAGEMENT_STATES: readonly EngagementState[] = [
  "engaged",
  "lull",
  "idle",
  "gone",
];

/**
 * The engagement band cutoffs, in milliseconds of silence. Exactly THREE
 * cutoffs delimit FOUR bands (half-open, deeper as silence grows):
 *
 * - silence < `lullMs`  → `engaged`
 * - `lullMs`  <= silence < `idleMs` → `lull`
 * - `idleMs`  <= silence < `goneMs` → `idle`
 * - silence >= `goneMs` → `gone`
 *
 * Each cutoff is the silence duration at which the NEXT deeper band begins,
 * so the contract is unambiguous: three configured numbers, four states,
 * and every boundary belongs to the deeper band. The boundaries are
 * locally configurable deployment configuration, never shared-library or
 * public policy content, and never code defaults: an unprovisioned
 * deployment runs the domain as a safe no-op.
 */
export interface EngagementBandMs {
  /** Silence at or beyond which the state is `lull` (no longer `engaged`). */
  readonly lullMs: number;
  /** Silence at or beyond which the state is `idle` (no longer `lull`). */
  readonly idleMs: number;
  /** Silence at or beyond which the state is `gone` (no longer `idle`). */
  readonly goneMs: number;
}

/**
 * One per-message engagement assessment, recorded at the moment a new user
 * message was ingested and persisted so grouped turns can read the
 * assessment of the last user message of their group, stable across
 * retries and lease reclaims.
 *
 * Assessments are assigned to user messages only; assistant messages and
 * idempotent replays never create or modify them.
 */
export interface MessageAssessment {
  /** The user message the assessment belongs to. */
  readonly messageId: string;
  /** The engagement state recorded for this message. */
  readonly state: EngagementState;
  /** The previous user message's recorded assessment state, if any. */
  readonly previousState: EngagementState | null;
  /** Silence between the previous user message and this one; null for the first. */
  readonly silenceMs: number | null;
  /**
   * True when the assessment retained a lull rather than advancing to
   * `engaged` — this message arrived during a lull band, so the effective
   * engagement is still `lull` until a subsequent message lands inside the
   * engaged band (the no-immediate-engagement rule).
   */
  readonly retainedLull: boolean;
  /** The effective time the assessment was derived from. */
  readonly messageEffectiveAt: string;
  /** The band cutoffs the assessment was computed with (provenance). */
  readonly bands: EngagementBandMs;
  readonly assessedAt: string;
}

/**
 * The current aggregate engagement for the thread, recomputed on read.
 * There is no mutable engagement row; the state is a pure function of the
 * durable message history and the configured cutoffs:
 *
 * - The **last-activity clock** is the newest user message's effective
 *   time. Inactivity is always measured from the LAST user message — every
 *   user message moves the clock, assistant messages and replays never do.
 * - The last user message's own recorded assessment (the band its
 *   preceding silence fell into) acts as a retention floor: right after a
 *   message that arrived during a lull (or deeper), the effective state is
 *   that assessment, not `engaged` — a single return message never
 *   overwrites the effective engagement. Subsequent inactivity transitions
 *   then measure from that message's effective time.
 *
 * Formally: `state = deeper(band(now − lastUser.effectiveAt),
 * lastUser.assessment.state)` — the deeper of the activity band and the
 * last assessment — and simply the activity band when no assessment is
 * recorded (pre-engagement history). The first user message of a thread
 * assesses `engaged` (no silence has elapsed), so a fresh thread starts
 * engaged; a message after a lull keeps the state at `lull`, a subsequent
 * immediate message assesses `engaged` and lifts the state, and a message
 * arriving in a deeper band keeps the deeper state until the next message.
 *
 * Shared with other worker domains through the typed store boundary;
 * recomputation on read is what advances the state during silence and makes
 * restart recovery and stale-callback fencing automatic (nothing mutates
 * state from a timer).
 */
export interface EngagementSummary {
  readonly state: EngagementState | null;
  /** The last user message (the last-activity anchor); null with none. */
  readonly lastUserMessageId: string | null;
  /** That message's effective time; null with no user message. */
  readonly lastUserEffectiveAt: string | null;
  /** Silence since the last user message's effective time; null with none. */
  readonly silenceMs: number | null;
  /** The configured band cutoffs this summary was computed with. */
  readonly bands: EngagementBandMs;
}

/**
 * Thrown when the configured band boundaries are not strictly monotone
 * (engaged < lull < idle < gone). The state machine cannot be configured
 * into a non-monotone timeline.
 */
export class EngagementConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EngagementConfigurationError";
  }
}

/**
 * The transaction-scoped query surface the engagement hook runs against.
 * The conversation store passes its ingest transaction's own client, so the
 * hook can see the just-inserted (not yet committed) message row and its
 * writes commit atomically with the message.
 */
export interface EngagementTxClient {
  readonly query: <T = unknown>(
    sql: string,
    params?: readonly unknown[],
  ) => Promise<{ rows: T[] }>;
}

/**
 * Store contract for the engagement domain. Owns the typed relational
 * assessment records and the shared read surface other worker domains use.
 * The conversation store calls `onUserMessageInserted` inside its ingest
 * transaction so a new user message and its assessment commit atomically;
 * replays never reach it.
 */
export interface EngagementStore {
  /**
   * In-transaction hook: assess and persist the engagement of one NEW user
   * message. Runs inside the conversation store's ingest transaction (the
   * advisory-locked serialized section) on that transaction's own client,
   * so the assessment's view of the previous user message is consistent and
   * the write is atomic with the message. Never called for assistant
   * messages or idempotent replays.
   */
  readonly onUserMessageInserted: (
    tx: EngagementTxClient,
    input: {
      readonly messageId: string;
      readonly effectiveAt: Date;
      readonly serverReceivedAt: Date;
    },
  ) => Promise<MessageAssessment>;

  /** The per-message assessment for one user message, if recorded. */
  readonly getAssessmentForMessage: (
    messageId: string,
  ) => Promise<MessageAssessment | null>;

  /**
   * The assessment of the LAST user message of a turn's grouped messages —
   * what a turn reads as its engagement context, stable across retries and
   * reclaims. Null when the turn has no user messages or none of its user
   * messages has an assessment (pre-engagement history).
   */
  readonly getAssessmentForTurn: (
    turnId: string,
  ) => Promise<MessageAssessment | null>;

  /**
   * The current engagement summary, recomputed on read at `observedAt`
   * from the last user message's effective time and the configured bands.
   * Null state when no user message has ever been ingested.
   */
  readonly getSummary: (observedAt: Date) => Promise<EngagementSummary>;
}