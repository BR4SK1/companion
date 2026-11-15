export type ShadowSourceKind = "fact" | "observation";
export type ShadowArm = "baseline" | "semantic_rerank" | "hybrid";
export type ShadowOrigin = "keyword" | "temporal_keyword" | "recency" | "semantic_only";

export const MAX_KEYWORD_CANDIDATES = 64;
export const MAX_SEMANTIC_ONLY_CANDIDATES = 4;
export const RANKING_STRATEGY_VERSION = "lexical-2x-semantic-1-rrf-k2-v2";
const RRF_RANK_OFFSET = 2;

export interface ShadowCandidate {
  readonly id: string;
  readonly type: ShadowSourceKind;
  readonly score: number;
  readonly chars: number;
  /** Rank under the exact keyword + recency + evidence baseline ordering. */
  readonly baselineRank: number;
  readonly baselineIncluded: boolean;
  readonly baselineResultRank?: number | null;
  readonly baselineOrigin?: Exclude<ShadowOrigin, "semantic_only">;
  readonly textScore: number;
  readonly semanticOnly?: boolean;
}

export function selectKeywordCandidates(
  baseline: readonly ShadowCandidate[],
  resultLimit: number,
): readonly ShadowCandidate[] {
  const ordered = [...baseline].sort((a, b) => a.baselineRank - b.baselineRank);
  const selected = ordered.filter((candidate) => candidate.baselineIncluded);
  const candidates = new Map([...ordered.slice(0, MAX_KEYWORD_CANDIDATES), ...selected]
    .map((candidate) => [candidate.id, candidate]));
  return [...candidates.values()]
    .sort((a, b) => a.baselineRank - b.baselineRank)
    .slice(0, MAX_KEYWORD_CANDIDATES + resultLimit);
}

export interface ShadowCandidateTrace {
  readonly id: string;
  readonly type: ShadowSourceKind;
  readonly origin: ShadowOrigin;
  readonly baselineRank: number | null;
  readonly semanticRank: number | null;
  readonly similarity: number | null;
  readonly arm: ShadowArm;
  readonly armRank: number | null;
  readonly budgetIncluded: boolean;
  readonly resultRank: number | null;
}

export interface ShadowArmResult {
  readonly arm: ShadowArm;
  readonly ids: readonly string[];
  readonly traces: readonly ShadowCandidateTrace[];
}

interface RankedCandidate {
  readonly candidate: ShadowCandidate;
  readonly origin: ShadowOrigin;
  readonly semanticRank: number | null;
  readonly similarity: number | null;
  readonly score: number;
}

/**
 * Build bounded comparison arms. Lexical rank contributes twice as much as
 * semantic rank. Missing vectors receive the lexical-rank semantic contribution
 * as a neutral imputation and remain marked as unscored in the trace.
 */
export function buildShadowArms(input: {
  readonly keywordCandidates: readonly ShadowCandidate[];
  readonly semanticOnlyCandidates: readonly ShadowCandidate[];
  /** Global exact-cosine rank and similarity for every successfully scored candidate. */
  readonly semantic: ReadonlyMap<string, { readonly rank: number; readonly similarity: number }>;
  readonly limit: number;
  readonly maxChars: number;
}): readonly [ShadowArmResult, ShadowArmResult] {
  const keywords = [...input.keywordCandidates]
    .sort((a, b) => a.baselineRank - b.baselineRank)
    .slice(0, MAX_KEYWORD_CANDIDATES + input.limit);
  const keywordIds = new Set(keywords.map((candidate) => candidate.id));
  const semanticOnly = [...input.semanticOnlyCandidates]
    .filter((candidate) => !keywordIds.has(candidate.id))
    .slice(0, MAX_SEMANTIC_ONLY_CANDIDATES);
  const hybridCandidates = [...keywords, ...semanticOnly];

  const makeRanked = (candidate: ShadowCandidate, lexicalRank: number | null): RankedCandidate => {
    const semantic = input.semantic.get(candidate.id);
    const semanticRank = semantic?.rank ?? null;
    const neutralSemanticRank = semanticRank ?? (lexicalRank === null ? null : lexicalRank);
    const score =
      (lexicalRank === null ? 0 : 2 / (RRF_RANK_OFFSET + lexicalRank)) +
      (neutralSemanticRank === null ? 0 : 1 / (RRF_RANK_OFFSET + neutralSemanticRank));
    return {
      candidate,
      origin: candidate.semanticOnly ? "semantic_only" : candidate.baselineOrigin ?? "keyword",
      semanticRank,
      similarity: semantic?.similarity ?? null,
      score,
    };
  };

  const rerank = keywords.map((candidate) => makeRanked(candidate, candidate.baselineRank));
  const hybrid = hybridCandidates.map((candidate) => makeRanked(
    candidate,
    candidate.semanticOnly ? null : candidate.baselineRank,
  ));
  const tie = (a: RankedCandidate, b: RankedCandidate): number =>
    b.score - a.score || b.candidate.score - a.candidate.score || a.candidate.id.localeCompare(b.candidate.id);
  rerank.sort(tie);
  hybrid.sort(tie);

  return [
    selectArm("semantic_rerank", rerank, input.limit, input.maxChars),
    selectArm("hybrid", hybrid, input.limit, input.maxChars),
  ];
}

function selectArm(
  arm: Exclude<ShadowArm, "baseline">,
  ranked: readonly RankedCandidate[],
  limit: number,
  maxChars: number,
): ShadowArmResult {
  const maxObservations = Math.max(1, Math.ceil(limit * 0.5));
  const selected = new Set<string>();
  const resultRanks = new Map<string, number>();
  let chars = 0;
  let observations = 0;
  for (const row of ranked) {
    if (resultRanks.size >= limit) break;
    if (row.candidate.type === "observation" && observations >= maxObservations) continue;
    if (resultRanks.size > 0 && chars + row.candidate.chars > maxChars) break;
    selected.add(row.candidate.id);
    resultRanks.set(row.candidate.id, resultRanks.size + 1);
    chars += row.candidate.chars;
    if (row.candidate.type === "observation") observations += 1;
  }
  const traces = ranked.map((row, index): ShadowCandidateTrace => ({
    id: row.candidate.id,
    type: row.candidate.type,
    origin: row.origin,
    baselineRank: row.candidate.semanticOnly ? null : row.candidate.baselineRank,
    semanticRank: row.semanticRank,
    similarity: row.similarity,
    arm,
    armRank: index + 1,
    budgetIncluded: selected.has(row.candidate.id),
    resultRank: resultRanks.get(row.candidate.id) ?? null,
  }));
  return { arm, ids: [...selected], traces };
}

export function baselineArmTraces(candidates: readonly ShadowCandidate[]): readonly ShadowCandidateTrace[] {
  return [...candidates]
    .sort((a, b) => a.baselineRank - b.baselineRank)
    .map((candidate) => ({
      id: candidate.id,
      type: candidate.type,
      origin: candidate.baselineOrigin ?? "keyword",
      baselineRank: candidate.baselineRank,
      semanticRank: null,
      similarity: null,
      arm: "baseline",
      armRank: candidate.baselineRank,
      budgetIncluded: candidate.baselineIncluded,
      resultRank: candidate.baselineResultRank ?? null,
    }));
}
