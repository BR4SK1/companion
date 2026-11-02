/**
 * Memory-domain configuration, parsed from the environment.
 *
 * Numeric defaults are code defaults that preserve the memory pipeline's
 * proven operating points; production tuning happens through deploy
 * configuration so rollback is a value revert, not a redeploy. Personal
 * behavior configuration (subjects, persona prompt text) is NOT code or
 * environment content: it lives in the `memory_subject` and `memory_prompt`
 * tables and is provisioned per deployment.
 */

import { MIN_LEASE_SECONDS } from "../work/timing.ts";

export class MemoryConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemoryConfigError";
  }
}

function optionalNumber(
  env: Record<string, string | undefined>,
  name: string,
  fallback: number,
  constraints: { readonly integer?: boolean; readonly positive?: boolean; readonly minimum?: number; readonly maximum?: number } = {},
): number {
  const raw = env[name];
  if (raw === undefined || raw.length === 0) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new MemoryConfigError(`${name} is not a finite number: ${raw}`);
  }
  if (constraints.integer && !Number.isInteger(value)) {
    throw new MemoryConfigError(`${name} must be an integer: ${raw}`);
  }
  if (constraints.positive && value <= 0) {
    throw new MemoryConfigError(`${name} must be positive: ${raw}`);
  }
  if (constraints.minimum !== undefined && value < constraints.minimum) {
    throw new MemoryConfigError(`${name} must be at least ${String(constraints.minimum)}: ${raw}`);
  }
  if (constraints.maximum !== undefined && value > constraints.maximum) {
    throw new MemoryConfigError(`${name} must be at most ${String(constraints.maximum)}: ${raw}`);
  }
  return value;
}

function optionalString(env: Record<string, string | undefined>, name: string, fallback: string): string {
  const value = env[name];
  return value === undefined || value.length === 0 ? fallback : value;
}

/** Feature flags preserve the source polarity: ingest/profiles/autopromote
 *  default off (`= 'true'`), recall/temporal context default on (`!== 'false'`).
 *  The v1 profile-sheet generator gets its own flag and also defaults off:
 *  the chat prompt consumes recent temporal summaries and v2 observation
 *  profiles only (source behavior), so v1 sheets have no runtime consumer
 *  and defaulting them on would make unobserved billable LLM calls. */
export interface MemoryConfig {
  readonly enabled: boolean;
  readonly ingestEnabled: boolean;
  readonly autopromoteEnabled: boolean;
  readonly profilesEnabled: boolean;
  /** v1 profile-sheet generation (distilled from day summaries), explicitly
   *  opted into; see the flag comment above. */
  readonly profileSummariesEnabled: boolean;
  readonly recallEnabled: boolean;
  readonly temporalContextEnabled: boolean;
  readonly temporalSummariesEnabled: boolean;
  /** Model id for every memory LLM task. */
  readonly model: string;
  readonly openrouterBaseUrl: string;
  readonly chatTimeoutMs: number;
  /** Ingest watermark pipeline. */
  readonly ingestMaxTurns: number;
  readonly ingestReconciliationMs: number;
  /** A completed turn is only extracted once it has been settled this long. */
  readonly ingestSettleMs: number;
  /** Fact extraction batching. */
  readonly factBatchTurns: number;
  readonly factBatchMaxChars: number;
  /** Consolidation + evidence policy. */
  readonly observationMaxTurns: number;
  readonly observationMaxFacts: number;
  readonly observationMaxOutputTokens: number;
  readonly observationRecencyWindowDays: number;
  readonly consolidationNewFactsThreshold: number;
  readonly consolidationIntervalMs: number;
  /** Canonical recall ranking. */
  readonly canonicalRecencyWeight: number;
  readonly canonicalRecencyHalfLifeDays: number;
  readonly canonicalCandidateLimit: number;
  /** Temporal summaries. */
  readonly temporalReconciliationMs: number;
  /** Profile v2 scheduling: local hour in the behavioral timezone. */
  readonly profilesGenerateHour: number;
  readonly profileMaxSourceChars: number;
  readonly profileMaxOutputTokens: number;
  /** Chat integration. */
  readonly recallLimit: number;
  readonly recallMaxChars: number;
  readonly leaseSecondsMinimum: number;
}

const DEFAULTS = {
  model: "z-ai/glm-5.3-flash",
  chatTimeoutMs: 120_000,
  ingestMaxTurns: 40,
  ingestReconciliationMs: 15 * 60_000,
  ingestSettleMs: 120_000,
  factBatchTurns: 8,
  factBatchMaxChars: 30_000,
  observationMaxTurns: 50,
  observationMaxFacts: 160,
  observationMaxOutputTokens: 12_000,
  observationRecencyWindowDays: 365,
  consolidationNewFactsThreshold: 40,
  consolidationIntervalMs: 24 * 60 * 60_000,
  canonicalRecencyWeight: 0.5,
  canonicalRecencyHalfLifeDays: 21,
  canonicalCandidateLimit: 24,
  temporalReconciliationMs: 300_000,
  profilesGenerateHour: 4,
  profileMaxSourceChars: 24_000,
  profileMaxOutputTokens: 8_000,
  recallLimit: 8,
  recallMaxChars: 12_000,
} as const;

export function loadMemoryConfig(
  env: Record<string, string | undefined>,
): MemoryConfig {
  const recencyWeightRaw = optionalNumber(
    env,
    "WORKER_MEMORY_CANONICAL_RECENCY_WEIGHT",
    DEFAULTS.canonicalRecencyWeight,
  );
  const halfLifeRaw = optionalNumber(
    env,
    "WORKER_MEMORY_CANONICAL_RECENCY_HALF_LIFE_DAYS",
    DEFAULTS.canonicalRecencyHalfLifeDays,
    { integer: true, minimum: 1 },
  );
  const candidateLimitRaw = optionalNumber(
    env,
    "WORKER_MEMORY_CANONICAL_CANDIDATE_LIMIT",
    DEFAULTS.canonicalCandidateLimit,
    { integer: true, minimum: 1 },
  );
  const profileMaxOutputTokensRaw = optionalNumber(
    env,
    "WORKER_MEMORY_PROFILE_MAX_OUTPUT_TOKENS",
    DEFAULTS.profileMaxOutputTokens,
    { integer: true, minimum: 4000 },
  );
  const profilesGenerateHourRaw = optionalNumber(
    env,
    "WORKER_MEMORY_PROFILES_GENERATE_HOUR",
    DEFAULTS.profilesGenerateHour,
    { integer: true, minimum: 0, maximum: 23 },
  );
  return {
    enabled: env["WORKER_MEMORY_ENABLED"] !== "false",
    ingestEnabled: env["WORKER_MEMORY_INGEST_ENABLED"] === "true",
    autopromoteEnabled: env["WORKER_MEMORY_AUTOPROMOTE_ENABLED"] === "true",
    profilesEnabled: env["WORKER_MEMORY_PROFILES_ENABLED"] === "true",
    profileSummariesEnabled: env["WORKER_MEMORY_PROFILE_SUMMARIES_ENABLED"] === "true",
    recallEnabled: env["WORKER_MEMORY_RECALL_ENABLED"] !== "false",
    temporalContextEnabled: env["WORKER_MEMORY_TEMPORAL_CONTEXT_ENABLED"] !== "false",
    temporalSummariesEnabled: env["WORKER_MEMORY_TEMPORAL_SUMMARIES_ENABLED"] !== "false",
    model: optionalString(env, "WORKER_MEMORY_MODEL", DEFAULTS.model),
    openrouterBaseUrl: optionalString(
      env,
      "WORKER_MEMORY_OPENROUTER_BASE_URL",
      "https://openrouter.ai/api/v1",
    ),
    chatTimeoutMs: optionalNumber(env, "WORKER_MEMORY_CHAT_TIMEOUT_MS", DEFAULTS.chatTimeoutMs, {
      integer: true,
      positive: true,
    }),
    ingestMaxTurns: optionalNumber(env, "WORKER_MEMORY_INGEST_MAX_TURNS", DEFAULTS.ingestMaxTurns, {
      integer: true,
      positive: true,
    }),
    ingestReconciliationMs: optionalNumber(
      env,
      "WORKER_MEMORY_INGEST_RECONCILIATION_MS",
      DEFAULTS.ingestReconciliationMs,
      { integer: true, positive: true },
    ),
    ingestSettleMs: optionalNumber(env, "WORKER_MEMORY_INGEST_SETTLE_MS", DEFAULTS.ingestSettleMs, {
      integer: true,
      minimum: 0,
    }),
    factBatchTurns: optionalNumber(env, "WORKER_MEMORY_FACT_BATCH_TURNS", DEFAULTS.factBatchTurns, {
      integer: true,
      positive: true,
    }),
    factBatchMaxChars: optionalNumber(
      env,
      "WORKER_MEMORY_FACT_BATCH_MAX_CHARS",
      DEFAULTS.factBatchMaxChars,
      { integer: true, positive: true },
    ),
    observationMaxTurns: optionalNumber(
      env,
      "WORKER_MEMORY_OBSERVATION_MAX_TURNS",
      DEFAULTS.observationMaxTurns,
      { integer: true, positive: true },
    ),
    observationMaxFacts: optionalNumber(
      env,
      "WORKER_MEMORY_OBSERVATION_MAX_FACTS",
      DEFAULTS.observationMaxFacts,
      { integer: true, positive: true },
    ),
    observationMaxOutputTokens: optionalNumber(
      env,
      "WORKER_MEMORY_OBSERVATION_MAX_OUTPUT_TOKENS",
      DEFAULTS.observationMaxOutputTokens,
      { integer: true, positive: true },
    ),
    observationRecencyWindowDays: optionalNumber(
      env,
      "WORKER_MEMORY_OBSERVATION_RECENCY_WINDOW_DAYS",
      DEFAULTS.observationRecencyWindowDays,
      { integer: true, positive: true },
    ),
    consolidationNewFactsThreshold: optionalNumber(
      env,
      "WORKER_MEMORY_CONSOLIDATION_NEW_FACTS_THRESHOLD",
      DEFAULTS.consolidationNewFactsThreshold,
      { integer: true, positive: true },
    ),
    consolidationIntervalMs: optionalNumber(
      env,
      "WORKER_MEMORY_CONSOLIDATION_INTERVAL_MS",
      DEFAULTS.consolidationIntervalMs,
      { integer: true, positive: true },
    ),
    canonicalRecencyWeight:
      Number.isFinite(recencyWeightRaw) && recencyWeightRaw >= 0
        ? recencyWeightRaw
        : DEFAULTS.canonicalRecencyWeight,
    canonicalRecencyHalfLifeDays:
      Number.isInteger(halfLifeRaw) && halfLifeRaw >= 1
        ? Math.min(halfLifeRaw, 365)
        : DEFAULTS.canonicalRecencyHalfLifeDays,
    canonicalCandidateLimit:
      Number.isInteger(candidateLimitRaw) && candidateLimitRaw >= 1
        ? Math.min(candidateLimitRaw, 256)
        : DEFAULTS.canonicalCandidateLimit,
    temporalReconciliationMs: optionalNumber(
      env,
      "WORKER_MEMORY_TEMPORAL_RECONCILIATION_MS",
      DEFAULTS.temporalReconciliationMs,
      { integer: true, positive: true },
    ),
    profilesGenerateHour: profilesGenerateHourRaw,
    profileMaxSourceChars: optionalNumber(
      env,
      "WORKER_MEMORY_PROFILE_MAX_SOURCE_CHARS",
      DEFAULTS.profileMaxSourceChars,
      { integer: true, positive: true },
    ),
    profileMaxOutputTokens: profileMaxOutputTokensRaw,
    recallLimit: optionalNumber(env, "WORKER_MEMORY_RECALL_LIMIT", DEFAULTS.recallLimit, {
      integer: true,
      positive: true,
    }),
    recallMaxChars: optionalNumber(env, "WORKER_MEMORY_RECALL_MAX_CHARS", DEFAULTS.recallMaxChars, {
      integer: true,
      positive: true,
    }),
    leaseSecondsMinimum: MIN_LEASE_SECONDS,
  };
}
