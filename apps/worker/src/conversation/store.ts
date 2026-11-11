/**
 * Domain-owned queries for durable grouped conversation work.
 *
 * Ownership note: this store belongs to the conversation domain, which is
 * currently hosted by the worker deployable. The shared PostgreSQL library
 * provides connection lifecycle and transaction mechanics only; every query,
 * constraint, and state rule here is domain-owned.
 *
 * Work model (see `apps/worker/README.md` for the full lifecycle):
 *
 * - User messages are appended unassigned (`turn_id IS NULL`) and form the
 *   pending backlog. Because assistant replies are always persisted with
 *   their turn, unassigned user messages always form a trailing run of the
 *   thread. Ingestion is serialized with claiming on the same advisory lock,
 *   so commit order matches `seq` order and a claim snapshot never straddles
 *   an in-flight ingest (see `appendUserMessage`).
 * - `claimNextTurn` groups the entire unassigned trailing run of user
 *   messages into one new turn and leases it — one snapshot, not one message
 *   at a time. Messages ingested after the grouping SELECT are not part of
 *   the snapshot; they are grouped into the next turn.
 * - While a turn is in flight with a valid lease, no other turn is claimed:
 *   processing is serialized, which keeps persisted reply order identical to
 *   turn order.
 * - A turn whose lease has expired is reclaimable (new attempt, fresh lease).
 * - Publication (`publishReply`) is fenced: it completes the turn and
 *   persists the reply in one transaction, conditional on the turn still
 *   being in flight under the caller's lease. A stale worker that lost its
 *   lease can neither publish a reply nor overwrite turn state
 *   (`recordTurnDecision`, `failTurn` are fenced the same way). A duplicate
 *   publication attempt after success is an idempotent no-op.
 * - Prior-turn context (`getThreadContext`) is the conversation-order
 *   snapshot of the messages of turns claimed before the processed turn.
 *   Because a reply is published after later-arriving user messages drew
 *   lower `seq` values, ordering goes by turn association (per turn: user
 *   messages, then reply; turns in claim order), not by raw `seq`.
 *   Unassigned messages, the processed turn's own messages, and any later
 *   turns' messages are excluded, so the snapshot neither leaks future
 *   work nor duplicates the turn's grouped messages, and it is identical
 *   across lease reclaims.
 *
 * Exactly-once honesty: fencing makes publication and turn-state transitions
 * exactly-once, but it cannot make the external provider calls exactly-once.
 * A crash between a provider call and publication replays the call after
 * reclaim; the fenced publication then guarantees only one reply survives.
 */

import { randomUUID } from "node:crypto";

import type {
  PostgresPool,
  PostgresPoolClient,
} from "@companion/postgres";
import { withTransaction } from "@companion/postgres";

import {
  DEFAULT_CLIENT_MAX_AHEAD_MS,
  classifyClientSentAt,
  resolveEffectiveAt,
} from "./timing.ts";

import type {
  AttemptSnapshotPayload,
  ChatOutcomeTrace,
  ChatOutcomeTracePayload,
  ChatRequestTracePayload,
  ChatIdentity,
  ConversationMessage,
  ConversationTurn,
  DecisionOutcomeTracePayload,
  DecisionRequestTracePayload,
  DecisionSelectionTrace,
  MessageRole,
  ResponsePattern,
  TraceChat,
  TraceChatMessage,
  TraceContextMessage,
  TraceDecision,
  TurnAttemptTrace,
  TurnTraceReport,
  TurnWork,
} from "./types.ts";
import { IdentityConfigurationError } from "./types.ts";

/**
 * Thrown by the composition edge when a fenced trace write reports that the
 * lease is no longer held. The store itself reports a fenced write by
 * returning `false` (a soft result a caller may choose to handle); the
 * wiring edge turns that result into this error so a stale attempt stops
 * processing immediately — no further provider calls, and no selection or
 * publication decision based on an unrecorded boundary. The engine handles
 * it through its existing fenced failure path (`failTurn` is itself fenced,
 * and a fenced failure marks the attempt).
 */
export class TraceWriteFencedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TraceWriteFencedError";
  }
}

/**
 * Arbitrary but fixed advisory-lock key serializing turn claims and message
 * ingestion across concurrent worker processes. Distinct from the migration
 * runner's key. Chosen once; changing it would break serialization between
 * versions. Exported so tests can hold or observe the same serialization
 * point.
 */
export const CLAIM_ADVISORY_LOCK_KEY = 918273645511;

interface MessageRow {
  id: string;
  seq: string;
  role: string;
  content: string;
  turn_id: string | null;
  client_key: string | null;
  created_at: Date;
  client_sent_at: Date | null;
  effective_at: Date;
  time_source: string;
  client_time_status: string;
  server_received_at: Date;
}

interface TurnRow {
  id: string;
  status: string;
  attempt: number;
  lease_owner: string | null;
  lease_expires_at: Date | null;
  selected_pattern_id: string | null;
  decision: unknown;
  error: string | null;
  created_at: Date;
  completed_at: Date | null;
}

interface PatternRow {
  id: string;
  selection_description: string;
  response_guidance: string;
  position: number;
}

function mapMessage(row: MessageRow): ConversationMessage {
  return {
    id: row.id,
    seq: Number(row.seq),
    role: row.role as MessageRole,
    content: row.content,
    turnId: row.turn_id,
    clientKey: row.client_key,
    createdAt: row.created_at.toISOString(),
    clientSentAt: row.client_sent_at?.toISOString() ?? null,
    effectiveAt: row.effective_at.toISOString(),
    timeSource: row.time_source as ConversationMessage["timeSource"],
    clientTimeStatus:
      row.client_time_status as ConversationMessage["clientTimeStatus"],
    serverReceivedAt: row.server_received_at.toISOString(),
  };
}

function mapTurn(row: TurnRow): ConversationTurn {
  return {
    id: row.id,
    status: row.status as ConversationTurn["status"],
    attempt: row.attempt,
    leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at?.toISOString() ?? null,
    selectedPatternId: row.selected_pattern_id,
    decision: row.decision,
    error: row.error,
    createdAt: row.created_at.toISOString(),
    completedAt: row.completed_at?.toISOString() ?? null,
  };
}

function mapPattern(row: PatternRow): ResponsePattern {
  return {
    id: row.id,
    selectionDescription: row.selection_description,
    responseGuidance: row.response_guidance,
    position: row.position,
  };
}

const MESSAGE_COLUMNS =
  "id, seq, role, content, turn_id, client_key, created_at, " +
  "client_sent_at, effective_at, time_source, client_time_status, " +
  "server_received_at";
const MESSAGE_COLUMNS_FROM_M =
  "m.id, m.seq, m.role, m.content, m.turn_id, m.client_key, m.created_at, " +
  "m.client_sent_at, m.effective_at, m.time_source, m.client_time_status, " +
  "m.server_received_at";
const TURN_COLUMNS =
  "id, status, attempt, lease_owner, lease_expires_at, selected_pattern_id, decision, error, created_at, completed_at";

export interface AppendUserMessageParams {
  readonly content: string;
  /**
   * Idempotency key; re-ingesting the same key with the same content
   * returns the existing message, and reuse with different content raises
   * `ClientKeyConflictError`.
   */
  readonly clientKey?: string;
  /**
   * The raw client-reported send time as received on the wire (epoch
   * milliseconds or an ISO-8601 instant), preserved alongside the server
   * receive time. The effective message time prefers this value when it is
   * valid and consistent with the thread's user-message order, and falls
   * back to the recorded server receive time otherwise; the selection is
   * made once at ingest and persisted with its provenance, and an
   * idempotent replay returns the originally recorded values untouched.
   */
  readonly clientSentAt?: number | string | null;
}

/**
 * In-transaction hook fired after a NEW user message row is inserted (never
 * on an idempotent replay), inside the same transaction — so anything the
 * hook writes (for example the engagement domain's per-message assessment)
 * commits atomically with the message, and a later replay observes exactly
 * the recorded values. The conversation store stays agnostic about what the
 * hook does: the composition edge injects it.
 */
export interface UserMessageInsertion {
  readonly messageId: string;
  readonly effectiveAt: Date;
  readonly serverReceivedAt: Date;
}

export type UserMessageInsertedHook = (
  tx: PostgresPoolClient,
  inserted: UserMessageInsertion,
) => Promise<unknown>;

/**
 * Post-commit notification for a NEW user message (never on replay). Fire
 * and forget from the caller's perspective: the store invokes it after the
 * ingest transaction has committed, with whatever summary the in-transaction
 * hook returned, so interested runtimes can react (for example re-arming an
 * engagement timer) without participating in the transaction.
 */
export type UserMessageCommittedHook = (result: unknown) => void;

export interface ConversationStoreOptions {
  /**
   * Tolerance for a client clock running ahead of the server clock when
   * accepting a client-reported send time, in milliseconds (see
   * `conversation/timing.ts`). Zero disables the tolerance entirely.
   */
  readonly clientTimeMaxAheadMs?: number;
  /**
   * In-transaction hook for new user messages (see `UserMessageInsertion`);
   * a thrown error fails the ingest transaction atomically.
   */
  readonly onUserMessageInserted?: UserMessageInsertedHook;
  /** Post-commit notification for new user messages; errors are swallowed. */
  readonly onUserMessageCommitted?: UserMessageCommittedHook;
}

/**
 * A caller reused an idempotency key with different content. This is a
 * caller contract violation (each key belongs to exactly one logical
 * message), surfaced to callers so it can be rejected instead of silently
 * associating two different messages with one key.
 */
export class ClientKeyConflictError extends Error {
  constructor(clientKey: string) {
    super(
      `client key is already used with different content: ${clientKey}`,
    );
    this.name = "ClientKeyConflictError";
  }
}

export type ClaimOutcome =
  | { readonly kind: "claimed"; readonly work: TurnWork }
  | { readonly kind: "idle" };

export interface ClaimParams {
  /** Unique lease owner token for this claim (e.g. a fresh UUID per claim). */
  readonly owner: string;
  readonly leaseSeconds: number;
  /**
   * Optional domain-owned gate for creating a new turn. It runs under the
   * claim/ingest serialization lock and after expired-turn recovery, so
   * existing work remains recoverable while new work can be held.
   */
  readonly canStartNewTurn?: (client: PostgresPoolClient) => Promise<boolean>;
}

export type PublishOutcome =
  | "published"
  | "already_published"
  | "fenced";

export type FailOutcome = "failed" | "fenced";

export interface PublishReplyParams {
  readonly turnId: string;
  readonly leaseOwner: string;
  readonly content: string;
  /**
   * Optional domain-owned work committed atomically with the reply. The
   * conversation store runs it behind a savepoint so optional-domain failure
   * cannot block publication; the callback receives this transaction's client.
   */
  readonly onPublicationTransaction?: (client: PostgresPoolClient) => Promise<void>;
}

export interface FailTurnParams {
  readonly turnId: string;
  readonly leaseOwner: string;
  readonly error: string;
  /**
   * The attempt's input snapshot (patterns + ordered context), recorded
   * transactionally with the failure when it was taken before the failing
   * step.
   */
  readonly snapshot?: AttemptSnapshotPayload;
}

export interface RecordAttemptSnapshotParams {
  readonly turnId: string;
  readonly leaseOwner: string;
  readonly snapshot: AttemptSnapshotPayload;
}

export interface TurnTraceParams {
  readonly turnId: string;
}

export interface RenewLeaseParams {
  readonly turnId: string;
  readonly leaseOwner: string;
  readonly leaseSeconds: number;
}

export interface RecordDecisionRequestParams {
  readonly turnId: string;
  readonly leaseOwner: string;
  /**
   * The decision request boundary record: the validated native typed request
   * as sent, with the question it asks. Written before the provider call, in
   * its own fenced transaction; the legacy `decision` JSONB column is left
   * untouched (it holds pre-tracing history only).
   */
  readonly trace: DecisionRequestTracePayload;
}

export interface RecordDecisionOutcomeParams {
  readonly turnId: string;
  readonly leaseOwner: string;
  /**
   * The decision outcome record: the available outcome after the provider
   * call (`responded` with the native typed response, `failed` with the
   * actual transport error, or `invalid` with the validation error), written
   * before the selection step, in its own fenced transaction; the legacy
   * `decision` JSONB column is left untouched.
   */
  readonly payload: DecisionOutcomeTracePayload;
}

export interface RecordDecisionSelectionParams {
  readonly turnId: string;
  readonly leaseOwner: string;
  /**
   * The decision question this selection resolves: the decision trace holds
   * one row per (attempt, question), so the selection write targets its own
   * question's row.
   */
  readonly questionId: string;
  /**
   * The selection outcome, recorded after the boundary and separately from
   * it: the chosen pattern id, or the rejection with its reason.
   */
  readonly selection: DecisionSelectionTrace;
}

export interface RecordChatRequestParams {
  readonly turnId: string;
  readonly leaseOwner: string;
  /** The exact chat request as sent, with per-message source linkage. */
  readonly payload: ChatRequestTracePayload;
}

export interface RecordChatOutcomeParams {
  readonly turnId: string;
  readonly leaseOwner: string;
  /** The full chat boundary: request plus the available outcome. */
  readonly payload: ChatOutcomeTracePayload;
}

export interface ThreadContextParams {
  /**
   * The turn being processed. Prior context is the messages of the turns
   * claimed before it, in conversation order; the turn's own grouped
   * messages are excluded (the caller supplies them separately).
   */
  readonly turnId: string;
  readonly limit: number;
}

/**
 * Generic thread-level work status; deliberately free of internal detail
 * (no turn ids, lease state, or error text leaves the domain this way).
 */
export interface ThreadStatus {
  /** User messages not yet grouped into a turn. */
  readonly queuedUserMessages: number;
  /** True while a turn is being processed (reply not yet published). */
  readonly generating: boolean;
  /**
   * Highest `seq` value the thread's identity sequence has allocated, whether
   * or not the message has committed (or ever will — a rolled-back insert
   * burns its seq). Because allocation is contiguous from 1, this bounds
   * what can exist below any page: every seq in `[1..highestAllocatedSeq]`
   * is either committed and visible, in flight (its transaction has drawn
   * the seq but not committed), or burned (rolled back) — never simply
   * absent. See the paged-history notes on `getThreadPage`.
   */
  readonly highestAllocatedSeq: number;
  /**
   * True when the thread's trailing state includes a failed turn: a failed
   * turn claimed after the most recently completed one (or any failure when
   * nothing has completed yet). Durable (derived from turn state on every
   * read) and sanitized — it never carries the underlying error text.
   */
  readonly hasRecentFailure: boolean;
}

export interface ThreadPageParams {
  readonly limit: number;
  /**
   * Exclusive upper `seq` bound for a history page; omit for the newest
   * page of the thread.
   */
  readonly before?: number;
}

/** One bounded page of the thread in persisted `seq` order. */
export interface ThreadPage {
  readonly messages: readonly ConversationMessage[];
  /** Smallest `seq` in the page; null when the page is empty. */
  readonly oldestSeq: number | null;
  /** True when committed messages exist below this page. */
  readonly hasMore: boolean;
}

export interface PreparedAssistantMessage {
  readonly content: string;
  /** The first instant at which this prepared publication becomes stale, if any. */
  readonly validUntil: Date | null;
  /** Cancel its locked domain event if the final pre-insert time has expired. */
  readonly cancel: (
    client: PostgresPoolClient,
    cancelledAt: Date,
  ) => Promise<void>;
  /** Required domain-owned event link, committed with this message. */
  readonly recordPublication: (
    client: PostgresPoolClient,
    messageId: string,
    publishedAt: Date,
  ) => Promise<void>;
}

export interface ConversationStore {
  appendUserMessage(
    params: AppendUserMessageParams,
  ): Promise<ConversationMessage>;
  claimNextTurn(params: ClaimParams): Promise<ClaimOutcome>;
  renewLease(params: RenewLeaseParams): Promise<boolean>;
  recordAttemptSnapshot(params: RecordAttemptSnapshotParams): Promise<boolean>;
  recordDecisionRequest(params: RecordDecisionRequestParams): Promise<boolean>;
  recordDecisionOutcome(params: RecordDecisionOutcomeParams): Promise<boolean>;
  recordDecisionSelection(params: RecordDecisionSelectionParams): Promise<boolean>;
  recordChatRequest(params: RecordChatRequestParams): Promise<boolean>;
  recordChatOutcome(params: RecordChatOutcomeParams): Promise<boolean>;
  publishReply(params: PublishReplyParams): Promise<PublishOutcome>;
  /** Publish one scheduled assistant-only message and its domain event atomically. */
  publishScheduledAssistantMessage(params: {
    readonly prepare: (
      client: PostgresPoolClient,
    ) => Promise<PreparedAssistantMessage | null>;
  }): Promise<boolean>;
  failTurn(params: FailTurnParams): Promise<FailOutcome>;
  markAttemptFenced(params: {
    turnId: string;
    leaseOwner: string;
  }): Promise<boolean>;
  getEnabledResponsePatterns(): Promise<readonly ResponsePattern[]>;
  /**
   * The owner-authored chat identity as provisioned in `chat_identity`.
   * Fail-closed: a missing or empty identity row is an
   * `IdentityConfigurationError`, never a silently-degraded prompt.
   */
  getChatIdentity(): Promise<ChatIdentity>;
  getThreadContext(params: ThreadContextParams): Promise<
    readonly ConversationMessage[]
  >;
  /** Bounded page of the thread in `seq` order (see the notes below). */
  getThreadPage(params: ThreadPageParams): Promise<ThreadPage>;
  getThreadStatus(): Promise<ThreadStatus>;
  getTurnTraceReport(params: TurnTraceParams): Promise<TurnTraceReport>;
}

export function createConversationStore(
  pool: PostgresPool,
  options?: ConversationStoreOptions,
): ConversationStore {
  async function appendUserMessage(
    params: AppendUserMessageParams,
  ): Promise<ConversationMessage> {
    // Set when a NEW message row was inserted, with whatever the
    // in-transaction insertion hook returned; released by the post-commit
    // handler below (never on an idempotent replay).
    let committedHookResult: unknown | undefined;
    let hasCommittedHookResult = false;
    const message = await withTransaction(pool, async (client) => {
      // Serialize with `claimNextTurn` (same advisory lock, always taken
      // before any row lock, so the two cannot deadlock). PostgreSQL
      // sequences are not transactional: an ingest that has drawn `seq` but
      // not yet committed is invisible to a concurrently started claim
      // snapshot, while a later ingest can commit a higher `seq` first — the
      // claim would then group the later message and omit the earlier one
      // from that turn's context, and process messages out of thread order.
      // Holding this lock across the insert means: ingests commit in `seq`
      // order, and a claim never snapshots while an ingest transaction is
      // in flight. Ingestion is short, so the brief mutual exclusion with
      // claiming is acceptable.
      await client.query("SELECT pg_advisory_xact_lock($1)", [
        CLAIM_ADVISORY_LOCK_KEY,
      ]);

      // One clock reading per ingest, taken from the database's own
      // transaction clock: the server receive time recorded on the message
      // and `created_at` are the same instant by construction, and the
      // client-time classification is decided against exactly that clock.
      const serverNow = await client.query<{ now: Date }>(
        "SELECT now() AS now",
      );
      const serverNowRow = serverNow.rows[0];
      if (serverNowRow === undefined) {
        throw new Error("server clock read returned no row");
      }
      const serverReceivedAt = serverNowRow.now;
      // The acceptance/order bound: the maximum effective time recorded so far
      // on user messages (fallbacks included) — a monotonically tracked
      // validation bound for client-time candidates. Read before the
      // insert, inside the serialized ingest transaction, so the max covers
      // every user row that exists at this moment. It gates candidate
      // validation only; the chosen fallback value is never modified by it.
      const boundResult = await client.query<{ order_bound: Date | null }>(
        `SELECT max(effective_at) AS order_bound FROM conversation_message
         WHERE role = 'user'`,
      );
      const orderBound = boundResult.rows[0]?.order_bound ?? null;
      const classification = classifyClientSentAt({
        clientSentAt: params.clientSentAt ?? null,
        serverReceivedAt,
        maxAheadMs:
          options?.clientTimeMaxAheadMs ?? DEFAULT_CLIENT_MAX_AHEAD_MS,
        ...(orderBound !== null ? { orderBoundAt: orderBound } : {}),
      });
      // The honest contract: a valid client time is the effective time;
      // every other status falls back to the actual recorded server receive
      // time, identical to `server_received_at`, with the classification's
      // own status preserved.
      const resolved = resolveEffectiveAt(classification, serverReceivedAt);

      const inserted = await client.query<MessageRow>(
        `INSERT INTO conversation_message
           (role, content, client_key, client_sent_at, effective_at,
            time_source, client_time_status, server_received_at)
         VALUES ('user', $1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (client_key) DO NOTHING
         RETURNING ${MESSAGE_COLUMNS}`,
        [
          params.content,
          params.clientKey ?? null,
          classification.clientSentAt,
          resolved.effectiveAt,
          resolved.timeSource,
          classification.status,
          serverReceivedAt,
        ],
      );
      const row = inserted.rows[0];
      if (row !== undefined) {
        // New message. The domain-owned insertion hook runs inside this
        // same transaction — whatever it writes (the engagement domain's
        // per-message assessment) commits atomically with the message, so
        // an idempotent replay later observes exactly the recorded values.
        if (options?.onUserMessageInserted !== undefined) {
          committedHookResult = await options.onUserMessageInserted(client, {
            messageId: row.id,
            effectiveAt: row.effective_at,
            serverReceivedAt: row.server_received_at,
          });
          hasCommittedHookResult = true;
        }
        return mapMessage(row);
      }
      // Unique-violation path: the same client key was already ingested. The
      // advisory lock guarantees no other ingest transaction is in flight,
      // so the conflicting row is already committed and visible here.
      if (params.clientKey === undefined) {
        throw new Error(
          "message insert returned no row without an idempotency key",
        );
      }
      const existing = await client.query<MessageRow>(
        `SELECT ${MESSAGE_COLUMNS} FROM conversation_message WHERE client_key = $1`,
        [params.clientKey],
      );
      const found = existing.rows[0];
      if (found === undefined) {
        throw new Error(
          `idempotent re-ingest failed: no message for client key ${params.clientKey}`,
        );
      }
      // A key is bound to exactly one logical message. Reuse with different
      // content is a caller contract violation, not an idempotent replay.
      if (found.content !== params.content) {
        throw new ClientKeyConflictError(params.clientKey);
      }
      // Idempotent replay: the originally recorded client time, effective
      // time, provenance, and (via the committed hook's durable rows) the
      // originally recorded engagement assessment are returned untouched —
      // a replay never re-classifies time and never re-fires the hook, so
      // it cannot reset user activity or engagement state.
      return mapMessage(found);
    });
    if (hasCommittedHookResult && options?.onUserMessageCommitted) {
      const result = committedHookResult;
      // Fire and forget, after the ingest transaction has committed: a
      // failed notification is logged and swallowed — it never fails the
      // already-durable message.
      try {
        options.onUserMessageCommitted(result);
      } catch (error: unknown) {
        console.warn(
          `[conversation] post-ingest notification handler failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    return message;
  }

  async function claimNextTurn(
    params: ClaimParams,
  ): Promise<ClaimOutcome> {
    if (!(params.leaseSeconds > 0)) {
      throw new Error("leaseSeconds must be greater than zero");
    }
    if (params.owner.length === 0) {
      throw new Error("owner must be a non-empty lease token");
    }
    return withTransaction(pool, async (client) => {
      // Serialize claims (and ingestion, see `appendUserMessage`) across
      // worker processes. The advisory lock is always taken before any row
      // lock, so participants cannot deadlock on each other's row locks.
      await client.query("SELECT pg_advisory_xact_lock($1)", [
        CLAIM_ADVISORY_LOCK_KEY,
      ]);

      // 1. Recovery first: reclaim the oldest in-flight turn whose lease has
      //    expired (crashed or stalled worker). Same turn, new attempt.
      const expired = await client.query<{ id: string; attempt: number }>(
        `SELECT id, attempt FROM conversation_turn
         WHERE status = 'in_flight' AND lease_expires_at <= now()
         ORDER BY created_at, id
         LIMIT 1
         FOR UPDATE SKIP LOCKED`,
      );
      const expiredTurn = expired.rows[0];
      if (expiredTurn !== undefined) {
        const reclaimed = await client.query<TurnRow>(
          `UPDATE conversation_turn
           SET attempt = attempt + 1,
               lease_owner = $2,
               lease_expires_at = now() + make_interval(secs => $3::double precision)
           WHERE id = $1
           RETURNING ${TURN_COLUMNS}`,
          [expiredTurn.id, params.owner, params.leaseSeconds],
        );
        const turnRow = reclaimed.rows[0];
        if (turnRow === undefined) {
          throw new Error("reclaim updated no turn row");
        }
        // A reclaim is a new attempt: the previous attempt is closed as
        // superseded inside the same transaction as the lease replacement,
        // so a crashed old worker cannot be counted on to mark itself —
        // and its own later fenced writes can never reopen or finalize the
        // row (its writes guard on finished_at IS NULL).
        await client.query(
          `UPDATE trace_attempt
           SET finished_at = now(), outcome = 'superseded'
           WHERE turn_id = $1 AND finished_at IS NULL`,
          [turnRow.id],
        );
        await client.query(
          `INSERT INTO trace_attempt (turn_id, attempt, lease_owner)
           VALUES ($1, $2, $3)`,
          [turnRow.id, turnRow.attempt, params.owner],
        );
        const messages = await client.query<MessageRow>(
          `SELECT ${MESSAGE_COLUMNS} FROM conversation_message
           WHERE turn_id = $1
           ORDER BY seq`,
          [turnRow.id],
        );
        return {
          kind: "claimed",
          work: {
            turn: mapTurn(turnRow),
            messages: messages.rows.map(mapMessage),
          },
        };
      }

      // 2. A healthy in-flight turn (valid lease) blocks new claims so reply
      //    order stays identical to turn order.
      const busy = await client.query(
        `SELECT 1 FROM conversation_turn WHERE status = 'in_flight' LIMIT 1`,
      );
      if (busy.rows.length > 0) {
        return { kind: "idle" };
      }

      // 3. Existing in-flight work is recovered above even while the routine
      // says unavailable. Only a brand-new grouped turn is subject to this
      // optional gate, evaluated inside the same serialized transaction.
      if (params.canStartNewTurn !== undefined &&
          !(await params.canStartNewTurn(client))) {
        return { kind: "idle" };
      }

      // 4. Group the entire unassigned trailing run of user messages into one
      //    new in-flight turn. Rows locked here are exactly the snapshot; a
      //    message ingested after this SELECT is grouped into the next turn.
      const pending = await client.query<MessageRow>(
        `SELECT ${MESSAGE_COLUMNS} FROM conversation_message
         WHERE turn_id IS NULL AND role = 'user'
         ORDER BY seq
         FOR UPDATE`,
      );
      if (pending.rows.length === 0) {
        return { kind: "idle" };
      }
      // The message-row lock above can wait behind another transaction. Sample
      // the schedule again after that wait so a claim cannot cross a departure
      // boundary using the earlier pre-lock clock; expired-turn recovery above
      // remains intentionally independent of this admission gate.
      if (params.canStartNewTurn !== undefined &&
          !(await params.canStartNewTurn(client))) {
        return { kind: "idle" };
      }
      const turnId = randomUUID();
      const turn = await client.query<TurnRow>(
        `INSERT INTO conversation_turn (id, lease_owner, lease_expires_at, created_at)
         VALUES ($1, $2, now() + make_interval(secs => $3::double precision), clock_timestamp())
         RETURNING ${TURN_COLUMNS}`,
        [turnId, params.owner, params.leaseSeconds],
      );
      const turnRow = turn.rows[0];
      if (turnRow === undefined) {
        throw new Error("turn insert returned no row");
      }
      // The first attempt's trace row is created inside the claim
      // transaction, so attempts are always correlated with the turn.
      await client.query(
        `INSERT INTO trace_attempt (turn_id, attempt, lease_owner)
         VALUES ($1, $2, $3)`,
        [turnRow.id, turnRow.attempt, params.owner],
      );
      await client.query(
        `UPDATE conversation_message
         SET turn_id = $1
         WHERE turn_id IS NULL AND seq = ANY($2::bigint[])`,
        [turnId, pending.rows.map((row) => Number(row.seq))],
      );
      return {
        kind: "claimed",
        work: {
          turn: mapTurn(turnRow),
          messages: pending.rows.map(mapMessage),
        },
      };
    });
  }

  async function renewLease(params: RenewLeaseParams): Promise<boolean> {
    if (!(params.leaseSeconds > 0)) {
      throw new Error("leaseSeconds must be greater than zero");
    }
    const result = await pool.query<{ id: string }>(
      `UPDATE conversation_turn
       SET lease_expires_at = now() + make_interval(secs => $1::double precision)
       WHERE id = $2 AND status = 'in_flight'
         AND lease_owner = $3 AND lease_expires_at > now()
       RETURNING id`,
      [params.leaseSeconds, params.turnId, params.leaseOwner],
    );
    return result.rows.length > 0;
  }

  /**
   * Finds the caller's open attempt row (created at claim time) while
   * verifying the caller still holds a valid lease on the in-flight turn.
   * Returns the attempt id or null when the write is fenced out.
   */
  async function findOpenAttempt(
    client: PostgresPoolClient,
    turnId: string,
    leaseOwner: string,
  ): Promise<string | null> {
    const result = await client.query<{ attempt_id: string }>(
      `SELECT a.id AS attempt_id
       FROM trace_attempt a
       JOIN conversation_turn t ON t.id = a.turn_id
       WHERE a.turn_id = $1 AND a.lease_owner = $2 AND a.finished_at IS NULL
         AND t.status = 'in_flight' AND t.lease_owner = $2
         AND t.lease_expires_at > now()`,
      [turnId, leaseOwner],
    );
    const row = result.rows[0];
    return row?.attempt_id ?? null;
  }

  /**
   * The caller's open attempt row without turn-state checks. Only for use
   * inside transactions that have already fenced the turn transition
   * themselves (publish/fail): at that point the turn no longer reads as
   * `in_flight`, so the ordinary fencing lookup above can never match.
   */
  async function findOpenAttemptAfterTransition(
    client: PostgresPoolClient,
    turnId: string,
    leaseOwner: string,
  ): Promise<string | null> {
    const result = await client.query<{ attempt_id: string }>(
      `SELECT id AS attempt_id FROM trace_attempt
       WHERE turn_id = $1 AND lease_owner = $2 AND finished_at IS NULL`,
      [turnId, leaseOwner],
    );
    return result.rows[0]?.attempt_id ?? null;
  }

  /**
   * Records the decision request (the validated native typed request as sent,
   * with the question it asks) before the provider call. Deliberate, not
   * best-effort: without it the boundary record would exist only for attempts
   * whose provider call succeeded, so a transport failure would leave no
   * request behind. Fenced: only the current lease holder of an in-flight
   * turn may record it. Idempotent per attempt; a duplicate request is a
   * harmless overwrite of the request fields and never touches the outcome or
   * the separately recorded selection.
   */
  async function recordDecisionRequest(
    params: RecordDecisionRequestParams,
  ): Promise<boolean> {
    return withTransaction(pool, async (client) => {
      const attemptId = await findOpenAttempt(
        client,
        params.turnId,
        params.leaseOwner,
      );
      if (attemptId === null) {
        return false;
      }
      await insertDecisionRequestTrace(client, attemptId, params.trace);
      return true;
    });
  }

  /**
   * Records the available decision outcome after the provider call: the
   * native typed response (`responded`), the actual transport error
   * (`failed`), or the contract validation error (`invalid`) — always before
   * the selection step, so a rejected selection still leaves every response
   * detail behind. Failure and invalid writes are best-effort: recording them
   * must never displace the turn's own failure handling. Fenced: only the
   * current lease holder of an in-flight turn may record it. Idempotent per
   * attempt; a duplicate outcome is a harmless overwrite of the outcome
   * fields and never resets the separately recorded selection outcome.
   */
  async function recordDecisionOutcome(
    params: RecordDecisionOutcomeParams,
  ): Promise<boolean> {
    return withTransaction(pool, async (client) => {
      const attemptId = await findOpenAttempt(
        client,
        params.turnId,
        params.leaseOwner,
      );
      if (attemptId === null) {
        return false;
      }
      await insertDecisionOutcomeTrace(client, attemptId, params.payload);
      return true;
    });
  }

  /**
   * Records how the selection step resolved: the chosen pattern (fenced, in
   * its own transaction — the turn's `selected_pattern_id` write), or the
   * rejection with its reason. Separate from the boundary so the boundary's
   * recorded response is never overwritten or invented over.
   */
  async function recordDecisionSelection(
    params: RecordDecisionSelectionParams,
  ): Promise<boolean> {
    return withTransaction(pool, async (client) => {
      if (params.selection.kind === "selected") {
        // Fenced pattern selection on the turn: only the current lease
        // holder of an in-flight turn may record it.
        const result = await client.query<{ id: string }>(
          `UPDATE conversation_turn
           SET selected_pattern_id = $2
           WHERE id = $1 AND status = 'in_flight'
             AND lease_owner = $3 AND lease_expires_at > now()
           RETURNING id`,
          [
            params.turnId,
            params.selection.patternId,
            params.leaseOwner,
          ],
        );
        if (result.rows.length === 0) {
          return false;
        }
      } else {
        // An article-memory selection writes no turn state (it is not a
        // response pattern), and a rejection writes no turn state either;
        // both are still fenced by the same in-flight lease the boundary and
        // other records use.
        const current = await client.query<{ id: string }>(
          `SELECT id FROM conversation_turn
           WHERE id = $1 AND status = 'in_flight'
             AND lease_owner = $2 AND lease_expires_at > now()`,
          [params.turnId, params.leaseOwner],
        );
        if (current.rows.length === 0) {
          return false;
        }
      }
      const attemptId = await findOpenAttempt(
        client,
        params.turnId,
        params.leaseOwner,
      );
      if (attemptId === null) {
        return true;
      }
      // The trace column records the selection in its own vocabulary: an
      // article-memory selection — a chosen reaction, or the legitimate
      // no-action `none` outcome — is a `selected` on its own question's row
      // (the choice column already carries the chosen option id, `none`
      // included), so a successful selection is never misrecorded as a
      // rejection.
      const selectionValue =
        params.selection.kind === "selected-article" ||
        params.selection.kind === "selected-none"
          ? "selected"
          : params.selection.kind;
      await client.query(
        `UPDATE trace_attempt_decision
         SET selection = $2,
             rejection_reason = $3
         WHERE attempt_id = $1 AND question_id = $4 AND selection IS NULL`,
        [
          attemptId,
          selectionValue,
          params.selection.kind === "rejected" ? params.selection.reason : null,
          params.questionId,
        ],
      );
      return true;
    });
  }

  /**
   * Writes the decision request record, in state `requested` before the
   * provider call: the question as asked (question id/type, instructions as
   * sent) with the request model. Idempotent per attempt (the attempt row is
   * unique), so a duplicate request is a harmless overwrite of the request
   * fields rather than an error; the outcome step below transitions the same
   * row and never resets the separately recorded selection.
   */
  async function insertDecisionRequestTrace(
    client: PostgresPoolClient,
    attemptId: string,
    payload: DecisionRequestTracePayload,
  ): Promise<void> {
    const question = payload.request.questions[payload.questionId];
    if (question === undefined) {
      throw new Error(
        `decision trace question ${payload.questionId} not present in the request`,
      );
    }
    const instructions =
      typeof question.instructions === "string"
        ? question.instructions
        : JSON.stringify(question.instructions);
    await client.query<{ id: string }>(
      `INSERT INTO trace_attempt_decision
         (attempt_id, state, question_id, question_type, request_model, instructions)
       VALUES ($1, 'requested', $2, $3, $4, $5)
       ON CONFLICT (attempt_id, question_id) DO UPDATE SET
         question_id = EXCLUDED.question_id,
         question_type = EXCLUDED.question_type,
         request_model = EXCLUDED.request_model,
         instructions = EXCLUDED.instructions,
         recorded_at = now()
       RETURNING id`,
      [
        attemptId,
        payload.questionId,
        question.type,
        payload.request.model,
        instructions,
      ],
    );
  }

  /**
   * Writes the available decision outcome after the provider call: the native
   * typed response (`responded`), the actual transport error (`failed`), or
   * the contract validation error (`invalid`). The row is upserted with the
   * request fields so the write is self-contained even if the request record
   * was fenced out of an earlier attempt. Idempotent per attempt; the
   * separately recorded selection is never reset.
   */
  async function insertDecisionOutcomeTrace(
    client: PostgresPoolClient,
    attemptId: string,
    payload: DecisionOutcomeTracePayload,
  ): Promise<void> {
    const trace = payload.trace;
    const question = trace.request.questions[trace.questionId];
    if (question === undefined) {
      throw new Error(
        `decision trace question ${trace.questionId} not present in the request`,
      );
    }
    const instructions =
      typeof question.instructions === "string"
        ? question.instructions
        : JSON.stringify(question.instructions);
    const outcome = payload.outcome;
    let state: string;
    let choice: string | null = null;
    let confidence: number | null = null;
    let responseModel: string | null = null;
    let responseProvider: string | null = null;
    let responseId: string | null = null;
    let usageInputTokens: number | null = null;
    let usageOutputTokens: number | null = null;
    let usageCost: number | null = null;
    let errorKind: string | null = null;
    let errorMessage: string | null = null;
    let errorBody: string | null = null;
    let probabilities: Readonly<Record<string, number>> | undefined;
    // Presence is recorded explicitly: a present-but-empty native
    // distribution (zero child rows) must stay distinguishable from an
    // absent one, so "no rows" alone cannot stand in for absence.
    let probabilitiesPresent = false;
    if (outcome.kind === "responded") {
      state = "responded";
      const answer = outcome.trace.response.answers[trace.questionId];
      if (answer === undefined) {
        throw new Error(
          `decision trace answer for ${trace.questionId} not present in the response`,
        );
      }
      if (answer.type === "choice") {
        choice = answer.choice;
        confidence = answer.confidence ?? null;
        probabilities = answer.probabilities;
        probabilitiesPresent = probabilities !== undefined;
      }
      responseModel = outcome.trace.response.model;
      responseProvider = outcome.trace.response.provider ?? null;
      responseId = outcome.trace.response.id ?? null;
      usageInputTokens = outcome.trace.response.usage.input_tokens;
      usageOutputTokens = outcome.trace.response.usage.output_tokens;
      usageCost = outcome.trace.response.usage.cost ?? null;
    } else if (outcome.kind === "failed") {
      state = "failed";
      errorKind = outcome.errorKind;
      errorMessage = outcome.message;
      errorBody = outcome.body;
    } else {
      state = "invalid";
      errorKind = "invalid";
      errorMessage = outcome.message;
    }
    const upserted = await client.query<{ id: string }>(
      `INSERT INTO trace_attempt_decision
         (attempt_id, state, question_id, question_type, request_model, instructions,
          choice, confidence, probabilities_present,
          response_model, response_provider, response_id,
          usage_input_tokens, usage_output_tokens, usage_cost,
          error_kind, error_message, error_body)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
       ON CONFLICT (attempt_id, question_id) DO UPDATE SET
         state = EXCLUDED.state,
         question_id = EXCLUDED.question_id,
         question_type = EXCLUDED.question_type,
         request_model = EXCLUDED.request_model,
         instructions = EXCLUDED.instructions,
         choice = EXCLUDED.choice,
         confidence = EXCLUDED.confidence,
         probabilities_present = EXCLUDED.probabilities_present,
         response_model = EXCLUDED.response_model,
         response_provider = EXCLUDED.response_provider,
         response_id = EXCLUDED.response_id,
         usage_input_tokens = EXCLUDED.usage_input_tokens,
         usage_output_tokens = EXCLUDED.usage_output_tokens,
         usage_cost = EXCLUDED.usage_cost,
         error_kind = EXCLUDED.error_kind,
         error_message = EXCLUDED.error_message,
         error_body = EXCLUDED.error_body,
         recorded_at = now()
       RETURNING id`,
      [
        attemptId,
        state,
        trace.questionId,
        question.type,
        trace.request.model,
        instructions,
        choice,
        confidence,
        probabilitiesPresent,
        responseModel,
        responseProvider,
        responseId,
        usageInputTokens,
        usageOutputTokens,
        usageCost,
        errorKind,
        errorMessage,
        errorBody,
      ],
    );
    const decisionRow = upserted.rows[0];
    if (decisionRow === undefined) {
      throw new Error("decision trace upsert returned no row");
    }
    // Replace the distribution with the freshly recorded one: no rows when
    // the provider returned none, one row per returned option otherwise.
    await client.query(
      `DELETE FROM trace_attempt_decision_probability WHERE decision_id = $1`,
      [decisionRow.id],
    );
    if (probabilities !== undefined) {
      const optionIds = Object.keys(probabilities);
      if (optionIds.length > 0) {
        await client.query(
          `INSERT INTO trace_attempt_decision_probability (decision_id, option_id, value)
           SELECT $1, p.option_id, p.value
           FROM unnest($2::text[], $3::numeric[]) AS p(option_id, value)`,
          [
            decisionRow.id,
            optionIds,
            optionIds.map((optionId) => String(probabilities[optionId])),
          ],
        );
      }
    }
  }

  /**
   * Records the attempt's input snapshot (mutable patterns and the exact
   * ordered context) before the decision step. Fenced: only the current
   * lease holder of the in-flight turn may record it.
   */
  async function recordAttemptSnapshot(
    params: RecordAttemptSnapshotParams,
  ): Promise<boolean> {
    return withTransaction(pool, async (client) => {
      const attemptId = await findOpenAttempt(
        client,
        params.turnId,
        params.leaseOwner,
      );
      if (attemptId === null) {
        return false;
      }
      // Idempotent: a second snapshot of the same attempt is a no-op (the
      // first one is what the attempt actually saw).
      const marked = await client.query<{ id: string }>(
        `UPDATE trace_attempt SET snapshot_recorded_at = now()
         WHERE id = $1 AND snapshot_recorded_at IS NULL
         RETURNING id`,
        [attemptId],
      );
      if (marked.rows.length === 0) {
        return true;
      }
      await writeAttemptSnapshot(client, attemptId, params.snapshot);
      return true;
    });
  }

  /**
   * Writes the attempt's input snapshot rows (idempotently guarded by the
   * caller's snapshot_recorded_at marker). Each row preserves the exact
   * captured content: the pattern rows as they stood and the message ids in
   * conversation order.
   */
  async function writeAttemptSnapshot(
    client: PostgresPoolClient,
    attemptId: string,
    snapshot: AttemptSnapshotPayload,
  ): Promise<void> {
    if (snapshot.patterns.length > 0) {
      await client.query(
        `INSERT INTO trace_attempt_pattern
           (attempt_id, position, pattern_id, selection_description, response_guidance)
         SELECT $1, s.position, s.pattern_id, s.selection_description, s.response_guidance
         FROM unnest($2::int[], $3::text[], $4::text[], $5::text[])
              AS s(position, pattern_id, selection_description, response_guidance)`,
        [
          attemptId,
          snapshot.patterns.map((pattern) => pattern.position),
          snapshot.patterns.map((pattern) => pattern.id),
          snapshot.patterns.map((pattern) => pattern.selectionDescription),
          snapshot.patterns.map((pattern) => pattern.responseGuidance),
        ],
      );
    }
    if (snapshot.context.length > 0) {
      await client.query(
        `INSERT INTO trace_attempt_context (attempt_id, position, message_id)
         SELECT $1, s.position, s.message_id
         FROM unnest($2::int[], $3::uuid[]) AS s(position, message_id)`,
        [
          attemptId,
          snapshot.context.map((_, index) => index),
          snapshot.context.map((message) => message.id),
        ],
      );
    }
  }

  /**
   * Writes the chat request record: the exact request as sent, with per-message
   * source linkage, in state `requested` before the provider call. Fenced and
   * idempotent per attempt; the outcome step below transitions the same row.
   */
  async function insertChatRequestTrace(
    client: PostgresPoolClient,
    attemptId: string,
    payload: ChatRequestTracePayload,
  ): Promise<void> {
    if (payload.messageSources.length !== payload.request.messages.length) {
      throw new Error(
        "chat trace messageSources must align with the request messages",
      );
    }
    if (payload.messageChunks.length !== payload.request.messages.length) {
      throw new Error(
        "chat trace messageChunks must align with the request messages",
      );
    }
    const chat = await client.query<{ id: string }>(
      `INSERT INTO trace_attempt_chat
         (attempt_id, state, request_model, temperature, max_tokens,
          identity_revision)
       VALUES ($1, 'requested', $2, $3, $4, $5)
       ON CONFLICT (attempt_id) DO UPDATE SET
         request_model = EXCLUDED.request_model,
         temperature = EXCLUDED.temperature,
         max_tokens = EXCLUDED.max_tokens,
         identity_revision = EXCLUDED.identity_revision,
         recorded_at = now()
       RETURNING id`,
      [
        attemptId,
        payload.request.model,
        payload.request.temperature ?? null,
        payload.request.max_tokens ?? null,
        payload.identityRevision,
      ],
    );
    const chatRow = chat.rows[0];
    if (chatRow === undefined) {
      throw new Error("chat trace upsert returned no row");
    }
    // Re-write the exact messages each time: the request is the attempt's
    // boundary fact, recorded as sent.
    await client.query(
      `DELETE FROM trace_attempt_chat_message WHERE chat_id = $1`,
      [chatRow.id],
    );
    if (payload.request.messages.length > 0) {
      await client.query(
        `INSERT INTO trace_attempt_chat_message
           (chat_id, position, role, content, source_message_id, chunk)
         SELECT $1, s.position, s.role, s.content, s.source_message_id, s.chunk
         FROM unnest($2::int[], $3::text[], $4::text[], $5::uuid[], $6::text[])
              AS s(position, role, content, source_message_id, chunk)`,
        [
          chatRow.id,
          payload.request.messages.map((_, index) => index),
          payload.request.messages.map((message) => message.role),
          payload.request.messages.map((message) => message.content),
          payload.messageSources.map((source) => source),
          payload.messageChunks.map((chunk) => chunk),
        ],
      );
    }
  }

  /**
   * Writes the available chat outcome after the provider call: the response
   * (`responded`), the actual transport error (`failed`), or the contract
   * validation error (`invalid`). A `responded` record carries the
   * application usability verdict separately: `applicationRejection` names
   * the reason the application rejected an arrived response (e.g. no
   * choices) while the response itself is still recorded in full. The row is
   * upserted with the request fields so the write is self-contained even if
   * the request record was fenced out of an earlier attempt. Idempotent per
   * attempt.
   */
  async function insertChatOutcomeTrace(
    client: PostgresPoolClient,
    attemptId: string,
    payload: ChatOutcomeTracePayload,
  ): Promise<void> {
    if (payload.messageSources.length !== payload.request.messages.length) {
      throw new Error(
        "chat trace messageSources must align with the request messages",
      );
    }
    if (payload.messageChunks.length !== payload.request.messages.length) {
      throw new Error(
        "chat trace messageChunks must align with the request messages",
      );
    }
    const outcome = payload.outcome;
    let state: string;
    let responseId: string | null = null;
    let responseModel: string | null = null;
    let replyContent: string | null = null;
    let applicationRejection: string | null = null;
    let errorKind: string | null = null;
    let errorMessage: string | null = null;
    let errorBody: string | null = null;
    let usagePromptTokens: number | null = null;
    let usageCompletionTokens: number | null = null;
    let usageTotalTokens: number | null = null;
    if (outcome.kind === "responded") {
      state = "responded";
      responseId = outcome.response.id ?? null;
      responseModel = outcome.response.model;
      replyContent = outcome.replyContent;
      applicationRejection = outcome.applicationRejection;
      usagePromptTokens = outcome.response.usage?.prompt_tokens ?? null;
      usageCompletionTokens = outcome.response.usage?.completion_tokens ?? null;
      usageTotalTokens = outcome.response.usage?.total_tokens ?? null;
    } else if (outcome.kind === "failed") {
      state = "failed";
      errorKind = outcome.errorKind;
      errorMessage = outcome.message;
      errorBody = outcome.body;
    } else {
      state = "invalid";
      errorKind = "invalid";
      errorMessage = outcome.message;
    }
    const chat = await client.query<{ id: string }>(
      `INSERT INTO trace_attempt_chat
         (attempt_id, state, request_model, temperature, max_tokens,
          identity_revision,
          response_id, response_model, reply_content, application_rejection,
          error_kind, error_message, error_body,
          usage_prompt_tokens, usage_completion_tokens, usage_total_tokens)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
       ON CONFLICT (attempt_id) DO UPDATE SET
         state = EXCLUDED.state,
         request_model = EXCLUDED.request_model,
         temperature = EXCLUDED.temperature,
         max_tokens = EXCLUDED.max_tokens,
         identity_revision = EXCLUDED.identity_revision,
         response_id = EXCLUDED.response_id,
         response_model = EXCLUDED.response_model,
         reply_content = EXCLUDED.reply_content,
         application_rejection = EXCLUDED.application_rejection,
         error_kind = EXCLUDED.error_kind,
         error_message = EXCLUDED.error_message,
         error_body = EXCLUDED.error_body,
         usage_prompt_tokens = EXCLUDED.usage_prompt_tokens,
         usage_completion_tokens = EXCLUDED.usage_completion_tokens,
         usage_total_tokens = EXCLUDED.usage_total_tokens,
         recorded_at = now()
       RETURNING id`,
      [
        attemptId,
        state,
        payload.request.model,
        payload.request.temperature ?? null,
        payload.request.max_tokens ?? null,
        payload.identityRevision,
        responseId,
        responseModel,
        replyContent,
        applicationRejection,
        errorKind,
        errorMessage,
        errorBody,
        usagePromptTokens,
        usageCompletionTokens,
        usageTotalTokens,
      ],
    );
    const chatRow = chat.rows[0];
    if (chatRow === undefined) {
      throw new Error("chat trace upsert returned no row");
    }
    // Re-write the exact messages and choices each time: the request and
    // response are the attempt's boundary facts, recorded as returned.
    await client.query(
      `DELETE FROM trace_attempt_chat_message WHERE chat_id = $1`,
      [chatRow.id],
    );
    if (payload.request.messages.length > 0) {
      await client.query(
        `INSERT INTO trace_attempt_chat_message
           (chat_id, position, role, content, source_message_id, chunk)
         SELECT $1, s.position, s.role, s.content, s.source_message_id, s.chunk
         FROM unnest($2::int[], $3::text[], $4::text[], $5::uuid[], $6::text[])
              AS s(position, role, content, source_message_id, chunk)`,
        [
          chatRow.id,
          payload.request.messages.map((_, index) => index),
          payload.request.messages.map((message) => message.role),
          payload.request.messages.map((message) => message.content),
          payload.messageSources.map((source) => source),
          payload.messageChunks.map((chunk) => chunk),
        ],
      );
    }
    await client.query(
      `DELETE FROM trace_attempt_chat_choice WHERE chat_id = $1`,
      [chatRow.id],
    );
    if (outcome.kind === "responded" && outcome.response.choices.length > 0) {
      await client.query(
        `INSERT INTO trace_attempt_chat_choice (chat_id, position, finish_reason, content)
         SELECT $1, s.position, s.finish_reason, s.content
         FROM unnest($2::int[], $3::text[], $4::text[]) AS s(position, finish_reason, content)`,
        [
          chatRow.id,
          outcome.response.choices.map((_, index) => index),
          outcome.response.choices.map((choice) => choice.finish_reason ?? null),
          outcome.response.choices.map((choice) => choice.message.content),
        ],
      );
    }
  }

  /**
   * Records the attempt's chat request (exact messages + source linkage)
   * before the provider call. Fenced: only the current lease holder of the
   * in-flight turn may record it. Idempotent per attempt.
   */
  async function recordChatRequest(
    params: RecordChatRequestParams,
  ): Promise<boolean> {
    return withTransaction(pool, async (client) => {
      const attemptId = await findOpenAttempt(
        client,
        params.turnId,
        params.leaseOwner,
      );
      if (attemptId === null) {
        return false;
      }
      await insertChatRequestTrace(client, attemptId, params.payload);
      return true;
    });
  }

  /**
   * Records the available chat outcome after the provider call, before
   * publication: the response (`responded`), the actual transport error
   * (`failed`), or the contract validation error (`invalid`). Fenced and
   * idempotent per attempt. Failing here must fail the attempt, not publish
   * an unrecorded boundary.
   */
  async function recordChatOutcome(
    params: RecordChatOutcomeParams,
  ): Promise<boolean> {
    return withTransaction(pool, async (client) => {
      const attemptId = await findOpenAttempt(
        client,
        params.turnId,
        params.leaseOwner,
      );
      if (attemptId === null) {
        return false;
      }
      await insertChatOutcomeTrace(client, attemptId, params.payload);
      return true;
    });
  }

  async function publishScheduledAssistantMessage(params: {
    readonly prepare: (
      client: PostgresPoolClient,
    ) => Promise<PreparedAssistantMessage | null>;
  }): Promise<boolean> {
    return withTransaction(pool, async (client) => {
      // Use the same serialization point as user ingest and turn claims. This
      // publishes a schedule notice as a normal assistant thread message, but
      // never groups or claims queued user messages.
      await client.query("SELECT pg_advisory_xact_lock($1)", [
        CLAIM_ADVISORY_LOCK_KEY,
      ]);
      const active = await client.query(
        `SELECT 1 FROM conversation_turn WHERE status = 'in_flight' LIMIT 1`,
      );
      if (active.rows.length > 0) return false;

      // Acquire the message-table write lock before preparing and sampling the
      // final publication time, so a DDL lock wait cannot carry a stale notice
      // across its configured return boundary.
      await client.query(`LOCK TABLE conversation_message IN ROW EXCLUSIVE MODE`);
      const prepared = await params.prepare(client);
      if (prepared === null) return false;
      const clock = await client.query<{ now: Date }>(
        "SELECT clock_timestamp() AS now",
      );
      const publishedAt = clock.rows[0]?.now;
      if (!(publishedAt instanceof Date) || !Number.isFinite(publishedAt.getTime())) {
        throw new Error("assistant notice publication clock returned no valid timestamp");
      }
      if (prepared.validUntil !== null && publishedAt.getTime() >= prepared.validUntil.getTime()) {
        await prepared.cancel(client, publishedAt);
        return false;
      }
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO conversation_message
           (role, content, turn_id, created_at, effective_at, time_source,
            client_time_status, server_received_at, thread_order)
         VALUES ('assistant', $1, NULL, $2, $2, 'server', 'absent', $2,
                 nextval('conversation_thread_order_seq'))
         RETURNING id`,
        [prepared.content, publishedAt],
      );
      const message = inserted.rows[0];
      if (message === undefined) throw new Error("assistant notice insert returned no row");
      await prepared.recordPublication(client, message.id, publishedAt);
      return true;
    });
  }

  async function publishReply(
    params: PublishReplyParams,
  ): Promise<PublishOutcome> {
    return withTransaction(pool, async (client) => {
      // Serialize assistant publication with ingestion, claiming, and
      // schedule-owned assistant messages before taking the turn row lock.
      await client.query("SELECT pg_advisory_xact_lock($1)", [
        CLAIM_ADVISORY_LOCK_KEY,
      ]);
      // Fenced transition: only the current lease holder of an in-flight turn
      // may complete it and persist the reply, and both happen atomically.
      const guard = await client.query<{ id: string }>(
        `UPDATE conversation_turn
         SET status = 'completed', completed_at = now()
         WHERE id = $1 AND status = 'in_flight'
           AND lease_owner = $2 AND lease_expires_at > now()
         RETURNING id`,
        [params.turnId, params.leaseOwner],
      );
      if (guard.rows.length === 1) {
        // Assistant replies carry no client time: the server receive time is
        // their effective time (absent client time, recorded provenance).
        // Assistant messages are not user activity and never touch the
        // engagement domain.
        await client.query(
          `INSERT INTO conversation_message
             (role, content, turn_id, effective_at, time_source,
              client_time_status, server_received_at)
           VALUES ('assistant', $1, $2, now(), 'server', 'absent', now())`,
          [params.content, params.turnId],
        );
        if (params.onPublicationTransaction !== undefined) {
          await client.query("SAVEPOINT optional_publication_hook");
          try {
            await params.onPublicationTransaction(client);
            await client.query("RELEASE SAVEPOINT optional_publication_hook");
          } catch {
            // Optional domain writes must be atomic with themselves but cannot
            // prevent a valid reply from publishing. Savepoint rollback keeps
            // a partial set of answer updates from leaking into the commit.
            await client.query("ROLLBACK TO SAVEPOINT optional_publication_hook");
            await client.query("RELEASE SAVEPOINT optional_publication_hook");
            console.warn(
              "[CONVERSATION] optional publication transaction hook failed; reply published without optional updates",
            );
          }
        }
        const attemptId = await findOpenAttemptAfterTransition(
          client,
          params.turnId,
          params.leaseOwner,
        );
        if (attemptId !== null) {
          await client.query(
            `UPDATE trace_attempt
             SET finished_at = now(), outcome = 'published'
             WHERE id = $1 AND finished_at IS NULL`,
            [attemptId],
          );
        }
        return "published";
      }
      // Fenced out, or this exact publication already succeeded earlier
      // (e.g. after a crash with unknown outcome). Distinguish the two so a
      // duplicate attempt is an idempotent no-op, not an error.
      const turn = await client.query<{ status: string }>(
        `SELECT status FROM conversation_turn WHERE id = $1`,
        [params.turnId],
      );
      const status = turn.rows[0]?.status;
      if (status === "completed") {
        const reply = await client.query<{ id: string }>(
          `SELECT id FROM conversation_message
           WHERE turn_id = $1 AND role = 'assistant'`,
          [params.turnId],
        );
        return reply.rows.length > 0 ? "already_published" : "fenced";
      }
      return "fenced";
    });
  }

  async function failTurn(params: FailTurnParams): Promise<FailOutcome> {
    return withTransaction(pool, async (client) => {
      const result = await client.query<{ id: string }>(
        `UPDATE conversation_turn
         SET status = 'failed', error = $2
         WHERE id = $1 AND status = 'in_flight'
           AND lease_owner = $3 AND lease_expires_at > now()
         RETURNING id`,
        [params.turnId, params.error, params.leaseOwner],
      );
      if (result.rows.length === 0) {
        return "fenced";
      }
      const attemptId = await findOpenAttemptAfterTransition(
        client,
        params.turnId,
        params.leaseOwner,
      );
      if (attemptId !== null) {
        if (params.snapshot !== undefined) {
          await writeAttemptSnapshot(client, attemptId, params.snapshot);
        }
        await client.query(
          `UPDATE trace_attempt
           SET finished_at = now(), outcome = 'failed'
           WHERE id = $1 AND finished_at IS NULL`,
          [attemptId],
        );
      }
      return "failed";
    });
  }

  /**
   * Marks the caller's own attempt row fenced: a stale worker that lost its
   * lease records its attempt as superseded without touching the turn's
   * state. Safe against concurrent writers (guarded by finished_at).
   */
  async function markAttemptFenced(params: {
    turnId: string;
    leaseOwner: string;
  }): Promise<boolean> {
    const result = await pool.query<{ id: string }>(
      `UPDATE trace_attempt
       SET finished_at = now(), outcome = 'fenced'
       WHERE turn_id = $1 AND lease_owner = $2 AND finished_at IS NULL
         AND EXISTS (
           SELECT 1 FROM conversation_turn t
           WHERE t.id = trace_attempt.turn_id
             AND (t.status <> 'in_flight'
                  OR t.lease_owner <> trace_attempt.lease_owner)
         )
       RETURNING id`,
      [params.turnId, params.leaseOwner],
    );
    return result.rows.length > 0;
  }

  // ---------------------------------------------------------------------------
  // Read-only trace report assembly
  // ---------------------------------------------------------------------------

  interface AttemptRow {
    id: string;
    attempt: number;
    lease_owner: string;
    claimed_at: Date;
    finished_at: Date | null;
    outcome: string | null;
    snapshot_recorded_at: Date | null;
  }

  interface DecisionRow {
    id: string;
    state: string;
    question_id: string;
    question_type: string;
    request_model: string;
    instructions: string;
    choice: string | null;
    confidence: string | null;
    probabilities_present: boolean;
    selection: string | null;
    rejection_reason: string | null;
    response_model: string | null;
    response_provider: string | null;
    response_id: string | null;
    usage_input_tokens: number | null;
    usage_output_tokens: number | null;
    usage_cost: string | null;
    error_kind: string | null;
    error_message: string | null;
    error_body: string | null;
    recorded_at: Date;
  }

  interface ChatRow {
    state: string;
    request_model: string;
    temperature: string | null;
    max_tokens: number | null;
    identity_revision: number | null;
    response_id: string | null;
    response_model: string | null;
    reply_content: string | null;
    application_rejection: string | null;
    error_kind: string | null;
    error_message: string | null;
    error_body: string | null;
    usage_prompt_tokens: number | null;
    usage_completion_tokens: number | null;
    usage_total_tokens: number | null;
    recorded_at: Date;
  }

  /**
   * Assembles a turn's full trace report from one read-only repeatable-read
   * transaction on a single pooled client: every query sees the same
   * committed snapshot, so the turn row and every attempt and boundary row
   * are mutually consistent even while publication or failure finalization
   * commits concurrently. READ ONLY is enforced by the server, not caller
   * discipline: any write inside the transaction fails.
   */
  async function getTurnTraceReport(
    params: TurnTraceParams,
  ): Promise<TurnTraceReport> {
    return withTransaction(
      pool,
      async (client) => {
        const turnResult = await client.query<TurnRow>(
          `SELECT ${TURN_COLUMNS} FROM conversation_turn WHERE id = $1`,
          [params.turnId],
        );
        const turnRow = turnResult.rows[0];
        if (turnRow === undefined) {
          throw new Error(`turn ${params.turnId} not found`);
        }
        const attemptsResult = await client.query<AttemptRow>(
          `SELECT id, attempt, lease_owner, claimed_at, finished_at, outcome,
                  snapshot_recorded_at
           FROM trace_attempt WHERE turn_id = $1 ORDER BY attempt`,
          [params.turnId],
        );
        const attempts: TurnAttemptTrace[] = [];
        for (const attemptRow of attemptsResult.rows) {
          // Context snapshot: the exact ordered messages the attempt saw.
          const contextResult = await client.query<{
            position: number;
            message_id: string;
            seq: string;
            role: string;
            content: string;
            is_turn_message: boolean;
          }>(
            `SELECT c.position, m.id AS message_id, m.seq, m.role, m.content,
                    (m.turn_id = $2) AS is_turn_message
             FROM trace_attempt_context c
             JOIN conversation_message m ON m.id = c.message_id
             WHERE c.attempt_id = $1
             ORDER BY c.position`,
            [attemptRow.id, params.turnId],
          );
          // Pattern snapshot: the mutable configuration as it stood.
          const patternsResult = await client.query<{
            position: number;
            pattern_id: string;
            selection_description: string;
            response_guidance: string;
          }>(
            `SELECT position, pattern_id, selection_description, response_guidance
             FROM trace_attempt_pattern WHERE attempt_id = $1 ORDER BY position`,
            [attemptRow.id],
          );
          // Decision traces: one row per (attempt, question) since the
          // article-share question joined the per-turn decision request.
          // Every row is reported in `decisions`; the response-pattern row
          // stays the legacy `decision` (falling back to the only row for
          // single-question attempts).
          const decisionResult = await client.query<DecisionRow>(
            `SELECT id, state, question_id, question_type, request_model, instructions,
                    choice, confidence, probabilities_present, selection, rejection_reason,
                    response_model, response_provider,
                    response_id, usage_input_tokens, usage_output_tokens,
                    usage_cost, error_kind, error_message, error_body,
                    recorded_at
             FROM trace_attempt_decision WHERE attempt_id = $1
             ORDER BY question_id`,
            [attemptRow.id],
          );
          const decisions: TraceDecision[] = [];
          for (const decisionRow of decisionResult.rows) {
            const probabilitiesResult = await client.query<{
              option_id: string;
              value: string;
            }>(
              `SELECT option_id, value
               FROM trace_attempt_decision_probability
               WHERE decision_id = $1 ORDER BY option_id`,
              [decisionRow.id],
            );
            decisions.push({
              state: decisionRow.state,
              questionId: decisionRow.question_id,
              questionType: decisionRow.question_type,
              requestModel: decisionRow.request_model,
              instructions: decisionRow.instructions,
              choice: decisionRow.choice,
              confidence: decisionRow.confidence !== null ? Number(decisionRow.confidence) : null,
              probabilitiesPresent: decisionRow.probabilities_present,
              selection: decisionRow.selection,
              rejectionReason: decisionRow.rejection_reason,
              responseModel: decisionRow.response_model,
              responseProvider: decisionRow.response_provider,
              responseId: decisionRow.response_id,
              usageInputTokens: decisionRow.usage_input_tokens,
              usageOutputTokens: decisionRow.usage_output_tokens,
              usageCost: decisionRow.usage_cost !== null ? Number(decisionRow.usage_cost) : null,
              errorKind: decisionRow.error_kind,
              errorMessage: decisionRow.error_message,
              errorBody: decisionRow.error_body,
              probabilities: probabilitiesResult.rows.map((row) => ({
                optionId: row.option_id,
                value: Number(row.value),
              })),
              recordedAt: decisionRow.recorded_at.toISOString(),
            });
          }
          const decision =
            decisions.find((entry) => entry.questionId === "response_pattern") ??
            decisions[0] ??
            null;
          // Chat trace (one row per attempt, when the chat was recorded).
          const chatResult = await client.query<ChatRow>(
            `SELECT state, request_model, temperature, max_tokens,
                    identity_revision, response_id,
                    response_model, reply_content, application_rejection,
                    error_kind, error_message,
                    error_body, usage_prompt_tokens,
                    usage_completion_tokens, usage_total_tokens, recorded_at
             FROM trace_attempt_chat WHERE attempt_id = $1`,
            [attemptRow.id],
          );
          let chat: TraceChat | null = null;
          const chatRow = chatResult.rows[0];
          if (chatRow !== undefined) {
            const chatMessagesResult = await client.query<{
              position: number;
              role: string;
              content: string;
              source_message_id: string | null;
              chunk: string | null;
            }>(
              `SELECT position, role, content, source_message_id, chunk
               FROM trace_attempt_chat_message WHERE chat_id = (
                 SELECT id FROM trace_attempt_chat WHERE attempt_id = $1
               ) ORDER BY position`,
              [attemptRow.id],
            );
            const chatChoicesResult = await client.query<{
              position: number;
              finish_reason: string | null;
              content: string;
            }>(
              `SELECT position, finish_reason, content
               FROM trace_attempt_chat_choice WHERE chat_id = (
                 SELECT id FROM trace_attempt_chat WHERE attempt_id = $1
               ) ORDER BY position`,
              [attemptRow.id],
            );
            chat = {
              requestModel: chatRow.request_model,
              temperature: chatRow.temperature !== null ? Number(chatRow.temperature) : null,
              maxTokens: chatRow.max_tokens,
              identityRevision:
                chatRow.identity_revision === null
                  ? null
                  : Number(chatRow.identity_revision),
              responseId: chatRow.response_id,
              state: chatRow.state,
              errorKind: chatRow.error_kind,
              errorMessage: chatRow.error_message,
              errorBody: chatRow.error_body,
              responseModel: chatRow.response_model,
              replyContent: chatRow.reply_content,
              applicationRejection: chatRow.application_rejection,
              usagePromptTokens: chatRow.usage_prompt_tokens,
              usageCompletionTokens: chatRow.usage_completion_tokens,
              usageTotalTokens: chatRow.usage_total_tokens,
              messages: chatMessagesResult.rows.map((row) => ({
                position: row.position,
                role: row.role as TraceChatMessage["role"],
                content: row.content,
                sourceMessageId: row.source_message_id,
                chunk: row.chunk as TraceChatMessage["chunk"],
              })),
              choices: chatChoicesResult.rows.map((row) => ({
                position: row.position,
                finishReason: row.finish_reason,
                content: row.content,
              })),
              recordedAt: chatRow.recorded_at.toISOString(),
            };
          }
          attempts.push({
            id: attemptRow.id,
            turnId: params.turnId,
            attempt: attemptRow.attempt,
            leaseOwner: attemptRow.lease_owner,
            claimedAt: attemptRow.claimed_at.toISOString(),
            finishedAt: attemptRow.finished_at?.toISOString() ?? null,
            outcome: attemptRow.outcome as TurnAttemptTrace["outcome"],
            snapshotRecordedAt: attemptRow.snapshot_recorded_at?.toISOString() ?? null,
            context: contextResult.rows.map((row) => ({
              position: row.position,
              messageId: row.message_id,
              seq: Number(row.seq),
              role: row.role as TraceContextMessage["role"],
              content: row.content,
              fromTurn: row.is_turn_message,
            })),
            patterns: patternsResult.rows.map((row) => ({
              position: row.position,
              patternId: row.pattern_id,
              selectionDescription: row.selection_description,
              responseGuidance: row.response_guidance,
            })),
            decision,
            decisions,
            chat,
          });
        }
        return { turn: mapTurn(turnRow), attempts };
      },
      { readOnly: true, isolationLevel: "repeatable read" },
    );
  }

  async function getEnabledResponsePatterns(): Promise<
    readonly ResponsePattern[]
  > {
    const result = await pool.query<PatternRow>(
      `SELECT id, selection_description, response_guidance, position
       FROM response_pattern
       WHERE enabled
       ORDER BY position, id`,
    );
    return result.rows.map(mapPattern);
  }

  /**
   * The owner-authored chat identity, read fresh per turn so owner edits
   * take effect on the next turn without a restart. Fail-closed: the
   * identity is required configuration, and a missing or empty row is an
   * `IdentityConfigurationError` — never a silently-degraded prompt or an
   * invented persona. (The table's CHECK constraint already forbids empty
   * content; the loader check keeps the failure honest even against a
   * schema that predates it.)
   */
  async function getChatIdentity(): Promise<ChatIdentity> {
    const result = await pool.query<{
      content: string;
      revision: number;
    }>(
      `SELECT content, revision FROM chat_identity WHERE id = 'identity'`,
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new IdentityConfigurationError(
        "chat_identity has no 'identity' row; provision the owner-authored identity before chat can run",
      );
    }
    if (row.content.trim().length === 0) {
      throw new IdentityConfigurationError(
        "chat_identity row 'identity' has empty content; provision non-empty identity text",
      );
    }
    return { content: row.content, revision: Number(row.revision) };
  }

  /**
   * Prior-turn context for a claimed turn, oldest first, bounded to the
   * last `limit` messages in conversation order.
   *
   * The snapshot is a pure function of `turnId` and `limit`: the messages
   * of exactly the turns claimed before this one (completed or failed —
   * a failed turn is terminal in this slice, but its user messages stay
   * part of the visible thread; they appear without a reply), ordered by
   * conversation order.
   *
   * Conversation order is not raw `seq` order. Under finish-then-group
   * semantics a user message that arrives while a turn is generating is
   * grouped into the *next* turn, so its `seq` is lower than that
   * previous turn's reply (published later). The reply still precedes
   * that message conversationally. Ordering therefore reconstructs the
   * thread by persisted turn/publication order: each turn and standalone
   * assistant notice receives an ordinal from one shared sequence while
   * holding the conversation serialization lock. All messages in a turn use
   * the turn's ordinal and retain their `seq` order; a notice uses its own
   * publication ordinal. Thus a user message queued before a notice cannot
   * drag the later-claimed turn ahead of that notice.
   *
   * Excluded from the snapshot:
   * - unassigned user messages (`turn_id IS NULL`): they belong to a future
   *   turn and must never leak into an earlier turn's context; standalone
   *   assistant schedule announcements are the exception and are included;
   * - the requested turn's own messages: the caller appends them
   *   separately, so including them would duplicate them;
   * - messages of turns claimed after this one: they are later
   *   conversationally, whatever their `seq`.
   *
   * Because exclusion and ordering are keyed by turn association rather
   * than by a raw-`seq` cutoff or lease state, the snapshot is identical
   * on every attempt of the same turn, including after a lease reclaim,
   * and is unaffected by messages ingested after the claim.
   */
  async function getThreadContext(params: ThreadContextParams): Promise<
    readonly ConversationMessage[]
  > {
    const result = await pool.query<MessageRow>(
      `WITH current_turn AS (
         SELECT t.thread_order
         FROM conversation_turn AS t
         WHERE t.id = $1
       ), prior_turn_message AS (
         SELECT ${MESSAGE_COLUMNS_FROM_M}, t.thread_order,
                min(m.seq) OVER (PARTITION BY m.turn_id) AS turn_first_seq
         FROM conversation_message AS m
         JOIN conversation_turn AS t ON t.id = m.turn_id
         WHERE m.turn_id IS NOT NULL
       ), prior_context AS (
         SELECT id, seq, role, content, turn_id, client_key, created_at,
                client_sent_at, effective_at, time_source, client_time_status,
                server_received_at, thread_order
         FROM prior_turn_message
         WHERE turn_id <> $1
           AND thread_order < (SELECT thread_order FROM current_turn)
         UNION ALL
         SELECT m.id, m.seq, m.role, m.content, m.turn_id, m.client_key,
                m.created_at, m.client_sent_at, m.effective_at, m.time_source,
                m.client_time_status, m.server_received_at, m.thread_order
         FROM conversation_message AS m
         WHERE m.turn_id IS NULL AND m.role = 'assistant'
           AND m.thread_order < (SELECT thread_order FROM current_turn)
       )
       SELECT id, seq, role, content, turn_id, client_key, created_at,
              client_sent_at, effective_at, time_source, client_time_status,
              server_received_at
       FROM prior_context
       ORDER BY thread_order DESC, seq DESC
       LIMIT $2`,
      [params.turnId, params.limit],
    );
    return result.rows.map(mapMessage).reverse();
  }

  /**
   * One bounded page of the whole thread, oldest first, in persisted `seq`
   * order — the read model for client history loading and reconciliation.
   *
   * Why pages instead of an incremental `seq > watermark` read: a reply's
   * `seq` is drawn at insert time inside the publication transaction, but
   * the row only becomes visible at commit. A user message ingested between
   * those moments commits first with a higher `seq`, so a poller that
   * already observed that message and later polls with `seq > watermark`
   * would never see the reply committed behind its watermark (its `seq` is
   * lower). Pages read a bounded seq range and let the consumer reconcile
   * by message `id`, which is immune to that ordering.
   *
   * Page selection: without `before`, the newest `limit` messages; with
   * `before`, the `limit` messages with the highest `seq` strictly below
   * that bound. Walking `before = oldestSeq` from the newest page therefore
   * pages backwards through the whole history, and `hasMore` (false once a
   * page reaches the bottom) terminates the walk.
   *
   * Concurrency: page rows and the `hasMore`/`oldestSeq` bounds are computed
   * in ONE statement, so they come from one read-committed snapshot — the
   * flag cannot disagree with the page it describes. A message whose
   * transaction commits during the read is simply absent from both; a
   * consumer that re-derives the gaps between its loaded seqs each cycle
   * (see `ThreadStatus` for the allocation invariant) recovers it on a
   * later read.
   */
  async function getThreadPage(params: ThreadPageParams): Promise<ThreadPage> {
    if (!(Number.isInteger(params.limit) && params.limit > 0)) {
      throw new Error("limit must be a positive integer");
    }
    if (
      params.before !== undefined &&
      !(Number.isInteger(params.before) && params.before >= 1)
    ) {
      throw new Error("before must be a positive integer seq bound");
    }
    const result = await pool.query<
      MessageRow & { page_oldest_seq: string | null; has_more: boolean }
    >(
      `WITH page AS (
         SELECT id, seq, role, content, turn_id, client_key, created_at,
                client_sent_at, effective_at, time_source, client_time_status,
                server_received_at
         FROM conversation_message
         WHERE ($2::bigint IS NULL OR seq < $2::bigint)
         ORDER BY seq DESC
         LIMIT $1
       ), bounds AS (
         SELECT
           (SELECT min(seq) FROM page) AS page_oldest_seq,
           EXISTS (
             SELECT 1 FROM conversation_message
             WHERE seq < COALESCE(
               (SELECT min(seq) FROM page), $2::bigint
             )
           ) AS has_more
       )
       SELECT p.id, p.seq, p.role, p.content, p.turn_id, p.client_key,
              p.created_at, p.client_sent_at, p.effective_at, p.time_source,
              p.client_time_status, p.server_received_at,
              b.page_oldest_seq, b.has_more
       FROM page p CROSS JOIN bounds b
       ORDER BY p.seq ASC`,
      [params.limit, params.before ?? null],
    );
    const firstRow = result.rows[0];
    const oldestSeq =
      firstRow !== undefined && firstRow.page_oldest_seq !== null
        ? Number(firstRow.page_oldest_seq)
        : null;
    return {
      messages: result.rows.map(mapMessage),
      oldestSeq,
      hasMore: firstRow !== undefined ? firstRow.has_more : false,
    };
  }

  /**
   * Generic thread-level work status for polling consumers, in one
   * statement so its parts describe one consistent moment:
   *
   * - how many user messages are still unassigned (queued for a future
   *   turn);
   * - whether a turn is currently in flight (reply not yet published);
   * - the highest allocated `seq` (see `ThreadStatus`) — the identity
   *   sequence this domain owns is read directly, without consuming a
   *   value; it includes seqs of in-flight and burned (rolled-back)
   *   inserts, and its contiguity (drawing seq N draws 1..N) is what lets
   *   consumers reason soundly about the seqs below any page;
   * - whether the trailing state includes a failed turn. Scope: a failed
   *   turn counts as recent while it is claimed after the most recently
   *   completed turn (turn order equals first-message `seq` order — see
   *   `getThreadContext` — so the comparison is deterministic), or when
   *   nothing has completed yet. Once a later turn completes, the earlier
   *   failure is history and the flag clears. The error text itself never
   *   leaves the domain through this method.
   */
  async function getThreadStatus(): Promise<ThreadStatus> {
    const result = await pool.query<{
      queued: string;
      generating: boolean;
      allocated_high: string;
      has_recent_failure: boolean;
    }>(
      `SELECT
         (SELECT count(*) FROM conversation_message
          WHERE role = 'user' AND turn_id IS NULL) AS queued,
         EXISTS (SELECT 1 FROM conversation_turn WHERE status = 'in_flight')
           AS generating,
         (SELECT CASE WHEN s.is_called THEN s.last_value ELSE 0 END
            FROM conversation_message_seq_seq s) AS allocated_high,
         EXISTS (
           SELECT 1 FROM conversation_turn f
           WHERE f.status = 'failed'
             AND (SELECT min(m.seq) FROM conversation_message m
                  WHERE m.turn_id = f.id)
               > COALESCE((
                   SELECT max(c.first_seq) FROM (
                     SELECT min(cm.seq) AS first_seq
                     FROM conversation_turn ct
                     JOIN conversation_message cm ON cm.turn_id = ct.id
                     WHERE ct.status = 'completed'
                     GROUP BY ct.id
                   ) c
                 ), 0)
         ) AS has_recent_failure`,
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new Error("thread status query returned no row");
    }
    return {
      queuedUserMessages: Number(row.queued),
      generating: row.generating,
      highestAllocatedSeq: Number(row.allocated_high),
      hasRecentFailure: row.has_recent_failure,
    };
  }

  return {
    appendUserMessage,
    claimNextTurn,
    renewLease,
    recordAttemptSnapshot,
    recordDecisionRequest,
    recordDecisionOutcome,
    recordDecisionSelection,
    recordChatRequest,
    recordChatOutcome,
    publishReply,
    publishScheduledAssistantMessage,
    failTurn,
    markAttemptFenced,
    getEnabledResponsePatterns,
    getChatIdentity,
    getThreadContext,
    getThreadPage,
    getThreadStatus,
    getTurnTraceReport,
  };
}
