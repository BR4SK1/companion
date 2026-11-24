/**
 * Scheduled consolidation: turns facts into observation candidates.
 *
 * Consolidation is intentionally conservative. It selects the newest
 * completed turns, loads their production facts (the ingest pipeline already
 * extracted them through the same per-turn cache, so no extra LLM calls are
 * needed for fact extraction), consolidates them into observation candidates
 * with one LLM call, applies the observation policy — accepted candidates
 * become artifacts, rejected candidates are recorded as omissions with their
 * reasons — and then hands the run to automatic promotion.
 *
 * Evidence counting uses behavioral days: a fact's observed day is its
 * behavioral day under the provisioned boundary (`memory_behavior`).
 */

import { withTransaction, type PostgresPool } from "@companion/postgres";

import type { MemoryConfig } from "./config.ts";
import type { MemoryLlmCaller } from "./llm.ts";
import { taskPresets } from "./llm.ts";
import { hashArtifact } from "./hashing.ts";
import { assertCompleteResponse } from "./extraction.ts";
import {
  buildObservationConsolidationPrompt,
  buildObservationConsolidationResponseFormat,
  factGenerationSignature,
  observationGenerationSignature,
  promptContentHash,
  observationKeyOf,
  OBSERVATION_CONSOLIDATION_PROMPT_VERSION,
  FACT_EXTRACTION_PROMPT_VERSION,
  renderFactInput,
  parseObservationConsolidationOutput,
  MemoryLlmOutputError,
} from "./prompts.ts";
import {
  evidenceStrength,
  evaluateObservationCandidate,
  OBSERVATION_POLICY_VERSION,
} from "./policy.ts";
import { selectLastCompletedTurns, sourceFingerprint } from "./source.ts";
import { getFactsByTurns, getIngestState, updateIngestState } from "./facts.ts";
import { areClaimsNearDuplicate } from "./recall.ts";
import { memoryErrorCategory, MemorySourceBudgetError } from "./errors.ts";
import { behavioralDay, type BehaviorTime } from "./time.ts";
import type {
  ConsolidationItem,
  MemoryFact,
  ObservationOmissionReason,
  SourceTurn,
} from "./types.ts";

const MAX_CLAIM_CHARS = 1_000;
const MAX_RELATION_CHARS = 500;
export const MAX_OBSERVATION_SOURCE_CHARS = 100_000;
const MAX_EXISTING_OBSERVATIONS_CHARS = 16_000;
const EXISTING_FACT_OVERLAP_THRESHOLD = 0.5;

export interface ExistingCanonicalReference {
  readonly observationKey: string;
  readonly subject: string;
  readonly kind: string;
  readonly claim: string;
  readonly sourceFactIds: readonly string[];
  readonly lastObservedAt: Date;
}

/**
 * Match a consolidated observation candidate to an already-active canonical
 * observation of the same `(subject, kind)` when either their claim text is a
 * near-duplicate or at least half of the candidate's supporting facts already
 * belong to that existing canonical observation. Reusing the existing
 * `observationKey` lets promotion revise the canonical row in place instead of
 * minting duplicate canonical identities on every consolidation window.
 */
export function matchExistingCanonicalObservationKey(
  candidate: {
    readonly subject: string;
    readonly kind: string;
    readonly claim: string;
    readonly sourceFactIds: readonly string[];
  },
  existing: readonly ExistingCanonicalReference[],
): string | null {
  const candidateFactSet = new Set(candidate.sourceFactIds);
  let bestKey: string | null = null;
  let bestScore = 0;

  for (const current of existing) {
    if (current.subject !== candidate.subject || current.kind !== candidate.kind) {
      continue;
    }
    let overlapCount = 0;
    for (const factKey of current.sourceFactIds) {
      if (candidateFactSet.has(factKey)) overlapCount += 1;
    }
    const overlapRatio =
      candidateFactSet.size > 0 ? overlapCount / candidateFactSet.size : 0;
    const textMatch = areClaimsNearDuplicate(candidate.claim, current.claim);
    if (!textMatch && overlapRatio < EXISTING_FACT_OVERLAP_THRESHOLD) {
      continue;
    }
    const matchScore = (textMatch ? 1 : 0) + overlapRatio;
    if (matchScore > bestScore) {
      bestScore = matchScore;
      bestKey = current.observationKey;
    }
  }
  return bestKey;
}

function renderExistingObservationsForPrompt(
  existing: readonly ExistingCanonicalReference[],
  maxChars: number = MAX_EXISTING_OBSERVATIONS_CHARS,
): string {
  if (existing.length === 0) return "";
  const lines: string[] = [];
  let used = 0;
  for (const obs of existing) {
    const line = `- [${obs.subject}/${obs.kind}] ${obs.claim.replace(/\s+/g, " ").trim()}`;
    const nextUsed = used === 0 ? line.length : used + 1 + line.length;
    if (nextUsed > maxChars) break;
    lines.push(line);
    used = nextUsed;
  }
  return lines.join("\n");
}

async function loadActiveCanonicalReferences(
  pool: PostgresPool,
  subjects: readonly string[],
): Promise<ExistingCanonicalReference[]> {
  if (subjects.length === 0) return [];
  const result = await pool.query<{
    observation_key: string;
    subject_id: string;
    kind: string;
    claim: string;
    source_fact_keys: string[];
    last_observed_at: Date;
  }>(
    `SELECT observation_key, subject_id, kind, claim, source_fact_keys, last_observed_at
     FROM memory_canonical_observation
     WHERE status = 'active' AND subject_id = ANY($1::text[])
     ORDER BY last_observed_at DESC, canonical_observation_id
     LIMIT 200`,
    [subjects],
  );
  return result.rows.map((row) => ({
    observationKey: row.observation_key,
    subject: row.subject_id,
    kind: row.kind,
    claim: row.claim,
    sourceFactIds: row.source_fact_keys,
    lastObservedAt: row.last_observed_at,
  }));
}

export interface FittedConsolidationWindow {
  readonly turns: SourceTurn[];
  readonly facts: MemoryFact[];
  readonly sourceChars: number;
  readonly trimmedTurns: number;
  readonly trimmedFacts: number;
}

function toPromptFact(fact: MemoryFact & { turnKey: string }) {
  return {
    id: factIdentifier(fact),
    subject: fact.subject,
    kind: fact.kind,
    claim: fact.claim,
    topics: fact.topics,
    condition: fact.condition ?? undefined,
    consequence: fact.consequence ?? undefined,
    observedAt: fact.observedAt,
    turnId: fact.turnKey,
  };
}

/**
 * Fit the newest contiguous suffix of completed turns into the consolidation
 * fact-count and source-character budgets.
 *
 * `turns` is oldest-first (as returned by `selectLastCompletedTurns`). When all
 * turns fit, they are returned unchanged. Otherwise oldest turns are dropped
 * until the remaining turns fit both `maxFacts` and `maxSourceChars`. If even
 * the newest turn with facts cannot fit on its own, throws
 * `MemorySourceBudgetError` instead of silently consolidating zero facts.
 */
export function fitTurnsToConsolidationBudget(
  turns: readonly SourceTurn[],
  facts: readonly MemoryFact[],
  budget: { readonly maxFacts: number; readonly maxSourceChars: number },
): FittedConsolidationWindow {
  const turnFacts = facts.filter(
    (fact): fact is MemoryFact & { turnKey: string } => fact.turnKey !== null,
  );
  if (turnFacts.length === 0) {
    return {
      turns: [...turns],
      facts: [],
      sourceChars: 0,
      trimmedTurns: 0,
      trimmedFacts: 0,
    };
  }

  const factsByTurn = new Map<string, Array<MemoryFact & { turnKey: string }>>();
  for (const fact of turnFacts) {
    const group = factsByTurn.get(fact.turnKey);
    if (group === undefined) {
      factsByTurn.set(fact.turnKey, [fact]);
    } else {
      group.push(fact);
    }
  }

  // `renderFactInput` joins each fact block with "\n\n", so the rendered
  // character length of any subset of facts is exact and order-invariant:
  // sum(blockLengths) + 2 * (count - 1).
  const selectedTurnsReversed: SourceTurn[] = [];
  let selectedFactCount = 0;
  let selectedChars = 0;

  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const turn = turns[i]!;
    const group = factsByTurn.get(turn.turnKey) ?? [];
    if (group.length === 0) {
      selectedTurnsReversed.push(turn);
      continue;
    }
    const nextFactCount = selectedFactCount + group.length;
    if (nextFactCount > budget.maxFacts) {
      break;
    }
    const groupRenderedLength = renderFactInput(group.map(toPromptFact)).length;
    const nextChars = selectedChars === 0
      ? groupRenderedLength
      : selectedChars + 2 + groupRenderedLength;
    if (nextChars > budget.maxSourceChars) {
      break;
    }
    selectedTurnsReversed.push(turn);
    selectedFactCount = nextFactCount;
    selectedChars = nextChars;
  }

  if (selectedFactCount === 0) {
    throw new MemorySourceBudgetError(
      `Newest turn with facts exceeds consolidation budget (maxFacts=${String(budget.maxFacts)}, maxSourceChars=${String(budget.maxSourceChars)})`,
    );
  }

  const selectedTurns = selectedTurnsReversed.reverse();
  const selectedTurnKeys = new Set(selectedTurns.map((turn) => turn.turnKey));
  const selectedFacts = turnFacts.filter((fact) => selectedTurnKeys.has(fact.turnKey));

  return {
    turns: selectedTurns,
    facts: selectedFacts,
    sourceChars: selectedChars,
    trimmedTurns: turns.length - selectedTurns.length,
    trimmedFacts: turnFacts.length - selectedFacts.length,
  };
}

export interface ConsolidationDeps {
  readonly pool: PostgresPool;
  readonly config: MemoryConfig;
  readonly subjects: readonly string[];
  readonly systemPrompt: string;
  /** Content hash of the fact-extraction prompt that produced the facts this
   *  run reads (the fact-set artifact identity binds to it). */
  readonly factExtractionPromptContentHash: string;
  readonly callLlm: MemoryLlmCaller;
  /** The behavioral-day boundary (provisioned configuration). */
  readonly behavior: BehaviorTime;
  readonly log?: (message: string) => void;
}

export interface ConsolidationRunResult {
  readonly runId: string;
  readonly selectedTurnCount: number;
  readonly factCount: number;
  readonly observations: number;
  readonly omissions: number;
  readonly llmCalls: number;
}

interface RunRow {
  run_id: string;
  status: string;
  facts_status: string;
  observations_status: string;
  source_fingerprint: string;
  fact_set_id: string;
  observation_set_id: string;
  fact_generation_signature: string;
  observation_generation_signature: string;
  max_turns: number;
  observation_count: number | null;
}

export async function getMemoryRun(
  pool: PostgresPool,
  runId: string,
): Promise<RunRow | null> {
  const result = await pool.query<RunRow>(
    `SELECT run_id, status, facts_status, observations_status, source_fingerprint,
            fact_set_id, observation_set_id, fact_generation_signature,
            observation_generation_signature, max_turns, observation_count
     FROM memory_run WHERE run_id = $1`,
    [runId],
  );
  return result.rows[0] ?? null;
}

async function getRunTurnIds(pool: PostgresPool, runId: string): Promise<string[]> {
  const result = await pool.query<{ turn_id: string }>(
    `SELECT turn_id FROM memory_run_turn WHERE run_id = $1 ORDER BY position`,
    [runId],
  );
  return result.rows.map((row) => row.turn_id);
}

export async function countObservationsByRun(
  pool: PostgresPool,
  runId: string,
): Promise<number> {
  const result = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM memory_observation WHERE run_id = $1`,
    [runId],
  );
  return Number(result.rows[0]?.n ?? 0);
}

function factIdentifier(fact: MemoryFact): string {
  return fact.factKey;
}

function normalizeText(value: string, maxChars: number): string {
  return value.replace(/\s+/g, " ").trim().slice(0, maxChars);
}

function normalizeOptionalText(value: string, maxChars: number): string | undefined {
  if (!value) return undefined;
  const normalized = normalizeText(value, maxChars);
  return normalized || undefined;
}

/**
 * Build one observation document (the accepted-artifact shape) from a
 * consolidation item and its resolved facts. Source-aware: turn breadth is
 * counted over the support facts' non-null turn keys only, so an
 * article-sourced observation honestly records zero turn evidence (its
 * breadth is distinct independent reactions, validated at promotion time).
 */
export function buildObservationDocument(
  item: ConsolidationItem,
  factsById: ReadonlyMap<string, MemoryFact>,
  run: { runId: string; observationSetId: string; factSetId: string; consolidationVersion: string },
  behavior: BehaviorTime,
): {
  observation: {
    observationKey: string;
    subject: string;
    kind: ConsolidationItem["kind"];
    claim: string;
    condition: string | undefined;
    consequence: string | undefined;
    topics: string[];
    supportCount: number;
    distinctTurnCount: number;
    distinctDayCount: number;
    contradictionCount: number;
    firstObservedAt: Date;
    lastObservedAt: Date;
    sourceFactIds: string[];
    contradictionFactIds: string[];
    evidenceStrength: string;
  };
} {
  const supportIds = [...new Set(item.sourceFactIds)];
  const contradictionIds = [...new Set(item.contradictionFactIds ?? [])];
  const allIds = [...supportIds, ...contradictionIds];
  const allFacts = allIds.map((id) => factsById.get(id));
  if (allFacts.some((fact) => fact === undefined)) {
    throw new MemoryLlmOutputError("Observation referenced an unknown fact");
  }
  const supportFacts = supportIds.map((id) => factsById.get(id)!);
  const claim = normalizeText(item.claim, MAX_CLAIM_CHARS);
  if (!claim) {
    throw new MemoryLlmOutputError("Observation claim was empty after normalization");
  }
  const condition = item.condition !== undefined
    ? normalizeOptionalText(item.condition, MAX_RELATION_CHARS)
    : undefined;
  const consequence = item.consequence !== undefined
    ? normalizeOptionalText(item.consequence, MAX_RELATION_CHARS)
    : undefined;
  const observationKey = observationKeyOf({
    subject: item.subject,
    kind: item.kind,
    claim,
    condition,
    consequence,
  });
  const observedTimes = allFacts.map((fact) => (fact as MemoryFact).observedAt.getTime());
  return {
    observation: {
      observationKey,
      subject: item.subject,
      kind: item.kind,
      claim,
      condition,
      consequence,
      topics: [...item.topics],
      supportCount: supportIds.length,
      distinctTurnCount: new Set(
        supportFacts
          .map((fact) => fact.turnKey)
          .filter((turnKey): turnKey is string => turnKey !== null),
      ).size,
      distinctDayCount: new Set(supportFacts.map((fact) => behavioralDay(fact.observedAt, behavior))).size,
      contradictionCount: contradictionIds.length,
      firstObservedAt: new Date(Math.min(...observedTimes)),
      lastObservedAt: new Date(Math.max(...observedTimes)),
      sourceFactIds: supportIds,
      contradictionFactIds: contradictionIds,
      evidenceStrength: evidenceStrength(item, supportFacts, behavior),
    },
  };
}

/** Distinct behavioral days among the support facts' observed times. */
export function distinctSupportDayCount(
  dates: ReadonlyArray<{ observedAt: Date }>,
  behavior: BehaviorTime,
): number {
  const days = new Set<string>();
  for (const fact of dates) {
    days.add(behavioralDay(fact.observedAt, behavior));
  }
  return days.size;
}

export async function runScheduledConsolidation(
  deps: ConsolidationDeps,
  now: Date = new Date(),
): Promise<ConsolidationRunResult> {
  const { pool, config } = deps;
  const runId = `auto-${now.getTime()}`;
  const log = deps.log ?? ((message: string) => console.log(message));

  const factSignature = factSignatureFor(config, deps.factExtractionPromptContentHash);
  const observationSignature = observationGenerationSignature(
    OBSERVATION_CONSOLIDATION_PROMPT_VERSION,
    {
      model: config.model,
      taskMaxTokens: config.observationMaxOutputTokens,
      taskTemperature: 0.1,
      maxFacts: config.observationMaxFacts,
      maxSourceChars: MAX_OBSERVATION_SOURCE_CHARS,
      promptContentHash: promptContentHash(deps.systemPrompt),
    },
  );

  const stateBefore = await getIngestState(pool);
  const countedBefore = stateBefore?.newFactsSinceConsolidation ?? 0;

  const rawTurns = await selectLastCompletedTurns(pool, config.observationMaxTurns);
  if (rawTurns.length === 0) {
    throw new Error("No completed turns matched the bounded selector");
  }
  // Load production facts before persisting the run so the recorded turn list,
  // source fingerprint, and artifact identities match the exact fitted window.
  const rawFacts = await getFactsByTurns(pool, rawTurns.map((turn) => turn.turnId));
  const fitted = fitTurnsToConsolidationBudget(rawTurns, rawFacts, {
    maxFacts: config.observationMaxFacts,
    maxSourceChars: MAX_OBSERVATION_SOURCE_CHARS,
  });
  if (fitted.trimmedTurns > 0) {
    log(
      `[MEMORY] consolidation window trimmed to fit budget: turns=${String(fitted.turns.length)}/${String(rawTurns.length)} facts=${String(fitted.facts.length)}/${String(rawFacts.length)} chars=${String(fitted.sourceChars)}/${String(MAX_OBSERVATION_SOURCE_CHARS)}`,
    );
  }
  const turns = fitted.turns;
  const facts = fitted.facts;

  const sourceHash = sourceFingerprint(turns);
  const factSetId = hashArtifact("fact-set", sourceHash, factSignature, "cacheable");
  const observationSetId = hashArtifact(
    "observation-set",
    factSetId,
    observationSignature,
    "cacheable",
  );
  const consolidationVersion = OBSERVATION_CONSOLIDATION_PROMPT_VERSION;

  await pool.query(
    `INSERT INTO memory_run
       (run_id, status, facts_status, observations_status, max_turns,
        source_fingerprint, fact_set_id, observation_set_id,
        fact_generation_signature, observation_generation_signature)
     VALUES ($1, 'planned', 'complete', 'pending', $2, $3, $4, $5, $6, $7)`,
    [
      runId,
      turns.length,
      sourceHash,
      factSetId,
      observationSetId,
      factSignature,
      observationSignature,
    ],
  );
  await pool.query(
    `INSERT INTO memory_run_turn (run_id, position, turn_id)
     SELECT $1, i.ord - 1, i.turn_id
     FROM unnest($2::uuid[]) WITH ORDINALITY AS i(turn_id, ord)`,
    [runId, turns.map((turn) => turn.turnId)],
  );

  try {
    await pool.query(
      `UPDATE memory_run SET status = 'facts-ready', fact_count = $2 WHERE run_id = $1`,
      [runId, facts.length],
    );

    const observations = await consolidateObservations(deps, {
      runId,
      observationSetId,
      factSetId,
      consolidationVersion,
      observationSignature,
      turns,
      facts,
    });

    // Consume exactly the facts counted when this run started (relative
    // subtract, so facts written by a concurrent ingest stay counted), and
    // stamp the interval only after the run's artifacts are durable. Pending
    // promotion recovery does not depend on this counter: completed runs are
    // reconciled by promotion id.
    await updateIngestState(pool, {
      lastConsolidatedAt: now,
      consumeFacts: countedBefore,
    });
    log(
      `scheduled consolidation ${runId} complete: ${facts.length} fact(s), ${observations} observation artifact(s)`,
    );
    return {
      runId,
      selectedTurnCount: turns.length,
      factCount: facts.length,
      observations,
      omissions: await countOmissions(pool, runId),
      llmCalls: 1,
    };
  } catch (error) {
    await pool.query(
      `UPDATE memory_run
       SET status = 'failed',
           facts_status = CASE WHEN facts_status = 'complete' THEN 'complete' ELSE 'failed' END,
           observations_status = 'failed',
           error = $2
       WHERE run_id = $1`,
      // Durable metadata: a fixed category, never error text (error messages
      // can carry model-derived content).
      [runId, memoryErrorCategory(error)],
    ).catch(() => undefined);
    throw error;
  }
}

function factSignatureFor(config: MemoryConfig, promptContentHashValue: string): string {
  return factGenerationSignature(FACT_EXTRACTION_PROMPT_VERSION, {
    model: config.model,
    providerBaseUrl: config.openrouterBaseUrl,
    taskMaxTokens: 8000,
    taskTemperature: 0.1,
    batchTurns: config.factBatchTurns,
    batchMaxChars: config.factBatchMaxChars,
    promptContentHash: promptContentHashValue,
  });
}

async function consolidateObservations(
  deps: ConsolidationDeps,
  input: {
    runId: string;
    observationSetId: string;
    factSetId: string;
    consolidationVersion: string;
    observationSignature: string;
    turns: readonly SourceTurn[];
    facts: readonly MemoryFact[];
  },
): Promise<number> {
  const { pool } = deps;
  const facts = input.facts;
  // Artifacts are per-run and immutable: observation_set_id is a stable
  // logical identity shared across runs over the same source window, so a
  // re-run must never delete another run's artifacts or evidence (that would
  // erase the provenance promotion items and canonical history point at).
  // Each run's artifacts are keyed UNIQUE (run_id, observation_key) and
  // inserted idempotently; failed runs leave their partial artifacts in place.

  if (facts.length === 0) {
    await pool.query(
      `UPDATE memory_run
       SET status = 'observations-ready', observations_status = 'complete',
           observation_count = 0, observation_candidate_count = 0,
           observation_accepted_count = 0, observation_omitted_count = 0,
           completed_at = now()
       WHERE run_id = $1`,
      [input.runId],
    );
    return 0;
  }
  if (facts.length > deps.config.observationMaxFacts) {
    throw new MemorySourceBudgetError(
      `Fact set contains ${facts.length} facts; reduce the bounded selector (limit ${deps.config.observationMaxFacts})`,
    );
  }

  // Turn-sourced facts only: observation consolidation builds evidence from
  // conversation turns; article-sourced facts (turnKey null) carry their
  // provenance in the reaction link and never feed turn consolidation.
  const turnFacts = facts.filter(
    (fact): fact is MemoryFact & { turnKey: string } => fact.turnKey !== null,
  );
  const factsForPrompt = turnFacts.map(toPromptFact);
  const source = renderFactInput(factsForPrompt);
  if (source.length > MAX_OBSERVATION_SOURCE_CHARS) {
    throw new MemorySourceBudgetError(
      `Observation source is ${source.length} characters; reduce the bounded selector (limit ${MAX_OBSERVATION_SOURCE_CHARS})`,
    );
  }
  const existingCanonical = await loadActiveCanonicalReferences(pool, deps.subjects);
  const existingSummary = renderExistingObservationsForPrompt(existingCanonical);
  const prompt = buildObservationConsolidationPrompt(
    deps.systemPrompt,
    source,
    existingSummary || undefined,
  );
  const result = await deps.callLlm({
    systemPrompt: prompt.systemPrompt,
    userMessage: prompt.messages[0]!.content,
    taskPreset: taskPresets(deps.config).memoryObservationConsolidation,
    responseFormat:
      buildObservationConsolidationResponseFormat(deps.subjects) as Record<string, unknown>,
  });
  assertCompleteResponse(result.finishReason, "Memory observation consolidation");

  const output = parseObservationConsolidationOutput(result.text, deps.subjects);
  const factsById = new Map(facts.map((fact) => [factIdentifier(fact), fact]));
  const observationCandidates = output.observations.map((item) => {
    const allIds = [...item.sourceFactIds, ...(item.contradictionFactIds ?? [])];
    if (new Set(allIds).size !== allIds.length) {
      throw new MemoryLlmOutputError(
        "Observation reused a fact as both support and contradiction",
      );
    }
    for (const id of allIds) {
      if (!factsById.has(id)) {
        throw new MemoryLlmOutputError(
          "Observation referenced an unknown fact id",
        );
      }
    }
    return buildObservationDocument(item, factsById, {
      runId: input.runId,
      observationSetId: input.observationSetId,
      factSetId: input.factSetId,
      consolidationVersion: input.consolidationVersion,
    }, deps.behavior).observation;
  });

  // Policy filter: accepted candidates become artifacts; rejected candidates
  // are recorded as omissions with their reasons.
  const omissionReasonCounts = new Map<ObservationOmissionReason, number>();
  const accepted: ReturnType<typeof buildObservationDocument>["observation"][] = [];
  const omissions: Array<{
    observation: ReturnType<typeof buildObservationDocument>["observation"];
    reason: ObservationOmissionReason;
  }> = [];
  for (const observation of observationCandidates) {
    const decision = evaluateObservationCandidate(
      {
        subject: observation.subject,
        kind: observation.kind,
        claim: observation.claim,
        topics: observation.topics,
        ...(observation.condition !== undefined ? { condition: observation.condition } : {}),
        ...(observation.consequence !== undefined
          ? { consequence: observation.consequence }
          : {}),
        sourceFactIds: observation.sourceFactIds,
        contradictionFactIds: observation.contradictionFactIds,
      },
      factsById,
    );
    if (decision.eligible) {
      accepted.push(observation);
      continue;
    }
    if (decision.reason !== undefined) {
      omissionReasonCounts.set(
        decision.reason,
        (omissionReasonCounts.get(decision.reason) ?? 0) + 1,
      );
      omissions.push({ observation, reason: decision.reason });
    }
  }

  // Reconcile accepted observations against already-active canonical
  // observations so reworded summaries of the same memory revise in place
  // instead of creating duplicate canonical rows. When multiple candidates in
  // one run map to the same canonical identity, retain the stronger/more
  // supported artifact so promotion never sees duplicate identities.
  const deduplicatedByKey = new Map<
    string,
    ReturnType<typeof buildObservationDocument>["observation"]
  >();
  for (const observation of accepted) {
    const matchedKey = matchExistingCanonicalObservationKey(observation, existingCanonical);
    const resolved = matchedKey !== null
      ? { ...observation, observationKey: matchedKey }
      : observation;
    const prior = deduplicatedByKey.get(resolved.observationKey);
    if (
      prior === undefined ||
      resolved.supportCount > prior.supportCount ||
      (resolved.supportCount === prior.supportCount &&
        resolved.lastObservedAt.getTime() > prior.lastObservedAt.getTime())
    ) {
      deduplicatedByKey.set(resolved.observationKey, resolved);
    }
  }
  const uniqueObservations = [...deduplicatedByKey.values()];

  for (const observation of uniqueObservations) {
    // One transaction per artifact: the artifact row and its evidence links
    // commit together, so a crash can never leave an artifact without its
    // provenance (and a retried run heals idempotently instead of skipping).
    await withTransaction(pool, async (client) => {
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
          input.runId,
          input.observationSetId,
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
          input.consolidationVersion,
        ],
      );
      let artifactId = inserted.rows[0]?.id;
      if (artifactId === undefined) {
        const existing = await client.query<{ id: string }>(
          `SELECT id FROM memory_observation WHERE run_id = $1 AND observation_key = $2`,
          [input.runId, observation.observationKey],
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
            evidenceRows.map((row2) => row2.factKey),
            evidenceRows.map((row2) => row2.role),
            evidenceRows.map((row2) => row2.position),
          ],
        );
      }
    });
  }

  for (const [index, omission] of omissions.entries()) {
    const omissionId = hashArtifact(
      "observation-omission",
      input.runId,
      String(index),
      omission.observation.observationKey,
    );
    // Omission row and its evidence links commit together: aggregate
    // provenance (which facts supported or contradicted the rejected
    // candidate) is never missing while the omission row exists.
    const evidenceRows = [
      ...omission.observation.sourceFactIds.map((factKey, position) => ({
        factKey,
        role: "support" as const,
        position,
      })),
      ...omission.observation.contradictionFactIds.map((factKey, position) => ({
        factKey,
        role: "contradiction" as const,
        position,
      })),
    ];
    await withTransaction(pool, async (client) => {
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
          input.runId,
          input.observationSetId,
          omission.observation.observationKey,
          omission.observation.subject,
          omission.observation.kind,
          omission.observation.claim,
          omission.observation.condition ?? null,
          omission.observation.consequence ?? null,
          omission.observation.topics,
          omission.observation.supportCount,
          omission.observation.distinctTurnCount,
          omission.observation.distinctDayCount,
          omission.observation.contradictionCount,
          omission.observation.firstObservedAt,
          omission.observation.lastObservedAt,
          omission.reason,
          OBSERVATION_POLICY_VERSION,
        ],
      );
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

  const storedCount = await countObservationsByRun(pool, input.runId);
  await pool.query(
    `UPDATE memory_run
     SET status = 'observations-ready', observations_status = 'complete',
         observation_count = $2,
         observation_llm_calls = 1,
         observation_candidate_count = $3,
         observation_accepted_count = $4,
         observation_omitted_count = $5,
         completed_at = now()
     WHERE run_id = $1`,
    [
      input.runId,
      storedCount,
      observationCandidates.length,
      storedCount,
      omissions.length,
    ],
  );
  return storedCount;
}

async function countOmissions(pool: PostgresPool, runId: string): Promise<number> {
  const result = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM memory_observation_omission WHERE run_id = $1`,
    [runId],
  );
  return Number(result.rows[0]?.n ?? 0);
}
