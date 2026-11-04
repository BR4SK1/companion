/**
 * Message ingest timing: the original-timing contract for user messages.
 *
 * The user-visible requirement is honest dual provenance: preserve what the
 * client reported as its send time alongside the server's own receive time,
 * and derive one "effective" message time used for time-based reasoning
 * (engagement bands and similar), preferring the original client time when
 * it is valid and consistent with the thread's order, falling back to the
 * recorded server receive time otherwise.
 *
 * The selection is deliberately pure and total: every wire input maps to one
 * explicit outcome, and the raw client value is preserved whenever it is
 * representable as a timestamp (even when it is not trusted) so provenance
 * never silently discards what the client claimed. The effective time is a
 * best-effort reconstruction, never a claim of the perfect original send
 * time: clock skew and delivery delay are recorded, not corrected.
 *
 * Ordering is defined by a monotonically tracked acceptance/order bound —
 * the maximum effective time recorded so far on user messages (fallbacks
 * included; computed inside the serialized ingest transaction). A client
 * candidate below that bound would move the thread's effective timeline
 * backwards and is rejected as `out_of_order`; equality is allowed. The
 * bound gates CANDIDATE VALIDATION only — it never modifies a chosen
 * value.
 *
 * The fallback is always the actual recorded server receive time,
 * identical to `server_received_at`, for every non-valid status. No
 * synthetic or clamped effective timestamp is ever produced: the effective
 * time is either an accepted client-reported send time or the honest
 * server receipt, and each status (`absent`, `future_skew`, `out_of_order`,
 * `invalid`) is preserved independently. An accepted client time may sit
 * ahead of later receipts (moderate skew is recorded, not corrected), so
 * the effective timeline is advisory: consumers treat negative gaps
 * defensively instead of the store fabricating monotonicity.
 *
 * The selection is made once at ingest and persisted with its provenance
 * (`time_source`, `client_time_status`); an idempotent replay returns the
 * recorded selection untouched, so a retry never re-classifies time.
 */

/**
 * Maximum epoch-ms value the client time may carry and still be considered
 * a plausible send time (2100-01-01T00:00:00Z). Beyond it the value is a
 * malformed input, not a skewed clock.
 */
export const MAX_CLIENT_EPOCH_MS = 4_102_444_800_000;

/** Default ahead-tolerance when the caller does not configure one. */
export const DEFAULT_CLIENT_MAX_AHEAD_MS = 10_000;

/** Which clock the persisted effective time came from. */
export type MessageTimeSource = "client" | "server";

/**
 * Why the effective time was chosen (persisted provenance):
 * `absent` (no client time supplied), `valid` (client time used),
 * `future_skew` (client time too far ahead of the server clock),
 * `out_of_order` (client time would move the thread's effective timeline
 * backwards — below the monotonically tracked acceptance/order bound),
 * `invalid` (unparseable client value). Every non-valid status falls back
 * to the actual recorded server receive time, so the statuses stay
 * independently distinguishable.
 */
export type ClientTimeStatus =
  | "absent"
  | "valid"
  | "future_skew"
  | "out_of_order"
  | "invalid";

/** Wire-shape client send time: epoch-ms number or ISO-8601 string. */
export type RawClientSentAt = number | string | null | undefined;

/**
 * The classified client time: the raw value when it was representable as a
 * timestamp (preserved for provenance even when not trusted), null when it
 * was absent or unparseable, plus the recorded status.
 */
export interface ClassifiedClientTime {
  readonly clientSentAt: Date | null;
  readonly status: ClientTimeStatus;
}

/**
 * The resolved effective time: the trusted working time for time-based
 * reasoning and which clock family it came from. The persisted provenance
 * status is the classification's own status (never rewritten by
 * resolution).
 */
export interface ResolvedEffectiveAt {
  readonly effectiveAt: Date;
  readonly timeSource: MessageTimeSource;
}

export interface ClassifyClientSentAtInput {
  /** The raw client-reported send time as received on the wire. */
  readonly clientSentAt: RawClientSentAt;
  /**
   * The server's transaction clock (stable within the ingest transaction).
   * This is the recorded server receive time.
   */
  readonly serverReceivedAt: Date;
  /**
   * Tolerance for a client clock running ahead of the server clock, in
   * milliseconds. A client time further ahead than this is treated as skew
   * (the server receive time is used) while the raw value is still
   * preserved. Moderately fast client clocks within the tolerance are
   * accepted as the original send time.
   */
  readonly maxAheadMs: number;
  /**
   * The monotonically tracked acceptance/order bound: the maximum effective
   * time recorded so far on user messages (fallbacks included). A client
   * candidate below it would move the thread's effective timeline backwards
   * and is rejected as `out_of_order`; equality is allowed. The bound gates
   * candidate validation only — it never modifies a chosen value. Omit (or
   * pass null) for the first user message.
   */
  readonly orderBoundAt?: Date | null;
}

/**
 * Classify the raw client-reported send time against the server clock and
 * the monotonically tracked acceptance/order bound. Pure and deterministic:
 * the same inputs always yield the same classification, and the
 * classification is made once at ingest and persisted.
 */
export function classifyClientSentAt(
  input: ClassifyClientSentAtInput,
): ClassifiedClientTime {
  const raw = input.clientSentAt;
  let clientMs: number | null = null;
  if (typeof raw === "number") {
    if (Number.isSafeInteger(raw) && raw >= 0 && raw <= MAX_CLIENT_EPOCH_MS) {
      clientMs = raw;
    }
  } else if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed.length > 0 && trimmed.length <= 64) {
      const parsed = Date.parse(trimmed);
      if (
        !Number.isNaN(parsed) &&
        Number.isSafeInteger(parsed) &&
        parsed >= 0 &&
        parsed <= MAX_CLIENT_EPOCH_MS
      ) {
        clientMs = parsed;
      }
    }
  }

  if (clientMs === null) {
    return {
      clientSentAt: null,
      status: raw === null || raw === undefined ? "absent" : "invalid",
    };
  }

  const clientAt = new Date(clientMs);

  // A client clock far ahead of the server is skew, not prophecy: the
  // server clock wins and the raw claim stays visible for provenance.
  if (clientMs > input.serverReceivedAt.getTime() + input.maxAheadMs) {
    return { clientSentAt: clientAt, status: "future_skew" };
  }

  // Ordering: the client time must not move the thread's effective timeline
  // backwards. The acceptance/order bound is the maximum effective time
  // recorded so far on user messages (monotone by construction); a
  // candidate below it is rejected, equality allowed (an immediate
  // follow-up).
  const boundMs = input.orderBoundAt?.getTime() ?? null;
  if (boundMs !== null && clientMs < boundMs) {
    return { clientSentAt: clientAt, status: "out_of_order" };
  }

  return { clientSentAt: clientAt, status: "valid" };
}

/**
 * Resolve the effective message time from a classification, per the
 * original-timing contract: a `valid` client time is the original send time
 * as accepted; EVERY other status falls back to the actual recorded server
 * receive time — identical to `server_received_at`, never clamped or
 * otherwise modified. The persisted status is the classification's own
 * status, so `absent`, `future_skew`, `out_of_order`, and `invalid` remain
 * independently distinguishable on identical fallback values.
 */
export function resolveEffectiveAt(
  classified: ClassifiedClientTime,
  serverReceivedAt: Date,
): ResolvedEffectiveAt {
  if (classified.status === "valid") {
    return {
      effectiveAt: classified.clientSentAt as Date,
      timeSource: "client",
    };
  }
  return { effectiveAt: serverReceivedAt, timeSource: "server" };
}
