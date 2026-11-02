/**
 * Deterministic canonical recall: weighted full-text search over production
 * facts and active canonical observations, blended with recency and
 * evidence-strength boosts, capped by limit and a character budget. No LLM
 * involvement.
 *
 * Ranking is PostgreSQL full text search over the stored content
 * (claim + condition + consequence), backed by the expression GIN indexes
 * the migration defines. Query tokens are OR-joined so recall stays
 * recall-shaped (any term can match); quotes and `$`-prefixed tokens are
 * stripped and leading/trailing dashes are neutralized so a raw user message
 * can never shape the query.
 */

import type { PostgresPool } from "@companion/postgres";

import type { MemoryConfig } from "./config.ts";
import { isValidTimezone } from "./time.ts";
import {
  detectRecallTimeRange,
  type RecallMode,
  type RecallTimeRange,
} from "./recall-time.ts";
import type {
  CanonicalRecallItem,
  CanonicalRecallResponse,
} from "./types.ts";

const MAX_QUERY_CHARS = 512;
export const DEFAULT_RECALL_LIMIT = 8;
const MAX_RESULT_LIMIT = 32;
const DEFAULT_MAX_CHARS = 12_000;
const MAX_MAX_CHARS = 96_000;
/** Observations hold at most half the response slots. */
const MAX_OBSERVATION_SHARE = 0.5;

export class CanonicalRecallValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanonicalRecallValidationError";
  }
}

/**
 * $text-style queries treat quotes and `$`-prefixed tokens as syntax; strip
 * them so a raw user message can never shape the query. Returns '' when
 * nothing searchable remains, which the caller treats as a recency fallback
 * rather than an error.
 */
export function sanitizeTextQuery(query: string): string {
  return query
    .replace(/["']/g, " ")
    .replace(/\$[a-zA-Z]+/g, " ")
    .replace(/\$/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Build the PostgreSQL tsquery text: sanitized tokens OR-joined, with dashes
 * neutralized so a token can never act as a websearch negation.
 */
export function buildTsQueryText(sanitized: string): string {
  const tokens = sanitized
    .split(" ")
    .map((token) => token.replace(/^-+|-+$/g, ""))
    .filter((token) => token.length > 0);
  return tokens.join(" OR ");
}

/**
 * Recency multiplier in (0, 1] with a configurable half-life. Durable
 * preferences age slowly: recency breaks ties and lifts fresh facts, it never
 * filters. The weight relative to the text score is configurable.
 */
export function recencyBoost(
  observedAt: Date,
  referenceTime: Date,
  halfLifeDays: number,
): number {
  const ageDays = Math.max(
    0,
    (referenceTime.getTime() - observedAt.getTime()) / 86_400_000,
  );
  return Math.pow(0.5, ageDays / halfLifeDays);
}

export function evidenceBoost(
  type: "fact" | "observation",
  explicitness?: string,
  evidenceStrength?: string,
): number {
  if (type === "fact") {
    if (explicitness === "explicit") return 0.2;
    if (explicitness === "inferred") return 0.1;
    return 0;
  }
  if (evidenceStrength === "strong") return 0.45;
  if (evidenceStrength === "supported") return 0.3;
  return 0.15;
}

function renderChars(claim: string, condition?: string, consequence?: string): number {
  return (
    claim.length +
    (condition !== undefined ? condition.length : 0) +
    (consequence !== undefined ? consequence.length : 0) +
    40
  );
}

export interface CanonicalRecallInput {
  readonly query: string;
  readonly referenceTime: Date;
  readonly limit: number;
  readonly maxChars: number;
  /**
   * The behavioral timezone for temporal-expression detection (calendar
   * semantics are personal configuration, never code). When omitted,
   * temporal detection is DISABLED: every query stays in keyword mode.
   */
  readonly timezone?: string;
}

export function normalizeRecallInput(input: {
  query: string;
  referenceTime: Date;
  limit?: number;
  maxChars?: number;
  timezone?: string;
}): CanonicalRecallInput {
  const query = input.query.trim();
  if (!query) throw new CanonicalRecallValidationError("query is required");
  if (query.length > MAX_QUERY_CHARS) {
    throw new CanonicalRecallValidationError(
      `query must not exceed ${String(MAX_QUERY_CHARS)} characters`,
    );
  }
  if (!Number.isFinite(input.referenceTime.getTime())) {
    throw new CanonicalRecallValidationError("referenceTime must be a valid date");
  }
  const limit = input.limit ?? DEFAULT_RECALL_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_RESULT_LIMIT) {
    throw new CanonicalRecallValidationError(
      `limit must be an integer between 1 and ${String(MAX_RESULT_LIMIT)}`,
    );
  }
  const maxChars = input.maxChars ?? DEFAULT_MAX_CHARS;
  if (!Number.isInteger(maxChars) || maxChars < 500 || maxChars > MAX_MAX_CHARS) {
    throw new CanonicalRecallValidationError(
      `maxChars must be an integer between 500 and ${String(MAX_MAX_CHARS)}`,
    );
  }
  return {
    query,
    referenceTime: input.referenceTime,
    limit,
    maxChars,
    ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
  };
}

const FACT_VECTOR =
  "to_tsvector('english', f.claim || ' ' || coalesce(f.condition, '') || ' ' || coalesce(f.consequence, ''))";
const OBSERVATION_VECTOR =
  "to_tsvector('english', o.claim || ' ' || coalesce(o.condition, '') || ' ' || coalesce(o.consequence, ''))";

interface FactCandidateRow {
  fact_key: string;
  subject_id: string;
  kind: string;
  claim: string;
  turn_id: string;
  condition: string | null;
  consequence: string | null;
  topics: string[];
  observed_at: Date;
  explicitness: string;
  text_score: number | null;
}

interface ObservationCandidateRow {
  canonical_observation_id: string;
  subject_id: string;
  kind: string;
  claim: string;
  condition: string | null;
  consequence: string | null;
  topics: string[];
  last_observed_at: Date;
  evidence_strength: string;
  support_count: number;
  distinct_day_count: number;
  text_score: number | null;
}

/**
 * Canonical recall over the memory tables. The caller supplies the already
 * sanitized query text (see the chat integration: the first words of the
 * turn's user message).
 */
export async function recallCanonical(
  pool: PostgresPool,
  config: MemoryConfig,
  input: {
    query: string;
    referenceTime: Date;
    limit?: number;
    maxChars?: number;
    timezone?: string;
  },
): Promise<CanonicalRecallResponse> {
  const startedAt = Date.now();
  const request = normalizeRecallInput(input);
  if (request.timezone !== undefined && !isValidTimezone(request.timezone)) {
    throw new CanonicalRecallValidationError("timezone must be a usable IANA timezone");
  }
  // Timeline/hybrid: an explicit temporal expression in the query narrows
  // candidates to the named window. With keywords remaining it is hybrid
  // (window AND full-text); with none it is a pure timeline ranked by
  // observed time. Without a detected window (or without a configured
  // timezone), keyword behavior is unchanged.
  const timeRange = detectRecallTimeRange(
    request.query,
    request.referenceTime,
    request.timezone,
  );
  // The keyword text is the query with the temporal expression REMOVED, so
  // "what did I do yesterday" searches for "what did I do" — temporal tokens
  // never leak into the full-text match.
  const keywordSource = timeRange === null ? request.query : timeRange.remainingQuery;
  const sanitized = sanitizeTextQuery(keywordSource);
  const tsQueryText = buildTsQueryText(sanitized);
  const emptyQueryFallback = tsQueryText.length === 0;
  const mode: RecallMode = timeRange === null
    ? "keyword"
    : emptyQueryFallback
      ? "timeline"
      : "hybrid";
  const candidateLimit = Math.max(
    request.limit * 3,
    config.canonicalCandidateLimit,
  );

  const dateWindow = timeRange !== null;
  // Window parameter positions differ by mode: timeline has no tsquery
  // parameter, so the window binds at $2/$3; hybrid binds at $3/$4.
  const factWindowPredicate = dateWindow
    ? (mode === "timeline"
      ? "f.observed_at >= $2::timestamptz AND f.observed_at < $3::timestamptz"
      : "f.observed_at >= $3::timestamptz AND f.observed_at < $4::timestamptz")
    : "";
  const observationWindowPredicate = dateWindow
    ? (mode === "timeline"
      ? "o.first_observed_at < $3::timestamptz AND o.last_observed_at >= $2::timestamptz"
      : "o.first_observed_at < $4::timestamptz AND o.last_observed_at >= $3::timestamptz")
    : "";
  const factSql = mode === "timeline"
    ? `SELECT f.fact_key, f.subject_id, f.kind, f.claim, f.turn_id, f.condition,
              f.consequence, f.topics, f.observed_at, f.explicitness,
              NULL::real AS text_score
       FROM memory_fact f
       WHERE ${factWindowPredicate}
       ORDER BY f.observed_at DESC
       LIMIT $1`
    : emptyQueryFallback
      ? `SELECT f.fact_key, f.subject_id, f.kind, f.claim, f.turn_id, f.condition,
              f.consequence, f.topics, f.observed_at, f.explicitness,
              NULL::real AS text_score
       FROM memory_fact f
       ORDER BY f.observed_at DESC
       LIMIT $1`
      : `SELECT f.fact_key, f.subject_id, f.kind, f.claim, f.turn_id, f.condition,
              f.consequence, f.topics, f.observed_at, f.explicitness,
              ts_rank(${FACT_VECTOR}, q.query) AS text_score
       FROM memory_fact f
       CROSS JOIN (SELECT websearch_to_tsquery('english', $2) AS query) q
       WHERE q.query @@ ${FACT_VECTOR}${dateWindow ? ` AND ${factWindowPredicate}` : ""}
       ORDER BY text_score DESC, f.observed_at DESC
       LIMIT $1`;
  const observationSql = mode === "timeline"
    ? `SELECT o.canonical_observation_id, o.subject_id, o.kind, o.claim,
              o.condition, o.consequence, o.topics, o.last_observed_at,
              o.evidence_strength, o.support_count, o.distinct_day_count,
              NULL::real AS text_score
       FROM memory_canonical_observation o
       WHERE o.status = 'active' AND ${observationWindowPredicate}
       ORDER BY o.last_observed_at DESC
       LIMIT $1`
    : emptyQueryFallback
      ? `SELECT o.canonical_observation_id, o.subject_id, o.kind, o.claim,
              o.condition, o.consequence, o.topics, o.last_observed_at,
              o.evidence_strength, o.support_count, o.distinct_day_count,
              NULL::real AS text_score
       FROM memory_canonical_observation o
       WHERE o.status = 'active'
       ORDER BY o.last_observed_at DESC
       LIMIT $1`
      : `SELECT o.canonical_observation_id, o.subject_id, o.kind, o.claim,
              o.condition, o.consequence, o.topics, o.last_observed_at,
              o.evidence_strength, o.support_count, o.distinct_day_count,
              ts_rank(${OBSERVATION_VECTOR}, q.query) AS text_score
       FROM memory_canonical_observation o
       CROSS JOIN (SELECT websearch_to_tsquery('english', $2) AS query) q
       WHERE o.status = 'active' AND q.query @@ ${OBSERVATION_VECTOR}${dateWindow ? ` AND ${observationWindowPredicate}` : ""}
       ORDER BY text_score DESC, o.last_observed_at DESC
       LIMIT $1`;

  const factParams: unknown[] = mode === "timeline" && timeRange !== null
    ? [candidateLimit, timeRange.start, timeRange.end]
    : emptyQueryFallback
      ? [candidateLimit]
      : timeRange !== null
        ? [candidateLimit, tsQueryText, timeRange.start, timeRange.end]
        : [candidateLimit, tsQueryText];
  const [factResult, observationResult] = await Promise.all([
    pool.query<FactCandidateRow>(factSql, factParams),
    pool.query<ObservationCandidateRow>(observationSql, factParams),
  ]);

  interface ScoredCandidate {
    readonly item: CanonicalRecallItem;
    readonly score: number;
    readonly chars: number;
  }
  const scored: ScoredCandidate[] = [];

  for (const row of factResult.rows) {
    const textScore = row.text_score ?? 0;
    const recency =
      recencyBoost(row.observed_at, request.referenceTime, config.canonicalRecencyHalfLifeDays) *
      config.canonicalRecencyWeight;
    const evidence = evidenceBoost("fact", row.explicitness);
    const item: CanonicalRecallItem = {
      type: "fact",
      id: row.fact_key,
      subject: row.subject_id,
      kind: row.kind,
      claim: row.claim,
      turnId: row.turn_id,
      ...(row.condition !== null ? { condition: row.condition } : {}),
      ...(row.consequence !== null ? { consequence: row.consequence } : {}),
      topics: row.topics,
      observedAt: row.observed_at.toISOString(),
      explicitness: row.explicitness,
      textScore,
      recencyBoost: recency,
      evidenceBoost: evidence,
      score: textScore + recency + evidence,
    };
    scored.push({
      score: item.score,
      chars: renderChars(item.claim, item.condition, item.consequence),
      item,
    });
  }

  for (const row of observationResult.rows) {
    const textScore = row.text_score ?? 0;
    const recency =
      recencyBoost(row.last_observed_at, request.referenceTime, config.canonicalRecencyHalfLifeDays) *
      config.canonicalRecencyWeight;
    const evidence = evidenceBoost("observation", undefined, row.evidence_strength);
    const item: CanonicalRecallItem = {
      type: "observation",
      id: row.canonical_observation_id,
      subject: row.subject_id,
      kind: row.kind,
      claim: row.claim,
      ...(row.condition !== null ? { condition: row.condition } : {}),
      ...(row.consequence !== null ? { consequence: row.consequence } : {}),
      topics: row.topics,
      observedAt: row.last_observed_at.toISOString(),
      evidenceStrength: row.evidence_strength,
      supportCount: row.support_count,
      distinctDayCount: row.distinct_day_count,
      textScore,
      recencyBoost: recency,
      evidenceBoost: evidence,
      score: textScore + recency + evidence,
    };
    scored.push({
      score: item.score,
      chars: renderChars(item.claim, item.condition, item.consequence),
      item,
    });
  }

  scored.sort(
    (a, b) => b.score - a.score || a.item.id.localeCompare(b.item.id),
  );

  const maxObservations = Math.max(
    1,
    Math.ceil(request.limit * MAX_OBSERVATION_SHARE),
  );
  const results: CanonicalRecallItem[] = [];
  let usedChars = 0;
  let observationCount = 0;
  let truncatedForBudget = 0;
  for (const candidate of scored) {
    if (results.length >= request.limit) break;
    if (
      candidate.item.type === "observation" &&
      observationCount >= maxObservations
    ) {
      continue;
    }
    if (results.length > 0 && usedChars + candidate.chars > request.maxChars) {
      truncatedForBudget = scored.length - results.length;
      break;
    }
    results.push(candidate.item);
    usedChars += candidate.chars;
    if (candidate.item.type === "observation") observationCount += 1;
  }

  return {
    query: {
      referenceTime: request.referenceTime.toISOString(),
      emptyQueryFallback,
      mode,
      ...(timeRange !== null
        ? {
            timeRange: {
              start: timeRange.start.toISOString(),
              end: timeRange.end.toISOString(),
              description: timeRange.description,
            },
          }
        : {}),
    },
    results,
    diagnostics: {
      factCandidates: factResult.rows.length,
      observationCandidates: observationResult.rows.length,
      truncatedForBudget,
      maxChars: request.maxChars,
      totalMs: Date.now() - startedAt,
    },
  };
}
