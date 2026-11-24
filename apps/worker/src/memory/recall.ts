/**
 * Hybrid canonical recall: pgvector semantic similarity combined with
 * length-normalized PostgreSQL full-text search over production facts and
 * active canonical observations, with gentle recency and evidence tie-breakers,
 * near-duplicate suppression, recent-turn repetition cooldown, and strict
 * slot/character budgets.
 *
 * When an `embeddingClient` is provided and healthy, live recall runs
 * semantic pgvector lookup in parallel with lexical FTS and blends both
 * relevance signals. If the embedding service is absent, busy, or fails,
 * recall degrades cleanly to lexical-only without failing the turn.
 */

import type { PostgresPool } from "@companion/postgres";

import type { MemoryConfig } from "./config.ts";
import {
  EMBEDDING_CODE_REVISION,
  EMBEDDING_INPUT_VERSION,
  EMBEDDING_MODEL,
  EMBEDDING_MODEL_REVISION,
  embeddingContentHash,
  renderEmbeddingInput,
  vectorLiteral,
  type EmbeddingClient,
} from "./embeddings.ts";
import { memoryErrorCategory } from "./errors.ts";
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
/** Short/anaphoric messages below both thresholds borrow minimal prior-turn context. */
const SHORT_QUERY_MAX_CHARS = 48;
const SHORT_QUERY_MIN_CONTENT_TOKENS = 6;
/** Bound prior assistant text when expanding a short/anaphoric message. */
const MAX_PRIOR_ASSISTANT_CHARS = 160;
export const DEFAULT_RECALL_LIMIT = 8;
const MAX_RESULT_LIMIT = 32;
const DEFAULT_MAX_CHARS = 12_000;
const MAX_MAX_CHARS = 96_000;
/** Observations hold at most half the response slots. */
const MAX_OBSERVATION_SHARE = 0.5;
/** Default cap on assistant-role items in chat recall (e.g. max 2 of 8). */
export const DEFAULT_RECALL_MAX_ASSISTANT_SHARE = 0.25;

/**
 * Calibrated for Nomic Embed Text v1.5 cosine similarity: unrelated English
 * pairs cluster near 0.45–0.55, topical matches start around 0.58–0.65, and
 * direct matches sit at 0.70–0.85+.
 */
const SEMANTIC_NOISE_FLOOR = 0.50;
const SEMANTIC_SCORE_SPAN = 0.35;
const MIN_SEMANTIC_SIMILARITY = 0.58;
const MIN_LEXICAL_OVERRIDE = 0.35;
const SEMANTIC_WEIGHT = 0.65;
const LEXICAL_WEIGHT = 0.35;
const LEXICAL_SATURATION_K = 0.05;
/** Soft penalty for memories surfaced in the immediately preceding chat turns. */
export const RECENT_RECALL_PENALTY = 0.25;

const CLAIM_STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "been", "being", "but", "by",
  "for", "from", "had", "has", "have", "he", "her", "hers", "him", "his", "i",
  "in", "is", "it", "its", "me", "my", "of", "on", "or", "our", "she", "that",
  "the", "their", "them", "they", "this", "to", "was", "we", "were", "with",
  "you", "your",
]);

/**
 * High-frequency conversational filler words excluded from OR-joined lexical
 * tsquery when more specific content tokens are present. Without this,
 * PostgreSQL ts_rank (which lacks IDF) rewards memories matching generic
 * filler like "like", "talk", "lot" over rare topical terms like "band".
 */
const QUERY_FILLER_WORDS = new Set([
  ...CLAIM_STOP_WORDS,
  "about", "actually", "all", "also", "any", "anything", "ask", "asked",
  "back", "basically", "can", "could", "did", "do", "does", "doing", "dont",
  "even", "everything", "feel", "get", "getting", "go", "going", "good", "got",
  "great", "haha", "hey", "hi", "honestly", "how", "im", "into", "ive", "just",
  "kind", "know", "like", "literally", "little", "lol", "lot", "lots", "make",
  "many", "maybe", "mean", "more", "most", "much", "nah", "need", "nice", "no",
  "not", "now", "oh", "ok", "okay", "one", "out", "over", "pretty", "probably",
  "really", "right", "said", "say", "see", "so", "some", "somebody", "someone",
  "something", "sort", "still", "stuff", "sure", "talk", "talking", "tell",
  "than", "that", "thats", "then", "there", "thing", "things", "think", "too",
  "told", "up", "very", "wait", "want", "well", "what", "whats", "when",
  "where", "which", "who", "why", "will", "would", "yeah", "yep", "yes",
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

function countQueryContentTokens(text: string): number {
  const normalized = normalizeClaimText(text);
  if (normalized.length === 0) return 0;
  let count = 0;
  for (const token of normalized.split(" ")) {
    if (token.length < 2 || QUERY_FILLER_WORDS.has(token)) continue;
    count += 1;
  }
  return count;
}

/**
 * Build a focused per-turn recall query.
 *
 * When the current user message is substantive on its own (at least 48 chars
 * or at least 6 topical tokens), use ONLY the current user text so a topic
 * switch (e.g., from languages/college to music/bands) is never diluted by a
 * verbose prior assistant reply. Only short/anaphoric follow-ups ("yeah",
 * "ok haha", "what about that?") borrow context from the immediately preceding
 * turn, with prior assistant text strictly bounded.
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

  const isShortFollowUp =
    current.length < SHORT_QUERY_MAX_CHARS &&
    countQueryContentTokens(current) < SHORT_QUERY_MIN_CONTENT_TOKENS;
  if (!isShortFollowUp) return current;

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

  // Prefer the prior turn's user text before a strictly bounded slice of its
  // assistant reply so both sides contribute without drowning out the prompt.
  const priorUser = previousTurnMessages
    .filter((m) => m.role === "user")
    .map((m) => m.content.trim())
    .filter(Boolean)
    .join(" ");
  const priorAssistant = trimToWordBoundary(
    previousTurnMessages
      .filter((m) => m.role === "assistant")
      .map((m) => m.content.trim())
      .filter(Boolean)
      .join(" "),
    MAX_PRIOR_ASSISTANT_CHARS,
  );

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
  if (shorter.length >= 20 && longer.includes(shorter) && shorter.length / longer.length >= 0.55) {
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
  return jaccard >= 0.55 || (minSize >= 4 && overlap >= 0.72);
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
 * neutralized so a token can never act as a websearch negation. High-frequency
 * conversational filler words are filtered out whenever substantive topical
 * tokens remain so generic words never drown out specific terms.
 */
export function buildTsQueryText(sanitized: string): string {
  const tokens = sanitized
    .split(" ")
    .map((token) => token.replace(/^-+|-+$/g, ""))
    .filter((token) => token.length > 0);
  if (tokens.length === 0) return "";
  const substantive = tokens.filter((token) => {
    const clean = token.toLowerCase().replace(/[^a-z0-9]/g, "");
    return clean.length >= 2 && !QUERY_FILLER_WORDS.has(clean);
  });
  const selected = substantive.length > 0 ? substantive : tokens;
  return selected.join(" OR ");
}

/** Map raw length-normalized ts_rank onto [0, 1) comparable with semantic relevance. */
export function normalizedLexicalScore(rawTextScore: number): number {
  if (!Number.isFinite(rawTextScore) || rawTextScore <= 0) return 0;
  return rawTextScore / (rawTextScore + LEXICAL_SATURATION_K);
}

/** Map calibrated Nomic cosine similarity onto [0, 1]. */
export function normalizedSemanticScore(similarity: number): number {
  if (!Number.isFinite(similarity)) return 0;
  return Math.max(0, Math.min(1, (similarity - SEMANTIC_NOISE_FLOOR) / SEMANTIC_SCORE_SPAN));
}

/**
 * Recency multiplier in (0, 1] with a configurable half-life. Durable
 * preferences age slowly: recency breaks ties and lifts fresh facts, it never
 * filters. The weight relative to the relevance score is configurable.
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

/**
 * Small evidence tie-breaker so corroborated observations and explicit facts
 * break close relevance ties without structurally overriding atomic facts.
 */
export function evidenceBoost(
  type: "fact" | "observation",
  explicitness?: string,
  evidenceStrength?: string,
): number {
  if (type === "fact") {
    if (explicitness === "explicit") return 0.03;
    if (explicitness === "supported") return 0.015;
    if (explicitness === "inferred") return 0.005;
    return 0;
  }
  if (evidenceStrength === "strong") return 0.07;
  if (evidenceStrength === "supported") return 0.05;
  return 0.02;
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
  similarity?: number | null;
  embedding_content_hash?: string | null;
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
  similarity?: number | null;
  embedding_content_hash?: string | null;
}

function validatedSimilarity(row: {
  readonly claim: string;
  readonly condition: string | null;
  readonly consequence: string | null;
  readonly similarity?: number | null;
  readonly embedding_content_hash?: string | null;
}): number | null {
  if (row.similarity === undefined || row.similarity === null || !Number.isFinite(row.similarity)) {
    return null;
  }
  if (typeof row.embedding_content_hash !== "string" || row.embedding_content_hash.length === 0) {
    return null;
  }
  const expectedHash = embeddingContentHash(
    renderEmbeddingInput({
      claim: row.claim,
      condition: row.condition,
      consequence: row.consequence,
    }),
  );
  if (expectedHash !== row.embedding_content_hash) return null;
  return Math.max(-1, Math.min(1, row.similarity));
}

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
  /** Optional embedding client for live pgvector hybrid retrieval (degrades to lexical on error). */
  readonly embeddingClient?: EmbeddingClient;
  /** Item IDs surfaced in the immediately preceding chat turns (receive a soft cooldown penalty). */
  readonly recentlyRecalledIds?: ReadonlySet<string>;
  readonly log?: (message: string) => void;
}

export async function recallCanonicalDetailed(
  pool: PostgresPool,
  config: MemoryConfig,
  input: RecallCanonicalOptions,
): Promise<CanonicalRecallDetailed> {
  const startedAt = Date.now();
  const log = input.log ?? (() => undefined);
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

  const timeRange = detectRecallTimeRange(
    request.query,
    request.referenceTime,
    request.timezone,
  );
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
  const semanticCandidateLimit = Math.max(candidateLimit * 2, 48);

  const addParam = (params: unknown[], value: unknown): string => {
    params.push(value);
    return `$${String(params.length)}`;
  };

  const usesTextSearch = mode !== "timeline" && !emptyQueryFallback;

  // Live query embedding (best-effort): failures degrade cleanly to lexical-only.
  let queryVectorLiteral: string | null = null;
  if (usesTextSearch && input.embeddingClient !== undefined) {
    const embedText = keywordSource.trim();
    if (embedText.length > 0) {
      try {
        const [vector] = await input.embeddingClient.embed([embedText], "query");
        if (vector !== undefined) {
          queryVectorLiteral = vectorLiteral(vector);
        }
      } catch (error) {
        log(
          `[MEMORY] live semantic query embedding failed (${memoryErrorCategory(error)}); falling back to lexical recall`,
        );
      }
    }
  }

  const factParams: unknown[] = [candidateLimit];
  const factWhere: string[] = [];
  let factCrossJoin = "";
  let factEmbeddingJoin = "";
  let factEmbeddingSelect = "";
  let factRankExpr = "NULL::real AS text_score";
  let factOrderBy = "f.observed_at DESC";
  if (usesTextSearch) {
    const queryParam = addParam(factParams, tsQueryText);
    factCrossJoin = `CROSS JOIN (SELECT websearch_to_tsquery('english', ${queryParam}) AS query) q`;
    factRankExpr = `ts_rank(${FACT_VECTOR}, q.query, 1) AS text_score`;
    factWhere.push(`q.query @@ ${FACT_VECTOR}`);
    factOrderBy = "text_score DESC, f.observed_at DESC";
  }
  if (minAgeCutoff !== null) {
    const cutoffParam = addParam(factParams, minAgeCutoff);
    factWhere.push(`f.observed_at <= ${cutoffParam}::timestamptz`);
  }
  if (excludeTurnIds.length > 0) {
    const excludedParam = addParam(factParams, excludeTurnIds);
    factWhere.push(`(f.turn_id IS NULL OR f.turn_id::text <> ALL(${excludedParam}::text[]))`);
  }
  if (timeRange !== null) {
    const startParam = addParam(factParams, timeRange.start);
    const endParam = addParam(factParams, timeRange.end);
    factWhere.push(
      `f.observed_at >= ${startParam}::timestamptz AND f.observed_at < ${endParam}::timestamptz`,
    );
  }
  if (queryVectorLiteral !== null) {
    const vecParam = addParam(factParams, queryVectorLiteral);
    const verParam = addParam(factParams, EMBEDDING_INPUT_VERSION);
    const modParam = addParam(factParams, EMBEDDING_MODEL);
    const revParam = addParam(factParams, EMBEDDING_MODEL_REVISION);
    const codeParam = addParam(factParams, EMBEDDING_CODE_REVISION);
    factEmbeddingJoin =
      `LEFT JOIN memory_semantic_embedding e ON e.fact_id = f.id` +
      ` AND e.embedding IS NOT NULL AND e.source_updated_at = f.updated_at` +
      ` AND e.input_version = ${verParam} AND e.model = ${modParam}` +
      ` AND e.model_revision = ${revParam} AND e.model_code_revision = ${codeParam}`;
    factEmbeddingSelect =
      `, (1 - (e.embedding <=> ${vecParam}::vector(768)))::real AS similarity` +
      `, e.source_content_hash AS embedding_content_hash`;
  }
  const factWhereSql = factWhere.length > 0 ? `WHERE ${factWhere.join(" AND ")}` : "";
  const factSql = `SELECT f.fact_key, f.subject_id, s.role AS subject_role, f.kind, f.claim, f.turn_id, f.source_type, f.article_reaction_id, f.condition,
            f.consequence, f.topics, f.observed_at, f.explicitness,
            ${factRankExpr}${factEmbeddingSelect}
     FROM memory_fact f
     JOIN memory_subject s ON s.id = f.subject_id
     ${factEmbeddingJoin}
     ${factCrossJoin}
     ${factWhereSql}
     ORDER BY ${factOrderBy}
     LIMIT $1`;

  const obsParams: unknown[] = [candidateLimit];
  const obsWhere: string[] = ["o.status = 'active'"];
  let obsCrossJoin = "";
  let obsEmbeddingJoin = "";
  let obsEmbeddingSelect = "";
  let obsRankExpr = "NULL::real AS text_score";
  let obsOrderBy = "o.last_observed_at DESC";
  if (usesTextSearch) {
    const queryParam = addParam(obsParams, tsQueryText);
    obsCrossJoin = `CROSS JOIN (SELECT websearch_to_tsquery('english', ${queryParam}) AS query) q`;
    obsRankExpr = `ts_rank(${OBSERVATION_VECTOR}, q.query, 1) AS text_score`;
    obsWhere.push(`q.query @@ ${OBSERVATION_VECTOR}`);
    obsOrderBy = "text_score DESC, o.last_observed_at DESC";
  }
  if (minAgeCutoff !== null) {
    const cutoffParam = addParam(obsParams, minAgeCutoff);
    obsWhere.push(`o.last_observed_at <= ${cutoffParam}::timestamptz`);
  }
  if (timeRange !== null) {
    const startParam = addParam(obsParams, timeRange.start);
    const endParam = addParam(obsParams, timeRange.end);
    obsWhere.push(
      `o.first_observed_at < ${endParam}::timestamptz AND o.last_observed_at >= ${startParam}::timestamptz`,
    );
  }
  if (queryVectorLiteral !== null) {
    const vecParam = addParam(obsParams, queryVectorLiteral);
    const verParam = addParam(obsParams, EMBEDDING_INPUT_VERSION);
    const modParam = addParam(obsParams, EMBEDDING_MODEL);
    const revParam = addParam(obsParams, EMBEDDING_MODEL_REVISION);
    const codeParam = addParam(obsParams, EMBEDDING_CODE_REVISION);
    obsEmbeddingJoin =
      `LEFT JOIN memory_semantic_embedding e ON e.canonical_observation_id = o.canonical_observation_id` +
      ` AND e.embedding IS NOT NULL AND e.source_updated_at = o.canonical_updated_at` +
      ` AND e.input_version = ${verParam} AND e.model = ${modParam}` +
      ` AND e.model_revision = ${revParam} AND e.model_code_revision = ${codeParam}`;
    obsEmbeddingSelect =
      `, (1 - (e.embedding <=> ${vecParam}::vector(768)))::real AS similarity` +
      `, e.source_content_hash AS embedding_content_hash`;
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
            ${obsRankExpr}${obsEmbeddingSelect}
     FROM memory_canonical_observation o
     JOIN memory_subject s ON s.id = o.subject_id
     ${obsEmbeddingJoin}
     ${obsCrossJoin}
     WHERE ${obsWhere.join(" AND ")}
     ORDER BY ${obsOrderBy}
     LIMIT $1`;

  // Semantic pgvector candidate pools (parallel with lexical when vector is ready).
  let semanticFactPromise: Promise<{ rows: FactCandidateRow[] }> = Promise.resolve({ rows: [] });
  let semanticObsPromise: Promise<{ rows: ObservationCandidateRow[] }> = Promise.resolve({ rows: [] });
  let semanticQueryFailed = false;

  if (queryVectorLiteral !== null) {
    const semFactParams: unknown[] = [
      semanticCandidateLimit,
      queryVectorLiteral,
      EMBEDDING_INPUT_VERSION,
      EMBEDDING_MODEL,
      EMBEDDING_MODEL_REVISION,
      EMBEDDING_CODE_REVISION,
    ];
    const semFactWhere: string[] = [
      "e.embedding IS NOT NULL",
      "e.source_updated_at = f.updated_at",
      "e.input_version = $3",
      "e.model = $4",
      "e.model_revision = $5",
      "e.model_code_revision = $6",
    ];
    if (minAgeCutoff !== null) {
      const cutoffParam = addParam(semFactParams, minAgeCutoff);
      semFactWhere.push(`f.observed_at <= ${cutoffParam}::timestamptz`);
    }
    if (excludeTurnIds.length > 0) {
      const excludedParam = addParam(semFactParams, excludeTurnIds);
      semFactWhere.push(`(f.turn_id IS NULL OR f.turn_id::text <> ALL(${excludedParam}::text[]))`);
    }
    if (timeRange !== null) {
      const startParam = addParam(semFactParams, timeRange.start);
      const endParam = addParam(semFactParams, timeRange.end);
      semFactWhere.push(
        `f.observed_at >= ${startParam}::timestamptz AND f.observed_at < ${endParam}::timestamptz`,
      );
    }
    const semFactSql = `SELECT f.fact_key, f.subject_id, s.role AS subject_role, f.kind, f.claim, f.turn_id, f.source_type, f.article_reaction_id, f.condition,
              f.consequence, f.topics, f.observed_at, f.explicitness,
              NULL::real AS text_score,
              (1 - (e.embedding <=> $2::vector(768)))::real AS similarity,
              e.source_content_hash AS embedding_content_hash
       FROM memory_semantic_embedding e
       JOIN memory_fact f ON f.id = e.fact_id
       JOIN memory_subject s ON s.id = f.subject_id
       WHERE ${semFactWhere.join(" AND ")}
       ORDER BY e.embedding <=> $2::vector(768) ASC
       LIMIT $1`;

    const semObsParams: unknown[] = [
      semanticCandidateLimit,
      queryVectorLiteral,
      EMBEDDING_INPUT_VERSION,
      EMBEDDING_MODEL,
      EMBEDDING_MODEL_REVISION,
      EMBEDDING_CODE_REVISION,
    ];
    const semObsWhere: string[] = [
      "o.status = 'active'",
      "e.embedding IS NOT NULL",
      "e.source_updated_at = o.canonical_updated_at",
      "e.input_version = $3",
      "e.model = $4",
      "e.model_revision = $5",
      "e.model_code_revision = $6",
    ];
    if (minAgeCutoff !== null) {
      const cutoffParam = addParam(semObsParams, minAgeCutoff);
      semObsWhere.push(`o.last_observed_at <= ${cutoffParam}::timestamptz`);
    }
    if (timeRange !== null) {
      const startParam = addParam(semObsParams, timeRange.start);
      const endParam = addParam(semObsParams, timeRange.end);
      semObsWhere.push(
        `o.first_observed_at < ${endParam}::timestamptz AND o.last_observed_at >= ${startParam}::timestamptz`,
      );
    }
    const semObsSql = `SELECT o.canonical_observation_id, o.subject_id, s.role AS subject_role,
              EXISTS (
                SELECT 1 FROM memory_fact sf
                WHERE sf.fact_key = ANY(o.source_fact_keys)
                  AND sf.source_type = 'article'
              ) AS article_sourced,
              o.kind, o.claim,
              o.condition, o.consequence, o.topics, o.last_observed_at,
              o.evidence_strength, o.support_count, o.distinct_day_count,
              NULL::real AS text_score,
              (1 - (e.embedding <=> $2::vector(768)))::real AS similarity,
              e.source_content_hash AS embedding_content_hash
       FROM memory_semantic_embedding e
       JOIN memory_canonical_observation o ON o.canonical_observation_id = e.canonical_observation_id
       JOIN memory_subject s ON s.id = o.subject_id
       WHERE ${semObsWhere.join(" AND ")}
       ORDER BY e.embedding <=> $2::vector(768) ASC
       LIMIT $1`;

    semanticFactPromise = pool.query<FactCandidateRow>(semFactSql, semFactParams).catch((error) => {
      semanticQueryFailed = true;
      log(`[MEMORY] live semantic fact lookup failed (${memoryErrorCategory(error)}); continuing with lexical candidates`);
      return { rows: [] };
    });
    semanticObsPromise = pool.query<ObservationCandidateRow>(semObsSql, semObsParams).catch((error) => {
      semanticQueryFailed = true;
      log(`[MEMORY] live semantic observation lookup failed (${memoryErrorCategory(error)}); continuing with lexical candidates`);
      return { rows: [] };
    });
  }

  const [factResult, observationResult, semFactResult, semObsResult] = await Promise.all([
    pool.query<FactCandidateRow>(factSql, factParams),
    pool.query<ObservationCandidateRow>(observationSql, obsParams),
    semanticFactPromise,
    semanticObsPromise,
  ]);

  const semanticUsed = queryVectorLiteral !== null && !semanticQueryFailed;
  const semanticCandidates = semFactResult.rows.length + semObsResult.rows.length;

  // Merge lexical + semantic candidates by typed ID so items matched by both
  // combine their lexical ts_rank and exact cosine similarity.
  const mergedFacts = new Map<string, { row: FactCandidateRow; textScore: number; similarity: number | null }>();
  for (const row of factResult.rows) {
    mergedFacts.set(row.fact_key, {
      row,
      textScore: row.text_score ?? 0,
      similarity: semanticUsed ? validatedSimilarity(row) : null,
    });
  }
  for (const row of semFactResult.rows) {
    const sim = validatedSimilarity(row);
    if (sim === null) continue;
    const existing = mergedFacts.get(row.fact_key);
    if (existing !== undefined) {
      existing.similarity = existing.similarity === null ? sim : Math.max(existing.similarity, sim);
    } else {
      mergedFacts.set(row.fact_key, { row, textScore: 0, similarity: sim });
    }
  }

  const mergedObservations = new Map<string, { row: ObservationCandidateRow; textScore: number; similarity: number | null }>();
  for (const row of observationResult.rows) {
    mergedObservations.set(row.canonical_observation_id, {
      row,
      textScore: row.text_score ?? 0,
      similarity: semanticUsed ? validatedSimilarity(row) : null,
    });
  }
  for (const row of semObsResult.rows) {
    const sim = validatedSimilarity(row);
    if (sim === null) continue;
    const existing = mergedObservations.get(row.canonical_observation_id);
    if (existing !== undefined) {
      existing.similarity = existing.similarity === null ? sim : Math.max(existing.similarity, sim);
    } else {
      mergedObservations.set(row.canonical_observation_id, { row, textScore: 0, similarity: sim });
    }
  }

  const scored: ScoredRecallCandidate[] = [];
  const recentlyRecalledIds = input.recentlyRecalledIds;

  const computeRelevance = (
    rawTextScore: number,
    similarity: number | null,
  ): number | null => {
    if (!usesTextSearch) return 0;
    const lexRel = normalizedLexicalScore(rawTextScore);
    if (semanticUsed && similarity !== null) {
      if (similarity < MIN_SEMANTIC_SIMILARITY && lexRel < MIN_LEXICAL_OVERRIDE) {
        return null;
      }
      return SEMANTIC_WEIGHT * normalizedSemanticScore(similarity) + LEXICAL_WEIGHT * lexRel;
    }
    return lexRel;
  };

  for (const { row, textScore, similarity } of mergedFacts.values()) {
    const relevance = computeRelevance(textScore, similarity);
    if (relevance === null) continue;
    const recency =
      recencyBoost(row.observed_at, request.referenceTime, config.canonicalRecencyHalfLifeDays) *
      config.canonicalRecencyWeight;
    const evidence = evidenceBoost("fact", row.explicitness);
    const penalty = recentlyRecalledIds?.has(row.fact_key) ? RECENT_RECALL_PENALTY : 0;
    const totalScore = Math.max(0, relevance + recency + evidence - penalty);
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
      ...(similarity !== null ? { semanticSimilarity: similarity } : {}),
      recencyBoost: recency,
      evidenceBoost: evidence,
      score: totalScore,
    };
    scored.push({
      score: item.score,
      chars: renderChars(item.claim, item.condition, item.consequence),
      item,
    });
  }

  for (const { row, textScore, similarity } of mergedObservations.values()) {
    const relevance = computeRelevance(textScore, similarity);
    if (relevance === null) continue;
    const recency =
      recencyBoost(row.last_observed_at, request.referenceTime, config.canonicalRecencyHalfLifeDays) *
      config.canonicalRecencyWeight;
    const evidence = evidenceBoost("observation", undefined, row.evidence_strength);
    const penalty = recentlyRecalledIds?.has(row.canonical_observation_id) ? RECENT_RECALL_PENALTY : 0;
    const totalScore = Math.max(0, relevance + recency + evidence - penalty);
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
      ...(similarity !== null ? { semanticSimilarity: similarity } : {}),
      recencyBoost: recency,
      evidenceBoost: evidence,
      score: totalScore,
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
      factCandidates: mergedFacts.size,
      observationCandidates: mergedObservations.size,
      semanticUsed,
      semanticCandidates,
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

/** Public recall (lexical or live hybrid when an embedding client is supplied). */
export async function recallCanonical(
  pool: PostgresPool,
  config: MemoryConfig,
  input: RecallCanonicalOptions,
): Promise<CanonicalRecallResponse> {
  return (await recallCanonicalDetailed(pool, config, input)).response;
}
