import { createHash } from "node:crypto";

import { withTransaction, type PostgresPool, type PostgresPoolClient } from "@companion/postgres";

import type { MemoryConfig } from "./config.ts";
import type { CanonicalRecallCandidate } from "./recall.ts";
import type { RecallMode } from "./recall-time.ts";
import { memoryErrorCategory } from "./errors.ts";
import { evidenceBoost, recencyBoost } from "./recall.ts";
import {
  EMBEDDING_CODE_REVISION,
  EMBEDDING_INPUT_VERSION,
  EMBEDDING_MODEL,
  EMBEDDING_MODEL_REVISION,
  type EmbeddingClient,
  EmbeddingRequestError,
  embeddingContentHash,
  renderEmbeddingInput,
  vectorLiteral,
} from "./embeddings.ts";
import {
  baselineArmTraces,
  buildShadowArms,
  MAX_KEYWORD_CANDIDATES,
  MAX_SEMANTIC_ONLY_CANDIDATES,
  RANKING_STRATEGY_VERSION,
  selectKeywordCandidates,
  type ShadowCandidate,
  type ShadowCandidateTrace,
} from "./semantic-shadow.ts";
import type { CanonicalRecallItem } from "./types.ts";

const MAX_SEMANTIC_OVERFETCH = 32;
const SEMANTIC_STATEMENT_TIMEOUT_MS = 3_000;
const RECONCILE_BATCH_SIZE = 8;

async function setSemanticStatementTimeout(client: PostgresPoolClient): Promise<void> {
  await client.query("SELECT set_config('statement_timeout', $1, true)", [`${String(SEMANTIC_STATEMENT_TIMEOUT_MS)}ms`]);
}

async function withSemanticTransaction<T>(
  pool: PostgresPool,
  work: (client: PostgresPoolClient) => Promise<T>,
): Promise<T> {
  return withTransaction(pool, async (client) => {
    await setSemanticStatementTimeout(client);
    return work(client);
  });
}

async function semanticQuery<Row extends object>(
  pool: PostgresPool,
  sql: string,
  parameters: readonly unknown[] = [],
): Promise<{ readonly rows: Row[] }> {
  const result = await withSemanticTransaction(pool, (client) => client.query(sql, [...parameters]));
  return { rows: result.rows as Row[] };
}

interface SemanticSource {
  readonly sourceKind: "fact" | "observation";
  readonly sourceId: string;
  readonly factId: string | null;
  readonly input: string;
  readonly contentHash: string;
  /** PostgreSQL's exact microsecond timestamp rendered as text, never JS Date. */
  readonly sourceUpdatedAt: string;
}

interface ReconcileSourceRow {
  source_kind: "fact" | "observation";
  source_id: string;
  fact_id: string | null;
  claim: string;
  condition: string | null;
  consequence: string | null;
  source_content_hash: string | null;
  source_updated_at: string;
  embedding_source_updated_at: string | null;
  embedding: unknown;
  input_version: string | null;
  model: string | null;
  model_revision: string | null;
  model_code_revision: string | null;
  retry_after: Date | null;
}

interface SimilarityRow {
  source_kind: "fact" | "observation";
  source_id: string;
  source_content_hash: string;
  current_claim: string;
  current_condition: string | null;
  current_consequence: string | null;
  similarity: number;
}

interface SemanticOnlyRow {
  source_kind: "fact" | "observation";
  source_id: string;
  fact_id: string | null;
  turn_id: string | null;
  subject_id: string;
  subject_role: string;
  kind: string;
  claim: string;
  condition: string | null;
  consequence: string | null;
  topics: string[];
  observed_at: Date;
  source_type: "conversation" | "article";
  article_reaction_id: string | null;
  explicitness: string | null;
  evidence_strength: string | null;
  support_count: number | null;
  distinct_day_count: number | null;
  content_hash: string;
  similarity: number;
}

function sourceId(kind: "fact" | "observation", id: string): string {
  return `${kind}:${id}`;
}

function itemInput(item: CanonicalRecallItem): string {
  return renderEmbeddingInput({
    claim: item.claim,
    condition: item.condition,
    consequence: item.consequence,
  });
}

function itemType(item: CanonicalRecallItem): "fact" | "observation" {
  return item.type;
}

function itemChars(item: CanonicalRecallItem): number {
  return item.claim.length + (item.condition?.length ?? 0) + (item.consequence?.length ?? 0) + 40;
}

function canonicalCandidate(
  candidate: CanonicalRecallCandidate,
  baselineOrigin: "keyword" | "temporal_keyword" | "recency",
): ShadowCandidate {
  return {
    id: sourceId(candidate.item.type, candidate.item.id),
    type: itemType(candidate.item),
    score: candidate.score,
    chars: candidate.chars,
    baselineRank: candidate.rank,
    baselineIncluded: candidate.baselineIncluded,
    baselineResultRank: candidate.baselineResultRank,
    baselineOrigin,
    textScore: candidate.item.textScore,
  };
}

function pgVector(value: readonly number[]): string {
  return vectorLiteral(value);
}

function clampSimilarity(value: number): number {
  return Math.max(-1, Math.min(1, value));
}

/** One bounded, resumable document-embedding reconciliation batch; inference is outside SQL transactions. */
export async function reconcileSemanticEmbeddingBatch(input: {
  readonly pool: PostgresPool;
  readonly client: EmbeddingClient;
}): Promise<{ readonly selected: number; readonly stored: number; readonly failed: number }> {
  if (input.client.busy) return { selected: 0, stored: 0, failed: 0 };
  const selected = await semanticQuery<ReconcileSourceRow>(input.pool,
    `SELECT source_kind, source_id, fact_id, claim, condition, consequence,
            source_content_hash, source_updated_at, embedding_source_updated_at,
            embedding, input_version, model, model_revision, model_code_revision,
            retry_after
     FROM (
       SELECT 'fact'::text AS source_kind, f.fact_key AS source_id, f.id AS fact_id,
              f.claim, f.condition, f.consequence, f.updated_at::text AS source_updated_at,
              e.source_content_hash, e.source_updated_at::text AS embedding_source_updated_at,
              e.embedding, e.input_version, e.model, e.model_revision, e.model_code_revision,
              e.retry_after
       FROM memory_fact f
       LEFT JOIN memory_semantic_embedding e ON e.fact_id = f.id
       UNION ALL
       SELECT 'observation'::text AS source_kind, o.canonical_observation_id AS source_id,
              NULL::uuid AS fact_id, o.claim, o.condition, o.consequence,
              o.canonical_updated_at::text AS source_updated_at,
              e.source_content_hash, e.source_updated_at::text AS embedding_source_updated_at,
              e.embedding, e.input_version, e.model, e.model_revision, e.model_code_revision,
              e.retry_after
       FROM memory_canonical_observation o
       LEFT JOIN memory_semantic_embedding e
         ON e.canonical_observation_id = o.canonical_observation_id
       WHERE o.status = 'active'
     ) pending
     WHERE (embedding_source_updated_at IS DISTINCT FROM source_updated_at
         OR model IS DISTINCT FROM $1
         OR model_revision IS DISTINCT FROM $2
         OR model_code_revision IS DISTINCT FROM $3
         OR input_version IS DISTINCT FROM $4
         OR embedding IS NULL)
       AND (embedding_source_updated_at IS DISTINCT FROM source_updated_at
         OR coalesce(retry_after, '-infinity'::timestamptz) <= now())
     ORDER BY source_updated_at, source_kind, source_id
     LIMIT ${String(RECONCILE_BATCH_SIZE)}`,
    [EMBEDDING_MODEL, EMBEDDING_MODEL_REVISION, EMBEDDING_CODE_REVISION, EMBEDDING_INPUT_VERSION],
  );
  if (selected.rows.length === 0) return { selected: 0, stored: 0, failed: 0 };

  const sources: SemanticSource[] = selected.rows.map((row) => {
    const text = renderEmbeddingInput({ claim: row.claim, condition: row.condition, consequence: row.consequence });
    return {
      sourceKind: row.source_kind,
      sourceId: row.source_id,
      factId: row.fact_id,
      input: text,
      contentHash: embeddingContentHash(text),
      sourceUpdatedAt: row.source_updated_at,
    };
  });
  const toEmbed: SemanticSource[] = [];
  for (const source of sources) {
    const currentAt = await sourceStillCurrent(input.pool, source);
    if (currentAt === null) continue;
    const row = selected.rows.find((candidate) => candidate.source_kind === source.sourceKind && candidate.source_id === source.sourceId)!;
    const sourceHasUsableVector = row.embedding !== null &&
      row.source_content_hash === source.contentHash &&
      row.input_version === EMBEDDING_INPUT_VERSION && row.model === EMBEDDING_MODEL &&
      row.model_revision === EMBEDDING_MODEL_REVISION && row.model_code_revision === EMBEDDING_CODE_REVISION;
    if (sourceHasUsableVector) {
      // Evidence-only updates advance the source timestamp without regenerating
      // a vector when the versioned claim/condition/consequence input is equal.
      await updateSourceTimestamp(input.pool, source, currentAt);
    } else {
      toEmbed.push({ ...source, sourceUpdatedAt: currentAt });
    }
  }
  if (toEmbed.length === 0) return { selected: sources.length, stored: 0, failed: 0 };
  let vectors: readonly (readonly number[])[];
  try {
    vectors = await input.client.embed(toEmbed.map((source) => source.input), "document");
  } catch (error) {
    const category = error instanceof EmbeddingRequestError ? error.category : "embedding_transport";
    for (const source of toEmbed) await recordEmbeddingFailure(input.pool, source, category);
    return { selected: sources.length, stored: 0, failed: toEmbed.length };
  }

  let stored = 0;
  for (let index = 0; index < toEmbed.length; index += 1) {
    const source = toEmbed[index]!;
    const vector = vectors[index]!;
    if (await persistEmbeddingFenced(input.pool, source, vector)) stored += 1;
  }
  return { selected: sources.length, stored, failed: 0 };
}

async function persistEmbeddingFenced(
  pool: PostgresPool,
  source: SemanticSource,
  vector: readonly number[],
): Promise<boolean> {
  return withSemanticTransaction(pool, async (client) => {
    const current = source.sourceKind === "fact"
      ? await client.query<{ claim: string; condition: string | null; consequence: string | null; source_updated_at: string }>(
          `SELECT claim, condition, consequence, updated_at::text AS source_updated_at
           FROM memory_fact WHERE id = $1 FOR UPDATE`, [source.factId],
        )
      : await client.query<{ claim: string; condition: string | null; consequence: string | null; source_updated_at: string }>(
          `SELECT claim, condition, consequence, canonical_updated_at::text AS source_updated_at
           FROM memory_canonical_observation
           WHERE canonical_observation_id = $1 AND status = 'active' FOR UPDATE`, [source.sourceId],
        );
    const row = current.rows[0];
    if (row === undefined || embeddingContentHash(renderEmbeddingInput(row)) !== source.contentHash) return false;
    const sourceUpdatedAt = row.source_updated_at;
    if (source.sourceKind === "fact") {
      await client.query(
        `INSERT INTO memory_semantic_embedding
           (fact_id, source_content_hash, source_updated_at, input_version, model, model_revision,
            model_code_revision, embedding, attempt_count, retry_after, last_error_category, updated_at)
         VALUES ($1, $2, $3::timestamptz, $4, $5, $6, $7, $8::vector(768), 0, NULL, NULL, now())
         ON CONFLICT (fact_id) WHERE fact_id IS NOT NULL DO UPDATE SET
           source_content_hash = EXCLUDED.source_content_hash,
           source_updated_at = EXCLUDED.source_updated_at,
           input_version = EXCLUDED.input_version, model = EXCLUDED.model,
           model_revision = EXCLUDED.model_revision, model_code_revision = EXCLUDED.model_code_revision,
           embedding = EXCLUDED.embedding, attempt_count = 0, retry_after = NULL,
           last_error_category = NULL, updated_at = now()`,
        [source.factId, source.contentHash, sourceUpdatedAt, EMBEDDING_INPUT_VERSION, EMBEDDING_MODEL,
          EMBEDDING_MODEL_REVISION, EMBEDDING_CODE_REVISION, pgVector(vector)],
      );
    } else {
      await client.query(
        `INSERT INTO memory_semantic_embedding
           (canonical_observation_id, source_content_hash, source_updated_at, input_version, model, model_revision,
            model_code_revision, embedding, attempt_count, retry_after, last_error_category, updated_at)
         VALUES ($1, $2, $3::timestamptz, $4, $5, $6, $7, $8::vector(768), 0, NULL, NULL, now())
         ON CONFLICT (canonical_observation_id) WHERE canonical_observation_id IS NOT NULL DO UPDATE SET
           source_content_hash = EXCLUDED.source_content_hash,
           source_updated_at = EXCLUDED.source_updated_at,
           input_version = EXCLUDED.input_version, model = EXCLUDED.model,
           model_revision = EXCLUDED.model_revision, model_code_revision = EXCLUDED.model_code_revision,
           embedding = EXCLUDED.embedding, attempt_count = 0, retry_after = NULL,
           last_error_category = NULL, updated_at = now()`,
        [source.sourceId, source.contentHash, sourceUpdatedAt, EMBEDDING_INPUT_VERSION, EMBEDDING_MODEL,
          EMBEDDING_MODEL_REVISION, EMBEDDING_CODE_REVISION, pgVector(vector)],
      );
    }
    return true;
  });
}

async function sourceStillCurrent(pool: PostgresPool, source: SemanticSource): Promise<string | null> {
  const result = source.sourceKind === "fact"
    ? await semanticQuery<{ claim: string; condition: string | null; consequence: string | null; source_updated_at: string }>(pool,
        `SELECT claim, condition, consequence, updated_at::text AS source_updated_at
         FROM memory_fact WHERE id = $1`, [source.factId],
      )
    : await semanticQuery<{ claim: string; condition: string | null; consequence: string | null; source_updated_at: string }>(pool,
        `SELECT claim, condition, consequence, canonical_updated_at::text AS source_updated_at
         FROM memory_canonical_observation
         WHERE canonical_observation_id = $1 AND status = 'active'`, [source.sourceId],
      );
  const current = result.rows[0];
  if (current === undefined) return null;
  const text = renderEmbeddingInput(current);
  return embeddingContentHash(text) === source.contentHash ? current.source_updated_at : null;
}

async function updateSourceTimestamp(pool: PostgresPool, source: SemanticSource, currentAt: string): Promise<void> {
  if (source.sourceKind === "fact") {
    await semanticQuery(pool,
      `UPDATE memory_semantic_embedding e SET source_updated_at = f.updated_at, updated_at = now()
       FROM memory_fact f
       WHERE f.id = $1 AND e.fact_id = f.id AND f.updated_at = $2::timestamptz
         AND e.source_content_hash = $3 AND e.embedding IS NOT NULL`,
      [source.factId, currentAt, source.contentHash],
    );
  } else {
    await semanticQuery(pool,
      `UPDATE memory_semantic_embedding e SET source_updated_at = o.canonical_updated_at, updated_at = now()
       FROM memory_canonical_observation o
       WHERE o.canonical_observation_id = $1 AND o.canonical_observation_id = e.canonical_observation_id
         AND o.status = 'active' AND o.canonical_updated_at = $2::timestamptz
         AND e.source_content_hash = $3 AND e.embedding IS NOT NULL`,
      [source.sourceId, currentAt, source.contentHash],
    );
  }
}

async function recordEmbeddingFailure(
  pool: PostgresPool,
  source: SemanticSource,
  category: string,
): Promise<void> {
  await withSemanticTransaction(pool, async (client) => {
    const current = source.sourceKind === "fact"
      ? await client.query<{ claim: string; condition: string | null; consequence: string | null; source_updated_at: string }>(
          `SELECT claim, condition, consequence, updated_at::text AS source_updated_at
           FROM memory_fact WHERE id = $1 FOR UPDATE`, [source.factId],
        )
      : await client.query<{ claim: string; condition: string | null; consequence: string | null; source_updated_at: string }>(
          `SELECT claim, condition, consequence, canonical_updated_at::text AS source_updated_at
           FROM memory_canonical_observation
           WHERE canonical_observation_id = $1 AND status = 'active' FOR UPDATE`, [source.sourceId],
        );
    const row = current.rows[0];
    if (row === undefined || embeddingContentHash(renderEmbeddingInput(row)) !== source.contentHash) return;
    const sourceUpdatedAt = row.source_updated_at;
    const tableKey = source.sourceKind === "fact" ? "fact_id" : "canonical_observation_id";
    const key = source.sourceKind === "fact" ? source.factId : source.sourceId;
    const conflict = source.sourceKind === "fact"
      ? "(fact_id) WHERE fact_id IS NOT NULL"
      : "(canonical_observation_id) WHERE canonical_observation_id IS NOT NULL";
    await client.query(
      `INSERT INTO memory_semantic_embedding
         (${tableKey}, source_content_hash, source_updated_at, input_version, model, model_revision,
          model_code_revision, embedding, attempt_count, retry_after, last_error_category, updated_at)
       VALUES ($1, $2, $3::timestamptz, $4, $5, $6, $7, NULL, 1, now() + interval '30 seconds', $8, now())
       ON CONFLICT ${conflict} DO UPDATE SET
         source_content_hash = EXCLUDED.source_content_hash,
         source_updated_at = EXCLUDED.source_updated_at,
         input_version = EXCLUDED.input_version, model = EXCLUDED.model,
         model_revision = EXCLUDED.model_revision, model_code_revision = EXCLUDED.model_code_revision,
         embedding = NULL,
         attempt_count = CASE WHEN memory_semantic_embedding.source_content_hash = EXCLUDED.source_content_hash
                                   AND memory_semantic_embedding.input_version = EXCLUDED.input_version
                                   AND memory_semantic_embedding.model = EXCLUDED.model
                                   AND memory_semantic_embedding.model_revision = EXCLUDED.model_revision
                                   AND memory_semantic_embedding.model_code_revision = EXCLUDED.model_code_revision
                             THEN LEAST(memory_semantic_embedding.attempt_count + 1, 10) ELSE 1 END,
         retry_after = now() + CASE WHEN memory_semantic_embedding.source_content_hash = EXCLUDED.source_content_hash
                                         AND memory_semantic_embedding.input_version = EXCLUDED.input_version
                                         AND memory_semantic_embedding.model = EXCLUDED.model
                                         AND memory_semantic_embedding.model_revision = EXCLUDED.model_revision
                                         AND memory_semantic_embedding.model_code_revision = EXCLUDED.model_code_revision
                                    THEN LEAST(3600000, 30000 * power(2, LEAST(memory_semantic_embedding.attempt_count, 7)))
                                    ELSE 30000 END * interval '1 millisecond',
         last_error_category = EXCLUDED.last_error_category, updated_at = now()`,
      [key, source.contentHash, sourceUpdatedAt, EMBEDDING_INPUT_VERSION, EMBEDDING_MODEL,
        EMBEDDING_MODEL_REVISION, EMBEDDING_CODE_REVISION, category],
    );
  });
}

export async function getKeywordSimilarities(input: {
  readonly pool: PostgresPool;
  readonly candidates: readonly CanonicalRecallCandidate[];
  readonly vector: readonly number[];
}): Promise<Map<string, number>> {
  const candidates = [...input.candidates].sort((a, b) => a.rank - b.rank)
    .slice(0, MAX_KEYWORD_CANDIDATES + 32);
  if (candidates.length === 0) return new Map();
  const kinds = candidates.map((row) => row.item.type);
  const ids = candidates.map((row) => row.item.id);
  const hashes = candidates.map((row) => embeddingContentHash(itemInput(row.item)));
  const result = await semanticQuery<SimilarityRow>(input.pool,
    `WITH requested AS (
       SELECT * FROM unnest($1::text[], $2::text[], $3::text[]) AS r(source_kind, source_id, content_hash)
     )
     SELECT r.source_kind, r.source_id, e.source_content_hash,
            CASE WHEN r.source_kind = 'fact' THEN f.claim ELSE o.claim END AS current_claim,
            CASE WHEN r.source_kind = 'fact' THEN f.condition ELSE o.condition END AS current_condition,
            CASE WHEN r.source_kind = 'fact' THEN f.consequence ELSE o.consequence END AS current_consequence,
            (1 - (e.embedding <=> $4::vector(768)))::real AS similarity
     FROM requested r
     JOIN memory_semantic_embedding e
       ON e.embedding IS NOT NULL AND e.source_content_hash = r.content_hash
      AND e.input_version = $5 AND e.model = $6
      AND e.model_revision = $7 AND e.model_code_revision = $8
     LEFT JOIN memory_fact f ON r.source_kind = 'fact' AND f.fact_key = r.source_id AND e.fact_id = f.id
     LEFT JOIN memory_canonical_observation o
       ON r.source_kind = 'observation' AND o.canonical_observation_id = r.source_id
      AND o.status = 'active' AND e.canonical_observation_id = o.canonical_observation_id
     WHERE (r.source_kind = 'fact' AND f.id IS NOT NULL AND e.source_updated_at = f.updated_at)
        OR (r.source_kind = 'observation' AND o.canonical_observation_id IS NOT NULL
            AND e.source_updated_at = o.canonical_updated_at)`,
    [kinds, ids, hashes, pgVector(input.vector), EMBEDDING_INPUT_VERSION, EMBEDDING_MODEL,
      EMBEDDING_MODEL_REVISION, EMBEDDING_CODE_REVISION],
  );
  const scores = new Map<string, number>();
  for (const row of result.rows) {
    const currentHash = embeddingContentHash(renderEmbeddingInput({
      claim: row.current_claim,
      condition: row.current_condition,
      consequence: row.current_consequence,
    }));
    if (currentHash !== row.source_content_hash) continue;
    if (!Number.isFinite(row.similarity)) continue;
    scores.set(sourceId(row.source_kind, row.source_id), clampSimilarity(row.similarity));
  }
  return scores;
}

async function getSemanticOnlyCandidates(input: {
  readonly pool: PostgresPool;
  readonly vector: readonly number[];
  readonly keywordFactKeys: readonly string[];
  readonly keywordObservationIds: readonly string[];
  readonly referenceTime: Date;
  readonly timeRange?: { readonly start: string; readonly end: string };
  readonly config: MemoryConfig;
}): Promise<{ readonly candidates: readonly ShadowCandidate[]; readonly scores: ReadonlyMap<string, number> }> {
  const timeRange = input.timeRange;
  const factRange = timeRange === undefined ? "" : "AND f.observed_at >= $4::timestamptz AND f.observed_at < $5::timestamptz";
  const observationRange = timeRange === undefined ? "" : "AND o.first_observed_at < $5::timestamptz AND o.last_observed_at >= $4::timestamptz";
  const versionParam = timeRange === undefined ? 4 : 6;
  const modelParam = versionParam + 1;
  const revisionParam = versionParam + 2;
  const codeRevisionParam = versionParam + 3;
  const limitParam = versionParam + 4;
  const params: unknown[] = [
    pgVector(input.vector), input.keywordFactKeys, input.keywordObservationIds,
    ...(timeRange === undefined ? [] : [timeRange.start, timeRange.end]),
    EMBEDDING_INPUT_VERSION, EMBEDDING_MODEL, EMBEDDING_MODEL_REVISION,
    EMBEDDING_CODE_REVISION, MAX_SEMANTIC_OVERFETCH,
  ];
  const result = await semanticQuery<SemanticOnlyRow>(input.pool,
    `SELECT * FROM (
       SELECT 'fact'::text AS source_kind, f.fact_key AS source_id, f.id AS fact_id,
              f.turn_id, f.subject_id, s.role AS subject_role, f.kind, f.claim, f.condition, f.consequence,
              f.topics, f.observed_at, f.source_type,
              f.article_reaction_id, f.explicitness, NULL::text AS evidence_strength,
              NULL::integer AS support_count, NULL::integer AS distinct_day_count,
              e.source_content_hash AS content_hash,
              (1 - (e.embedding <=> $1::vector(768)))::real AS similarity
       FROM memory_semantic_embedding e JOIN memory_fact f ON f.id = e.fact_id
       JOIN memory_subject s ON s.id = f.subject_id
       WHERE e.embedding IS NOT NULL AND e.source_updated_at = f.updated_at
         AND e.input_version = $${versionParam}
         AND e.model = $${modelParam} AND e.model_revision = $${revisionParam}
         AND e.model_code_revision = $${codeRevisionParam}
         AND f.fact_key <> ALL($2::text[]) ${factRange}
       UNION ALL
       SELECT 'observation'::text AS source_kind, o.canonical_observation_id AS source_id,
              NULL::uuid AS fact_id, NULL::uuid AS turn_id, o.subject_id, s.role AS subject_role, o.kind,
              o.claim, o.condition, o.consequence, o.topics, o.last_observed_at AS observed_at,
              CASE WHEN EXISTS (
                SELECT 1 FROM memory_fact sf WHERE sf.fact_key = ANY(o.source_fact_keys)
                  AND sf.source_type = 'article'
              ) THEN 'article'::text ELSE 'conversation'::text END AS source_type,
              NULL::uuid AS article_reaction_id, NULL::text AS explicitness,
              o.evidence_strength, o.support_count, o.distinct_day_count,
              e.source_content_hash AS content_hash,
              (1 - (e.embedding <=> $1::vector(768)))::real AS similarity
       FROM memory_semantic_embedding e JOIN memory_canonical_observation o
         ON o.canonical_observation_id = e.canonical_observation_id AND o.status = 'active'
       JOIN memory_subject s ON s.id = o.subject_id
       WHERE e.embedding IS NOT NULL AND e.source_updated_at = o.canonical_updated_at
         AND e.input_version = $${versionParam}
         AND e.model = $${modelParam} AND e.model_revision = $${revisionParam}
         AND e.model_code_revision = $${codeRevisionParam}
         AND o.canonical_observation_id <> ALL($3::text[]) ${observationRange}
     ) semantic_candidates
     ORDER BY similarity DESC, source_kind, source_id
     LIMIT $${limitParam}`,
    params,
  );
  const candidates: ShadowCandidate[] = [];
  const scores = new Map<string, number>();
  for (const row of result.rows) {
    const text = renderEmbeddingInput({ claim: row.claim, condition: row.condition, consequence: row.consequence });
    if (embeddingContentHash(text) !== row.content_hash || !Number.isFinite(row.similarity)) continue;
    const item = itemFromSemanticRow(row, input.referenceTime, input.config);
    const id = sourceId(row.source_kind, row.source_id);
    candidates.push({
      id,
      type: row.source_kind,
      score: item.score,
      chars: itemChars(item),
      baselineRank: Number.MAX_SAFE_INTEGER,
      baselineIncluded: false,
      textScore: 0,
      semanticOnly: true,
    });
    scores.set(id, clampSimilarity(row.similarity));
  }
  return { candidates: candidates.slice(0, MAX_SEMANTIC_ONLY_CANDIDATES), scores };
}

function itemFromSemanticRow(row: SemanticOnlyRow, referenceTime: Date, config: MemoryConfig): CanonicalRecallItem {
  const recency = recencyBoost(row.observed_at, referenceTime, config.canonicalRecencyHalfLifeDays) * config.canonicalRecencyWeight;
  const evidence = row.source_kind === "fact"
    ? evidenceBoost("fact", row.explicitness ?? undefined)
    : evidenceBoost("observation", undefined, row.evidence_strength ?? undefined);
  return {
    type: row.source_kind,
    id: row.source_id,
    subject: row.subject_id,
    subjectRole: row.subject_role as "user" | "assistant" | "relationship",
    kind: row.kind,
    claim: row.claim,
    ...(row.source_kind === "fact" && row.source_type === "conversation" && row.turn_id !== null
      ? { turnId: row.turn_id }
      : {}),
    sourceType: row.source_type,
    ...(row.article_reaction_id !== null ? { articleReactionId: row.article_reaction_id } : {}),
    ...(row.condition !== null ? { condition: row.condition } : {}),
    ...(row.consequence !== null ? { consequence: row.consequence } : {}),
    topics: row.topics,
    observedAt: row.observed_at.toISOString(),
    ...(row.explicitness !== null ? { explicitness: row.explicitness } : {}),
    ...(row.evidence_strength !== null ? { evidenceStrength: row.evidence_strength } : {}),
    ...(row.support_count !== null ? { supportCount: row.support_count } : {}),
    ...(row.distinct_day_count !== null ? { distinctDayCount: row.distinct_day_count } : {}),
    textScore: 0,
    recencyBoost: recency,
    evidenceBoost: evidence,
    score: recency + evidence,
  };
}

function similarityRanks(
  candidates: readonly ShadowCandidate[],
  scores: ReadonlyMap<string, number>,
): Map<string, { rank: number; similarity: number }> {
  const sorted = [...candidates]
    .filter((candidate) => scores.has(candidate.id))
    .sort((a, b) => (scores.get(b.id)! - scores.get(a.id)!) || a.id.localeCompare(b.id));
  return new Map(sorted.map((candidate, index) => [candidate.id, {
    rank: index + 1,
    similarity: scores.get(candidate.id)!,
  }]));
}

export async function runSemanticShadowRecall(input: {
  readonly pool: PostgresPool;
  readonly client: EmbeddingClient;
  readonly config: MemoryConfig;
  readonly source: "chat" | "api";
  readonly turnId?: string;
  readonly turnAttempt?: number;
  readonly recallOperationId?: string | null;
  readonly query: string;
  readonly referenceTime: Date;
  readonly limit: number;
  readonly maxChars: number;
  readonly candidates: readonly CanonicalRecallCandidate[];
  readonly baselineOrigin: "keyword" | "temporal_keyword" | "recency";
  readonly retrievalMode: RecallMode;
  readonly emptyQueryFallback: boolean;
  readonly timeRange?: { readonly start: string; readonly end: string };
  readonly log?: (message: string) => void;
}): Promise<void> {
  const startedAt = new Date();
  const log = input.log ?? (() => undefined);
  const baseline = input.candidates.map((candidate) => canonicalCandidate(candidate, input.baselineOrigin));
  let outcome: "ok" | "failed" | "skipped" = "ok";
  let errorCategory: string | null = null;
  let skipReason: "non_comparable_baseline" | null = null;
  let traces: ShadowCandidateTrace[] = [...baselineArmTraces(baseline)];
  let semanticOnlyCount = 0;
  if (input.retrievalMode === "timeline" || input.emptyQueryFallback || input.baselineOrigin === "recency") {
    outcome = "skipped";
    skipReason = "non_comparable_baseline";
  } else {
    try {
      const vector = (await input.client.embed([input.query], "query"))[0]!;
      const keywordCandidates = selectKeywordCandidates(baseline, input.limit);
      const keywordSimilarities = await getKeywordSimilarities({
        pool: input.pool,
        candidates: keywordCandidates.map((candidate) =>
          input.candidates.find((source) => sourceId(source.item.type, source.item.id) === candidate.id)!,
        ),
        vector,
      });
      const keywordFactKeys = input.candidates
        .filter((candidate) => candidate.item.type === "fact")
        .map((candidate) => candidate.item.id);
      const keywordObservationIds = input.candidates
        .filter((candidate) => candidate.item.type === "observation")
        .map((candidate) => candidate.item.id);
      const semanticOnly = await getSemanticOnlyCandidates({
        pool: input.pool,
        vector,
        keywordFactKeys,
        keywordObservationIds,
        referenceTime: input.referenceTime,
        config: input.config,
        ...(input.timeRange !== undefined ? { timeRange: input.timeRange } : {}),
      });
      semanticOnlyCount = semanticOnly.candidates.length;
      const union = [...keywordCandidates, ...semanticOnly.candidates];
      const scores = new Map<string, number>([...keywordSimilarities, ...semanticOnly.scores]);
      const semantic = similarityRanks(union, scores);
      const [rerankArm, hybridArm] = buildShadowArms({
        keywordCandidates,
        semanticOnlyCandidates: semanticOnly.candidates,
        semantic,
        limit: input.limit,
        maxChars: input.maxChars,
      });
      traces = [...baselineArmTraces(baseline), ...rerankArm.traces, ...hybridArm.traces];
    } catch (error) {
      outcome = "failed";
      errorCategory = error instanceof EmbeddingRequestError
        ? error.category
        : memoryErrorCategory(error);
    }
  }

  try {
    const omittedDeletedSources = await persistShadowAttempt(input.pool, {
      source: input.source,
      ...(input.turnId !== undefined ? { turnId: input.turnId } : {}),
      ...(input.turnAttempt !== undefined ? { turnAttempt: input.turnAttempt } : {}),
      recallOperationId: input.recallOperationId ?? null,
      outcome,
      errorCategory,
      skipReason,
      retrievalMode: input.retrievalMode,
      referenceTime: input.referenceTime,
      ...(input.timeRange !== undefined ? { timeRange: input.timeRange } : {}),
      queryFingerprint: createHash("sha256").update(input.query).digest("hex"),
      startedAt,
      finishedAt: new Date(),
      baselineCount: baseline.length,
      semanticOnlyCount,
      resultLimit: input.limit,
      maxChars: input.maxChars,
      traces,
    });
    if (omittedDeletedSources > 0) {
      log("[MEMORY] semantic shadow trace omitted candidates whose source rows were deleted during persistence");
    }
  } catch (error) {
    log(`[MEMORY] semantic shadow trace persistence failed: ${memoryErrorCategory(error)}`);
  }
}

async function persistShadowAttempt(pool: PostgresPool, input: {
  readonly source: "chat" | "api";
  readonly turnId?: string;
  readonly turnAttempt?: number;
  readonly recallOperationId: string | null;
  readonly outcome: "ok" | "failed" | "skipped";
  readonly errorCategory: string | null;
  readonly skipReason: "non_comparable_baseline" | null;
  readonly retrievalMode: RecallMode;
  readonly referenceTime: Date;
  readonly timeRange?: { readonly start: string; readonly end: string };
  readonly queryFingerprint: string;
  readonly startedAt: Date;
  readonly finishedAt: Date;
  readonly baselineCount: number;
  readonly semanticOnlyCount: number;
  readonly resultLimit: number;
  readonly maxChars: number;
  readonly traces: readonly ShadowCandidateTrace[];
}): Promise<number> {
  const inserted = await semanticQuery<{ id: string }>(pool,
    `INSERT INTO memory_semantic_shadow_attempt
       (turn_id, turn_attempt, recall_operation_id, source, outcome, error_category, skip_reason,
        retrieval_mode, reference_time, time_range_start, time_range_end, query_fingerprint,
        input_version, ranking_strategy_version, model, model_revision, model_code_revision,
        baseline_candidate_count, semantic_only_candidate_count, result_limit, max_chars,
        started_at, finished_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16,
             $17, $18, $19, $20, $21, $22, $23)
     RETURNING id`,
    [input.turnId ?? null, input.turnAttempt ?? null, input.recallOperationId, input.source,
      input.outcome, input.errorCategory, input.skipReason, input.retrievalMode, input.referenceTime,
      input.timeRange?.start ?? null, input.timeRange?.end ?? null, input.queryFingerprint,
      EMBEDDING_INPUT_VERSION, RANKING_STRATEGY_VERSION, EMBEDDING_MODEL,
      EMBEDDING_MODEL_REVISION, EMBEDDING_CODE_REVISION, input.baselineCount,
      input.semanticOnlyCount, input.resultLimit, input.maxChars, input.startedAt, input.finishedAt],
  );
  const attemptId = inserted.rows[0]?.id;
  if (attemptId === undefined || input.traces.length === 0) return 0;

  let omittedDeletedSources = 0;
  await withSemanticTransaction(pool, async (client) => {
    for (let offset = 0; offset < input.traces.length; offset += 32) {
      const batch = input.traces.slice(offset, offset + 32);
      await client.query("SAVEPOINT semantic_shadow_batch");
      try {
        await insertShadowTraceBatch(client, attemptId, batch);
        await client.query("RELEASE SAVEPOINT semantic_shadow_batch");
      } catch (error) {
        await client.query("ROLLBACK TO SAVEPOINT semantic_shadow_batch");
        if (!isForeignKeyViolation(error)) throw error;
        for (const trace of batch) {
          await client.query("SAVEPOINT semantic_shadow_candidate");
          try {
            await insertShadowTraceBatch(client, attemptId, [trace]);
          } catch (candidateError) {
            await client.query("ROLLBACK TO SAVEPOINT semantic_shadow_candidate");
            if (!isForeignKeyViolation(candidateError) || await sourceStillExists(client, trace)) {
              throw candidateError;
            }
            omittedDeletedSources += 1;
          } finally {
            await client.query("RELEASE SAVEPOINT semantic_shadow_candidate");
          }
        }
        await client.query("RELEASE SAVEPOINT semantic_shadow_batch");
      }
    }
  });
  return omittedDeletedSources;
}

function isForeignKeyViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23503";
}

async function sourceStillExists(client: PostgresPoolClient, trace: ShadowCandidateTrace): Promise<boolean> {
  const sourceIdValue = trace.id.slice(trace.id.indexOf(":") + 1);
  const result = trace.type === "fact"
    ? await client.query<{ present: boolean }>(
        "SELECT EXISTS (SELECT 1 FROM memory_fact WHERE fact_key = $1) AS present", [sourceIdValue],
      )
    : await client.query<{ present: boolean }>(
        "SELECT EXISTS (SELECT 1 FROM memory_canonical_observation WHERE canonical_observation_id = $1) AS present",
        [sourceIdValue],
      );
  return result.rows[0]?.present === true;
}

async function insertShadowTraceBatch(
  client: PostgresPoolClient,
  attemptId: string,
  traces: readonly ShadowCandidateTrace[],
): Promise<void> {
  if (traces.length === 0) return;
  const values: unknown[] = [];
  const tuples = traces.map((trace, index) => {
    const offset = index * 13;
    const sourceIdValue = trace.id.slice(trace.id.indexOf(":") + 1);
    const factKey = trace.type === "fact" ? sourceIdValue : null;
    const observationId = trace.type === "observation" ? sourceIdValue : null;
    values.push(
      attemptId, trace.arm, trace.type, sourceIdValue, factKey, observationId, trace.origin,
      trace.baselineRank, trace.semanticRank,
      trace.similarity === null ? null : clampSimilarity(trace.similarity),
      trace.armRank, trace.budgetIncluded, trace.resultRank,
    );
    return `($${offset + 1}::uuid, $${offset + 2}::text, $${offset + 3}::text, $${offset + 4}::text, $${offset + 5}::text, $${offset + 6}::text, $${offset + 7}::text, $${offset + 8}::integer, $${offset + 9}::integer, $${offset + 10}::real, $${offset + 11}::integer, $${offset + 12}::boolean, $${offset + 13}::integer)`;
  });
  await client.query(
    `INSERT INTO memory_semantic_shadow_candidate
       (attempt_id, arm, source_kind, source_id, fact_key, canonical_observation_id,
        candidate_origin, baseline_rank, semantic_rank, similarity, arm_rank, budget_included, result_rank)
     SELECT row_values.*
     FROM (VALUES ${tuples.join(",")}) AS row_values
       (attempt_id, arm, source_kind, source_id, fact_key, canonical_observation_id,
        candidate_origin, baseline_rank, semantic_rank, similarity, arm_rank, budget_included, result_rank)
     WHERE (row_values.source_kind = 'fact' AND EXISTS (
              SELECT 1 FROM memory_fact f WHERE f.fact_key = row_values.fact_key))
        OR (row_values.source_kind = 'observation' AND EXISTS (
              SELECT 1 FROM memory_canonical_observation o
              WHERE o.canonical_observation_id = row_values.canonical_observation_id))
     ON CONFLICT DO NOTHING`,
    values,
  );
}

export const __semanticStoreLimits = {
  MAX_KEYWORD_CANDIDATES,
  MAX_SEMANTIC_OVERFETCH,
  RECONCILE_BATCH_SIZE,
};
