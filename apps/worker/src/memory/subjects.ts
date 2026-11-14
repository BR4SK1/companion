/**
 * Personal behavior configuration, loaded from the database.
 *
 * Subjects, persona prompt text, behavioral-day start hour, and the
 * worker-wide timezone are deployment configuration, not code or repository content. The loader fails
 * closed: a missing subject, prompt, behavior row, or per-subject evidence
 * rule is an error, never a silently-degraded pipeline. (An entirely
 * unprovisioned deployment is handled one layer up: the worker starts and
 * runs memory as a safe no-op instead of failing.)
 */

import type { PostgresPool } from "@companion/postgres";

import { promptContentHash } from "./prompts.ts";
import { isValidTimezone } from "./time.ts";
import type { MemorySubject, PromptConfig } from "./types.ts";

export class MemoryConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemoryConfigurationError";
  }
}

interface SubjectRow {
  id: string;
  role: string;
  profile_enabled: boolean;
  source_label: string;
  profile_evidence_rule: string;
  position: number;
}

interface PromptRow {
  kind: string;
  version: string;
  system_prompt: string;
}

interface BehaviorRow {
  timezone: string | null;
  day_start_hour: number;
}

/** The memory behavioral-day start hour plus worker-wide timezone. */
export interface MemoryBehaviorConfig {
  readonly timezone: string;
  readonly dayStartHour: number;
}

export interface MemoryConfiguration {
  readonly subjects: readonly MemorySubject[];
  readonly prompts: Readonly<Record<string, PromptConfig>>;
  /** The subject whose `role` is 'user' (the person the memories are about). */
  readonly userSubject: MemorySubject;
  /** The subject whose `role` is 'assistant'. */
  readonly assistantSubject: MemorySubject;
  /** The behavioral-day boundary every period/evidence computation uses. */
  readonly behavior: MemoryBehaviorConfig;
}

/** The behavioral-day boundary alone, for tools that need only time semantics
 *  (e.g. the review CLI). Fails closed when the row is missing or invalid. */
export async function loadMemoryBehavior(
  pool: PostgresPool,
  authoritativeTimezone?: string | null,
): Promise<MemoryBehaviorConfig> {
  const timezoneExpression = authoritativeTimezone === undefined ? "t.timezone" : "$1::text";
  const settingsJoin = authoritativeTimezone === undefined
    ? "CROSS JOIN companion_time_settings t"
    : "";
  const settingsPredicate = authoritativeTimezone === undefined ? " AND t.id = true" : "";
  const behaviorResult = await pool.query<BehaviorRow>(
    `SELECT ${timezoneExpression} AS timezone, b.day_start_hour
     FROM memory_behavior b
     ${settingsJoin}
     WHERE b.id = 'behavior'${settingsPredicate}`,
    authoritativeTimezone === undefined ? [] : [authoritativeTimezone],
  );
  const behaviorRow = behaviorResult.rows[0];
  if (behaviorRow === undefined) {
    throw new MemoryConfigurationError(
      "memory_behavior has no row; provision its behavioral-day start hour and companion_time_settings.timezone",
    );
  }
  if (behaviorRow.timezone === null || !isValidTimezone(behaviorRow.timezone)) {
    throw new MemoryConfigurationError(
      "companion_time_settings.timezone is not a usable IANA timezone",
    );
  }
  return { timezone: behaviorRow.timezone, dayStartHour: behaviorRow.day_start_hour };
}

export async function loadMemoryConfiguration(
  pool: PostgresPool,
  promptVersions: Readonly<Record<string, string>>,
  authoritativeTimezone?: string | null,
): Promise<MemoryConfiguration> {
  const subjectsResult = await pool.query<SubjectRow>(
    `SELECT id, role, profile_enabled, source_label, profile_evidence_rule, position
     FROM memory_subject ORDER BY position, id`,
  );
  const subjects: MemorySubject[] = subjectsResult.rows.map((row) => ({
    id: row.id,
    role: row.role as MemorySubject["role"],
    profileEnabled: row.profile_enabled,
    sourceLabel: row.source_label,
    profileEvidenceRule: row.profile_evidence_rule,
    position: row.position,
  }));
  if (subjects.length === 0) {
    throw new MemoryConfigurationError(
      "memory_subject has no rows; provision subject configuration before enabling memory",
    );
  }
  const userSubject = subjects.find((subject) => subject.role === "user");
  const assistantSubject = subjects.find((subject) => subject.role === "assistant");
  if (userSubject === undefined || assistantSubject === undefined) {
    throw new MemoryConfigurationError(
      "memory_subject must define one 'user' role subject and one 'assistant' role subject",
    );
  }
  const emptyRule = subjects.find((subject) => subject.profileEvidenceRule.trim().length === 0);
  if (emptyRule !== undefined) {
    throw new MemoryConfigurationError(
      `memory_subject row '${emptyRule.id}' has an empty profile_evidence_rule; provision the subject's evidence-attribution rule`,
    );
  }

  const behavior = await loadMemoryBehavior(pool, authoritativeTimezone);

  const kinds = Object.keys(promptVersions);
  const expectedVersions = kinds.map((kind) => promptVersions[kind]!);
  // Exact (kind, version) pair selection: the two parallel arrays are zipped
  // positionally and joined, so only the row for each REQUIRED version can
  // come back. The previous `kind = ANY(...) AND version = ANY(...)`
  // predicate was a cross product: a decoy row like (fact_extraction,
  // temporal-v6) could win for its kind by mere existence and shadow the
  // required row.
  const promptsResult = await pool.query<PromptRow>(
    `SELECT p.kind, p.version, p.system_prompt
     FROM unnest($1::text[], $2::text[]) AS k(kind, version)
     JOIN memory_prompt p ON p.kind = k.kind AND p.version = k.version`,
    [kinds, expectedVersions],
  );
  const byKind = new Map<string, PromptRow>();
  for (const row of promptsResult.rows) byKind.set(row.kind, row);
  const prompts: Record<string, PromptConfig> = {};
  for (const kind of kinds) {
    const expectedVersion = promptVersions[kind];
    if (expectedVersion === undefined) continue;
    const row = byKind.get(kind);
    if (row === undefined) {
      throw new MemoryConfigurationError(
        `memory_prompt has no row for kind '${kind}' version '${expectedVersion}'; provision the expected prompt version before enabling memory`,
      );
    }
    if (row.version !== expectedVersion) {
      throw new MemoryConfigurationError(
        `memory_prompt for kind '${kind}' is version '${row.version}' but code requires '${expectedVersion}'; provision the expected version`,
      );
    }
    prompts[kind] = {
      kind,
      version: row.version,
      systemPrompt: row.system_prompt,
      contentHash: promptContentHash(row.system_prompt),
    };
  }

  return { subjects, prompts, userSubject, assistantSubject, behavior };
}
