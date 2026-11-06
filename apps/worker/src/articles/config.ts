/**
 * Article-ingestion configuration, loaded from PostgreSQL on every attempt.
 *
 * Configuration tables (`article_feed`, `article_behavior`, `article_prompt`)
 * are personal deployment configuration — provisioned per deployment, never
 * seeded by migrations or shipped in code. Loading is fail-closed and
 * happens at every scheduled/manual attempt, so provisioning the tables
 * takes effect on the next attempt without a worker restart:
 *
 * - A missing or incomplete configuration (no behavior row, a missing
 *   required prompt row, or no enabled feed) is an
 *   `ArticleConfigurationMissingError`: the runtime logs exactly
 *   `ingestion not configured` and the attempt returns before any feed
 *   fetch, provider call, or article state write.
 * - An invalid configuration (a malformed URL or out-of-range limit) is an
 *   `ArticleConfigurationInvalidError` — distinct from missing.
 * - A behavior row with enabled=false is an `ArticleDisabledError`.
 */

import type { PostgresPool } from "@companion/postgres";

import { promptContentHash } from "../memory/prompts.ts";
import {
  ArticleConfigurationInvalidError,
  ArticleConfigurationMissingError,
  ArticleDisabledError,
} from "./errors.ts";
import {
  ARTICLE_REACTION_GENERATION_PROMPT_VERSION,
  ARTICLE_REACTION_REVIEW_PROMPT_VERSION,
} from "./prompts.ts";
import type { ArticleConfiguration, ArticleFeed } from "./types.ts";

interface BehaviorRow {
  enabled: boolean;
  model: string;
  max_generations_per_run: number;
  max_reaction_attempts: number;
  max_article_age_days: number;
  max_reaction_chars: number;
  max_excerpt_chars: number;
  share_cooldown_minutes: number;
  decision_max_candidates: number;
}

interface FeedRow {
  id: string;
  url: string;
  position: number;
}

interface PromptRow {
  kind: string;
  version: string;
  system_prompt: string;
}

/** Limits with hard code-side bounds so bad rows can never unbound the run. */
const HARD_MAX_GENERATIONS_PER_RUN = 10;
const HARD_MAX_CANDIDATES = 8;
const HARD_MAX_AGE_DAYS = 365;
const HARD_MAX_ATTEMPTS = 5;
const HARD_MAX_REACTION_CHARS = 4_000;
const HARD_MAX_COOLDOWN_MINUTES = 10_080;
const HARD_MAX_EXCERPT_CHARS = 20_000;
const DEFAULT_MAX_EXCERPT_CHARS = 2_000;

export const DEFAULT_SHARE_COOLDOWN_MINUTES = 4 * 60 * 24 * 7;
export const DEFAULT_DECISION_MAX_CANDIDATES = 3;

export interface ArticleConfigPromptVersions {
  readonly generation: string;
  readonly review: string;
}

function boundedPositiveInt(value: number, hardMax: number, fallback: number, field: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new ArticleConfigurationInvalidError(`${field} must be a positive integer`);
  }
  return Math.min(value, hardMax) || fallback;
}

function validateFeedUrl(url: string, feedId: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ArticleConfigurationInvalidError(`feed '${feedId}' url is not a valid URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ArticleConfigurationInvalidError(
      `feed '${feedId}' url must be http(s), got ${parsed.protocol}`,
    );
  }
  return url;
}

/**
 * Load and validate the article configuration. Throws:
 * - `ArticleConfigurationMissingError` when the required rows are absent.
 * - `ArticleConfigurationInvalidError` when a row is present but invalid.
 * - `ArticleDisabledError` when the behavior row disables the feature.
 */
export async function loadArticleConfiguration(
  pool: PostgresPool,
  promptVersions: ArticleConfigPromptVersions = {
    generation: ARTICLE_REACTION_GENERATION_PROMPT_VERSION,
    review: ARTICLE_REACTION_REVIEW_PROMPT_VERSION,
  },
): Promise<ArticleConfiguration> {
  const behaviorResult = await pool.query<BehaviorRow>(
    `SELECT enabled, model, max_generations_per_run, max_reaction_attempts,
            max_article_age_days, max_reaction_chars, max_excerpt_chars,
            share_cooldown_minutes, decision_max_candidates
     FROM article_behavior WHERE id = 'behavior'`,
  );
  const behaviorRow = behaviorResult.rows[0];
  if (behaviorRow === undefined) {
    throw new ArticleConfigurationMissingError(
      "article_behavior has no row; provision the behavior row to enable article ingestion",
    );
  }
  if (behaviorRow.enabled !== true) {
    throw new ArticleDisabledError();
  }

  const feedRows = await pool.query<FeedRow>(
    `SELECT id, url, position FROM article_feed WHERE enabled = true ORDER BY position, id`,
  );
  const feeds: ArticleFeed[] = feedRows.rows.map((row) => ({
    id: row.id,
    url: validateFeedUrl(row.url, row.id),
    // Only enabled feeds are selected; the position orders them.
    enabled: true,
    position: row.position,
  }));
  if (feeds.length === 0) {
    throw new ArticleConfigurationMissingError(
      "article_feed has no enabled rows; provision at least one enabled feed",
    );
  }

  const promptResult = await pool.query<PromptRow>(
    `SELECT kind, version, system_prompt FROM article_prompt
     WHERE (kind = 'reaction_generation' AND version = $1)
        OR (kind = 'reaction_review' AND version = $2)`,
    [promptVersions.generation, promptVersions.review],
  );
  const prompts = new Map(promptResult.rows.map((row) => [row.kind, row]));
  const generationPrompt = prompts.get("reaction_generation");
  const reviewPrompt = prompts.get("reaction_review");
  if (generationPrompt === undefined) {
    throw new ArticleConfigurationMissingError(
      `article_prompt has no reaction_generation row for version '${promptVersions.generation}'`,
    );
  }
  if (reviewPrompt === undefined) {
    throw new ArticleConfigurationMissingError(
      `article_prompt has no reaction_review row for version '${promptVersions.review}'`,
    );
  }
  if (generationPrompt.system_prompt.trim().length === 0) {
    throw new ArticleConfigurationInvalidError(
      "article_prompt reaction_generation system_prompt is empty",
    );
  }
  if (reviewPrompt.system_prompt.trim().length === 0) {
    throw new ArticleConfigurationInvalidError(
      "article_prompt reaction_review system_prompt is empty",
    );
  }

  const model = behaviorRow.model.trim();
  if (model.length === 0) {
    throw new ArticleConfigurationInvalidError("article_behavior.model is empty");
  }

  // Accepted reactions become real assistant-attributed memory facts, so the
  // assistant subject must exist. Fail closed when it does not.
  const assistantResult = await pool.query<{ id: string }>(
    `SELECT id FROM memory_subject WHERE role = 'assistant' LIMIT 1`,
  );
  const assistantSubjectId = assistantResult.rows[0]?.id;
  if (assistantSubjectId === undefined) {
    throw new ArticleConfigurationMissingError(
      "memory_subject has no assistant subject; article reactions cannot be attributed",
    );
  }

  return {
    behavior: {
      enabled: true,
      model,
      maxGenerationsPerRun: boundedPositiveInt(
        behaviorRow.max_generations_per_run,
        HARD_MAX_GENERATIONS_PER_RUN,
        3,
        "article_behavior.max_generations_per_run",
      ),
      maxReactionAttempts: boundedPositiveInt(
        behaviorRow.max_reaction_attempts,
        HARD_MAX_ATTEMPTS,
        3,
        "article_behavior.max_reaction_attempts",
      ),
      maxArticleAgeDays: boundedPositiveInt(
        behaviorRow.max_article_age_days,
        HARD_MAX_AGE_DAYS,
        120,
        "article_behavior.max_article_age_days",
      ),
      maxReactionChars: boundedPositiveInt(
        behaviorRow.max_reaction_chars,
        HARD_MAX_REACTION_CHARS,
        1_000,
        "article_behavior.max_reaction_chars",
      ),
      shareCooldownMinutes: boundedPositiveInt(
        behaviorRow.share_cooldown_minutes,
        HARD_MAX_COOLDOWN_MINUTES,
        DEFAULT_SHARE_COOLDOWN_MINUTES,
        "article_behavior.share_cooldown_minutes",
      ),
      decisionMaxCandidates: boundedPositiveInt(
        behaviorRow.decision_max_candidates,
        HARD_MAX_CANDIDATES,
        DEFAULT_DECISION_MAX_CANDIDATES,
        "article_behavior.decision_max_candidates",
      ),
      maxExcerptChars: boundedPositiveInt(
        behaviorRow.max_excerpt_chars,
        HARD_MAX_EXCERPT_CHARS,
        DEFAULT_MAX_EXCERPT_CHARS,
        "article_behavior.max_excerpt_chars",
      ),
    },
    assistantSubjectId,
    feeds,
    prompts: {
      reaction_generation: {
        kind: "reaction_generation",
        version: promptVersions.generation,
        systemPrompt: generationPrompt.system_prompt,
        contentHash: promptContentHash(generationPrompt.system_prompt),
      },
      reaction_review: {
        kind: "reaction_review",
        version: promptVersions.review,
        systemPrompt: reviewPrompt.system_prompt,
        contentHash: promptContentHash(reviewPrompt.system_prompt),
      },
    },
  };
}
