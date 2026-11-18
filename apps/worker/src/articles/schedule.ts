/**
 * Durable article-fetch cadence plus the per-process random round-robin feed
 * cycle. The cadence reservation is recorded in the existing metadata-only
 * `memory_operation` trace and serialized with an advisory transaction lock,
 * so worker replicas and restarts share one 12-hour window without new schema.
 */

import { withTransaction, type PostgresPool } from "@companion/postgres";

import type { ArticleFeed } from "./types.ts";

/** The article source list is fetched at most once every twelve hours. */
export const ARTICLE_INGEST_INTERVAL_MS = 12 * 60 * 60 * 1000;
/** Keep configuration discovery bounded while an unprovisioned source list is being set up. */
export const ARTICLE_CONFIGURATION_RECHECK_MS = ARTICLE_INGEST_INTERVAL_MS;

export interface ArticleIngestionReservation {
  readonly traceId: string;
  readonly startedAt: Date;
}

export type ArticleIngestionSlot =
  | { readonly status: "reserved"; readonly reservation: ArticleIngestionReservation }
  | { readonly status: "rate_limited"; readonly retryAfterMs: number };

/**
 * Atomically claim the next fetch window. Historical `article_ingestion`
 * traces already carry the attempt's start time; the detail predicate excludes
 * old configuration-load failures that never reached a feed. A reservation
 * is written before the external fetch, so a restart cannot duplicate a call
 * after its traceable boundary. An unfinished reservation intentionally still
 * consumes the window if the process crashes.
 */
export async function reserveArticleIngestionSlot(
  pool: PostgresPool,
  input: {
    readonly reason: string;
    readonly model: string;
    readonly promptVersion: string;
  },
): Promise<ArticleIngestionSlot> {
  return withTransaction(pool, async (client) => {
    // Transaction-scoped and article-owned: simultaneous replicas serialize
    // before observing the latest durable reservation.
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtext('companion.article_ingestion.12h'))`,
    );
    const clock = await client.query<{
      database_now: Date;
      last_started_at: Date | null;
    }>(
      `SELECT clock_timestamp() AS database_now,
              max(started_at) AS last_started_at
       FROM memory_operation
       WHERE kind = 'article_ingestion'
         AND (detail LIKE '%feedsAttempted=%' OR detail LIKE '%feed_reserved=true%')`,
    );
    const now = clock.rows[0]?.database_now;
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
      throw new Error("article ingestion database clock unavailable");
    }
    const lastStartedAt = clock.rows[0]?.last_started_at;
    if (lastStartedAt instanceof Date && Number.isFinite(lastStartedAt.getTime())) {
      const retryAfterMs = articleIngestionRetryAfterMs(lastStartedAt, now);
      if (retryAfterMs > 0) {
        return { status: "rate_limited", retryAfterMs };
      }
    }

    const inserted = await client.query<{ id: string; started_at: Date }>(
      `INSERT INTO memory_operation
         (kind, outcome, detail, model, prompt_version, started_at)
       VALUES ('article_ingestion', 'failed', $1, $2, $3, clock_timestamp())
       RETURNING id, started_at`,
      [`reason=${input.reason} feed_reserved=true`, input.model, input.promptVersion],
    );
    const row = inserted.rows[0];
    if (row === undefined || !(row.started_at instanceof Date)) {
      throw new Error("article ingestion reservation was not recorded");
    }
    return {
      status: "reserved",
      reservation: { traceId: row.id, startedAt: row.started_at },
    };
  });
}

/** A shuffled cycle that visits each currently enabled feed at most once. */
export class ArticleFeedShuffleCycle {
  private remaining: string[] = [];
  private visited = new Set<string>();
  private readonly random: () => number;

  constructor(random: () => number = Math.random) {
    this.random = random;
  }

  next(feeds: readonly ArticleFeed[]): ArticleFeed | undefined {
    const byId = new Map(feeds.filter((feed) => feed.enabled).map((feed) => [feed.id, feed]));
    const enabledIds = new Set(byId.keys());

    // Removed/disabled feeds are dropped from the current cycle. Newly enabled
    // feeds join its remaining portion rather than waiting for another cycle.
    this.visited = new Set([...this.visited].filter((id) => enabledIds.has(id)));
    this.remaining = this.remaining.filter(
      (id) => enabledIds.has(id) && !this.visited.has(id),
    );
    const remainingIds = new Set(this.remaining);
    const addedIds = [...enabledIds].filter(
      (id) => !this.visited.has(id) && !remainingIds.has(id),
    );
    if (addedIds.length > 0) {
      this.remaining = this.shuffle([...this.remaining, ...addedIds]);
    }

    // A completed (or emptied by removals) cycle starts with a fresh shuffle.
    if (this.remaining.length === 0 && enabledIds.size > 0) {
      this.visited.clear();
      this.remaining = this.shuffle([...enabledIds]);
    }

    const id = this.remaining.shift();
    if (id === undefined) return undefined;
    this.visited.add(id);
    return byId.get(id);
  }

  private shuffle(ids: string[]): string[] {
    for (let index = ids.length - 1; index > 0; index -= 1) {
      const other = this.randomIndex(index + 1);
      [ids[index], ids[other]] = [ids[other]!, ids[index]!];
    }
    return ids;
  }

  private randomIndex(length: number): number {
    const sample = this.random();
    const bounded = Number.isFinite(sample) ? Math.min(Math.max(sample, 0), 0.999999999) : 0;
    return Math.floor(bounded * length);
  }
}

/** Pure helper for the 12-hour boundary (the database remains authoritative). */
export function articleIngestionRetryAfterMs(
  lastStartedAt: Date | null,
  now: Date,
): number {
  if (lastStartedAt === null) return 0;
  return Math.max(
    0,
    lastStartedAt.getTime() + ARTICLE_INGEST_INTERVAL_MS - now.getTime(),
  );
}
