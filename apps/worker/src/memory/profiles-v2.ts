/**
 * Observation profiles (v2): subject sheets distilled from canonical
 * observations.
 *
 * The substrate is the reviewed canonical observation set only: facts churn
 * with every turn, promotions are the deliberate quality gate, so profiles
 * regenerate only when that gate moves. The fingerprint covers exactly what
 * the profile was built from (observation id, revision, status, content hash,
 * evidence strength) plus the profile prompt version — unchanged inputs cost
 * one indexed read and zero LLM calls, and the served sheet is byte-identical.
 *
 * The system prompt is persona-bearing configuration from the `memory_prompt`
 * table (kind `observation_profile`); it is never code content.
 */

import { createHash } from "node:crypto";
import { withTransaction, type PostgresPool } from "@companion/postgres";

import type { MemoryConfig } from "./config.ts";

/** Anything that can execute a query: the pool or one transaction client. */
type SqlExecutor = PostgresPool | import("@companion/postgres").PostgresPoolClient;
import { taskPresets, type MemoryLlmCaller } from "./llm.ts";
import { promptContentHash } from "./prompts.ts";
import {
  buildObservationProfilePrompt,
  buildObservationProfileResponseFormat,
  MEMORY_PROFILE_PROMPT_VERSION,
  parseProfileV2Output,
} from "./prompts.ts";
import type { ObservationProfile, ProfileSourceObservation } from "./types.ts";

const MAX_SOURCE_OBSERVATIONS = 400;
const MAX_SOURCE_CHARS = 24_000;

export interface ProfileV2Deps {
  readonly pool: PostgresPool;
  readonly config: MemoryConfig;
  readonly systemPrompt: string;
  readonly callLlm: MemoryLlmCaller;
}

export interface ProfileGenerateSummary {
  readonly subject: string;
  readonly fingerprint: string;
  readonly content: string | null;
  readonly claims: ReadonlyArray<{ observationId: string; text: string }>;
  readonly regenerated: boolean;
  readonly skippedReason?: "unchanged" | "no-source" | "stale-at-save";
  readonly sourceCount: number;
}

/** Active canonical observations for one subject, newest first, bounded. */
export async function loadProfileObservations(
  executor: SqlExecutor,
  subjectId: string,
): Promise<ProfileSourceObservation[]> {
  const result = await executor.query<{
    canonical_observation_id: string;
    revision: number;
    status: string;
    content_hash: string;
    subject_id: string;
    kind: string;
    claim: string;
    condition: string | null;
    consequence: string | null;
    topics: string[];
    evidence_strength: string;
    distinct_day_count: number;
    last_observed_at: Date;
  }>(
    `SELECT canonical_observation_id, revision, status, content_hash,
            subject_id, kind, claim, condition, consequence, topics,
            evidence_strength, distinct_day_count, last_observed_at
     FROM memory_canonical_observation
     WHERE status = 'active' AND subject_id = $1
     ORDER BY last_observed_at DESC
     LIMIT $2`,
    [subjectId, MAX_SOURCE_OBSERVATIONS],
  );
  return result.rows.map((row) => ({
    observationId: row.canonical_observation_id,
    revision: row.revision,
    status: row.status,
    contentHash: row.content_hash,
    subject: row.subject_id,
    kind: row.kind,
    claim: row.claim,
    ...(row.condition !== null ? { condition: row.condition } : {}),
    ...(row.consequence !== null ? { consequence: row.consequence } : {}),
    topics: row.topics,
    evidenceStrength: row.evidence_strength,
    distinctDayCount: row.distinct_day_count,
    lastObservedAt: row.last_observed_at.toISOString(),
  }));
}

/**
 * Fingerprint over exactly what the profile was built from. Unchanged inputs
 * mean an unchanged fingerprint: no LLM call and a byte-identical served
 * profile.
 */
export function computeProfileFingerprint(
  promptVersion: string,
  observations: ReadonlyArray<{
    observationId: string;
    revision: number;
    status: string;
    contentHash: string;
    evidenceStrength: string;
  }>,
  promptContentHashValue: string,
  /** Generation-affecting configuration: two inputs that change what the
   *  model produces even with identical sources and prompt text. A change to
   *  either invalidates the cached profile and forces regeneration. */
  generation: { readonly model: string; readonly maxOutputTokens: number },
): string {
  const digest = observations
    .map((observation) =>
      [
        observation.observationId,
        String(observation.revision),
        observation.status,
        observation.contentHash,
        observation.evidenceStrength,
      ].join(":"),
    )
    .sort()
    .join("|");
  return createHash("sha256")
    .update(JSON.stringify({
      promptVersion,
      promptContentHash: promptContentHashValue,
      model: generation.model,
      maxOutputTokens: generation.maxOutputTokens,
      digest,
    }))
    .digest("hex")
    .slice(0, 32);
}

/**
 * Compact JSON source material. Claims stay verbatim so the generator can
 * restate them without drift.
 */
export function renderProfileSource(
  observations: readonly ProfileSourceObservation[],
): string {
  return JSON.stringify(
    observations.map((observation) => ({
      id: observation.observationId,
      kind: observation.kind,
      claim: observation.claim,
      ...(observation.condition !== undefined
        ? { condition: observation.condition }
        : {}),
      ...(observation.consequence !== undefined
        ? { consequence: observation.consequence }
        : {}),
      topics: observation.topics,
      evidenceStrength: observation.evidenceStrength,
      distinctDayCount: observation.distinctDayCount,
    })),
  );
}

interface ProfileRow {
  subject_id: string;
  fingerprint: string;
  prompt_version: string;
  prompt_content_hash: string;
  content: string;
  source_count: number;
  model: string | null;
  generated_at: Date | null;
}

/**
 * What the serving configuration expects of a profile document. When passed
 * to `getProfileDocument`, the document is suppressed unless it was generated
 * under exactly this prompt version, prompt content, and model — so a DB edit
 * of the same-version prompt row, or a changed generation model, never serves
 * prose produced under the old settings (the next profile pass regenerates).
 */
export interface ProfileServeExpectation {
  readonly promptVersion: string;
  readonly promptContentHash: string;
  readonly model: string;
}

export async function getProfileDocument(
  pool: PostgresPool,
  subjectId: string,
  expected?: ProfileServeExpectation,
): Promise<ObservationProfile | null> {
  const result = await pool.query<ProfileRow>(
    `SELECT subject_id, fingerprint, prompt_version, prompt_content_hash,
            content, source_count, model, generated_at
     FROM memory_observation_profile WHERE subject_id = $1`,
    [subjectId],
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  // Serve-time generation-settings gate (where practical, without
  // recomputing the observation fingerprint): the stored document must have
  // been generated under the currently configured prompt version, prompt
  // content, and model. A cleared profile (model null, empty content) has no
  // generated prose to invalidate and still serves as "no profile".
  if (
    expected !== undefined &&
    (row.prompt_version !== expected.promptVersion ||
      row.prompt_content_hash !== expected.promptContentHash ||
      (row.model !== null && row.model !== expected.model))
  ) {
    return null;
  }
  const claims = await pool.query<{ observation_id: string; claim_text: string }>(
    `SELECT observation_id, claim_text
     FROM memory_observation_profile_claim
     WHERE subject_id = $1 ORDER BY position`,
    [subjectId],
  );
  // Serve-time staleness gate over the FULL generation input set
  // (`memory_observation_profile_source`), not only the claims the model
  // happened to emit: the prose can reflect any input observation, so a
  // concurrent retraction — or a revision that changed an input's content —
  // must suppress the whole document (the next profile pass regenerates it
  // from the current active set).
  const sources = await pool.query<{
    observation_id: string;
    content_hash: string;
    revision: number;
    status: string;
    current_content_hash: string | null;
    current_revision: number | null;
  }>(
    `SELECT s.observation_id, s.content_hash, s.revision,
            c.status, c.content_hash AS current_content_hash, c.revision AS current_revision
     FROM memory_observation_profile_source s
     LEFT JOIN memory_canonical_observation c
       ON c.canonical_observation_id = s.observation_id
     WHERE s.subject_id = $1`,
    [subjectId],
  );
  const stale = sources.rows.some(
    (source) =>
      source.status !== "active" ||
      source.current_content_hash === null ||
      source.current_revision === null ||
      source.current_content_hash !== source.content_hash ||
      source.current_revision !== source.revision,
  );
  if (stale) return null;
  if (claims.rows.length > 0) {
    // Defense in depth for rows written before the source table existed:
    // every claimed observation must still be an active canonical row.
    const claimed = await pool.query<{ canonical_observation_id: string; status: string }>(
      `SELECT canonical_observation_id, status
       FROM memory_canonical_observation
       WHERE canonical_observation_id = ANY($1::text[])`,
      [claims.rows.map((claim) => claim.observation_id)],
    );
    const statusById = new Map(
      claimed.rows.map((source) => [source.canonical_observation_id, source.status]),
    );
    if (claims.rows.some((claim) => statusById.get(claim.observation_id) !== "active")) {
      return null;
    }
  }
  return {
    subject: row.subject_id,
    fingerprint: row.fingerprint,
    promptVersion: row.prompt_version,
    content: row.content,
    claims: claims.rows.map((claim) => ({
      observationId: claim.observation_id,
      text: claim.claim_text,
    })),
    sourceCount: row.source_count,
    model: row.model,
    generatedAt: row.generated_at,
  };
}

/**
 * The generation-affecting configuration for profile synthesis. Part of the
 * generation fingerprint: changing the model or the output cap invalidates
 * cached profiles.
 */
function profileGeneration(config: MemoryConfig): {
  readonly model: string;
  readonly maxOutputTokens: number;
} {
  return { model: config.model, maxOutputTokens: config.profileMaxOutputTokens };
}

async function upsertProfile(
  pool: PostgresPool,
  fields: {
    subjectId: string;
    fingerprint: string;
    promptContentHash: string;
    content: string;
    claims: ReadonlyArray<{ observationId: string; text: string }>;
    /** The FULL generation input set: every observation rendered into the
     *  prompt, each with the revision and content hash at generation time. */
    sources: ReadonlyArray<{
      observationId: string;
      revision: number;
      contentHash: string;
    }>;
    /** Generation-affecting configuration at generation time (fingerprint). */
    generation: { readonly model: string; readonly maxOutputTokens: number };
    sourceCount: number;
    model: string | null;
  },
): Promise<"saved" | "stale"> {
  const now = new Date();
  const wasGenerated = fields.sourceCount > 0;
  // One transaction, with a save-time recheck: the LLM call above took time,
  // and a retraction can commit in that window. The profile is only written
  // when the observation set it was generated from still matches the current
  // active set (same fingerprint); otherwise the write is skipped so a
  // concurrent generation can never restore prose citing retracted sources.
  return withTransaction(pool, async (client) => {
    const fresh = await loadProfileObservations(client, fields.subjectId);
    const freshFingerprint = computeProfileFingerprint(
      MEMORY_PROFILE_PROMPT_VERSION,
      fresh,
      fields.promptContentHash,
      fields.generation,
    );
    if (freshFingerprint !== fields.fingerprint) return "stale" as const;
    await client.query(
      `INSERT INTO memory_observation_profile
         (subject_id, fingerprint, prompt_version, prompt_content_hash, content,
          source_count, model, generated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (subject_id) DO UPDATE SET
         fingerprint = EXCLUDED.fingerprint,
         prompt_version = EXCLUDED.prompt_version,
         prompt_content_hash = EXCLUDED.prompt_content_hash,
         content = EXCLUDED.content,
         source_count = EXCLUDED.source_count,
         model = EXCLUDED.model,
         ${wasGenerated ? "generated_at = EXCLUDED.generated_at," : ""}
         updated_at = now()`,
      [
        fields.subjectId,
        fields.fingerprint,
        MEMORY_PROFILE_PROMPT_VERSION,
        fields.promptContentHash,
        fields.content,
        fields.sourceCount,
        fields.model,
        wasGenerated ? now : null,
      ],
    );
    await client.query(
      `DELETE FROM memory_observation_profile_claim WHERE subject_id = $1`,
      [fields.subjectId],
    );
    if (fields.claims.length > 0) {
      await client.query(
        `INSERT INTO memory_observation_profile_claim (subject_id, position, observation_id, claim_text)
         SELECT $1::text, i.ord - 1, i.observation_id, i.claim_text
         FROM unnest($2::text[], $3::text[]) WITH ORDINALITY AS i(observation_id, claim_text, ord)`,
        [fields.subjectId, fields.claims.map((claim) => claim.observationId), fields.claims.map((claim) => claim.text)],
      );
    }
    // Persist the FULL input dependency set in the same transaction: the
    // serve-time gate checks every source, so a concurrent retraction or
    // content revision of any input observation suppresses the document.
    await client.query(
      `DELETE FROM memory_observation_profile_source WHERE subject_id = $1`,
      [fields.subjectId],
    );
    if (fields.sources.length > 0) {
      await client.query(
        `INSERT INTO memory_observation_profile_source
           (subject_id, position, observation_id, content_hash, revision)
         SELECT $1::text, i.ord - 1, i.observation_id, i.content_hash, i.revision
         FROM unnest($2::text[], $3::text[], $4::int[]) WITH ORDINALITY
           AS i(observation_id, content_hash, revision, ord)`,
        [
          fields.subjectId,
          fields.sources.map((source) => source.observationId),
          fields.sources.map((source) => source.contentHash),
          fields.sources.map((source) => source.revision),
        ],
      );
    }
    return "saved" as const;
  });
}

/**
 * Regenerate one subject's profile when its observation-set fingerprint has
 * changed. Unchanged sets cost one indexed read and zero LLM calls; empty
 * observation sets clear stale prose instead of calling the LLM.
 */
export async function generateProfileIfNeeded(
  deps: ProfileV2Deps,
  subjectId: string,
): Promise<ProfileGenerateSummary> {
  const observations = await loadProfileObservations(deps.pool, subjectId);
  const currentFingerprint = computeProfileFingerprint(
    MEMORY_PROFILE_PROMPT_VERSION,
    observations,
    promptContentHash(deps.systemPrompt),
    profileGeneration(deps.config),
  );
  const existing = await getProfileDocument(deps.pool, subjectId);
  if (existing !== null && existing.fingerprint === currentFingerprint) {
    return {
      subject: subjectId,
      fingerprint: currentFingerprint,
      content: existing.content,
      claims: existing.claims,
      regenerated: false,
      skippedReason: "unchanged",
      sourceCount: observations.length,
    };
  }
  if (observations.length === 0) {
    const cleared = await upsertProfile(deps.pool, {
      subjectId,
      fingerprint: currentFingerprint,
      promptContentHash: promptContentHash(deps.systemPrompt),
      content: "",
      claims: [],
      sources: [],
      generation: profileGeneration(deps.config),
      sourceCount: 0,
      model: null,
    });
    if (cleared === "stale") {
      return {
        subject: subjectId,
        fingerprint: currentFingerprint,
        content: null,
        claims: [],
        regenerated: false,
        skippedReason: "stale-at-save",
        sourceCount: 0,
      };
    }
    return {
      subject: subjectId,
      fingerprint: currentFingerprint,
      content: null,
      claims: [],
      regenerated: true,
      skippedReason: "no-source",
      sourceCount: 0,
    };
  }
  const source = renderProfileSource(observations);
  if (source.length > deps.config.profileMaxSourceChars) {
    throw new Error(
      `Profile source for ${subjectId} is ${String(source.length)} characters (limit ${String(deps.config.profileMaxSourceChars)})`,
    );
  }
  const prompt = buildObservationProfilePrompt(
    deps.systemPrompt,
    observations.map((observation) => ({
      observationId: observation.observationId,
      kind: observation.kind,
      claim: observation.claim,
      ...(observation.condition !== undefined
        ? { condition: observation.condition }
        : {}),
      ...(observation.consequence !== undefined
        ? { consequence: observation.consequence }
        : {}),
      topics: observation.topics,
      evidenceStrength: observation.evidenceStrength,
      distinctDayCount: observation.distinctDayCount,
    })),
  );
  const result = await deps.callLlm({
    systemPrompt: prompt.systemPrompt,
    userMessage: prompt.messages[0]!.content,
    taskPreset: taskPresets(deps.config).memoryProfileV2,
    responseFormat: buildObservationProfileResponseFormat(),
  });
  if (result.finishReason === "length") {
    throw new Error(
      "Profile generation response was truncated; reduce the observation set or raise the output cap",
    );
  }
  const parsed = parseProfileV2Output(result.text, observations);
  // The generator sometimes renders provenance as a content footer instead of
  // the claims array. The profile was built from the full observation set, so
  // backfilling claims from that set is an accurate, deterministic fallback.
  const claims = parsed.claims.length > 0
    ? parsed.claims
    : observations.map((observation) => ({
        observationId: observation.observationId,
        text: observation.claim,
      }));
  const saved = await upsertProfile(deps.pool, {
    subjectId,
    fingerprint: currentFingerprint,
    promptContentHash: promptContentHash(deps.systemPrompt),
    content: parsed.content,
    claims,
    sources: observations.map((observation) => ({
      observationId: observation.observationId,
      revision: observation.revision,
      contentHash: observation.contentHash,
    })),
    generation: profileGeneration(deps.config),
    sourceCount: observations.length,
    model: result.model || deps.config.model,
  });
  if (saved === "stale") {
    return {
      subject: subjectId,
      fingerprint: currentFingerprint,
      content: null,
      claims: [],
      regenerated: false,
      skippedReason: "stale-at-save",
      sourceCount: observations.length,
    };
  }
  return {
    subject: subjectId,
    fingerprint: currentFingerprint,
    content: parsed.content,
    claims,
    regenerated: true,
    sourceCount: observations.length,
  };
}
