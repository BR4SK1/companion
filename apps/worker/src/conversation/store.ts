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

import type { PostgresPool } from "@companion/postgres";
import { withTransaction } from "@companion/postgres";

import type {
  ConversationMessage,
  ConversationTurn,
  MessageRole,
  ResponsePattern,
  TurnWork,
} from "./types.ts";

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
  "id, seq, role, content, turn_id, client_key, created_at";
const TURN_COLUMNS =
  "id, status, attempt, lease_owner, lease_expires_at, selected_pattern_id, decision, error, created_at, completed_at";

export interface AppendUserMessageParams {
  readonly content: string;
  /** Idempotency key; re-ingesting the same key returns the existing message. */
  readonly clientKey?: string;
}

export type ClaimOutcome =
  | { readonly kind: "claimed"; readonly work: TurnWork }
  | { readonly kind: "idle" };

export interface ClaimParams {
  /** Unique lease owner token for this claim (e.g. a fresh UUID per claim). */
  readonly owner: string;
  readonly leaseSeconds: number;
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
}

export interface FailTurnParams {
  readonly turnId: string;
  readonly leaseOwner: string;
  readonly error: string;
}

export interface RenewLeaseParams {
  readonly turnId: string;
  readonly leaseOwner: string;
  readonly leaseSeconds: number;
}

export interface RecordDecisionParams {
  readonly turnId: string;
  readonly leaseOwner: string;
  readonly selectedPatternId: string | null;
  readonly decision: unknown;
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

export interface ConversationStore {
  appendUserMessage(
    params: AppendUserMessageParams,
  ): Promise<ConversationMessage>;
  claimNextTurn(params: ClaimParams): Promise<ClaimOutcome>;
  renewLease(params: RenewLeaseParams): Promise<boolean>;
  recordTurnDecision(params: RecordDecisionParams): Promise<boolean>;
  publishReply(params: PublishReplyParams): Promise<PublishOutcome>;
  failTurn(params: FailTurnParams): Promise<FailOutcome>;
  getEnabledResponsePatterns(): Promise<readonly ResponsePattern[]>;
  getThreadContext(params: ThreadContextParams): Promise<
    readonly ConversationMessage[]
  >;
}

export function createConversationStore(pool: PostgresPool): ConversationStore {
  async function appendUserMessage(
    params: AppendUserMessageParams,
  ): Promise<ConversationMessage> {
    return withTransaction(pool, async (client) => {
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

      const inserted = await client.query<MessageRow>(
        `INSERT INTO conversation_message (role, content, client_key)
         VALUES ('user', $1, $2)
         ON CONFLICT (client_key) DO NOTHING
         RETURNING ${MESSAGE_COLUMNS}`,
        [params.content, params.clientKey ?? null],
      );
      const row = inserted.rows[0];
      if (row !== undefined) {
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
      return mapMessage(found);
    });
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

      // 3. Group the entire unassigned trailing run of user messages into one
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
      const turnId = randomUUID();
      const turn = await client.query<TurnRow>(
        `INSERT INTO conversation_turn (id, lease_owner, lease_expires_at)
         VALUES ($1, $2, now() + make_interval(secs => $3::double precision))
         RETURNING ${TURN_COLUMNS}`,
        [turnId, params.owner, params.leaseSeconds],
      );
      const turnRow = turn.rows[0];
      if (turnRow === undefined) {
        throw new Error("turn insert returned no row");
      }
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

  async function recordTurnDecision(
    params: RecordDecisionParams,
  ): Promise<boolean> {
    const result = await pool.query<{ id: string }>(
      `UPDATE conversation_turn
       SET selected_pattern_id = $2, decision = $3
       WHERE id = $1 AND status = 'in_flight'
         AND lease_owner = $4 AND lease_expires_at > now()
       RETURNING id`,
      [
        params.turnId,
        params.selectedPatternId,
        JSON.stringify(params.decision ?? null),
        params.leaseOwner,
      ],
    );
    return result.rows.length > 0;
  }

  async function publishReply(
    params: PublishReplyParams,
  ): Promise<PublishOutcome> {
    return withTransaction(pool, async (client) => {
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
        await client.query(
          `INSERT INTO conversation_message (role, content, turn_id)
           VALUES ('assistant', $1, $2)`,
          [params.content, params.turnId],
        );
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
    const result = await pool.query<{ id: string }>(
      `UPDATE conversation_turn
       SET status = 'failed', error = $2
       WHERE id = $1 AND status = 'in_flight'
         AND lease_owner = $3 AND lease_expires_at > now()
       RETURNING id`,
      [params.turnId, params.error, params.leaseOwner],
    );
    return result.rows.length > 0 ? "failed" : "fenced";
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
   * thread per turn: for each turn, in turn order, its user messages in
   * `seq` order followed by its assistant reply. Turn order is the order
   * of the turns' first user-message `seq`, which is strictly increasing
   * in claim order because a claim always groups the entire unassigned
   * run while holding the serialization lock (see `claimNextTurn`) —
   * every message of a later turn has a higher `seq` than every message
   * of an earlier turn, so a later turn (claimed after this one) is
   * excluded by the same first-seq bound that selects prior turns.
   *
   * Excluded from the snapshot:
   * - unassigned messages (`turn_id IS NULL`): they belong to a future
   *   turn and must never leak into an earlier turn's context;
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
      `SELECT id, seq, role, content, turn_id, client_key, created_at
       FROM (
         SELECT ${MESSAGE_COLUMNS},
                min(seq) OVER (PARTITION BY turn_id) AS turn_first_seq
         FROM conversation_message
         WHERE turn_id IS NOT NULL
       ) prior_turn_message
       WHERE turn_id <> $1
         AND turn_first_seq < (
           SELECT min(seq) FROM conversation_message WHERE turn_id = $1
         )
       ORDER BY turn_first_seq DESC, seq DESC
       LIMIT $2`,
      [params.turnId, params.limit],
    );
    return result.rows.map(mapMessage).reverse();
  }

  return {
    appendUserMessage,
    claimNextTurn,
    renewLease,
    recordTurnDecision,
    publishReply,
    failTurn,
    getEnabledResponsePatterns,
    getThreadContext,
  };
}
