/**
 * Recall evaluation harness (general recall parity tooling).
 *
 * Loads a synthetic observation corpus into a DISPOSABLE database, runs each
 * corpus query through the canonical recall pipeline, computes ranking
 * metrics (recall@k, precision@k, MRR, temporal-window violations), and
 * removes its own seeded rows afterwards. Exit-worthy threshold checks live
 * with the caller (the CLI), not here.
 *
 * Safety model:
 * - The harness WRITES rows (one dedicated evaluation subject and its
 *   canonical observations, every id prefixed `eval-`) and therefore must
 *   only ever run against a disposable test database — the CLI refuses to
 *   start without the test-database URL.
 * - Before seeding it verifies the evaluation subject does not already
 *   exist; cleanup deletes ONLY rows under that subject, so a refused run
 *   can never delete pre-existing data.
 * - Corpus observations are point-in-time seeds (first seen == last seen),
 *   which makes the temporal-violation check exact against the served
 *   window.
 *
 * The corpus is generic synthetic content with no personal configuration;
 * personal behavior configuration lives in the relational database, never
 * in code or fixtures.
 */

import { withTransaction, type PostgresPool } from "@companion/postgres";

import { recallCanonical } from "./recall.ts";
import type { MemoryConfig } from "./config.ts";

/** The dedicated evaluation subject id; also the cleanup scope. */
export const EVAL_SUBJECT_ID = "memory-eval-subject";

/** Every seeded canonical observation id carries this prefix. */
export const EVAL_ID_PREFIX = "eval-";

export interface EvalObservation {
  /** Canonical observation id; must start with the `eval-` prefix. */
  readonly id: string;
  readonly kind: "fact" | "preference" | "habit" | "conditional_pattern" | "boundary";
  readonly claim: string;
  readonly condition?: string;
  readonly consequence?: string;
  readonly topics?: readonly string[];
  /** Absolute point-in-time observation moment (first seen == last seen). */
  readonly observedAt: string;
  readonly evidenceStrength: "tentative" | "supported" | "strong";
  readonly supportCount: number;
  readonly distinctTurnCount: number;
  readonly distinctDayCount: number;
}

export interface EvalQuery {
  readonly query: string;
  /** Canonical observation ids (eval- prefixed) the query should surface. */
  readonly expect: readonly string[];
}

export interface EvalCorpus {
  readonly version: number;
  readonly description: string;
  readonly observations: readonly EvalObservation[];
  readonly queries: readonly EvalQuery[];
}

export class EvalCorpusError extends Error {}

/** Structural corpus validation, shared by the CLI and the tests. */
export function validateEvalCorpus(corpus: unknown): EvalCorpus {
  if (typeof corpus !== "object" || corpus === null) {
    throw new EvalCorpusError("corpus must be an object");
  }
  const record = corpus as Record<string, unknown>;
  if (record.version !== 1) {
    throw new EvalCorpusError("corpus.version must be 1");
  }
  if (typeof record.description !== "string" || record.description.length === 0) {
    throw new EvalCorpusError("corpus.description must be a nonempty string");
  }
  if (!Array.isArray(record.observations) || record.observations.length === 0) {
    throw new EvalCorpusError("corpus.observations must be a nonempty array");
  }
  const ids = new Set<string>();
  for (const raw of record.observations) {
    if (typeof raw !== "object" || raw === null) {
      throw new EvalCorpusError("each observation must be an object");
    }
    const observation = raw as Record<string, unknown>;
    if (typeof observation.id !== "string" || !observation.id.startsWith(EVAL_ID_PREFIX)) {
      throw new EvalCorpusError(`observation ids must start with "${EVAL_ID_PREFIX}"`);
    }
    if (ids.has(observation.id)) {
      throw new EvalCorpusError(`duplicate observation id: ${observation.id}`);
    }
    ids.add(observation.id);
    if (
      observation.kind !== "fact" &&
      observation.kind !== "preference" &&
      observation.kind !== "habit" &&
      observation.kind !== "conditional_pattern" &&
      observation.kind !== "boundary"
    ) {
      throw new EvalCorpusError(`observation ${observation.id}: invalid kind`);
    }
    if (typeof observation.claim !== "string" || observation.claim.length === 0) {
      throw new EvalCorpusError(`observation ${observation.id}: claim is required`);
    }
    if (Number.isNaN(Date.parse(String(observation.observedAt)))) {
      throw new EvalCorpusError(`observation ${observation.id}: observedAt must be an ISO date`);
    }
    if (
      observation.evidenceStrength !== "tentative" &&
      observation.evidenceStrength !== "supported" &&
      observation.evidenceStrength !== "strong"
    ) {
      throw new EvalCorpusError(`observation ${observation.id}: invalid evidenceStrength`);
    }
    for (const field of ["supportCount", "distinctTurnCount", "distinctDayCount"] as const) {
      if (!Number.isInteger(observation[field]) || Number(observation[field]) < 1) {
        throw new EvalCorpusError(`observation ${observation.id}: ${field} must be an integer >= 1`);
      }
    }
  }
  if (!Array.isArray(record.queries) || record.queries.length === 0) {
    throw new EvalCorpusError("corpus.queries must be a nonempty array");
  }
  for (const raw of record.queries) {
    if (typeof raw !== "object" || raw === null) {
      throw new EvalCorpusError("each query must be an object");
    }
    const query = raw as Record<string, unknown>;
    if (typeof query.query !== "string" || query.query.length === 0) {
      throw new EvalCorpusError("each query needs a nonempty query string");
    }
    if (
      !Array.isArray(query.expect) ||
      query.expect.length === 0 ||
      !query.expect.every((id) => typeof id === "string" && ids.has(id))
    ) {
      throw new EvalCorpusError(
        "each query needs a nonempty expect array of known observation ids",
      );
    }
  }
  return {
    version: 1,
    description: record.description,
    observations: record.observations as EvalObservation[],
    queries: record.queries as EvalQuery[],
  };
}

export interface EvalQueryResult {
  readonly query: string;
  /** Seeded observation ids surfaced within the result window. */
  readonly got: readonly string[];
}

export interface EvalScores {
  /** Mean per-query hit fraction over the expected set. */
  readonly recall: number;
  /** Mean per-query hit fraction over the returned window (already top-k). */
  readonly precision: number;
  /** Mean reciprocal rank of the best-ranked expected row. */
  readonly mrr: number;
  readonly perQuery: {
    readonly query: string;
    readonly recall: number;
    readonly precision: number;
    readonly reciprocalRank: number;
  }[];
}

export interface EvalMetrics extends EvalScores {
  /** Returned eval rows whose observation time sits outside the served window. */
  readonly temporalViolations: number;
}

/**
 * Pure scoring: recall@k, precision@k, and MRR from corpus expectations and
 * the recall results. Ranking semantics follow the source harness (hits over
 * expected, precision over the returned top-k window, reciprocal rank of the
 * best-ranked expected row).
 */
export function scoreEvalQueries(
  corpus: EvalCorpus,
  results: readonly EvalQueryResult[],
): EvalScores {
  const byQuery = new Map(results.map((result) => [result.query, result]));
  const recall: number[] = [];
  const precision: number[] = [];
  const rr: number[] = [];
  const perQuery: EvalScores["perQuery"] = [];
  for (const query of corpus.queries) {
    const result = byQuery.get(query.query);
    const got = result?.got ?? [];
    const hits = query.expect.filter((id) => got.includes(id));
    const queryRecall = hits.length / query.expect.length;
    const queryPrecision = got.length > 0 ? hits.length / got.length : 0;
    const reciprocalRank = Math.max(
      ...query.expect.map((id) => {
        const index = got.indexOf(id);
        return index === -1 ? 0 : 1 / (index + 1);
      }),
    );
    recall.push(queryRecall);
    precision.push(queryPrecision);
    rr.push(reciprocalRank);
    perQuery.push({
      query: query.query,
      recall: queryRecall,
      precision: queryPrecision,
      reciprocalRank,
    });
  }
  const mean = (values: number[]): number =>
    values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
  return {
    recall: mean(recall),
    precision: mean(precision),
    mrr: mean(rr),
    perQuery,
  };
}

/** Count returned eval rows whose observation time falls outside the served window. */
export function countTemporalViolations(
  responses: readonly {
    readonly rows: readonly { readonly id: string; readonly observedAt: string }[];
    readonly window?: { readonly start: string; readonly end: string };
  }[],
): number {
  let violations = 0;
  for (const response of responses) {
    if (response.window === undefined) continue;
    const start = Date.parse(response.window.start);
    const end = Date.parse(response.window.end);
    for (const row of response.rows) {
      if (!row.id.startsWith(EVAL_ID_PREFIX)) continue;
      const time = Date.parse(row.observedAt);
      if (time < start || time >= end) violations += 1;
    }
  }
  return violations;
}

interface CanonicalSeedRow {
  readonly id: string;
  readonly kind: string;
  readonly claim: string;
  readonly condition: string | null;
  readonly consequence: string | null;
  readonly topics: string[];
  readonly observedAt: Date;
  readonly evidenceStrength: string;
  readonly supportCount: number;
  readonly distinctTurnCount: number;
  readonly distinctDayCount: number;
}

export interface RecallEvalOptions {
  readonly k: number;
  readonly referenceTime: Date;
  /** Behavioral timezone for temporal-expression detection in the queries. */
  readonly timezone?: string;
}

export interface RecallEvalRun {
  readonly metrics: EvalMetrics;
  /** Per-query raw outputs for diagnostics. */
  readonly responses: {
    readonly query: string;
    readonly got: readonly string[];
    readonly rows: readonly { readonly id: string; readonly observedAt: string }[];
    readonly window?: { readonly start: string; readonly end: string };
  }[];
}

/**
 * Map a validated corpus to its canonical seed rows (pure). Exposed so the
 * integration tests can seed the corpus through the exact same path the
 * evaluation run uses.
 */
export function buildEvalSeeds(corpus: EvalCorpus): CanonicalSeedRow[] {
  return corpus.observations.map(
    (observation): CanonicalSeedRow => ({
      id: observation.id,
      kind: observation.kind,
      claim: observation.claim,
      condition: observation.condition ?? null,
      consequence: observation.consequence ?? null,
      topics: [...(observation.topics ?? [])],
      observedAt: new Date(observation.observedAt),
      evidenceStrength: observation.evidenceStrength,
      supportCount: observation.supportCount,
      distinctTurnCount: observation.distinctTurnCount,
      distinctDayCount: observation.distinctDayCount,
    }),
  );
}

/**
 * Run the full evaluation: seed, query, score, and clean up. Cleanup runs
 * even when a query fails; a seeding failure rolls back before anything is
 * written.
 */
export async function runRecallEval(
  pool: PostgresPool,
  config: MemoryConfig,
  corpus: EvalCorpus,
  options: RecallEvalOptions,
): Promise<RecallEvalRun> {
  await assertEvalSubjectAbsent(pool);
  const seeds = buildEvalSeeds(corpus);
  await seedEvalCorpus(pool, seeds);

  const responses: RecallEvalRun["responses"] = [];
  try {
    for (const query of corpus.queries) {
      const response = await recallCanonical(pool, config, {
        query: query.query,
        referenceTime: options.referenceTime,
        limit: options.k,
        timezone: options.timezone,
      });
      const rows = response.results.map((item) => ({
        id: item.id,
        observedAt: item.observedAt,
      }));
      responses.push({
        query: query.query,
        got: rows.filter((row) => row.id.startsWith(EVAL_ID_PREFIX)).map((row) => row.id),
        rows,
        ...(response.query.timeRange !== undefined
          ? {
              window: {
                start: response.query.timeRange.start,
                end: response.query.timeRange.end,
              },
            }
          : {}),
      });
    }
  } finally {
    await cleanupEvalCorpus(pool);
  }
  const scores = scoreEvalQueries(
    corpus,
    responses.map((response) => ({ query: response.query, got: response.got })),
  );
  const temporalViolations = countTemporalViolations(responses);
  return {
    metrics: { ...scores, temporalViolations },
    responses,
  };
}

async function assertEvalSubjectAbsent(pool: PostgresPool): Promise<void> {
  const existing = await pool.query<{ id: string }>(
    `SELECT id FROM memory_subject WHERE id = $1`,
    [EVAL_SUBJECT_ID],
  );
  if (existing.rows.length > 0) {
    throw new EvalCorpusError(
      `evaluation subject "${EVAL_SUBJECT_ID}" already exists; refusing to run (cleanup deletes by this subject, so a pre-existing row is never touched)`,
    );
  }
}

export async function seedEvalCorpus(pool: PostgresPool, seeds: readonly CanonicalSeedRow[]): Promise<void> {
  await withTransaction(pool, async (client) => {
    await client.query(
      `INSERT INTO memory_subject (id, role, profile_enabled, source_label, profile_evidence_rule, position)
       VALUES ($1, 'assistant', false, 'memory-eval', 'Synthetic evaluation subject; attribution rules are not exercised by the recall evaluation.', 999999)`,
      [EVAL_SUBJECT_ID],
    );
    for (const seed of seeds) {
      await client.query(
        `INSERT INTO memory_canonical_observation (
           canonical_observation_id, canonical_identity_key, identity_version,
           observation_key, subject_id, kind, claim, condition, consequence, topics,
           support_count, distinct_turn_count, distinct_day_count, contradiction_count,
           first_observed_at, last_observed_at, source_fact_keys,
           evidence_strength, status, consolidation_version, content_hash,
           revision, promotion_id, promotion_sequence,
           latest_artifact_id, latest_run_id, latest_observation_set_id, latest_fact_set_id,
           latest_artifact_created_at, latest_artifact_updated_at,
           canonical_created_at, canonical_updated_at
         ) VALUES (
           $1, $2, 1, $3, $4, $5, $6, $7, $8, $9,
           $10, $11, $12, 0,
           $13, $13, ARRAY[]::text[],
           $14, 'active', 'memory-eval', $15,
           1, 'memory-eval-promotion', 1,
           'memory-eval-artifact', 'memory-eval-run', 'memory-eval-observation-set', 'memory-eval-fact-set',
           $13, $13,
           $13, $13
         )`,
        [
          seed.id,
          `${EVAL_ID_PREFIX}identity-${seed.id.slice(EVAL_ID_PREFIX.length)}`,
          `${EVAL_ID_PREFIX}observation-${seed.id.slice(EVAL_ID_PREFIX.length)}`,
          EVAL_SUBJECT_ID,
          seed.kind,
          seed.claim,
          seed.condition,
          seed.consequence,
          seed.topics,
          seed.supportCount,
          seed.distinctTurnCount,
          seed.distinctDayCount,
          seed.observedAt,
          seed.evidenceStrength,
          `${EVAL_ID_PREFIX}content-${seed.id.slice(EVAL_ID_PREFIX.length)}`,
        ],
      );
    }
  });
}

/** Remove exactly this run's rows: the evaluation subject's canonical rows, then the subject. */
export async function cleanupEvalCorpus(pool: PostgresPool): Promise<void> {
  await withTransaction(pool, async (client) => {
    await client.query(
      `DELETE FROM memory_canonical_observation
       WHERE subject_id = $1 AND canonical_observation_id LIKE $2`,
      [EVAL_SUBJECT_ID, `${EVAL_ID_PREFIX}%`],
    );
    await client.query(`DELETE FROM memory_subject WHERE id = $1`, [EVAL_SUBJECT_ID]);
  });
}
