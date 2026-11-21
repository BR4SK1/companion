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
/** Default cap on assistant-role items in chat recall (e.g. max 2 of 8). */
export const DEFAULT_RECALL_MAX_ASSISTANT_SHARE = 0.25;

const CLAIM_STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "been", "being", "but", "by",
  "for", "from", "had", "has", "have", "he", "her", "hers", "him", "his", "i",
  "in", "is", "it", "its", "me", "my", "of", "on", "or", "our", "she", "that",
  "the", "their", "them", "they", "this", "to", "was", "we", "were", "with",
  "you", "your",
]);

function trimToWordBoundary(text: string, maxChars: number): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= maxChars) return collapsed;
  const slice = collapsed.slice(0, maxChars);
  const lastSpace = slice.lastIndexOf(" ");
  return (lastSpace >= Math.floor(maxChars * 0.5) ? slice.slice(0, lastSpace) : slice).trim();
}

export interface RecallQueryHistoryMessage {
  readonly role: "user" | "assistant";
  readonly content: string;
  readonly turnId?: string | null;
}

/**
 * Build a per-turn recall query from the current user message(s) plus the
 * immediately preceding full turn (user + assistant) from `history`, cleanly
 * bounded to `maxChars` (512) at word boundaries without an artificial 16-word
 * cut. The current turn's user text is placed first so it is never truncated
 * out by a long prior assistant reply and takes precedence for temporal-window
 * detection.
 */
export function buildRecallQuery(input: {
  readonly currentUserText: string;
  readonly history?: readonly RecallQueryHistoryMessage[];
  readonly maxChars?: number;
}): string {
  const maxChars = Math.max(1, Math.min(input.maxChars ?? MAX_QUERY_CHARS, MAX_QUERY_CHARS));
  const current = trimToWordBoundary(input.currentUserText, maxChars);
  if (current.length === 0) return "";
  if (current.length >= maxChars) return current;

  const history = input.history ?? [];
  if (history.length === 0) return current;

  // Identify the immediately preceding full turn in `history`.
  const lastMessage = history[history.length - 1]!;
  let previousTurnMessages: readonly RecallQueryHistoryMessage[];
  if (lastMessage.turnId !== undefined && lastMessage.turnId !== null) {
    const targetTurnId = lastMessage.turnId;
    previousTurnMessages = history.filter((m) => m.turnId === targetTurnId);
  } else {
    previousTurnMessages = history.slice(-2);
  }

  // Prefer the prior turn's user text before its assistant reply so both sides
  // contribute while user context is kept if the assistant reply is long.
  const priorUser = previousTurnMessages
    .filter((m) => m.role === "user")
    .map((m) => m.content.trim())
    .filter(Boolean)
    .join(" ");
  const priorAssistant = previousTurnMessages
    .filter((m) => m.role === "assistant")
    .map((m) => m.content.trim())
    .filter(Boolean)
    .join(" ");

  let combined = current;
  for (const segment of [priorUser, priorAssistant]) {
    if (segment.length === 0) continue;
    const remaining = maxChars - combined.length - 1;
    if (remaining < 16) break;
    const bounded = trimToWordBoundary(segment, remaining);
    if (bounded.length > 0) {
      combined = `${combined} ${bounded}`;
    }
  }
  return combined;
}

function normalizeClaimText(claim: string): string {
  return claim
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function claimContentTokens(normalized: string): Set<string> {
  const tokens = new Set<string>();
  for (const token of normalized.split(" ")) {
    if (token.length < 2 || CLAIM_STOP_WORDS.has(token)) continue;
    tokens.add(token);
  }
  return tokens;
}

/** Deterministic near-duplicate check for claims belonging to the same subject. */
export function areClaimsNearDuplicate(a: string, b: string): boolean {
  const normA = normalizeClaimText(a);
  const normB = normalizeClaimText(b);
  if (normA.length === 0 || normB.length === 0) return false;
  if (normA === normB) return true;

  const shorter = normA.length <= normB.length ? normA : normB;
  const longer = normA.length <= normB.length ? normB : normA;
  if (shorter.length >= 20 && longer.includes(shorter) && shorter.length / longer.length >= 0.6) {
    return true;
  }

  const tokensA = claimContentTokens(normA);
  const tokensB = claimContentTokens(normB);
  const minSize = Math.min(tokensA.size, tokensB.size);
  if (minSize < 3) return false;
  let intersection = 0;
  for (const token of tokensA) {
    if (tokensB.has(token)) intersection += 1;
  }
  const union = tokensA.size + tokensB.size - intersection;
  const jaccard = union === 0 ? 0 : intersection / union;
  const overlap = intersection / minSize;
  return jaccard >= 0.72 || (minSize >= 4 && overlap >= 0.85);
}

export interface ScoredRecallCandidate {
  readonly item: CanonicalRecallItem;
  readonly score: number;
  readonly chars: number;
}

export function selectRecallResults(
  scored: readonly ScoredRecallCandidate[],
  options: {
    readonly limit: number;
    readonly maxChars: number;
    readonly maxAssistantShare?: number;
    readonly deduplicateClaims?: boolean;
  },
): {
  readonly results: readonly CanonicalRecallItem[];
  readonly truncatedForBudget: number;
} {
  const maxObservations = Math.max(
    1,
    Math.ceil(options.limit * MAX_OBSERVATION_SHARE),
  );
  const maxAssistantItems =
    options.maxAssistantShare !== undefined
      ? Math.max(1, Math.floor(options.limit * options.maxAssistantShare))
      : undefined;
  const deduplicate = options.deduplicateClaims === true;

  const results: CanonicalRecallItem[] = [];
  let usedChars = 0;
  let observationCount = 0;
  let assistantCount = 0;
  let truncatedForBudget = 0;

  for (const candidate of scored) {
    if (results.length >= options.limit) break;
    if (
      candidate.item.type === "observation" &&
      observationCount >= maxObservations
    ) {
      continue;
    }
    if (
      maxAssistantItems !== undefined &&
      candidate.item.subjectRole === "assistant" &&
      assistantCount >= maxAssistantItems
    ) {
      continue;
    }
    if (
      deduplicate &&
      results.some(
        (existing) =>
          existing.subject === candidate.item.subject &&
          areClaimsNearDuplicate(existing.claim, candidate.item.claim),
      )
    ) {
      continue;
    }
    if (results.length > 0 && usedChars + candidate.chars > options.maxChars) {
      truncatedForBudget = scored.length - results.length;
      break;
    }
    results.push(candidate.item);
    usedChars += candidate.chars;
    if (candidate.item.type === "observation") observationCount += 1;
    if (candidate.item.subjectRole === "assistant") assistantCount += 1;
  }

  return { results, truncatedForBudget };
}

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
  subject_role: string;
  kind: string;
  claim: string;
  turn_id: string | null;
  source_type: string;
  article_reaction_id: string | null;
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
  subject_role: string;
  article_sourced: boolean;
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
export interface CanonicalRecallCandidate {
  readonly item: CanonicalRecallItem;
  readonly score: number;
  readonly chars: number;
  readonly rank: number;
  readonly baselineIncluded: boolean;
  readonly baselineResultRank: number | null;
}

export interface CanonicalRecallDetailed {
  readonly response: CanonicalRecallResponse;
  /** Exact normalized values used by the baseline, including API defaults. */
  readonly normalizedInput: CanonicalRecallInput;
  /** Bounded at the same per-kind SQL candidate limit as ordinary recall. */
  readonly candidates: readonly CanonicalRecallCandidate[];
}

export interface RecallCanonicalOptions {
  readonly query: string;
  readonly referenceTime: Date;
  readonly limit?: number;
  readonly maxChars?: number;
  readonly timezone?: string;
  /** Exclude conversation facts originating from these turn IDs (e.g., turns already in history). */
  readonly excludeTurnIds?: readonly string[];
  /** Exclude facts/observations observed more recently than `referenceTime - minAgeMs`. */
  readonly minAgeMs?: number;
  /** Cap assistant-role items as a share of `limit` (e.g. 0.25 => max 2 of 8). */
  readonly maxAssistantShare?: number;
  /** Deduplicate near-identical claims for the same subject before filling `limit`. */
  readonly deduplicateClaims?: boolean;
}

export async function recallCanonicalDetailed(
  pool: PostgresPool,
  config: MemoryConfig,
  input: RecallCanonicalOptions,
): Promise<CanonicalRecallDetailed> {
  const startedAt = Date.now();
  const request = normalizeRecallInput(input);
  if (request.timezone !== undefined && !isValidTimezone(request.timezone)) {
    throw new CanonicalRecallValidationError("timezone must be a usable IANA timezone");
  }
  const minAgeMs = input.minAgeMs ?? 0;
  if (!Number.isFinite(minAgeMs) || minAgeMs < 0) {
    throw new CanonicalRecallValidationError("minAgeMs must be a non-negative finite number");
  }
  const excludeTurnIds = [
    ...new Set((input.excludeTurnIds ?? []).map((id) => id.trim()).filter(Boolean)),
  ];
  const minAgeCutoff =
    minAgeMs > 0 ? new Date(request.referenceTime.getTime() - minAgeMs) : null;

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

  const addParam = (params: unknown[], value: unknown): string => {
    params.push(value);
    return `$${String(params.length)}`;
  };

  const usesTextSearch = mode !== "timeline" && !emptyQueryFallback;

  const factParams: unknown[] = [candidateLimit];
  const factWhere: string[] = [];
  let factCrossJoin = "";
  let factRankExpr = "NULL::real AS text_score";
  let factOrderBy = "f.observed_at DESC";
  if (usesTextSearch) {
    const queryParam = addParam(factParams, tsQueryText);
    factCrossJoin = `CROSS JOIN (SELECT websearch_to_tsquery('english', ${queryParam}) AS query) q`;
    factRankExpr = `ts_rank(${FACT_VECTOR}, q.query) AS text_score`;
    factWhere.push(`q.query @@ ${FACT_VECTOR}`);
    factOrderBy = "text_score DESC, f.observed_at DESC";
  }
  if (timeRange !== null) {
    const startParam = addParam(factParams, timeRange.start);
    const endParam = addParam(factParams, timeRange.end);
    factWhere.push(
      `f.observed_at >= ${startParam}::timestamptz AND f.observed_at < ${endParam}::timestamptz`,
    );
  }
  if (minAgeCutoff !== null) {
    const cutoffParam = addParam(factParams, minAgeCutoff);
    factWhere.push(`f.observed_at <= ${cutoffParam}::timestamptz`);
  }
  if (excludeTurnIds.length > 0) {
    const excludedParam = addParam(factParams, excludeTurnIds);
    factWhere.push(`(f.turn_id IS NULL OR f.turn_id::text <> ALL(${excludedParam}::text[]))`);
  }
  const factWhereSql = factWhere.length > 0 ? `WHERE ${factWhere.join(" AND ")}` : "";
  const factSql = `SELECT f.fact_key, f.subject_id, s.role AS subject_role, f.kind, f.claim, f.turn_id, f.source_type, f.article_reaction_id, f.condition,
            f.consequence, f.topics, f.observed_at, f.explicitness,
            ${factRankExpr}
     FROM memory_fact f
     JOIN memory_subject s ON s.id = f.subject_id
     ${factCrossJoin}
     ${factWhereSql}
     ORDER BY ${factOrderBy}
     LIMIT $1`;

  const obsParams: unknown[] = [candidateLimit];
  const obsWhere: string[] = ["o.status = 'active'"];
  let obsCrossJoin = "";
  let obsRankExpr = "NULL::real AS text_score";
  let obsOrderBy = "o.last_observed_at DESC";
  if (usesTextSearch) {
    const queryParam = addParam(obsParams, tsQueryText);
    obsCrossJoin = `CROSS JOIN (SELECT websearch_to_tsquery('english', ${queryParam}) AS query) q`;
    obsRankExpr = `ts_rank(${OBSERVATION_VECTOR}, q.query) AS text_score`;
    obsWhere.push(`q.query @@ ${OBSERVATION_VECTOR}`);
    obsOrderBy = "text_score DESC, o.last_observed_at DESC";
  }
  if (timeRange !== null) {
    const startParam = addParam(obsParams, timeRange.start);
    const endParam = addParam(obsParams, timeRange.end);
    obsWhere.push(
      `o.first_observed_at < ${endParam}::timestamptz AND o.last_observed_at >= ${startParam}::timestamptz`,
    );
  }
  if (minAgeCutoff !== null) {
    const cutoffParam = addParam(obsParams, minAgeCutoff);
    obsWhere.push(`o.last_observed_at <= ${cutoffParam}::timestamptz`);
  }
  const observationSql = `SELECT o.canonical_observation_id, o.subject_id, s.role AS subject_role,
            EXISTS (
              SELECT 1 FROM memory_fact sf
              WHERE sf.fact_key = ANY(o.source_fact_keys)
                AND sf.source_type = 'article'
            ) AS article_sourced,
            o.kind, o.claim,
            o.condition, o.consequence, o.topics, o.last_observed_at,
            o.evidence_strength, o.support_count, o.distinct_day_count,
            ${obsRankExpr}
     FROM memory_canonical_observation o
     JOIN memory_subject s ON s.id = o.subject_id
     ${obsCrossJoin}
     WHERE ${obsWhere.join(" AND ")}
     ORDER BY ${obsOrderBy}
     LIMIT $1`;

  const [factResult, observationResult] = await Promise.all([
    pool.query<FactCandidateRow>(factSql, factParams),
    pool.query<ObservationCandidateRow>(observationSql, obsParams),
  ]);

  const scored: ScoredRecallCandidate[] = [];

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
      subjectRole: row.subject_role as "user" | "assistant" | "relationship",
      kind: row.kind,
      claim: row.claim,
      ...(row.turn_id !== null ? { turnId: row.turn_id } : {}),
      sourceType: row.source_type === "article" ? "article" : "conversation",
      ...(row.article_reaction_id !== null
        ? { articleReactionId: row.article_reaction_id }
        : {}),
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
      subjectRole: row.subject_role as "user" | "assistant" | "relationship",
      kind: row.kind,
      claim: row.claim,
      sourceType: row.article_sourced ? "article" : "conversation",
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

  const { results, truncatedForBudget } = selectRecallResults(scored, {
    limit: request.limit,
    maxChars: request.maxChars,
    ...(input.maxAssistantShare !== undefined
      ? { maxAssistantShare: input.maxAssistantShare }
      : {}),
    ...(input.deduplicateClaims !== undefined
      ? { deduplicateClaims: input.deduplicateClaims }
      : {}),
  });

  const response: CanonicalRecallResponse = {
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
  const resultRanks = new Map(results.map((item, index) => [item.id, index + 1]));
  const includedIds = new Set(resultRanks.keys());
  return {
    response,
    normalizedInput: request,
    candidates: scored.map((candidate, index) => ({
      item: candidate.item,
      score: candidate.score,
      chars: candidate.chars,
      rank: index + 1,
      baselineIncluded: includedIds.has(candidate.item.id),
      baselineResultRank: resultRanks.get(candidate.item.id) ?? null,
    })),
  };
}

/** Public recall remains the original keyword result; shadow consumers are separate. */
export async function recallCanonical(
  pool: PostgresPool,
  config: MemoryConfig,
  input: RecallCanonicalOptions,
): Promise<CanonicalRecallResponse> {
  return (await recallCanonicalDetailed(pool, config, input)).response;
}
