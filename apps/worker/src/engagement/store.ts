/**
 * Domain-owned queries for the engagement domain.
 *
 * Ownership note: this store belongs to the engagement domain, currently
 * hosted by the worker deployable as a peer to memory. It owns its own
 * typed relational tables and reads conversation message timing by foreign
 * key — the same cross-domain read shape memory uses for source turns.
 *
 * The state model: there is no mutable "current engagement" row. The
 * effective state is always recomputed on read from the LAST user message's
 * effective time (the last-activity clock, written once at ingest) and that
 * message's own recorded assessment (the retention floor). Recomputation on
 * read is what advances the state during silence, recovers after restarts,
 * and fences stale callbacks — nothing mutates engagement state from a
 * timer, and no reader can overwrite a newer state because there is nothing
 * to overwrite.
 *
 * Per-message assessments are the only engagement writes, and they happen
 * exactly once per new user message, inside the conversation store's
 * serialized ingest transaction (advisory-locked): the hook observes the
 * immediately-preceding user message and its assessment in the same
 * snapshot the message commits in. Assistant messages and idempotent
 * replays never write assessments, so user activity and recorded values
 * are never reset.
 */

import type {
  PostgresPool,
} from "@companion/postgres";

import { assessMessage, stateAt } from "./runtime.ts";
import type {
  EngagementBandMs,
  EngagementState,
  EngagementStore,
  EngagementSummary,
  EngagementTxClient,
  MessageAssessment,
} from "./types.ts";

interface AssessmentRow {
  message_id: string;
  state: string;
  previous_state: string | null;
  silence_ms: string | null;
  retained_lull: boolean;
  message_effective_at: Date;
  lull_ms: string;
  idle_ms: string;
  gone_ms: string;
  assessed_at: Date;
}

interface PreviousUserRow {
  id: string;
  effective_at: Date;
  previous_state: string | null;
}

/** The last user message with its own recorded assessment state, if any. */
interface LastUserRow {
  id: string;
  effective_at: Date;
  assessment_state: string | null;
}

function mapAssessment(row: AssessmentRow): MessageAssessment {
  return {
    messageId: row.message_id,
    state: row.state as EngagementState,
    previousState:
      row.previous_state === null
        ? null
        : (row.previous_state as EngagementState),
    silenceMs: row.silence_ms === null ? null : Number(row.silence_ms),
    retainedLull: row.retained_lull,
    messageEffectiveAt: row.message_effective_at.toISOString(),
    bands: {
      lullMs: Number(row.lull_ms),
      idleMs: Number(row.idle_ms),
      goneMs: Number(row.gone_ms),
    },
    assessedAt: row.assessed_at.toISOString(),
  };
}

const ASSESSMENT_COLUMNS =
  "message_id, state, previous_state, silence_ms, retained_lull, " +
  "message_effective_at, lull_ms, idle_ms, gone_ms, assessed_at";

export interface CreateEngagementStoreParams {
  readonly pool: PostgresPool;
  readonly bands: EngagementBandMs;
}

export function createEngagementStore(
  params: CreateEngagementStoreParams,
): EngagementStore {
  const { pool, bands } = params;

  async function onUserMessageInserted(
    tx: EngagementTxClient,
    input: {
      messageId: string;
      effectiveAt: Date;
      serverReceivedAt: Date;
    },
  ): Promise<MessageAssessment> {
    // The immediately-preceding user message and its recorded assessment
    // state, in one query. Runs on the ingest transaction's own client, so
    // it sees the just-inserted (not yet committed) message row, and the
    // ingest advisory lock serializes this read with every other ingest —
    // the snapshot is the serialized thread order.
    const previous = await tx.query<PreviousUserRow>(
      `SELECT prev.id, prev.effective_at, prior_assessment.state AS previous_state
       FROM conversation_message prev
       LEFT JOIN engagement_message_assessment prior_assessment
         ON prior_assessment.message_id = prev.id
       WHERE prev.role = 'user'
         AND prev.seq < (SELECT seq FROM conversation_message WHERE id = $1)
       ORDER BY prev.seq DESC
       LIMIT 1`,
      [input.messageId],
    );
    const previousRow = previous.rows[0];

    const assessment = assessMessage({
      messageEffectiveAt: input.effectiveAt,
      previousUserMessageAt: previousRow?.effective_at ?? null,
      previousAssessmentState:
        (previousRow?.previous_state as EngagementState | undefined) ?? null,
      bands,
    });

    const inserted = await tx.query<AssessmentRow>(
      `INSERT INTO engagement_message_assessment
         (message_id, state, previous_state, silence_ms, retained_lull,
          message_effective_at, lull_ms, idle_ms, gone_ms)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING ${ASSESSMENT_COLUMNS}`,
      [
        input.messageId,
        assessment.state,
        assessment.previousState,
        assessment.silenceMs,
        assessment.retainedLull,
        input.effectiveAt,
        bands.lullMs,
        bands.idleMs,
        bands.goneMs,
      ],
    );
    const row = inserted.rows[0];
    if (row === undefined) {
      throw new Error(
        `engagement assessment insert returned no row for message ${input.messageId}`,
      );
    }
    return mapAssessment(row);
  }

  async function getAssessmentForMessage(
    messageId: string,
  ): Promise<MessageAssessment | null> {
    const result = await pool.query<AssessmentRow>(
      `SELECT ${ASSESSMENT_COLUMNS}
       FROM engagement_message_assessment
       WHERE message_id = $1`,
      [messageId],
    );
    const row = result.rows[0];
    return row === undefined ? null : mapAssessment(row);
  }

  async function getAssessmentForTurn(
    turnId: string,
  ): Promise<MessageAssessment | null> {
    // The assessment of the LAST user message of the turn's grouped
    // messages, in thread order — the actual last message, selected first,
    // then its assessment or absence. Stable across retries and reclaims:
    // it is a recorded row, not a recomputation. A mixed turn (an earlier
    // assessed message followed by an unassessed last message — possible
    // when engagement was provisioned between ingestion and claim) reports
    // the LAST message's absence, never an earlier message's assessment.
    const latest = await pool.query<{ id: string }>(
      `SELECT id FROM conversation_message
       WHERE turn_id = $1 AND role = 'user'
       ORDER BY seq DESC
       LIMIT 1`,
      [turnId],
    );
    const row = latest.rows[0];
    if (row === undefined) {
      return null;
    }
    return getAssessmentForMessage(row.id);
  }

  async function getSummary(observedAt: Date): Promise<EngagementSummary> {
    // The last user message — the last-activity anchor — with its own
    // recorded assessment state (null for pre-engagement history). The
    // effective state is the deeper of the activity band (silence measured
    // from this message's effective time) and the message's assessment, so
    // a single return message never overwrites the state to `engaged`
    // while inactivity transitions still measure from the last activity.
    // Everything is recomputed from durable rows; recorded assessments keep
    // the values they were computed with, so later band-configuration
    // changes never move history.
    const last = await pool.query<LastUserRow>(
      `SELECT m.id, m.effective_at, a.state AS assessment_state
       FROM conversation_message m
       LEFT JOIN engagement_message_assessment a ON a.message_id = m.id
       WHERE m.role = 'user'
       ORDER BY m.seq DESC
       LIMIT 1`,
    );
    const lastRow = last.rows[0];
    const state = stateAt({
      lastUserMessageAt: lastRow?.effective_at ?? null,
      lastAssessmentState:
        (lastRow?.assessment_state as EngagementState | undefined) ?? null,
      observedAt,
      bands,
    });
    return {
      state,
      lastUserMessageId: lastRow?.id ?? null,
      lastUserEffectiveAt:
        lastRow?.effective_at.toISOString() ?? null,
      silenceMs:
        lastRow === undefined
          ? null
          : Math.max(
            0,
            observedAt.getTime() - lastRow.effective_at.getTime(),
          ),
      bands,
    };
  }

  return {
    onUserMessageInserted,
    getAssessmentForMessage,
    getAssessmentForTurn,
    getSummary,
  };
}
