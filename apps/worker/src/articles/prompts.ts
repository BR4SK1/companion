/**
 * Article-reaction prompt envelopes and output contracts.
 *
 * The persona-bearing prompt TEXT itself is personal configuration stored in
 * `article_prompt` (provisioned per deployment, never code content) — this
 * module only owns the mechanical envelope: how an article excerpt is
 * presented to the model, how the reaction and review outputs are parsed,
 * and the bounded task presets. Nothing here invents policy content.
 */

import type { TaskPreset } from "../memory/llm.ts";
import type { FeedArticle } from "./types.ts";

export const ARTICLE_REACTION_GENERATION_PROMPT_VERSION = "article-reaction-generation-v1";
export const ARTICLE_REACTION_REVIEW_PROMPT_VERSION = "article-reaction-review-v1";
export const ARTICLE_INTEREST_CONSOLIDATION_PROMPT_VERSION =
  "article-interest-consolidation-v1";

/** Maximum reaction text length accepted from the generation task. */
export const MAX_REACTION_CHARS = 1_000;
/** Maximum excerpt characters presented to the model per article. */
export const MAX_ARTICLE_INPUT_CHARS = 4_000;

/** Bounded task presets for the article LLM tasks. */
export const articleTaskPresets: Readonly<{
  generation: TaskPreset;
  review: TaskPreset;
  consolidation: TaskPreset;
}> = {
  generation: {
    maxTokens: 2_000,
    temperature: 0.6,
    reasoningEffort: "low",
  },
  review: {
    maxTokens: 1_000,
    temperature: 0.1,
    reasoningEffort: "low",
  },
  consolidation: {
    maxTokens: 2_000,
    temperature: 0.1,
    reasoningEffort: "low",
  },
};

export interface ArticlePromptInput {
  readonly sourceName: string;
  readonly title: string;
  readonly excerpt: string;
  readonly url: string;
  readonly publishedAt: string | null;
}

/** Deterministically render the article for the generation prompt. */
export function renderArticleReactionInput(article: ArticlePromptInput): string {
  return [
    "SOURCE ARTICLE",
    `SOURCE NAME: ${article.sourceName}`,
    `TITLE: ${article.title}`,
    `URL: ${article.url}`,
    `PUBLISHED: ${article.publishedAt ?? "unknown"}`,
    `EXCERPT: ${article.excerpt}`,
    "END SOURCE ARTICLE",
  ].join("\n");
}

/** Deterministically render the reaction under review with its article. */
export function renderArticleReviewInput(
  article: ArticlePromptInput,
  reaction: string,
): string {
  return [
    "REVIEW REQUEST",
    `SOURCE NAME: ${article.sourceName}`,
    `TITLE: ${article.title}`,
    "PROPOSED REACTION:",
    reaction,
    "END REVIEW REQUEST",
  ].join("\n");
}

export type ReactionReviewVerdict = "accept" | "reject";

export interface ReactionReviewOutput {
  readonly verdict: ReactionReviewVerdict;
  readonly reason: string;
}

function boundedText(value: string, maxChars: number): string {
  return value.length > maxChars ? value.slice(0, maxChars) : value;
}

/**
 * Validate the generation output: non-empty, bounded. Returns the trimmed
 * reaction or null when unusable. The model's reasoning content is already
 * stripped by the caller adapter; only visible text arrives here.
 */
export function parseReactionText(text: string, maxChars = MAX_REACTION_CHARS): string | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  return boundedText(trimmed, maxChars);
}

/**
 * Parse the review output: a JSON object with `verdict` ("accept" or
 * "reject") and a bounded `reason`. Tolerates surrounding text by taking the
 * first balanced JSON object. Returns null when unusable.
 */
export function parseReactionReview(text: string): ReactionReviewOutput | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          const parsed: unknown = JSON.parse(text.slice(start, i + 1));
          if (typeof parsed !== "object" || parsed === null) return null;
          const record = parsed as Record<string, unknown>;
          const verdict = record.verdict;
          const reason = record.reason;
          if (verdict !== "accept" && verdict !== "reject") return null;
          if (typeof reason !== "string") return null;
          return { verdict, reason: boundedText(reason.trim(), 500) };
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/**
 * The synthetic source key for a reaction: traceable to its reaction row and
 * stable across attempts (the reaction row id is stable per article). Each
 * independently sourced reaction is one distinct evidence unit; a regenerated
 * reaction replaces its fact (accepted is terminal, so an accepted reaction
 * never regenerates and never duplicates evidence).
 */
export function articleSourceKey(reactionId: string): string {
  return `article:${reactionId}`;
}

export const __internal = { boundedText };

// ---------------------------------------------------------------------------
// Article interest consolidation (turn-free evidence path)
// ---------------------------------------------------------------------------

/** One article-sourced fact as presented to the consolidation model. */
export interface ArticleConsolidationFactInput {
  readonly factKey: string;
  readonly claim: string;
  readonly topics: readonly string[];
  readonly observedAt: string;
}

/** The fixed source envelope of the consolidation render. */
const CONSOLIDATION_SOURCE_HEADER = "RECORDED ARTICLE REACTIONS";
const CONSOLIDATION_SOURCE_FOOTER = "END RECORDED ARTICLE REACTIONS";

/** One article-sourced fact rendered as its source block. */
export function renderArticleInterestConsolidationFactBlock(
  fact: ArticleConsolidationFactInput,
): string {
  return [
    `FACT ${fact.factKey}`,
    `OBSERVED: ${fact.observedAt}`,
    `TOPICS: ${fact.topics.join(", ")}`,
    fact.claim,
  ].join("\n");
}

/** Deterministically render the bounded fact set for the consolidation call. */
export function renderArticleInterestConsolidationInput(
  facts: readonly ArticleConsolidationFactInput[],
): string {
  return [
    CONSOLIDATION_SOURCE_HEADER,
    ...facts.map((fact) => renderArticleInterestConsolidationFactBlock(fact)),
    CONSOLIDATION_SOURCE_FOOTER,
  ].join("\n\n");
}

/**
 * The character length a rendered source has before and after any fact
 * blocks (header, footer, and the one separator that remains when the block
 * list is empty). Callers that account the rendered size block by block add
 * each block's length plus its leading block separator (`\n\n`, two
 * characters): total = envelope + Σ (block.length + 2).
 */
export function articleInterestConsolidationEnvelopeChars(): number {
  return (
    CONSOLIDATION_SOURCE_HEADER.length +
    CONSOLIDATION_SOURCE_FOOTER.length +
    2 // the single "\n\n" separator between header and footer
  );
}

export interface ArticleConsolidationCandidate {
  readonly claim: string;
  readonly condition?: string;
  readonly consequence?: string;
  readonly topics: readonly string[];
  readonly sourceFactIds: readonly string[];
  readonly contradictionFactIds?: readonly string[];
}

const MAX_CANDIDATE_CLAIM_CHARS = 1_000;
const MAX_CANDIDATE_RELATION_CHARS = 500;
const MAX_CANDIDATE_TOPICS = 32;
const MAX_CANDIDATE_FACT_IDS = 64;

function boundedTopicList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const topics = value
    .filter((topic): topic is string => typeof topic === "string")
    .map((topic) => topic.trim())
    .filter((topic) => topic.length > 0)
    .slice(0, MAX_CANDIDATE_TOPICS);
  return topics.length > 0 ? topics : undefined;
}

function boundedFactIdList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const ids = value
    .filter((id): id is string => typeof id === "string")
    .map((id) => id.trim())
    .filter((id) => id.length > 0)
    .slice(0, MAX_CANDIDATE_FACT_IDS);
  return ids.length > 0 ? ids : undefined;
}

/**
 * Parse the consolidation output: `{observations: [...]}` where each
 * candidate carries a claim, optional relations, topics, and the fact ids it
 * rests on. The subject and kind are code-owned (the assistant subject and
 * the preference kind — article-sourced reactions contribute to assistant
 * interests/preferences evidence only), so the model never chooses them.
 * Tolerates surrounding text by taking the first balanced JSON object.
 * Returns null when unusable.
 */
export function parseArticleInterestConsolidation(
  text: string,
): ArticleConsolidationCandidate[] | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          const parsed: unknown = JSON.parse(text.slice(start, i + 1));
          if (typeof parsed !== "object" || parsed === null) return null;
          const record = parsed as Record<string, unknown>;
          const observations = record.observations;
          if (!Array.isArray(observations)) return null;
          const candidates: ArticleConsolidationCandidate[] = [];
          for (const entry of observations) {
            if (typeof entry !== "object" || entry === null) return null;
            const item = entry as Record<string, unknown>;
            const claim = item.claim;
            if (typeof claim !== "string") return null;
            const normalizedClaim = claim.replace(/\s+/g, " ").trim();
            if (normalizedClaim.length === 0) return null;
            const topics = boundedTopicList(item.topics);
            if (topics === undefined) return null;
            const sourceFactIds = boundedFactIdList(item.sourceFactIds);
            if (sourceFactIds === undefined) return null;
            const condition = typeof item.condition === "string"
              ? (item.condition.replace(/\s+/g, " ").trim().slice(
                  0,
                  MAX_CANDIDATE_RELATION_CHARS,
                ) || undefined)
              : undefined;
            const consequence = typeof item.consequence === "string"
              ? (item.consequence.replace(/\s+/g, " ").trim().slice(
                  0,
                  MAX_CANDIDATE_RELATION_CHARS,
                ) || undefined)
              : undefined;
            const contradictionFactIds = boundedFactIdList(item.contradictionFactIds);
            candidates.push({
              claim: normalizedClaim.slice(0, MAX_CANDIDATE_CLAIM_CHARS),
              ...(condition !== undefined ? { condition } : {}),
              ...(consequence !== undefined ? { consequence } : {}),
              topics,
              sourceFactIds,
              ...(contradictionFactIds !== undefined
                ? { contradictionFactIds }
                : {}),
            });
          }
          return candidates;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/**
 * The structured output contract for the consolidation call, in the
 * transport's `response_format` envelope (the OpenRouter chat endpoint takes
 * `json_schema` with a named, strict schema — a bare JSON Schema object is
 * not a valid `response_format`). Optional fields are nullable unions so the
 * strict schema can require every key; the parser tolerates absent and null
 * optional fields alike.
 */
export const ARTICLE_INTEREST_CONSOLIDATION_RESPONSE_FORMAT: Record<string, unknown> = {
  type: "json_schema",
  json_schema: {
    name: "article_interest_consolidation",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        observations: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              claim: { type: "string" },
              condition: { type: ["string", "null"] },
              consequence: { type: ["string", "null"] },
              topics: { type: "array", items: { type: "string" } },
              sourceFactIds: { type: "array", items: { type: "string" } },
              contradictionFactIds: { type: ["array", "null"], items: { type: "string" } },
            },
            required: [
              "claim",
              "condition",
              "consequence",
              "topics",
              "sourceFactIds",
              "contradictionFactIds",
            ],
          },
        },
      },
      required: ["observations"],
    },
  },
};
