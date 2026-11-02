/**
 * Source-turn loading from the conversation domain.
 *
 * A memory "source turn" is a completed conversation turn: the grouped user
 * messages plus the published assistant reply. The turn is the memory
 * pipeline's unit of work — it maps directly onto the worker's claim-time
 * grouping, so no separate message-grouping heuristic exists here.
 *
 * Selection is watermark-driven for the ingest pipeline (oldest-first,
 * strictly after the watermark position) and recency-driven for
 * consolidation (newest N completed turns).
 */

import type { PostgresPool } from "@companion/postgres";

import { hashPayload } from "./hashing.ts";
import type { SourceTurn } from "./types.ts";

export interface WatermarkPosition {
  readonly turnId: string;
  readonly endAt: Date;
}

interface TurnHeaderRow {
  id: string;
  start_at: Date;
  end_at: Date;
  user_count: string;
  assistant_count: string;
}

interface MessageRow {
  id: string;
  turn_id: string;
  role: string;
  content: string;
  created_at: Date;
}

function compositeKeyOf(turnId: string): string {
  return turnId;
}

/**
 * Strictly-after comparison on the composite (endAt, turnId) position. The
 * watermark is a high-water mark over a contiguous oldest-first walk, so a
 * turn is pending exactly when its position is greater than the watermark.
 */
export function positionAfterWatermark(
  endAt: Date,
  turnId: string,
  watermark: WatermarkPosition,
): boolean {
  const endAtTime = endAt.getTime();
  if (endAtTime !== watermark.endAt.getTime()) {
    return endAtTime > watermark.endAt.getTime();
  }
  return compositeKeyOf(turnId) > compositeKeyOf(watermark.turnId);
}

interface SelectOptions {
  readonly watermark: WatermarkPosition | null;
  readonly maxTurns: number;
  /** A completed turn is only eligible once it has been settled this long. */
  readonly settleMs: number;
  readonly now: Date;
}

async function loadMessagesForTurns(
  pool: PostgresPool,
  turnIds: readonly string[],
): Promise<Map<string, MessageRow[]>> {
  const grouped = new Map<string, MessageRow[]>();
  if (turnIds.length === 0) return grouped;
  const result = await pool.query<MessageRow>(
    `SELECT id, turn_id, role, content, created_at
     FROM conversation_message
     WHERE turn_id = ANY($1::uuid[])
       AND role IN ('user', 'assistant')
     ORDER BY created_at, id`,
    [turnIds],
  );
  for (const row of result.rows) {
    const group = grouped.get(row.turn_id) ?? [];
    group.push(row);
    grouped.set(row.turn_id, group);
  }
  return grouped;
}

function buildSourceTurns(
  headers: ReadonlyArray<{ id: string; start_at: Date; end_at: Date }>,
  messagesByTurn: ReadonlyMap<string, MessageRow[]>,
): SourceTurn[] {
  const turns: SourceTurn[] = [];
  for (const header of headers) {
    const messages = messagesByTurn.get(header.id) ?? [];
    const userText = messages
      .filter((message) => message.role === "user")
      .map((message) => message.content.trim())
      .filter(Boolean)
      .join("\n");
    const assistantText = messages
      .filter((message) => message.role === "assistant")
      .map((message) => message.content.trim())
      .filter(Boolean)
      .join("\n");
    if (!userText || !assistantText || messages.length === 0) continue;
    turns.push({
      turnId: header.id,
      turnKey: header.id,
      startAt: messages[0]!.created_at,
      endAt: messages[messages.length - 1]!.created_at,
      userText,
      assistantText,
      sourceMessageIds: messages.map((message) => message.id),
    });
  }
  return turns.sort((a, b) =>
    a.startAt.getTime() - b.startAt.getTime() ||
    a.turnKey.localeCompare(b.turnKey));
}

/**
 * Select complete, settled completed turns strictly after the watermark,
 * oldest first, capped at maxTurns. Selection is watermark-driven, so every
 * attempt converges on the same remaining work and a failed attempt simply
 * re-runs it. Turns older than the newest processed turn that never completed
 * (e.g. a failed turn with no reply) are skipped, exactly as the source
 * pipeline's high-water mark behaves.
 */
export async function selectTurnsAfterWatermark(
  pool: PostgresPool,
  options: SelectOptions,
): Promise<SourceTurn[]> {
  const settledBefore = new Date(options.now.getTime() - options.settleMs);
  // Fetch a bounded superset: the SQL limit applies before the composite
  // watermark check, so over-fetch to keep the slice exact in the common case.
  const headers = await pool.query<TurnHeaderRow>(
    `SELECT t.id, agg.start_at, agg.end_at, agg.user_count, agg.assistant_count
     FROM conversation_turn t
     JOIN (
       SELECT turn_id,
              min(created_at) AS start_at,
              max(created_at) AS end_at,
              count(*) FILTER (WHERE role = 'user') AS user_count,
              count(*) FILTER (WHERE role = 'assistant') AS assistant_count
       FROM conversation_message
       GROUP BY turn_id
     ) agg ON agg.turn_id = t.id
     WHERE t.status = 'completed'
       AND ($1::timestamptz IS NULL OR agg.end_at >= $1::timestamptz)
     ORDER BY agg.end_at, t.id
     LIMIT $2`,
    [options.watermark?.endAt ?? null, options.maxTurns * 4],
  );

  const candidates = headers.rows
    .filter((row) => Number(row.user_count) > 0 && Number(row.assistant_count) > 0)
    .filter((row) => row.end_at.getTime() <= settledBefore.getTime())
    .filter((row) =>
      options.watermark === undefined || options.watermark === null ||
      positionAfterWatermark(row.end_at, row.id, options.watermark))
    .slice(0, options.maxTurns);

  if (candidates.length === 0) return [];
  const messagesByTurn = await loadMessagesForTurns(pool, candidates.map((row) => row.id));
  return buildSourceTurns(candidates, messagesByTurn);
}

/**
 * The newest completed turn's watermark position, or null when no completed
 * turn exists. Used to initialize the ingest cursor at "now" so a freshly
 * enabled pipeline processes only turns published after it — never
 * pre-existing history.
 */
export async function selectNewestCompletedTurnPosition(
  pool: PostgresPool,
): Promise<WatermarkPosition | null> {
  const result = await pool.query<TurnHeaderRow>(
    `SELECT t.id, agg.end_at, agg.user_count, agg.assistant_count
     FROM conversation_turn t
     JOIN (
       SELECT turn_id,
              max(created_at) AS end_at,
              count(*) FILTER (WHERE role = 'user') AS user_count,
              count(*) FILTER (WHERE role = 'assistant') AS assistant_count
       FROM conversation_message
       GROUP BY turn_id
     ) agg ON agg.turn_id = t.id
     WHERE t.status = 'completed' AND agg.user_count > 0 AND agg.assistant_count > 0
     ORDER BY agg.end_at DESC, t.id DESC
     LIMIT 1`,
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  return { turnId: row.id, endAt: row.end_at };
}

/**
 * Select the newest completed turns for a consolidation run, oldest first in
 * the returned order (newest-first selection, oldest first in the result).
 */
export async function selectLastCompletedTurns(
  pool: PostgresPool,
  maxTurns: number,
): Promise<SourceTurn[]> {
  const headers = await pool.query<TurnHeaderRow>(
    `SELECT t.id, agg.start_at, agg.end_at, agg.user_count, agg.assistant_count
     FROM conversation_turn t
     JOIN (
       SELECT turn_id,
              min(created_at) AS start_at,
              max(created_at) AS end_at,
              count(*) FILTER (WHERE role = 'user') AS user_count,
              count(*) FILTER (WHERE role = 'assistant') AS assistant_count
       FROM conversation_message
       GROUP BY turn_id
     ) agg ON agg.turn_id = t.id
     WHERE t.status = 'completed'
     ORDER BY agg.end_at DESC, t.id DESC
     LIMIT $1`,
    [Math.max(maxTurns * 4, maxTurns)],
  );

  const candidates = headers.rows
    .filter((row) => Number(row.user_count) > 0 && Number(row.assistant_count) > 0)
    .slice(0, maxTurns);

  if (candidates.length === 0) return [];
  const messagesByTurn = await loadMessagesForTurns(pool, candidates.map((row) => row.id));
  return buildSourceTurns(candidates, messagesByTurn);
}

export function sourceFingerprint(turns: readonly SourceTurn[]): string {
  const sorted = [...turns].sort((a, b) => a.turnKey.localeCompare(b.turnKey));
  const hash = hashPayload(
    sorted.map((turn) => ({
      turnKey: turn.turnKey,
      startAt: turn.startAt.toISOString(),
      endAt: turn.endAt.toISOString(),
      userText: turn.userText,
      assistantText: turn.assistantText,
      sourceMessageIds: turn.sourceMessageIds,
    })),
  );
  return hash;
}
