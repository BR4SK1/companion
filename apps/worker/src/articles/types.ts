/**
 * Article-ingestion domain types.
 *
 * The article domain is hosted by the worker deployable and is owner-only:
 * feeds, prompts, policy limits, and the model are personal configuration
 * stored in relational tables (`article_feed`, `article_behavior`,
 * `article_prompt`), never code constants or environment values. See
 * `migrations.ts` and the root `AGENTS.md` for the configuration rules.
 */

import type { MemoryLlmCallInput, MemoryLlmCallResult } from "../memory/llm.ts";

/** One configured feed. Personal deployment configuration. */
export interface ArticleFeed {
  readonly id: string;
  readonly url: string;
  readonly enabled: boolean;
  readonly position: number;
}

/** Ingestion policy (single `article_behavior` row), with its enable switch. */
export interface ArticleBehaviorConfig {
  readonly enabled: boolean;
  readonly model: string;
  readonly maxGenerationsPerRun: number;
  readonly maxReactionAttempts: number;
  readonly maxArticleAgeDays: number;
  readonly maxReactionChars: number;
  readonly maxExcerptChars: number;
  readonly decisionMaxCandidates: number;
  readonly shareCooldownMinutes: number;
}

/** A provisioned persona prompt for one article LLM task. */
export interface ArticlePromptConfig {
  readonly kind: "reaction_generation" | "reaction_review";
  readonly version: string;
  readonly systemPrompt: string;
  readonly contentHash: string;
}

/** The full loaded configuration for one ingestion attempt or turn. */
export interface ArticleConfiguration {
  readonly behavior: ArticleBehaviorConfig;
  readonly feeds: readonly ArticleFeed[];
  readonly prompts: Readonly<Record<ArticlePromptConfig["kind"], ArticlePromptConfig>>;
  /** The assistant subject reactions are attributed to (from memory_subject). */
  readonly assistantSubjectId: string;
}

export class ArticleConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArticleConfigurationError";
  }
}

/** The LLM caller shape shared by the article runtime's LLM tasks. */
export type ArticleRuntimeLlmCaller = (
  model: string,
  input: MemoryLlmCallInput,
) => Promise<MemoryLlmCallResult>;

/** Thrown when configuration exists but the feature is switched off. */
export class ArticleDisabledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArticleDisabledError";
  }
}

/** A parsed excerpt-level article from a feed (never full-page content). */
export interface FeedArticle {
  readonly feedId: string;
  readonly url: string;
  readonly title: string;
  readonly excerpt: string;
  readonly publishedAt: Date | null;
}

/** A durable fetched item. */
export interface ArticleItem {
  readonly id: string;
  readonly feedId: string;
  readonly url: string;
  readonly title: string;
  readonly excerpt: string;
  readonly publishedAt: Date | null;
  readonly fetchedAt: Date;
}

export type ArticleReactionState = "generating" | "accepted" | "rejected" | "failed";

/** A durable reaction attempt record for one item. */
export interface ArticleReaction {
  readonly id: string;
  readonly itemId: string;
  readonly state: ArticleReactionState;
  readonly attemptCount: number;
  readonly reaction: string | null;
  readonly leaseExpiresAt: Date | null;
  readonly lastError: string | null;
  readonly model: string | null;
  readonly generationPromptVersion: string | null;
  readonly generatedAt: Date | null;
  readonly reviewPromptVersion: string | null;
  readonly reviewedAt: Date | null;
  readonly factKey: string | null;
}

/** Result metadata of one ingestion attempt. */
export interface ArticleIngestionResult {
  readonly feedsAttempted: number;
  readonly feedsFailed: number;
  readonly itemsFetched: number;
  readonly itemsNew: number;
  readonly candidatesAttempted: number;
  readonly generated: number;
  readonly rejected: number;
  readonly failed: number;
  readonly skippedClaims: number;
  /**
   * Attempts whose terminal finalize did not apply: the lease was lost
   * between claim and finalize (expired, with or without a takeover) or the
   * finalize itself errored. The provider call was spent but nothing was
   * written and no terminal outcome is counted. The row stays recoverable by
   * the normal paths — another claim over the expired lease, or the
   * exhausted-lease sweep.
   */
  readonly lostFinalizes: number;
  readonly llmCalls: number;
}

/**
 * A candidate for the per-turn article-memory decision: a newest-first,
 * cooldown-filtered accepted reaction with its source metadata.
 */
export interface ArticleMemoryCandidate {
  readonly reactionId: string;
  readonly itemId: string;
  readonly url: string;
  readonly title: string;
  readonly feedId: string;
  readonly reaction: string;
  readonly factKey: string | null;
  readonly publishedAt: string | null;
  readonly generatedAt: string;
}

/** One recent accepted article memory as served by the retrieval API. */
export interface ArticleMemoryItem {
  readonly reactionId: string;
  readonly url: string;
  readonly title: string;
  readonly feedId: string;
  readonly reaction: string;
  readonly factKey: string | null;
  readonly publishedAt: string | null;
  readonly generatedAt: string;
}

/** Retrieval API response: deterministic newest-first accepted memories. */
export interface ArticleMemoriesResponse {
  readonly results: readonly ArticleMemoryItem[];
  readonly limit: number;
}

export interface ArticleIngestionSummary {
  readonly result: ArticleIngestionResult;
  readonly status: "ok" | "not_configured" | "disabled" | "invalid";
  /**
   * Ok attempts only: the number of enabled feeds configuration provided for
   * this attempt. The runtime uses it to rotate the next run's starting
   * position past the feeds this run attempted (see `MAX_FEEDS_PER_RUN`).
   */
  readonly feedsAvailable?: number;
}
