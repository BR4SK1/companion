/**
 * Temporal summary persistence and prompt-context assembly.
 *
 * Summaries are keyed by (kind, period_key) and regenerated only when the
 * source fingerprint changes. The stored timezone comes from the provisioned
 * behavioral configuration, and every served summary is validated against it.
 * The prompt context is assembled from the near-term prompt periods only (see
 * `periods.ts`), with a strict validity check so a late or stale document can
 * never be injected under a current natural-language label. The `text` field
 * additionally carries the v1 profile sheets (`<profile_memories>`, source
 * surface parity); the chat prompt consumes `recentText` (recent temporal
 * leaves) plus the v2 observation profiles, never this v1 block.
 */

import { createHash } from "node:crypto";
import { withTransaction, type PostgresPool } from "@companion/postgres";

import { TEMPORAL_SUMMARY_PROMPT_VERSION, PROFILE_SUMMARY_PROMPT_VERSION } from "../prompts.ts";
import type { BehaviorTime } from "../time.ts";
import type {
  ProfileSummary,
  TemporalPeriod,
  TemporalPromptContext,
  TemporalPromptItem,
  TemporalSummary,
} from "../types.ts";
import { getPromptTemporalPeriods } from "./periods.ts";

export function fingerprint(parts: readonly string[]): string {
  return createHash("sha256").update(parts.join("\n")).digest("hex");
}

interface SummaryRow {
  id: string;
  kind: string;
  period_key: string;
  timezone: string;
  start_at: Date;
  end_at: Date;
  content: string;
  message_count: number;
  fingerprint: string;
  selection_version: string | null;
  child_summary_keys: string[];
  selected_pair_ids: string[];
  segment_pair_counts: number[];
  model: string;
  prompt_version: string;
  prompt_content_hash: string;
  generated_at: Date;
  input_tokens: number;
  output_tokens: number;
  call_count: number;
  status: string;
}

function toSummary(
  row: SummaryRow,
  messageIds: readonly string[],
): TemporalSummary {
  return {
    id: row.id,
    kind: row.kind as TemporalSummary["kind"],
    periodKey: row.period_key,
    timezone: row.timezone,
    startAt: row.start_at,
    endAt: row.end_at,
    content: row.content,
    messageCount: row.message_count,
    fingerprint: row.fingerprint,
    selectionVersion: row.selection_version,
    childSummaryKeys: row.child_summary_keys,
    model: row.model,
    promptVersion: row.prompt_version,
    generatedAt: row.generated_at,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    callCount: row.call_count,
    status: row.status as "complete" | "failed",
    messageIds,
    selectedPairIds: row.selected_pair_ids,
    segmentPairCounts: row.segment_pair_counts,
  };
}

export async function getTemporalSummary(
  pool: PostgresPool,
  period: TemporalPeriod,
): Promise<TemporalSummary | null> {
  const result = await pool.query<SummaryRow>(
    `SELECT id, kind, period_key, timezone, start_at, end_at, content,
            message_count, fingerprint, selection_version, child_summary_keys,
            selected_pair_ids, segment_pair_counts,
            model, prompt_version, prompt_content_hash, generated_at,
            input_tokens, output_tokens, call_count, status
     FROM memory_temporal_summary
     WHERE kind = $1 AND period_key = $2`,
    [period.kind, period.periodKey],
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  // Source-message provenance lives in the links table; a cached summary
  // must carry it so the served document keeps its aggregate evidence chain.
  const links = await pool.query<{ message_id: string }>(
    `SELECT message_id FROM memory_temporal_summary_message
     WHERE summary_id = $1 ORDER BY position`,
    [row.id],
  );
  return toSummary(row, links.rows.map((link) => link.message_id));
}

/** Diagnostics carried alongside the summary content when saving. */
export interface TemporalSummarySaveInput {
  readonly period: TemporalPeriod;
  /** The behavioral timezone the period was computed in (provisioned config). */
  readonly timezone: string;
  readonly content: string;
  readonly messageCount: number;
  readonly fingerprint: string;
  readonly selectionVersion: string | null;
  readonly selectedPairIds: readonly string[];
  readonly segmentPairCounts: readonly number[];
  readonly withTurnLog: number | null;
  readonly childSummaryKeys: readonly string[];
  readonly model: string;
  readonly promptVersion: string;
  /** Content hash of the exact prompt text used; checked at serve time so a
   *  DB edit of the same-version prompt row never serves old prose. */
  readonly promptContentHash: string;
  readonly generatedAt: Date;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly callCount: number;
  /** Message ids linked to leaf summaries (source evidence, child table). */
  readonly messageIds: readonly string[];
  readonly status: "complete" | "failed";
  readonly error?: string;
}

export async function saveTemporalSummary(
  pool: PostgresPool,
  input: TemporalSummarySaveInput,
): Promise<void> {
  const { period } = input;
  // One transaction: the summary upsert and its message links commit together,
  // so a crash can never leave a summary whose links are partially replaced
  // (the reader would then serve a summary citing messages it does not list).
  await withTransaction(pool, async (client) => {
    await client.query(
      `INSERT INTO memory_temporal_summary
         (kind, period_key, timezone, start_at, end_at, content, message_count,
          fingerprint, selection_version, selected_pair_ids, segment_pair_counts,
          with_turn_log, child_summary_keys, model, prompt_version,
          prompt_content_hash, generated_at,
          input_tokens, output_tokens, call_count, status, error)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
               $16, $17, $18, $19, $20, $21, $22)
       ON CONFLICT (kind, period_key) DO UPDATE SET
         timezone = EXCLUDED.timezone,
         start_at = EXCLUDED.start_at,
         end_at = EXCLUDED.end_at,
         content = EXCLUDED.content,
         message_count = EXCLUDED.message_count,
         fingerprint = EXCLUDED.fingerprint,
         selection_version = EXCLUDED.selection_version,
         selected_pair_ids = EXCLUDED.selected_pair_ids,
         segment_pair_counts = EXCLUDED.segment_pair_counts,
         with_turn_log = EXCLUDED.with_turn_log,
         child_summary_keys = EXCLUDED.child_summary_keys,
         model = EXCLUDED.model,
         prompt_version = EXCLUDED.prompt_version,
         prompt_content_hash = EXCLUDED.prompt_content_hash,
         generated_at = EXCLUDED.generated_at,
         input_tokens = EXCLUDED.input_tokens,
         output_tokens = EXCLUDED.output_tokens,
         call_count = EXCLUDED.call_count,
         status = EXCLUDED.status,
         error = EXCLUDED.error,
         updated_at = now()`,
      [
        period.kind,
        period.periodKey,
        input.timezone,
        period.startAt,
        period.endAt,
        input.content,
        input.messageCount,
        input.fingerprint,
        input.selectionVersion,
        input.selectedPairIds,
        input.segmentPairCounts,
        input.withTurnLog,
        input.childSummaryKeys,
        input.model,
        input.promptVersion,
        input.promptContentHash,
        input.generatedAt,
        input.inputTokens,
        input.outputTokens,
        input.callCount,
        input.status,
        input.error ?? null,
      ],
    );

    if (input.messageIds.length > 0) {
      const summaryId = (await client.query<{ id: string }>(
        `SELECT id FROM memory_temporal_summary WHERE kind = $1 AND period_key = $2`,
        [period.kind, period.periodKey],
      )).rows[0]?.id;
      if (summaryId !== undefined) {
        await client.query(
          `DELETE FROM memory_temporal_summary_message WHERE summary_id = $1`,
          [summaryId],
        );
        await client.query(
          `INSERT INTO memory_temporal_summary_message (summary_id, position, message_id)
           SELECT $1::uuid, i.ord - 1, i.message_id
           FROM unnest($2::uuid[]) WITH ORDINALITY AS i(message_id, ord)`,
          [summaryId, input.messageIds],
        );
      }
    }
  });
}

/** Persisted v1 profile summary, including its error field. */
export interface StoredProfileSummary extends ProfileSummary {
  readonly error: string | null;
}

export async function getProfileSummary(
  pool: PostgresPool,
  subjectId: string,
): Promise<StoredProfileSummary | null> {
  const result = await pool.query<{
    subject_id: string;
    content: string;
    source_summary_keys: string[];
    source_fingerprint: string;
    model: string;
    prompt_version: string;
    status: string;
    error: string | null;
    generated_at: Date;
  }>(
    `SELECT subject_id, content, source_summary_keys, source_fingerprint, model,
            prompt_version, status, error, generated_at
     FROM memory_profile_summary WHERE subject_id = $1`,
    [subjectId],
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  return {
    subject: row.subject_id,
    content: row.content,
    sourceSummaryKeys: row.source_summary_keys,
    sourceFingerprint: row.source_fingerprint,
    model: row.model,
    promptVersion: row.prompt_version,
    status: row.status as "complete" | "failed",
    error: row.error,
    generatedAt: row.generated_at,
  };
}

export async function saveProfileSummary(
  pool: PostgresPool,
  summary: StoredProfileSummary,
): Promise<void> {
  await pool.query(
    `INSERT INTO memory_profile_summary
       (subject_id, content, source_summary_keys, source_fingerprint, model,
        prompt_version, status, error, generated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (subject_id) DO UPDATE SET
       content = EXCLUDED.content,
       source_summary_keys = EXCLUDED.source_summary_keys,
       source_fingerprint = EXCLUDED.source_fingerprint,
       model = EXCLUDED.model,
       prompt_version = EXCLUDED.prompt_version,
       status = EXCLUDED.status,
       error = EXCLUDED.error,
       generated_at = EXCLUDED.generated_at,
       updated_at = now()`,
    [
      summary.subject,
      summary.content,
      summary.sourceSummaryKeys,
      summary.sourceFingerprint,
      summary.model,
      summary.promptVersion,
      summary.status,
      summary.error,
      summary.generatedAt,
    ],
  );
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const TAG_BY_LEAF_KIND = {
  night: "last_night",
  morning: "this_morning",
  afternoon: "this_afternoon",
} as const;

/**
 * Assemble the temporal + v1-profile prompt context. Every served summary is
 * validated against its period's current boundaries, timezone, prompt
 * version, and closure: a period key alone is not enough, so a late or stale
 * document cannot be injected under a current label. Subject tags use the
 * configured subject ids; no subject name is code content.
 *
 * When `expected` is provided, each served summary must additionally have
 * been generated under the current model and the current prompt content
 * (checked against the stored `model` / `prompt_content_hash`): a changed
 * generation model or a DB edit of the same-version prompt row excludes the
 * stored document from the prompt context until regeneration.
 */
export async function getTemporalSummaryPromptContext(
  pool: PostgresPool,
  subjects: readonly { id: string; profileEnabled: boolean }[],
  now: Date,
  behavior: BehaviorTime,
  expected?: {
    readonly model: string;
    readonly promptContentHash: string;
  },
): Promise<TemporalPromptContext> {
  const periods = getPromptTemporalPeriods(now, behavior);
  const periodKeys = periods.map((candidate) => candidate.periodKey);
  const docs = await pool.query<SummaryRow>(
    `SELECT id, kind, period_key, timezone, start_at, end_at, content,
            message_count, fingerprint, selection_version, child_summary_keys,
            selected_pair_ids, segment_pair_counts,
            model, prompt_version, prompt_content_hash, generated_at,
            input_tokens, output_tokens, call_count, status
     FROM memory_temporal_summary
     WHERE status = 'complete' AND period_key = ANY($1::text[])`,
    [periodKeys],
  );
  const byKey = new Map(docs.rows.map((row) => [row.period_key, row]));
  const valid: Array<{ period: TemporalPeriod; summary: TemporalSummary }> = [];

  for (const candidate of periods) {
    const row = byKey.get(candidate.periodKey);
    if (row === undefined) continue;
    const boundariesMatch =
      row.kind === candidate.kind &&
      row.period_key === candidate.periodKey &&
      row.timezone === behavior.timezone &&
      row.status === "complete" &&
      typeof row.content === "string" &&
      row.content.trim().length > 0 &&
      row.message_count > 0 &&
      row.prompt_version === TEMPORAL_SUMMARY_PROMPT_VERSION &&
      // Serve-time generation-settings gate (when the caller supplies the
      // current settings): the document must come from this model and this
      // exact prompt content.
      (expected === undefined ||
        (row.model === expected.model &&
          row.prompt_content_hash === expected.promptContentHash)) &&
      row.start_at.getTime() === candidate.startAt.getTime() &&
      row.end_at.getTime() === candidate.endAt.getTime() &&
      now.getTime() >= candidate.endAt.getTime();
    if (boundariesMatch) {
      // Provenance read-back for served summaries too (one batched query).
      const links = await pool.query<{ message_id: string }>(
        `SELECT message_id FROM memory_temporal_summary_message
         WHERE summary_id = $1 ORDER BY position`,
        [row.id],
      );
      valid.push({
        period: candidate,
        summary: toSummary(row, links.rows.map((link) => link.message_id)),
      });
    }
  }

  const profileSections: string[] = [];
  const profileRows = await pool.query<{
    subject_id: string;
    content: string;
    prompt_version: string;
    status: string;
  }>(
    `SELECT subject_id, content, prompt_version, status
     FROM memory_profile_summary
     WHERE status = 'complete' AND subject_id = ANY($1::text[])`,
    [subjects.filter((subject) => subject.profileEnabled).map((subject) => subject.id)],
  );
  for (const row of profileRows.rows) {
    if (
      row.content &&
      row.prompt_version === PROFILE_SUMMARY_PROMPT_VERSION
    ) {
      profileSections.push(
        `<${row.subject_id}_profile>\n${escapeXml(row.content)}\n</${row.subject_id}_profile>`,
      );
    }
  }

  const tagByKind = TAG_BY_LEAF_KIND;
  const recentEntries = valid.flatMap(({ period, summary }) => {
    if (
      period.kind !== "night" &&
      period.kind !== "morning" &&
      period.kind !== "afternoon"
    ) {
      return [];
    }
    const tag = tagByKind[period.kind];
    const date = period.periodKey.slice(0, 10);
    return [{
      section: `<${tag} date="${escapeXml(date)}">\n${escapeXml(summary.content)}\n</${tag}>`,
      summaryItem: {
        kind: period.kind,
        periodKey: period.periodKey,
        contentLength: summary.content.length,
      } satisfies TemporalPromptItem,
    }];
  });
  const recentSections = recentEntries.map((entry) => entry.section);
  const recentSummaries = recentEntries.map((entry) => entry.summaryItem);
  const recentText = recentSections.length > 0
    ? `<recent_memories>\n${recentSections.join("\n")}\n</recent_memories>`
    : undefined;

  if (profileSections.length === 0 && recentSections.length === 0) {
    return { summaries: [], recentSummaries: [] };
  }

  const blocks = [
    ...(profileSections.length > 0
      ? [`<profile_memories>\n${profileSections.join("\n")}\n</profile_memories>`]
      : []),
    ...(recentSections.length > 0 ? [recentText as string] : []),
  ];

  return {
    text: blocks.join("\n\n"),
    recentText,
    summaries: valid.map(({ period }) => ({
      kind: period.kind,
      periodKey: period.periodKey,
      contentLength: byKey.get(period.periodKey)?.content.length ?? 0,
    })),
    recentSummaries,
  };
}
