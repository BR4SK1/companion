/**
 * Programmatic article-memory retrieval.
 *
 * The deterministic read surface for accepted article memories: newest-first
 * by reaction generation time, with a caller-configurable limit bounded by
 * safe defaults and maxima. Independent of lexical recall — no query text,
 * no ranking, no LLM involvement; ordering and shape are fully determined.
 *
 * This surface serves reads only. Retrieval never writes state, never
 * creates or strengthens evidence, and never counts as new memory evidence.
 */

import type { PostgresPool } from "@companion/postgres";

import type { ArticleMemoriesResponse } from "./types.ts";

/** Default page size of the bounded article-memory retrieval. */
export const DEFAULT_ARTICLE_MEMORIES_LIMIT = 20;

/** Maximum page size of the bounded article-memory retrieval. */
export const MAX_ARTICLE_MEMORIES_LIMIT = 100;

export class ArticleMemoriesValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArticleMemoriesValidationError";
  }
}

/**
 * Caller-configurable limit with safe defaults and maxima: an omitted limit
 * takes the default; an out-of-range value is a validation error the caller
 * maps to its own boundary (the private API maps it to 400).
 */
export function normalizeArticleMemoriesLimit(limit?: number): number {
  if (limit === undefined) return DEFAULT_ARTICLE_MEMORIES_LIMIT;
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > MAX_ARTICLE_MEMORIES_LIMIT
  ) {
    throw new ArticleMemoriesValidationError(
      `limit must be an integer between 1 and ${String(MAX_ARTICLE_MEMORIES_LIMIT)}`,
    );
  }
  return limit;
}

/**
 * Newest-first accepted article memories: each accepted reaction with its
 * article metadata and the memory-fact key it produced. Deterministic
 * ordering (`generated_at DESC, reaction id DESC`); the limit is bounded by
 * `normalizeArticleMemoriesLimit`.
 */
export async function getRecentArticleMemories(
  pool: PostgresPool,
  input: { readonly limit?: number },
): Promise<ArticleMemoriesResponse> {
  const limit = normalizeArticleMemoriesLimit(input.limit);
  const result = await pool.query<{
    reaction_id: string;
    url: string;
    title: string;
    feed_id: string;
    reaction: string;
    fact_key: string;
    published_at: Date | null;
    generated_at: Date;
  }>(
    `SELECT r.id AS reaction_id, i.url, i.title, i.feed_id,
            r.reaction, r.fact_key, i.published_at, r.generated_at
     FROM article_reaction r
     JOIN article_item i ON i.id = r.item_id
     WHERE r.state = 'accepted'
       AND r.fact_key IS NOT NULL
       AND r.reaction IS NOT NULL
     ORDER BY r.generated_at DESC, r.id DESC
     LIMIT $1`,
    [limit],
  );
  return {
    results: result.rows.map((row) => ({
      reactionId: row.reaction_id,
      url: row.url,
      title: row.title,
      feedId: row.feed_id,
      reaction: row.reaction,
      factKey: row.fact_key,
      publishedAt: row.published_at?.toISOString() ?? null,
      generatedAt: row.generated_at.toISOString(),
    })),
    limit,
  };
}
