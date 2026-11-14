/**
 * Article ingestion runner: the in-process scheduler that keeps the article
 * pipeline moving on one owner's data.
 *
 * Responsibilities (serial per attempt, reconciling, traced metadata-only):
 *
 * - Load and validate the article configuration at every attempt (feeds,
 *   policy limits, model, prompts). Configuration lives in PostgreSQL
 *   (`article_feed`, `article_behavior`, `article_prompt`), so provisioning
 *   changes apply on the next attempt without a worker restart.
 * - Missing or incomplete configuration is a rollout state: the runner logs
 *   exactly `ingestion not configured` and returns before any feed fetch,
 *   provider call, or state write. It keeps polling, so provisioning later
 *   enables ingestion without a restart.
 * - Fetch each enabled feed with bounded, SSRF-safe networking and persist
 *   excerpt-level items idempotently (unique per URL; a re-fetch never
 *   duplicates an item).
 * - For eligible items, run the bounded generation -> review reaction flow
 *   with the provisioned persona prompts and model, under a claim lease so
 *   concurrent workers never double-generate. Accepted reactions become real
 *   assistant-attributed memory facts (`memory_fact` with
 *   `source_type = 'article'`) in the same transaction that marks them
 *   accepted, so a fact never exists without its reaction provenance.
 *
 * Every failure is logged with a bounded category and traced, never thrown
 * into the caller: article work must never break a chat turn or the worker
 * process.
 */

import { withTransaction, type PostgresPool } from "@companion/postgres";

import { recordMemoryOperation } from "../memory/runtime.ts";

import { loadArticleConfiguration } from "./config.ts";
import {
  ArticleConfigError,
  ArticleConfigurationInvalidError,
  ArticleConfigurationMissingError,
  ArticleDisabledError,
  articleErrorCategory,
} from "./errors.ts";
import {
  articleSourceKey,
  articleTaskPresets,
  ARTICLE_REACTION_GENERATION_PROMPT_VERSION,
  ARTICLE_REACTION_REVIEW_PROMPT_VERSION,
  parseReactionReview,
  parseReactionText,
  renderArticleReactionInput,
  renderArticleReviewInput,
} from "./prompts.ts";
import { runArticleObservationConsolidation } from "./observation.ts";
import { boundedFetchText, checkFeedUrlSafety, parseFeed, resolveFeedHost } from "./rss.ts";
import type { PinnedRequestFn } from "./pinnedHttp.ts";
import type { FeedHostLookup } from "./rss.ts";
import type {
  ArticleConfiguration,
  ArticleIngestionResult,
  ArticleIngestionSummary,
  ArticleRuntimeLlmCaller,
} from "./types.ts";

/** Re-exported for callers that associate the caller shape with the runtime. */
export type { ArticleRuntimeLlmCaller };

/** Ingest pipeline version recorded on article-sourced memory facts. */
export const ARTICLE_INGEST_VERSION = "article-ingest-v1";

/** How long a generation claim lease is held while an LLM attempt runs. */
const DEFAULT_LEASE_MS = 10 * 60 * 1000;
/** How often the runner wakes to check configuration and feeds when idle. */
const DEFAULT_POLL_INTERVAL_MS = 15 * 60 * 1000;
/**
 * Hard cap on feeds attempted per run: feed count is personal configuration
 * with no code-side bound, so without a cap one run's fetch phase (network
 * timeout per feed) would be unbounded. Feeds beyond the cap are not
 * starved: the runtime rotates the starting position across runs (see
 * `ArticleRuntimeDeps`), so every enabled feed is attempted over successive
 * runs. With the default 12s fetch timeout this bounds a run's fetch phase
 * at roughly two minutes plus the generation budget.
 */
export const MAX_FEEDS_PER_RUN = 8;
/** Bounded review output contract presented to the model. */
const REVIEW_RESPONSE_FORMAT: Record<string, unknown> = {
  type: "json_schema",
  json_schema: {
    name: "reaction_review",
    strict: true,
    schema: {
      type: "object",
      properties: {
        verdict: { type: "string", enum: ["accept", "reject"] },
        reason: { type: "string" },
      },
      required: ["verdict", "reason"],
      additionalProperties: false,
    },
  },
};

/** Mutable per-attempt accumulator; mapped onto the readonly result type. */
interface MutableIngestionResult {
  feedsAttempted: number;
  feedsFailed: number;
  itemsFetched: number;
  itemsNew: number;
  candidatesAttempted: number;
  generated: number;
  rejected: number;
  failed: number;
  skippedClaims: number;
  lostFinalizes: number;
  llmCalls: number;
}

function emptyResult(): MutableIngestionResult {
  return {
    feedsAttempted: 0,
    feedsFailed: 0,
    itemsFetched: 0,
    itemsNew: 0,
    candidatesAttempted: 0,
    generated: 0,
    rejected: 0,
    failed: 0,
    skippedClaims: 0,
    lostFinalizes: 0,
    llmCalls: 0,
  };
}

export interface ArticleRuntimeDeps {
  readonly pool: PostgresPool;
  /** Startup-captured authoritative timezone for evidence-day computations. */
  readonly timezone?: string | null;
  /**
   * The LLM caller, bound per call to the model configured in
   * `article_behavior` (the article domain owns its model choice in the
   * database, not in code or environment). Composition wires this to the
   * shared OpenRouter transport; tests inject fakes.
   */
  readonly callLlm: ArticleRuntimeLlmCaller;
  readonly log?: (message: string) => void;
  readonly pollIntervalMs?: number;
  readonly leaseMs?: number;
  /**
   * Injectable protocol transport for feed fetching (the pinned-connector
   * seam: a function shaped like node's http(s).request). Defaults to the
   * platform http/https modules, whose connect-time lookup hook is pinned to
   * the validated addresses (see pinnedHttp.ts); tests inject fakes so no
   * integration test touches the network.
   */
  readonly transport?: PinnedRequestFn;
  /**
   * Injectable all-address host lookup backing both the pre-connection host
   * validation (`resolveFeedHost`) and the connector's connect-time pinned
   * lookup. Defaults to the platform resolver (`systemLookup`); tests inject
   * a fake so no test performs real DNS.
   */
  readonly lookupAll?: FeedHostLookup;
  /**
   * Injectable pre-connection host validation for feed fetching. Defaults to
   * the real resolver (`resolveFeedHost`), so the production path validates
   * every resolved address before any request; tests inject fakes to stay
   * hermetic. This is a defense-in-depth belt: the connector re-validates
   * every address inside the connect-time lookup hook, so the connection is
   * pinned to validated addresses (no rebinding window).
   */
  readonly resolveFeedHost?: (url: string) => Promise<
    { ok: true } | { ok: false; reason: string }
  >;
}

export interface ArticleRuntime {
  /** Run one ingestion attempt now (also used by tests and manual checks). */
  runOnce(): Promise<ArticleIngestionSummary>;
  close(): Promise<void>;
}

interface ClaimedCandidate {
  readonly reactionId: string;
  readonly itemId: string;
  readonly feedId: string;
  readonly url: string;
  readonly title: string;
  readonly excerpt: string;
  readonly publishedAt: Date | null;
  readonly attemptCount: number;
  readonly leaseExpiresAt: Date;
}

interface ReactionRow {
  id: string;
  state: string;
  attempt_count: number;
  lease_expires_at: Date | null;
}

/**
 * Persist parsed feed items idempotently. The URL is the natural key: a
 * re-fetch updates the title and fetch stamp but never overwrites the
 * excerpt a reaction was generated from, so provenance stays stable.
 *
 * Items arrive validated from the parser (canonicalized http(s) URLs,
 * length-capped, no control characters in any text; see `parseFeed`), so a
 * hostile item is isolated at parse time and cannot fail this transaction
 * for the whole batch.
 */
async function persistFeedItems(
  pool: PostgresPool,
  articles: readonly { feedId: string; url: string; title: string; excerpt: string; publishedAt: Date | null }[],
): Promise<number> {
  if (articles.length === 0) return 0;
  return withTransaction(pool, async (client) => {
    let inserted = 0;
    for (const article of articles) {
      const result = await client.query<{ is_new: boolean }>(
        `INSERT INTO article_item (feed_id, url, title, excerpt, published_at, fetched_at)
         VALUES ($1, $2, $3, $4, $5, now())
         ON CONFLICT (url) DO UPDATE
           SET title = EXCLUDED.title, fetched_at = now(), updated_at = now()
         RETURNING (xmax = 0) AS is_new`,
        [article.feedId, article.url, article.title, article.excerpt, article.publishedAt],
      );
      if (result.rows[0]?.is_new === true) inserted += 1;
    }
    return inserted;
  });
}

/**
 * Select items eligible for a reaction attempt: never reacted, a generating
 * lease (a live lease stays selectable so the claim attempt below observes
 * and counts the skip instead of silently ignoring the item; a stale lease
 * retries, bounded by the attempt cap enforced again atomically at claim
 * time), or a rejected/failed reaction with attempts left. Only items of
 * currently ENABLED feeds are candidates — an item whose feed was disabled
 * after it was fetched never reacts. Items older than the configured age
 * limit are never candidates; undated items are treated as recent. Ordering
 * is newest fetch first, then URL, so concurrent attempts agree on the same
 * candidate order.
 */
async function selectReactionCandidates(
  pool: PostgresPool,
  config: ArticleConfiguration,
  limit: number,
): Promise<
  {
    itemId: string;
    feedId: string;
    url: string;
    title: string;
    excerpt: string;
    publishedAt: Date | null;
  }[]
> {
  const cutoff = new Date(Date.now() - config.behavior.maxArticleAgeDays * 24 * 60 * 60 * 1000);
  const result = await pool.query<{
    item_id: string;
    feed_id: string;
    url: string;
    title: string;
    excerpt: string;
    published_at: Date | null;
  }>(
    `SELECT i.id AS item_id, i.feed_id, i.url, i.title, i.excerpt, i.published_at
     FROM article_item i
     JOIN article_feed f ON f.id = i.feed_id AND f.enabled = true
     LEFT JOIN article_reaction r ON r.item_id = i.id
     WHERE (i.published_at IS NULL OR i.published_at >= $1)
       AND (
         r.id IS NULL
         OR (r.state = 'generating' AND r.attempt_count < $2)
         OR (r.state IN ('rejected', 'failed') AND r.attempt_count < $2)
       )
     ORDER BY i.fetched_at DESC, i.url ASC
     LIMIT $3`,
    [cutoff, config.behavior.maxReactionAttempts, limit],
  );
  return result.rows.map((row) => ({
    itemId: row.item_id,
    feedId: row.feed_id,
    url: row.url,
    title: row.title,
    excerpt: row.excerpt,
    publishedAt: row.published_at,
  }));
}

/**
 * Settle reaction rows whose attempt budget is exhausted while stalled in
 * 'generating' (a crashed worker's lease): they are never selected again, so
 * without this sweep they would sit as zombie leases forever. The sweep
 * turns them into an honest terminal failure. Live leases are untouched —
 * the row is only settled once its lease has expired.
 */
async function settleExhaustedReactions(
  pool: PostgresPool,
  maxReactionAttempts: number,
): Promise<void> {
  await pool.query(
    `UPDATE article_reaction
     SET state = 'failed',
         last_error = 'reaction attempt budget exhausted',
         lease_expires_at = NULL,
         updated_at = now()
     WHERE state = 'generating'
       AND attempt_count >= $1
       AND (lease_expires_at IS NULL OR lease_expires_at < now())`,
    [maxReactionAttempts],
  );
}

/**
 * Claim one item for a generation attempt under a lease. The claim is a
 * single guarded statement, so concurrent workers never double-generate: a
 * fresh item gets a new generating row; an existing retry-eligible row is
 * bumped only while its lease is not live AND its attempt budget is not
 * exhausted — the cap is enforced atomically here, not only at selection
 * time, so a row can never be bumped past `maxReactionAttempts` by a race
 * between selection and claim. Returns null when another worker owns the
 * item, the row became terminal since selection, or the attempt budget is
 * exhausted.
 */
async function claimReaction(
  pool: PostgresPool,
  itemId: string,
  leaseExpiresAt: Date,
  maxReactionAttempts: number,
): Promise<{ reactionId: string; attemptCount: number } | null> {
  return withTransaction(pool, async (client) => {
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO article_reaction (item_id, state, attempt_count, lease_expires_at)
       VALUES ($1, 'generating', 1, $2)
       ON CONFLICT (item_id) DO NOTHING
       RETURNING id`,
      [itemId, leaseExpiresAt],
    );
    if (inserted.rows[0] !== undefined) {
      return { reactionId: inserted.rows[0].id, attemptCount: 1 };
    }
    const bumped = await client.query<{ id: string; attempt_count: number }>(
      `UPDATE article_reaction
       SET state = 'generating',
           attempt_count = attempt_count + 1,
           lease_expires_at = $2,
           updated_at = now()
       WHERE item_id = $1
         AND state IN ('generating', 'rejected', 'failed')
         AND (state <> 'generating' OR lease_expires_at IS NULL OR lease_expires_at < now())
         AND attempt_count < $3
       RETURNING id, attempt_count`,
      [itemId, leaseExpiresAt, maxReactionAttempts],
    );
    const row = bumped.rows[0];
    if (row === undefined) return null;
    return { reactionId: row.id, attemptCount: row.attempt_count };
  });
}

interface FinalizeInput {
  readonly reactionId: string;
  readonly leaseExpiresAt: Date;
  readonly state: "accepted" | "rejected" | "failed";
  readonly reaction: string | null;
  readonly lastError: string | null;
  readonly model: string;
  readonly generatedAt: Date;
  readonly reviewedAt: Date | null;
  /** Accepted reactions only: the memory fact to write atomically. */
  readonly fact?: {
    readonly subjectId: string;
    readonly claim: string;
    readonly observedAt: Date;
    readonly extractionVersion: string;
  };
}

/**
 * Finalize a claimed attempt: set the terminal state with lease fencing. A
 * finalize applies only while the lease we claimed is still the LIVE one —
 * the exact lease we claimed AND not yet expired (`lease_expires_at >
 * now()`): an expired lease that nobody has taken over yet is just as lost
 * as one taken over, and its writes must never apply. Returns whether the
 * fenced update actually applied; a lost lease returns false, the caller
 * counts no terminal outcome (the work is reported as `lostFinalizes`
 * instead), and nothing — terminal state or memory fact — is written.
 * An accepted reaction and its memory fact are written in the same
 * transaction, and the fact insert runs only after the fenced update
 * matched, so a lost lease can never write the fact either. The fact
 * insert is idempotent by its deterministic key.
 */
async function finalizeReaction(
  pool: PostgresPool,
  input: FinalizeInput,
): Promise<boolean> {
  return withTransaction(pool, async (client) => {
    const updated = await client.query<{ id: string }>(
      `UPDATE article_reaction
       SET state = $2,
           reaction = $3,
           lease_expires_at = NULL,
           last_error = $4,
           model = $5,
           generation_prompt_version = $6,
           generated_at = $7,
           review_prompt_version = $8,
           reviewed_at = $9,
           fact_key = $10,
           updated_at = now()
       WHERE id = $1
         AND state = 'generating'
         AND lease_expires_at = $11
         AND lease_expires_at > now()
       RETURNING id`,
      [
        input.reactionId,
        input.state,
        input.reaction,
        input.lastError,
        input.model,
        ARTICLE_REACTION_GENERATION_PROMPT_VERSION,
        input.generatedAt,
        input.state === "accepted" ? ARTICLE_REACTION_REVIEW_PROMPT_VERSION : null,
        input.reviewedAt,
        input.state === "accepted" ? articleSourceKey(input.reactionId) : null,
        input.leaseExpiresAt,
      ],
    );
    if (updated.rows[0] === undefined) return false;
    if (input.state === "accepted" && input.fact !== undefined) {
      await client.query(
        `INSERT INTO memory_fact
           (fact_key, turn_id, subject_id, kind, claim, condition, consequence, topics,
            observed_at, explicitness, evidence_basis, extraction_version, ingest_version,
            article_reaction_id, source_type)
         VALUES ($1, NULL, $2, 'preference', $3, NULL, NULL, '{}', $4,
                 'explicit', 'observed_behavior', $5, $6, $7, 'article')
         ON CONFLICT (fact_key) DO NOTHING`,
        [
          articleSourceKey(input.reactionId),
          input.fact.subjectId,
          input.fact.claim,
          input.fact.observedAt,
          input.fact.extractionVersion,
          ARTICLE_INGEST_VERSION,
          input.reactionId,
        ],
      );
    }
    return true;
  });
}

/**
 * Run one ingestion attempt. Exported for manual runs and tests; the runtime
 * below serializes attempts through the same function. Never throws into the
 * caller.
 *
 * `options.feedStartIndex` rotates which enabled feeds a capped run attempts
 * (see `MAX_FEEDS_PER_RUN`); the runtime advances it across runs so feeds
 * beyond the per-run cap are not starved. Manual and default runs start at
 * the configured position order.
 */
export async function runIngestionAttempt(
  deps: ArticleRuntimeDeps,
  reason: string,
  options: { feedStartIndex?: number } = {},
): Promise<ArticleIngestionSummary> {
  const pool = deps.pool;
  const log = deps.log ?? ((message: string) => console.log(message));
  const leaseMs = deps.leaseMs ?? DEFAULT_LEASE_MS;
  const resolveHost = deps.resolveFeedHost ?? resolveFeedHost;
  const result = emptyResult();
  const startedAt = new Date();

  // Configuration load: fail closed before any fetch, provider call, or
  // state write. Missing is the expected rollout state on an unprovisioned
  // deployment and logs exactly the contracted line.
  let config: ArticleConfiguration;
  try {
    config = await loadArticleConfiguration(pool);
  } catch (error) {
    if (error instanceof ArticleConfigurationMissingError) {
      log("ingestion not configured");
      return { status: "not_configured", result };
    }
    if (error instanceof ArticleDisabledError) {
      log("article ingestion disabled");
      return { status: "disabled", result };
    }
    if (error instanceof ArticleConfigurationInvalidError) {
      log(`article configuration invalid: ${error.message}`);
      return { status: "invalid", result };
    }
    log(`[ARTICLE] configuration load failed (${reason}): ${articleErrorCategory(error)}`);
    const finishedAt = new Date();
    await recordMemoryOperation(pool, {
      kind: "article_ingestion",
      outcome: "failed",
      detail: `reason=${reason} category=configuration`,
      startedAt,
      finishedAt,
    }).catch(() => undefined);
    return { status: "invalid", result };
  }

  // Fetch phase: enabled feeds are attempted with bounded, safe networking;
  // failures are per-feed and never stop the run. The per-run cap and the
  // rotation start index bound a run's fetch work (see `MAX_FEEDS_PER_RUN`).
  const feedArticles: {
    feedId: string;
    url: string;
    title: string;
    excerpt: string;
    publishedAt: Date | null;
  }[] = [];
  const feedCount = config.feeds.length;
  const feedsThisRun = Math.min(MAX_FEEDS_PER_RUN, feedCount);
  const startIndex = Math.max(0, Math.floor(options.feedStartIndex ?? 0)) % feedCount;
  for (let index = 0; index < feedsThisRun; index += 1) {
    const feed = config.feeds[(startIndex + index) % feedCount]!;
    result.feedsAttempted += 1;
    const safety = checkFeedUrlSafety(feed.url);
    if (!safety.ok) {
      result.feedsFailed += 1;
      log(`[ARTICLE] feed ${feed.id} skipped: ${safety.reason}`);
      continue;
    }
    try {
      const fetched = await boundedFetchText(feed.url, {
        transport: deps.transport,
        resolveHost,
        ...(deps.lookupAll !== undefined ? { lookupAll: deps.lookupAll } : {}),
      });
      const articles = parseFeed(fetched.body, feed.id, {
        maxExcerptChars: config.behavior.maxExcerptChars,
      });
      result.itemsFetched += articles.length;
      feedArticles.push(...articles);
    } catch (error) {
      result.feedsFailed += 1;
      log(`[ARTICLE] feed ${feed.id} fetch failed: ${articleErrorCategory(error)}`);
    }
  }
  try {
    result.itemsNew += await persistFeedItems(pool, feedArticles);
  } catch (error) {
    log(`[ARTICLE] item persistence failed: ${articleErrorCategory(error)}`);
  }

  // Reaction phase: claim up to the per-run generation budget and run each
  // claimed candidate through generation -> review -> finalize. Before
  // selection, exhausted stalled rows are settled (see
  // `settleExhaustedReactions`), and the claim itself re-enforces the
  // attempt cap atomically.
  const budget = config.behavior.maxGenerationsPerRun - result.candidatesAttempted;
  if (budget > 0) {
    try {
      await settleExhaustedReactions(pool, config.behavior.maxReactionAttempts);
    } catch (error) {
      log(`[ARTICLE] exhausted-reaction settle failed: ${articleErrorCategory(error)}`);
    }
    const selected = await selectReactionCandidates(pool, config, budget);
    for (const candidate of selected) {
      if (result.candidatesAttempted >= config.behavior.maxGenerationsPerRun) break;
      const leaseExpiresAt = new Date(Date.now() + leaseMs);
      const claim = await claimReaction(
        pool,
        candidate.itemId,
        leaseExpiresAt,
        config.behavior.maxReactionAttempts,
      );
      if (claim === null) {
        result.skippedClaims += 1;
        continue;
      }
      result.candidatesAttempted += 1;
      try {
        const generatedAt = new Date();
        const generation = await deps.callLlm(config.behavior.model, {
          systemPrompt: config.prompts.reaction_generation.systemPrompt,
          userMessage: renderArticleReactionInput({
            sourceName: candidate.feedId,
            title: candidate.title,
            excerpt: candidate.excerpt,
            url: candidate.url,
            publishedAt: candidate.publishedAt?.toISOString() ?? null,
          }),
          taskPreset: articleTaskPresets.generation,
        });
        result.llmCalls += 1;
        const reaction = parseReactionText(generation.text, config.behavior.maxReactionChars);
        if (reaction === null) {
          if (await finalizeReaction(pool, {
            reactionId: claim.reactionId,
            leaseExpiresAt,
            state: "failed",
            reaction: null,
            lastError: "empty generation output",
            model: config.behavior.model,
            generatedAt,
            reviewedAt: null,
          })) {
            result.failed += 1;
          } else {
            result.lostFinalizes += 1;
          }
          continue;
        }

        const reviewedAt = new Date();
        const review = await deps.callLlm(config.behavior.model, {
          systemPrompt: config.prompts.reaction_review.systemPrompt,
          userMessage: renderArticleReviewInput(
            {
              sourceName: candidate.feedId,
              title: candidate.title,
              excerpt: candidate.excerpt,
              url: candidate.url,
              publishedAt: candidate.publishedAt?.toISOString() ?? null,
            },
            reaction,
          ),
          taskPreset: articleTaskPresets.review,
          responseFormat: REVIEW_RESPONSE_FORMAT,
        });
        result.llmCalls += 1;
        const verdict = parseReactionReview(review.text);
        if (verdict === null) {
          if (await finalizeReaction(pool, {
            reactionId: claim.reactionId,
            leaseExpiresAt,
            state: "failed",
            reaction: null,
            lastError: "unusable review output",
            model: config.behavior.model,
            generatedAt,
            reviewedAt,
          })) {
            result.failed += 1;
          } else {
            result.lostFinalizes += 1;
          }
          continue;
        }

        if (verdict.verdict === "reject") {
          if (await finalizeReaction(pool, {
            reactionId: claim.reactionId,
            leaseExpiresAt,
            state: "rejected",
            reaction: null,
            lastError: verdict.reason,
            model: config.behavior.model,
            generatedAt,
            reviewedAt,
          })) {
            result.rejected += 1;
          } else {
            result.lostFinalizes += 1;
          }
          continue;
        }

        // Accepted: the reaction and its assistant-attributed memory fact
        // are written atomically with lease fencing. A lost lease writes
        // nothing and counts no success.
        if (await finalizeReaction(pool, {
          reactionId: claim.reactionId,
          leaseExpiresAt,
          state: "accepted",
          reaction,
          lastError: null,
          model: config.behavior.model,
          generatedAt,
          reviewedAt,
          fact: {
            subjectId: config.assistantSubjectId,
            claim: reaction,
            observedAt: generatedAt,
            extractionVersion: ARTICLE_REACTION_GENERATION_PROMPT_VERSION,
          },
        })) {
          result.generated += 1;
        } else {
          result.lostFinalizes += 1;
        }
      } catch (error) {
        const category = articleErrorCategory(error);
        log(`[ARTICLE] reaction attempt failed for item ${candidate.itemId}: ${category}`);
        // Best-effort terminal failure: a lost lease writes nothing and
        // counts no outcome — the attempt is reported as lost instead.
        if (await finalizeReaction(pool, {
          reactionId: claim.reactionId,
          leaseExpiresAt,
          state: "failed",
          reaction: null,
          lastError: category,
          model: config.behavior.model,
          generatedAt: new Date(),
          reviewedAt: null,
        }).catch(() => false)) {
          result.failed += 1;
        } else {
          result.lostFinalizes += 1;
        }
      }
    }
  }

  // Article interest consolidation: the turn-free evidence path over the
  // accepted reactions this runtime owns. Fail-soft by contract — every
  // outcome is only logged and never fails the ingestion attempt.
  try {
    const outcome = await runArticleObservationConsolidation({
      pool,
      timezone: deps.timezone,
      callLlm: deps.callLlm,
      log,
    });
    if (outcome.status === "skipped") {
      log(`[ARTICLE] interest consolidation skipped: ${outcome.reason}`);
    } else if (outcome.status === "failed") {
      log(`[ARTICLE] interest consolidation failed: ${outcome.category}`);
    } else {
      log(
        `[ARTICLE] interest consolidation ok: facts=${outcome.factCount} ` +
          `accepted=${outcome.accepted} omitted=${outcome.omitted}`,
      );
    }
  } catch (error) {
    log(`[ARTICLE] interest consolidation crashed: ${articleErrorCategory(error)}`);
  }

  // Trace one metadata-only operation for the attempt.
  const finishedAt = new Date();
  await recordMemoryOperation(pool, {
    kind: "article_ingestion",
    outcome: "ok",
    detail:
      `reason=${reason} feedsAttempted=${result.feedsAttempted}` +
      ` feedsFailed=${result.feedsFailed} itemsFetched=${result.itemsFetched}` +
      ` itemsNew=${result.itemsNew} candidates=${result.candidatesAttempted}` +
      ` generated=${result.generated} rejected=${result.rejected}` +
      ` failed=${result.failed} skippedClaims=${result.skippedClaims}` +
      ` lostFinalizes=${result.lostFinalizes}`,
    model: config.behavior.model,
    promptVersion: ARTICLE_REACTION_GENERATION_PROMPT_VERSION,
    llmCalls: result.llmCalls,
    startedAt,
    finishedAt,
  }).catch(() => undefined);

  // The enabled-feed count is returned so the runtime can rotate the next
  // run's starting position past the feeds this run attempted.
  return { status: "ok", result, feedsAvailable: feedCount };
}

/**
 * Start the article runtime. It keeps polling on a timer even while
 * unprovisioned, so provisioning configuration later enables ingestion
 * without a worker restart. Attempts are serialized: a long attempt delays
 * the next one instead of overlapping. Timer ticks COALESCE (mirroring the
 * memory runtime's serial queue): at most one scheduled attempt sits in the
 * chain at a time, so ticks arriving while an attempt runs or queues
 * collapse into one follow-up instead of piling an attempt onto the chain
 * per tick.
 */
export function startArticleRuntime(deps: ArticleRuntimeDeps): ArticleRuntime {
  const pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const log = deps.log ?? ((message: string) => console.log(message));
  let tail: Promise<unknown> = Promise.resolve();
  let timer: ReturnType<typeof setInterval> | undefined;
  let closed = false;
  let attemptQueued = false;
  // Feed rotation cursor: the starting position of the next run's capped
  // fetch phase, advanced by the number of feeds each run attempted so
  // feeds beyond the per-run cap rotate through over successive runs.
  let feedCursor = 0;

  /** Serialize onto the attempt chain; a rejected task never breaks the chain. */
  const enqueue = <T>(task: () => Promise<T>): Promise<T> => {
    const next = tail.then(task, task);
    tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  const scheduledAttempt = (reason: string): void => {
    if (attemptQueued) return;
    attemptQueued = true;
    void enqueue(async () => {
      attemptQueued = false;
      if (closed) return;
      try {
        const summary = await runIngestionAttempt(deps, reason, { feedStartIndex: feedCursor });
        if (summary.status === "ok") {
          if (summary.feedsAvailable !== undefined && summary.feedsAvailable > 0) {
            feedCursor =
              (feedCursor + summary.result.feedsAttempted) % summary.feedsAvailable;
          }
          log(
            `[ARTICLE] ingestion ok: items=${summary.result.itemsNew} ` +
              `generated=${summary.result.generated} rejected=${summary.result.rejected} ` +
              `failed=${summary.result.failed} lost=${summary.result.lostFinalizes}`,
          );
        }
      } catch (error) {
        log(`[ARTICLE] ingestion attempt crashed: ${articleErrorCategory(error)}`);
      }
    });
  };

  scheduledAttempt("startup");
  timer = setInterval(() => {
    scheduledAttempt("interval");
  }, pollIntervalMs);

  return {
    runOnce: () =>
      enqueue(async () => {
        try {
          return await runIngestionAttempt(deps, "manual");
        } catch (error) {
          log(`[ARTICLE] manual ingestion failed: ${articleErrorCategory(error)}`);
          return { status: "invalid", result: emptyResult() };
        }
      }),
    close: async () => {
      closed = true;
      if (timer !== undefined) clearInterval(timer);
      await tail;
    },
  };
}
