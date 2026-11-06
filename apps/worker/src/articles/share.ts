/**
 * Per-turn article-memory share decision.
 *
 * One optional `choice` decision question per turn: the offered options are
 * the cooldown-eligible accepted article reactions, newest first, each
 * described by its article, plus a permanent `none` option. The decision
 * selects context retrieval/inclusion for this turn's prompt — it never
 * asserts that a memory was or will be shared. The durable record of what
 * happened is the `article_share` row, which records PROMPT INCLUSION, not a
 * share claim.
 *
 * Candidate selection is deterministic and bounded:
 *
 * - newest-first by reaction generation time (accepted reactions only, each
 *   carrying its memory-fact key),
 * - cooldown-filtered: a reaction included in a prompt within the configured
 *   cooldown window is not offered again,
 * - deduplicated against the turn's lexical recall: a fact the recall chunk
 *   already surfaced is not offered separately,
 * - bounded by the configured `decisionMaxCandidates`.
 *
 * Configuration (cooldown window, candidate cap) is loaded from PostgreSQL
 * with the same fail-closed contract as ingestion: a missing or disabled
 * configuration yields no candidates (the question is not asked), and only
 * unexpected failures are logged with a fixed error category.
 */

import type { PostgresPool } from "@companion/postgres";
import type {
  DecisionsChoiceQuestion,
  DecisionsResponse,
} from "@companion/openrouter";

import { recordMemoryOperation } from "../memory/runtime.ts";
import {
  ArticleConfigurationInvalidError,
  ArticleConfigurationMissingError,
  ArticleDisabledError,
} from "./errors.ts";
import { articleErrorCategory } from "./errors.ts";
import { loadArticleConfiguration } from "./config.ts";
import { UnusableDecisionError } from "../work/decision.ts";
import type { ArticleMemoryCandidate } from "./types.ts";

/** Fixed question id for the per-turn article-memory share choice. */
export const ARTICLE_SHARE_QUESTION_ID = "article_memory_share";

/** The permanent no-action option: include nothing from the article memory. */
export const ARTICLE_SHARE_NONE_CHOICE = "none";

/** Reaction excerpt used in an option's description, in characters. */
const MAX_OPTION_DESCRIPTION_CHARS = 200;

export interface ArticleShareDecisionContext {
  readonly candidates: readonly ArticleMemoryCandidate[];
}

/**
 * Mechanical, mechanism-level instructions: how to choose, not what any
 * specific memory is or when sharing fits. The decision selects context
 * inclusion for this turn only.
 */
const ARTICLE_SHARE_INSTRUCTIONS =
  "One of these options may be included as background context for this turn. " +
  "Select none unless including one clearly fits the conversation state.";

function reactionDescription(candidate: ArticleMemoryCandidate): string {
  const reaction = candidate.reaction.replace(/\s+/g, " ").trim();
  const excerpt = reaction.length > MAX_OPTION_DESCRIPTION_CHARS
    ? `${reaction.slice(0, MAX_OPTION_DESCRIPTION_CHARS - 3)}...`
    : reaction;
  return `From the article "${candidate.title}" (${candidate.feedId}): ${excerpt}`;
}

/**
 * Build the typed optional share question. Option keys are reaction ids
 * (uuids) plus the reserved `none` option; descriptions describe each
 * candidate's article and reaction, passed through unchanged otherwise.
 * Criteria are built with `Object.defineProperty` (own-key-safe, same hazard
 * the pattern choice guards against).
 */
export function buildArticleShareQuestion(
  candidates: readonly ArticleMemoryCandidate[],
): { readonly questionId: string; readonly question: DecisionsChoiceQuestion } {
  if (candidates.length === 0) {
    throw new UnusableDecisionError(
      "cannot build an article share question with no candidates",
    );
  }
  const criteria: Record<string, string> = {
    [ARTICLE_SHARE_NONE_CHOICE]: "Include no article memory as context for this turn.",
  };
  for (const candidate of candidates) {
    Object.defineProperty(criteria, candidate.reactionId, {
      value: reactionDescription(candidate),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return {
    questionId: ARTICLE_SHARE_QUESTION_ID,
    question: {
      type: "choice",
      instructions: ARTICLE_SHARE_INSTRUCTIONS,
      criteria,
    },
  };
}

export type ArticleShareSelection =
  | { readonly kind: "none" }
  | { readonly kind: "selected"; readonly candidate: ArticleMemoryCandidate };

/**
 * Extract the share answer from a validated exchange. Throws
 * `UnusableDecisionError` when the answer does not name `none` or one of the
 * offered candidates — no silent fallback.
 */
export function selectArticleShare(
  response: DecisionsResponse,
  candidates: readonly ArticleMemoryCandidate[],
): ArticleShareSelection {
  const offered = new Set([
    ARTICLE_SHARE_NONE_CHOICE,
    ...candidates.map((candidate) => candidate.reactionId),
  ]);
  const answer = response.answers[ARTICLE_SHARE_QUESTION_ID];
  if (
    answer === undefined ||
    !Object.hasOwn(response.answers, ARTICLE_SHARE_QUESTION_ID)
  ) {
    throw new UnusableDecisionError(
      "decision response has no answer for the article-share question",
    );
  }
  if (answer.type !== "choice") {
    throw new UnusableDecisionError(
      `article-share question expected a choice answer, got ${answer.type}`,
    );
  }
  if (!offered.has(answer.choice)) {
    throw new UnusableDecisionError(
      `article-share decision chose ${JSON.stringify(answer.choice)}, which is not an offered option`,
    );
  }
  if (answer.choice === ARTICLE_SHARE_NONE_CHOICE) {
    return { kind: "none" };
  }
  const candidate = candidates.find(
    (entry) => entry.reactionId === answer.choice,
  );
  if (candidate === undefined) {
    throw new UnusableDecisionError(
      "article-share decision named an offered option that is no longer a candidate",
    );
  }
  return { kind: "selected", candidate };
}

/**
 * Load the per-turn share candidates. Configuration is loaded fresh from
 * PostgreSQL (fail-closed): a missing, incomplete, or disabled configuration
 * is a rollout state that yields no candidates and asks no question. An
 * invalid configuration or an unexpected failure is logged with a fixed
 * error category (never message text) and also yields no candidates.
 */
export async function loadArticleShareContext(
  pool: PostgresPool,
  input: {
    /** Fact keys the lexical recall chunk already surfaced this turn. */
    readonly recallFactKeys?: readonly string[];
    readonly now?: Date;
  },
): Promise<ArticleShareDecisionContext | null> {
  const now = input.now ?? new Date();
  let config;
  try {
    config = await loadArticleConfiguration(pool);
  } catch (error) {
    if (
      error instanceof ArticleConfigurationMissingError ||
      error instanceof ArticleDisabledError
    ) {
      return null;
    }
    const category = error instanceof ArticleConfigurationInvalidError
      ? "configuration_invalid"
      : articleErrorCategory(error);
    console.warn(`[ARTICLE] share candidates unavailable: ${category}`);
    return null;
  }

  const cutoffMs = now.getTime() - config.behavior.shareCooldownMinutes * 60_000;
  const cutoff = new Date(cutoffMs);
  const excludedFactKeys = [...new Set(input.recallFactKeys ?? [])];
  const result = await pool.query<{
    reaction_id: string;
    item_id: string;
    url: string;
    title: string;
    feed_id: string;
    reaction: string;
    fact_key: string;
    published_at: Date | null;
    generated_at: Date;
  }>(
    `SELECT r.id AS reaction_id, i.id AS item_id, i.url, i.title, i.feed_id,
            r.reaction, r.fact_key, i.published_at, r.generated_at
     FROM article_reaction r
     JOIN article_item i ON i.id = r.item_id
     WHERE r.state = 'accepted'
       AND r.fact_key IS NOT NULL
       AND r.reaction IS NOT NULL
       AND r.fact_key::text <> ALL($1::text[])
       AND NOT EXISTS (
         SELECT 1 FROM article_share s
         WHERE s.reaction_id = r.id AND s.included_at > $2
       )
     ORDER BY r.generated_at DESC, r.id DESC
     LIMIT $3`,
    [excludedFactKeys, cutoff, config.behavior.decisionMaxCandidates],
  );
  const candidates: ArticleMemoryCandidate[] = result.rows.map((row) => ({
    reactionId: row.reaction_id,
    itemId: row.item_id,
    url: row.url,
    title: row.title,
    feedId: row.feed_id,
    reaction: row.reaction,
    factKey: row.fact_key,
    publishedAt: row.published_at?.toISOString() ?? null,
    generatedAt: row.generated_at.toISOString(),
  }));
  return { candidates };
}

function formatAgeShort(generatedAt: Date, now: Date): string {
  const diffMs = Math.max(0, now.getTime() - generatedAt.getTime());
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 60) return `${String(Math.max(1, minutes))}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${String(hours)}h ago`;
  const days = Math.floor(hours / 24);
  return `${String(days)}d ago`;
}

function sanitizeForXmlText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const MAX_CONTEXT_REACTION_CHARS = 600;

/**
 * Render the chosen candidate as the turn's `article` context chunk. The
 * chunk describes provenance (article title, source feed, URL, reaction age)
 * and presents the reaction text as background context — it never instructs
 * the model to share anything and never claims a share happened.
 */
export function buildArticleShareContextForPrompt(
  candidate: ArticleMemoryCandidate,
  now: Date = new Date(),
): string {
  const generatedAt = new Date(candidate.generatedAt);
  const age = Number.isNaN(generatedAt.getTime())
    ? "unknown age"
    : formatAgeShort(generatedAt, now);
  const title = sanitizeForXmlText(candidate.title);
  const url = sanitizeForXmlText(candidate.url);
  const reaction = candidate.reaction.replace(/\s+/g, " ").trim();
  const boundedReaction = reaction.length > MAX_CONTEXT_REACTION_CHARS
    ? `${reaction.slice(0, MAX_CONTEXT_REACTION_CHARS - 3)}...`
    : reaction;
  return [
    "An article you read earlier, offered as background context. Reference it naturally when relevant — do not force it into conversation.",
    `- "${title}" (${url}) [read ${age}]`,
    `  Reaction you noted at the time: ${sanitizeForXmlText(boundedReaction)}`,
  ].join("\n");
}

/**
 * Record one prompt-inclusion event for the chosen reaction. The row records
 * PROMPT INCLUSION, not a share claim; the share cooldown is computed from
 * the newest inclusion's `included_at`, which is the provided `now` (or the
 * current worker clock). Idempotent per (reaction, turn) via the partial
 * unique index, so a retried turn's duplicate write is a no-op. The
 * accompanying metadata-only trace is best-effort and never fails the turn.
 */
export async function recordArticleShareInclusion(
  pool: PostgresPool,
  input: {
    readonly turnId: string;
    readonly reactionId: string;
    readonly now?: Date;
  },
): Promise<void> {
  const startedAt = input.now ?? new Date();
  // The provided `now` is the inclusion instant itself: the cooldown is
  // computed from `included_at`, so it must come from the same clock the
  // caller (and the cooldown query) reasons about, not a separate DB stamp.
  await pool.query(
    `INSERT INTO article_share (reaction_id, turn_id, included_at)
     VALUES ($1, $2, $3)
     ON CONFLICT (reaction_id, turn_id) WHERE turn_id IS NOT NULL DO NOTHING`,
    [input.reactionId, input.turnId, startedAt],
  );
  await recordMemoryOperation(pool, {
    kind: "article_memory_share",
    outcome: "ok",
    detail: `turn=${input.turnId} reaction=${input.reactionId}`,
    startedAt,
    finishedAt: new Date(),
  }).catch(() => undefined);
}

export const __internal = {
  reactionDescription,
  formatAgeShort,
};
