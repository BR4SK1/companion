/**
 * Article interest consolidation: the turn-free evidence path.
 *
 * Independent accepted article reactions — each already a real
 * assistant-attributed memory fact — are consolidated into observation
 * candidates about the assistant subject, so recurring interests can form
 * durable observations without any conversation-turn evidence:
 *
 * - The fact set is article-sourced only (source_type 'article', preference
 *   kind, assistant subject, not yet referenced by any observation or
 *   omission evidence row), newest-first, bounded per run.
 * - The subject and kind are code-owned: the assistant subject and the
 *   preference kind. The model only groups claims and cites the fact ids it
 *   rests on — strict subject/provenance isolation by construction.
 * - Evidence breadth is distinct independent reactions (never turns); the
 *   observation policy's source-aware branch enforces it, and the shared
 *   observation/policy/promotion validation recomputes it from the facts.
 * - Accepted candidates become ordinary `memory_observation` artifacts of a
 *   turn-free `memory_run`, so the existing promotion engine promotes them
 *   with the same fencing, idempotency, and verification as every other run.
 * - The phase is single-flight under a durable claim
 *   (`article_observation_claim`, migration 0009): a concurrent worker skips
 *   instead of duplicating the provider call, a crashed worker's lease is
 *   taken over after expiry, and every artifact write is fenced by the exact
 *   lease it was claimed under.
 *
 * The phase is fail-soft by design: a missing behavior boundary, a missing
 * assistant subject, or a missing prompt row skips the phase (a rollout
 * state, like ingestion's `ingestion not configured`), and any failure is
 * logged with a fixed category and never fails the ingestion attempt.
 */

import { randomUUID } from "node:crypto";

import { withTransaction, type PostgresPool } from "@companion/postgres";

import { hashArtifact } from "../memory/hashing.ts";
import { assertCompleteResponse } from "../memory/extraction.ts";
import { buildObservationDocument } from "../memory/consolidation.ts";
import { evaluateObservationCandidate, OBSERVATION_POLICY_VERSION } from "../memory/policy.ts";
import { isValidTimezone, type BehaviorTime } from "../memory/time.ts";
import { recordMemoryOperation } from "../memory/runtime.ts";
import type { MemoryFact } from "../memory/types.ts";
import { memoryErrorCategory } from "../memory/errors.ts";
import { promptContentHash } from "../memory/prompts.ts";
import {
  ARTICLE_INTEREST_CONSOLIDATION_PROMPT_VERSION,
  ARTICLE_INTEREST_CONSOLIDATION_RESPONSE_FORMAT,
  articleInterestConsolidationEnvelopeChars,
  articleTaskPresets,
  parseArticleInterestConsolidation,
  renderArticleInterestConsolidationFactBlock,
  renderArticleInterestConsolidationInput,
  type ArticleConsolidationFactInput,
} from "./prompts.ts";
import type { ArticleRuntimeLlmCaller } from "./types.ts";

/** Bounded fact set per consolidation run. */
const MAX_FACTS_PER_RUN = 12;
/** Bounded rendered source size for the consolidation call, in characters. */
const MAX_SOURCE_CHARS = 20_000;
/** Minimum distinct reactions required before a consolidation call is made. */
const MIN_DISTINCT_REACTIONS = 2;
/** How long the consolidation claim lease is held while the phase runs. */
const DEFAULT_CONSOLIDATION_LEASE_MS = 10 * 60 * 1000;
/** The single durable claim row for the phase. */
const CLAIM_ID = "consolidation";

/** Thrown when artifact writes run under a claim that is no longer ours. */
class ConsolidationClaimLostError extends Error {
  constructor() {
    super("article observation consolidation claim was lost");
    this.name = "ConsolidationClaimLostError";
  }
}

export interface ArticleObservationDeps {
  readonly pool: PostgresPool;
  /** Startup-captured authoritative zone; omitted only by direct domain callers/tests. */
  readonly timezone?: string | null;
  readonly callLlm: ArticleRuntimeLlmCaller;
  readonly log?: (message: string) => void;
  /** Claim lease duration; tests shorten it to exercise recovery. */
  readonly consolidationLeaseMs?: number;
}

export type ArticleObservationOutcome =
  | {
      readonly status: "ok";
      readonly runId: string;
      readonly factCount: number;
      readonly accepted: number;
      readonly omitted: number;
    }
  | { readonly status: "skipped"; readonly reason: string }
  | { readonly status: "failed"; readonly category: string };

interface BehaviorRow {
  timezone: string | null;
  day_start_hour: number;
}

interface ArticleFactRow {
  fact_key: string;
  subject_id: string;
  kind: string;
  claim: string;
  condition: string | null;
  consequence: string | null;
  topics: string[];
  observed_at: Date;
  explicitness: string;
  article_reaction_id: string;
}

/**
 * Run one article interest-consolidation phase. Never throws into the
 * caller: every failure path returns a status the runner logs.
 */
export async function runArticleObservationConsolidation(
  deps: ArticleObservationDeps,
  now: Date = new Date(),
): Promise<ArticleObservationOutcome> {
  const { pool } = deps;
  const log = deps.log ?? ((message: string) => console.log(message));
  const startedAt = now;

  // Provisioned behavioral-day boundary (memory-domain configuration): the
  // evidence-day counting input. Missing is a rollout state.
  const timezoneExpression = deps.timezone === undefined ? "settings.timezone" : "$1::text";
  const behaviorResult = await pool.query<BehaviorRow>(
    `SELECT ${timezoneExpression} AS timezone, behavior.day_start_hour
     FROM memory_behavior AS behavior
     CROSS JOIN companion_time_settings AS settings
     WHERE behavior.id = 'behavior' AND settings.id = true`,
    deps.timezone === undefined ? [] : [deps.timezone],
  );
  const behaviorRow = behaviorResult.rows[0];
  if (behaviorRow === undefined || behaviorRow.timezone === null) {
    return { status: "skipped", reason: "behavior_boundary_not_provisioned" };
  }
  if (!isValidTimezone(behaviorRow.timezone)) {
    return { status: "skipped", reason: "authoritative_timezone_invalid" };
  }
  const behavior: BehaviorTime = {
    timezone: behaviorRow.timezone,
    dayStartHour: behaviorRow.day_start_hour,
  };

  // The assistant subject reactions are attributed to; the facts and the
  // observations they form carry exactly this subject.
  const assistantResult = await pool.query<{ id: string }>(
    `SELECT id FROM memory_subject WHERE role = 'assistant' LIMIT 1`,
  );
  const assistantSubjectId = assistantResult.rows[0]?.id;
  if (assistantSubjectId === undefined) {
    return { status: "skipped", reason: "assistant_subject_missing" };
  }

  // The persona-bearing prompt for this task; provisioned privately, and a
  // missing row is a rollout state that skips the phase.
  const promptResult = await pool.query<{ system_prompt: string }>(
    `SELECT system_prompt FROM article_prompt
     WHERE kind = 'article_interest_consolidation' AND version = $1`,
    [ARTICLE_INTEREST_CONSOLIDATION_PROMPT_VERSION],
  );
  const systemPrompt = promptResult.rows[0]?.system_prompt;
  if (systemPrompt === undefined || systemPrompt.trim().length === 0) {
    return { status: "skipped", reason: "consolidation_prompt_not_provisioned" };
  }

  // Unconsolidated article facts: assistant-subject preference facts from
  // accepted reactions, not yet referenced by any observation or omission
  // evidence row, newest-first, bounded.
  const factResult = await pool.query<ArticleFactRow>(
    `SELECT f.fact_key, f.subject_id, f.kind, f.claim, f.condition, f.consequence,
            f.topics, f.observed_at, f.explicitness, f.article_reaction_id
     FROM memory_fact f
     WHERE f.source_type = 'article'
       AND f.article_reaction_id IS NOT NULL
       AND f.kind = 'preference'
       AND f.subject_id = $1
       AND NOT EXISTS (
         SELECT 1 FROM memory_observation_evidence e WHERE e.fact_id = f.id)
       AND NOT EXISTS (
         SELECT 1 FROM memory_observation_omission_evidence e WHERE e.fact_id = f.id)
     ORDER BY f.observed_at DESC, f.fact_key
     LIMIT $2`,
    [assistantSubjectId, MAX_FACTS_PER_RUN],
  );
  const rows = factResult.rows;

  /**
   * Character-budgeted batch accounting: the bounded selector caps the fact
   * COUNT, but claims are only bounded by the configured reaction cap, so a
   * batch of long reactions could still render over `MAX_SOURCE_CHARS` —
   * which used to fail the run and then re-select the same batch forever.
   * The batch is therefore trimmed to what fits, newest-first, always keeping
   * at least the minimum distinct reactions; trimmed-out facts stay pending
   * and are picked up by a later attempt (progress by construction).
   */
  const envelopeChars = articleInterestConsolidationEnvelopeChars();
  let batchLength = rows.length;
  {
    let rendered = envelopeChars;
    for (let index = 0; index < rows.length; index += 1) {
      const block = renderArticleInterestConsolidationFactBlock({
        factKey: rows[index]!.fact_key,
        claim: rows[index]!.claim,
        topics: rows[index]!.topics,
        observedAt: rows[index]!.observed_at.toISOString(),
      });
      const fits = rendered + block.length + 2 <= MAX_SOURCE_CHARS; // + "\n\n" separator
      if (!fits && index >= MIN_DISTINCT_REACTIONS) {
        batchLength = index;
        break;
      }
      rendered += block.length + 2;
    }
  }
  const batch = rows.slice(0, batchLength);
  const distinctReactions = new Set(batch.map((row) => row.article_reaction_id)).size;
  if (distinctReactions < MIN_DISTINCT_REACTIONS) {
    return { status: "skipped", reason: "insufficient_unconsolidated_reactions" };
  }

  const facts: MemoryFact[] = batch.map((row) => ({
    id: "",
    factKey: row.fact_key,
    turnId: null,
    turnKey: null,
    articleReactionId: row.article_reaction_id,
    subject: row.subject_id,
    kind: row.kind as MemoryFact["kind"],
    claim: row.claim,
    condition: row.condition,
    consequence: row.consequence,
    topics: row.topics,
    observedAt: row.observed_at,
    explicitness: row.explicitness as MemoryFact["explicitness"],
    evidenceBasis: "observed_behavior",
    extractionVersion: ARTICLE_INTEREST_CONSOLIDATION_PROMPT_VERSION,
    ingestVersion: ARTICLE_INTEREST_CONSOLIDATION_PROMPT_VERSION,
  }));
  const factsById = new Map(facts.map((fact) => [fact.factKey, fact]));

  // Run identity: deterministic hashes over the bounded source and the
  // generation signature, like every consolidation run.
  const sortedFactKeys = [...facts.map((fact) => fact.factKey)].sort();
  const sourceFingerprint = hashArtifact(
    "article-observation-source",
    ...sortedFactKeys,
  );
  const generationSignature = hashArtifact(
    "article-observation-signature",
    ARTICLE_INTEREST_CONSOLIDATION_PROMPT_VERSION,
    promptContentHash(systemPrompt),
    String(MAX_FACTS_PER_RUN),
    String(MAX_SOURCE_CHARS),
  );
  const factSetId = hashArtifact("fact-set", sourceFingerprint, generationSignature);
  const observationSetId = hashArtifact(
    "observation-set",
    factSetId,
    generationSignature,
  );
  const runId = `article-obs-${String(startedAt.getTime())}`;

  // Durable single-flight claim: concurrent workers select the same
  // unconsolidated facts (evidence rows only appear after the provider
  // call), so a durable claim — not selection order — decides who runs. The
  // lease expires so a crashed worker cannot wedge the phase; artifact
  // writes below are fenced by this exact lease.
  const owner = randomUUID();
  const leaseMs = deps.consolidationLeaseMs ?? DEFAULT_CONSOLIDATION_LEASE_MS;
  const claim: ConsolidationClaim = {
    owner,
    leaseExpiresAt: new Date(startedAt.getTime() + leaseMs),
  };
  if (!(await claimConsolidation(pool, claim))) {
    return { status: "skipped", reason: "consolidation_in_progress_elsewhere" };
  }

  try {
    await pool.query(
      `INSERT INTO memory_run
         (run_id, status, facts_status, observations_status, max_turns,
          source_fingerprint, fact_set_id, observation_set_id,
          fact_generation_signature, observation_generation_signature)
       VALUES ($1, 'planned', 'complete', 'pending', 0, $2, $3, $4, $5, $5)`,
      [runId, sourceFingerprint, factSetId, observationSetId, generationSignature],
    );

    try {
      const promptInput: ArticleConsolidationFactInput[] = facts.map((fact) => ({
        factKey: fact.factKey,
        claim: fact.claim,
        topics: fact.topics,
        observedAt: fact.observedAt.toISOString(),
      }));
      const source = renderArticleInterestConsolidationInput(promptInput);
      if (source.length > MAX_SOURCE_CHARS) {
        throw new Error(
          `article observation source is ${String(source.length)} characters; reduce the bounded selector`,
        );
      }
      const result = await deps.callLlm(await loadModel(pool), {
        systemPrompt,
        userMessage: source,
        taskPreset: articleTaskPresets.consolidation,
        responseFormat: ARTICLE_INTEREST_CONSOLIDATION_RESPONSE_FORMAT,
      });
      assertCompleteResponse(result.finishReason, "Article interest consolidation");

      const candidates = parseArticleInterestConsolidation(result.text);
      if (candidates === null) {
        throw new Error("unusable article interest consolidation output");
      }

      // Candidate validation and policy interpretation: every cited fact id
      // must exist in this run's fact set, support and contradiction sets must
      // not overlap or repeat, and the source-aware policy enforces the
      // preference kind and the distinct-reaction breadth.
      interface CandidateDecision {
        readonly accepted: boolean;
        readonly reason?: string;
        readonly document: ReturnType<typeof buildObservationDocument>["observation"];
      }
      const decisions: CandidateDecision[] = [];
      for (const candidate of candidates) {
        const allIds = [...candidate.sourceFactIds, ...(candidate.contradictionFactIds ?? [])];
        if (new Set(allIds).size !== allIds.length) {
          throw new Error("article observation reused a fact as both support and contradiction");
        }
        for (const id of allIds) {
          if (!factsById.has(id)) {
            throw new Error("article observation referenced an unknown fact id");
          }
        }
        const item = {
          subject: assistantSubjectId,
          kind: "preference" as const,
          claim: candidate.claim,
          topics: candidate.topics,
          ...(candidate.condition !== undefined ? { condition: candidate.condition } : {}),
          ...(candidate.consequence !== undefined
            ? { consequence: candidate.consequence }
            : {}),
          sourceFactIds: candidate.sourceFactIds,
          ...(candidate.contradictionFactIds !== undefined
            ? { contradictionFactIds: candidate.contradictionFactIds }
            : {}),
        };
        const decision = evaluateObservationCandidate(item, factsById);
        const document = buildObservationDocument(item, factsById, {
          runId,
          observationSetId,
          factSetId,
          consolidationVersion: ARTICLE_INTEREST_CONSOLIDATION_PROMPT_VERSION,
        }, behavior).observation;
        decisions.push({
          accepted: decision.eligible,
          ...(decision.reason !== undefined ? { reason: decision.reason } : {}),
          document,
        });
      }

      // Artifacts: one transaction per artifact, idempotent per (run, key),
      // each fenced by the consolidation claim.
      for (const decision of decisions.filter((entry) => entry.accepted)) {
        const observation = decision.document;
        await withTransactionArtifact(pool, observation, observationSetId, runId, claim);
      }

      // Omissions: rejected candidates with their reasons and evidence.
      const omissions = decisions.filter((entry) => !entry.accepted);
      for (const [index, omission] of omissions.entries()) {
        const omissionId = hashArtifact(
          "observation-omission",
          runId,
          String(index),
          omission.document.observationKey,
        );
        await withTransactionOmission(
          pool,
          omission.document,
          omission.reason ?? "source_policy_rejected",
          omissionId,
          observationSetId,
          runId,
          claim,
        );
      }

      const storedCount = await pool
        .query<{ n: string }>(
          `SELECT count(*)::text AS n FROM memory_observation WHERE run_id = $1`,
          [runId],
        )
        .then((result) => Number(result.rows[0]?.n ?? 0));

      if (storedCount > 0) {
        await pool.query(
          `UPDATE memory_run
           SET status = 'observations-ready', observations_status = 'complete',
               observation_count = $2, observation_llm_calls = 1,
               observation_candidate_count = $3, observation_accepted_count = $4,
               observation_omitted_count = $5, completed_at = now()
           WHERE run_id = $1`,
          [runId, storedCount, decisions.length, storedCount, omissions.length],
        );
      } else {
        // No accepted candidate: the run is terminally failed so the promotion
        // scheduler never retries it; the unconsolidated facts stay pending for
        // a later attempt (each ingestion attempt retries the phase at most
        // once).
        await pool.query(
          `UPDATE memory_run
           SET status = 'failed', observations_status = 'failed', error = $2,
               observation_llm_calls = 1, observation_candidate_count = $3,
               observation_accepted_count = 0, observation_omitted_count = $4,
               completed_at = now()
           WHERE run_id = $1`,
          [runId, "no_accepted_article_interest_candidates", decisions.length, omissions.length],
        );
      }

      await recordMemoryOperation(pool, {
        kind: "observation_consolidation",
        outcome: "ok",
        runId,
        detail:
          `source=article facts=${String(facts.length)} candidates=${String(decisions.length)}` +
          ` accepted=${String(storedCount)} omitted=${String(omissions.length)}`,
        model: result.model,
        promptVersion: ARTICLE_INTEREST_CONSOLIDATION_PROMPT_VERSION,
        llmCalls: 1,
        startedAt,
        finishedAt: new Date(),
      }).catch(() => undefined);

      return {
        status: "ok",
        runId,
        factCount: facts.length,
        accepted: storedCount,
        omitted: omissions.length,
      };
    } catch (error) {
      const category = memoryErrorCategory(error);
      await pool.query(
        `UPDATE memory_run
         SET status = 'failed', observations_status = 'failed', error = $2, completed_at = now()
         WHERE run_id = $1`,
        [runId, category],
      ).catch(() => undefined);
      await recordMemoryOperation(pool, {
        kind: "observation_consolidation",
        outcome: "failed",
        runId,
        detail: `source=article category=${category}`,
        startedAt,
        finishedAt: new Date(),
      }).catch(() => undefined);
      return { status: "failed", category };
    }
  } finally {
    // Release the claim on every outcome. The delete is fenced by the exact
    // lease: a lease taken over after expiry is never deleted here.
    await releaseConsolidationClaim(pool, claim).catch(() => undefined);
  }
}

/** The consolidation model is the article behavior row's model. */
async function loadModel(pool: PostgresPool): Promise<string> {
  const result = await pool.query<{ model: string }>(
    `SELECT model FROM article_behavior WHERE id = 'behavior'`,
  );
  const model = result.rows[0]?.model;
  if (model === undefined || model.trim().length === 0) {
    throw new Error("article behavior model unavailable for consolidation");
  }
  return model;
}

/** The consolidation claim held while the phase runs. */
interface ConsolidationClaim {
  readonly owner: string;
  readonly leaseExpiresAt: Date;
}

/**
 * Take the single-flight consolidation claim: insert the row, or take an
 * EXPIRED lease over (crash recovery). A live lease held by another worker
 * returns false — the caller skips the phase instead of duplicating the
 * provider call and its artifacts.
 */
async function claimConsolidation(
  pool: PostgresPool,
  claim: ConsolidationClaim,
): Promise<boolean> {
  return withTransaction(pool, async (client) => {
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO article_observation_claim (id, owner, lease_expires_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (id) DO NOTHING
       RETURNING id`,
      [CLAIM_ID, claim.owner, claim.leaseExpiresAt],
    );
    if (inserted.rows[0] !== undefined) return true;
    const takenOver = await client.query<{ id: string }>(
      `UPDATE article_observation_claim
       SET owner = $2, lease_expires_at = $3, updated_at = now()
       WHERE id = $1 AND lease_expires_at < now()
       RETURNING id`,
      [CLAIM_ID, claim.owner, claim.leaseExpiresAt],
    );
    return takenOver.rows[0] !== undefined;
  });
}

/**
 * Release the claim. Fenced by the exact lease values so a claim that was
 * taken over after this lease expired is never deleted.
 */
async function releaseConsolidationClaim(
  pool: PostgresPool,
  claim: ConsolidationClaim,
): Promise<void> {
  await pool.query(
    `DELETE FROM article_observation_claim
     WHERE id = $1 AND owner = $2 AND lease_expires_at = $3`,
    [CLAIM_ID, claim.owner, claim.leaseExpiresAt],
  );
}

/**
 * Fencing: the artifact transaction only applies while the claim it runs
 * under is still the live one. A stalled worker whose lease expired and was
 * taken over must not write evidence after another worker already did.
 */
/**
 * Fence every artifact write against the exact lease the worker holds,
 * INSIDE the artifact transaction: the SELECT takes the claim row's lock
 * (FOR UPDATE), so a concurrent takeover's UPDATE waits until this
 * transaction commits or rolls back — check and writes are serialized, and
 * there is no window in which a lost claim still writes. The lease must
 * also still be LIVE (`lease_expires_at > now()`): an expired lease that
 * nobody has taken over yet is just as lost as one taken over, and its
 * writes must fail. The lock is held only inside the short artifact
 * transaction, never across the provider call.
 */
async function assertClaimHeld(
  client: import("@companion/postgres").PostgresPoolClient,
  claim: ConsolidationClaim,
): Promise<void> {
  const result = await client.query<{ id: string }>(
    `SELECT id FROM article_observation_claim
     WHERE id = $1 AND owner = $2 AND lease_expires_at = $3 AND lease_expires_at > now()
     FOR UPDATE`,
    [CLAIM_ID, claim.owner, claim.leaseExpiresAt],
  );
  if (result.rows[0] === undefined) throw new ConsolidationClaimLostError();
}

/** One artifact row and its evidence links, in one transaction. */
async function withTransactionArtifact(
  pool: PostgresPool,
  observation: ReturnType<typeof buildObservationDocument>["observation"],
  observationSetId: string,
  runId: string,
  claim: ConsolidationClaim,
): Promise<void> {
  await withTransactionImpl(pool, async (client) => {
    await assertClaimHeld(client, claim);
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO memory_observation
         (run_id, observation_set_id, observation_key, subject_id, kind, claim,
          condition, consequence, topics, support_count, distinct_turn_count,
          distinct_day_count, contradiction_count, first_observed_at, last_observed_at,
          evidence_strength, status, consolidation_version)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, 'active', $17)
       ON CONFLICT (run_id, observation_key) DO NOTHING
       RETURNING id`,
      [
        runId,
        observationSetId,
        observation.observationKey,
        observation.subject,
        observation.kind,
        observation.claim,
        observation.condition ?? null,
        observation.consequence ?? null,
        observation.topics,
        observation.supportCount,
        observation.distinctTurnCount,
        observation.distinctDayCount,
        observation.contradictionCount,
        observation.firstObservedAt,
        observation.lastObservedAt,
        observation.evidenceStrength,
        ARTICLE_INTEREST_CONSOLIDATION_PROMPT_VERSION,
      ],
    );
    let artifactId = inserted.rows[0]?.id;
    if (artifactId === undefined) {
      const existing = await client.query<{ id: string }>(
        `SELECT id FROM memory_observation WHERE run_id = $1 AND observation_key = $2`,
        [runId, observation.observationKey],
      );
      artifactId = existing.rows[0]?.id;
      if (artifactId === undefined) {
        throw new Error(
          `Artifact ${observation.observationKey} vanished during consolidation`,
        );
      }
    }
    const evidenceRows = [
      ...observation.sourceFactIds.map((factKey, index) => ({
        factKey,
        role: "support" as const,
        position: index,
      })),
      ...observation.contradictionFactIds.map((factKey, index) => ({
        factKey,
        role: "contradiction" as const,
        position: index,
      })),
    ];
    if (evidenceRows.length > 0) {
      await client.query(
        `INSERT INTO memory_observation_evidence (observation_id, fact_id, role, position)
         SELECT $1, f.id, i.role, i.position
         FROM unnest($2::text[], $3::text[], $4::int[]) AS i(fact_key, role, position)
         JOIN memory_fact f ON f.fact_key = i.fact_key
         ON CONFLICT (observation_id, fact_id, role) DO NOTHING`,
        [
          artifactId,
          evidenceRows.map((row) => row.factKey),
          evidenceRows.map((row) => row.role),
          evidenceRows.map((row) => row.position),
        ],
      );
    }
  });
}

/** One omission row and its evidence links, in one transaction. */
async function withTransactionOmission(
  pool: PostgresPool,
  observation: ReturnType<typeof buildObservationDocument>["observation"],
  reason: string,
  omissionId: string,
  observationSetId: string,
  runId: string,
  claim: ConsolidationClaim,
): Promise<void> {
  await withTransactionImpl(pool, async (client) => {
    await assertClaimHeld(client, claim);
    await client.query(
      `INSERT INTO memory_observation_omission
         (omission_id, run_id, observation_set_id, observation_key, subject_id, kind,
          claim, condition, consequence, topics, support_count, distinct_turn_count,
          distinct_day_count, contradiction_count, first_observed_at, last_observed_at,
          reason, policy_version)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
       ON CONFLICT (omission_id) DO NOTHING`,
      [
        omissionId,
        runId,
        observationSetId,
        observation.observationKey,
        observation.subject,
        observation.kind,
        observation.claim,
        observation.condition ?? null,
        observation.consequence ?? null,
        observation.topics,
        observation.supportCount,
        observation.distinctTurnCount,
        observation.distinctDayCount,
        observation.contradictionCount,
        observation.firstObservedAt,
        observation.lastObservedAt,
        reason,
        OBSERVATION_POLICY_VERSION,
      ],
    );
    const evidenceRows = [
      ...observation.sourceFactIds.map((factKey, position) => ({
        factKey,
        role: "support" as const,
        position,
      })),
      ...observation.contradictionFactIds.map((factKey, position) => ({
        factKey,
        role: "contradiction" as const,
        position,
      })),
    ];
    if (evidenceRows.length > 0) {
      await client.query(
        `INSERT INTO memory_observation_omission_evidence (omission_id, fact_id, role, position)
         SELECT o.id, f.id, i.role, i.position
         FROM memory_observation_omission o
         CROSS JOIN unnest($2::text[], $3::text[], $4::int[]) AS i(fact_key, role, position)
         JOIN memory_fact f ON f.fact_key = i.fact_key
         WHERE o.omission_id = $1
         ON CONFLICT (omission_id, fact_id, role) DO NOTHING`,
        [
          omissionId,
          evidenceRows.map((row) => row.factKey),
          evidenceRows.map((row) => row.role),
          evidenceRows.map((row) => row.position),
        ],
      );
    }
  });
}

/** Local transaction helper (keeps this module free of extra imports). */
async function withTransactionImpl<T>(
  pool: PostgresPool,
  task: (client: import("@companion/postgres").PostgresPoolClient) => Promise<T>,
): Promise<T> {
  const { withTransaction } = await import("@companion/postgres");
  return withTransaction(pool, task);
}
