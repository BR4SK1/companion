/**
 * DB-backed configuration registry for the local config manager.
 *
 * The set of tables is exactly the worker's provisioned-configuration set
 * (the same table list the deployed-smoke configuration fingerprint covers):
 * owner-authored prompts, patterns, modules, bands, schedules, and per-domain
 * behavior rows. Deployment environment values (model ids, endpoints,
 * timeouts, secrets), learned state (conversation records, traces, memory
 * facts/observations, counters, cursors), and any credential are excluded
 * by design: this registry cannot express them, and the server never reads
 * or returns them.
 *
 * Table order is parent-first for FK-safe writes: parents are inserted
 * before children, deleted in reverse.
 */

export type ColumnType = "text" | "integer" | "boolean" | "number";

export interface ColumnDef {
  readonly name: string;
  readonly type: ColumnType;
  /** True when NULL is an allowed stored value. */
  readonly nullable: boolean;
  /** Prompt-bearing field: returned in full, never truncated or masked. */
  readonly prompt?: boolean;
  readonly values?: readonly string[];
  readonly min?: number;
  readonly max?: number;
  readonly maxLength?: number;
  readonly minLength?: number;
  readonly pattern?: string;
  /** Timestamp bookkeeping written by the DB/manager, not client-editable. */
  readonly auto?: boolean;
}

export interface TableDef {
  readonly table: string;
  readonly primaryKey: readonly string[];
  /** Singleton rows carry their fixed PK; multi-row tables may hold many. */
  readonly singleton: boolean;
  readonly columns: readonly ColumnDef[];
}

const text = (name: string, extra: Partial<ColumnDef> = {}): ColumnDef => ({
  name,
  type: "text",
  nullable: false,
  ...extra,
});
const nullableText = (name: string, extra: Partial<ColumnDef> = {}): ColumnDef => ({
  name,
  type: "text",
  nullable: true,
  ...extra,
});
const integer = (name: string, extra: Partial<ColumnDef> = {}): ColumnDef => ({
  name,
  type: "integer",
  nullable: false,
  ...extra,
});
const nullableInteger = (name: string, extra: Partial<ColumnDef> = {}): ColumnDef => ({
  name,
  type: "integer",
  nullable: true,
  ...extra,
});
const boolean = (name: string, extra: Partial<ColumnDef> = {}): ColumnDef => ({
  name,
  type: "boolean",
  nullable: false,
  ...extra,
});
const number = (name: string, extra: Partial<ColumnDef> = {}): ColumnDef => ({
  name,
  type: "number",
  nullable: false,
  ...extra,
});
const updatedAt = (): ColumnDef => ({
  name: "updated_at",
  type: "text",
  nullable: false,
  auto: true,
});

export const TABLE_REGISTRY: readonly TableDef[] = [
  {
    table: "chat_identity",
    primaryKey: ["id"],
    singleton: true,
    columns: [
      text("id", { minLength: 1 }),
      text("content", { prompt: true, minLength: 1 }),
      integer("revision", { min: 1, auto: true }),
      updatedAt(),
    ],
  },
  {
    table: "companion_time_settings",
    primaryKey: ["id"],
    singleton: true,
    columns: [
      boolean("id"),
      nullableText("timezone"),
      nullableText("season_hemisphere", {
        values: ["north", "south"],
      }),
      nullableInteger("birthday_month", { min: 1, max: 12 }),
      nullableInteger("birthday_day", { min: 1, max: 31 }),
      nullableInteger("day_start_hour", { min: 0, max: 23 }),
      updatedAt(),
    ],
  },
  {
    table: "engagement_bands",
    primaryKey: ["id"],
    singleton: true,
    columns: [
      boolean("id"),
      integer("lull_ms", { min: 1 }),
      integer("idle_ms", { min: 1 }),
      integer("gone_ms", { min: 1 }),
      updatedAt(),
    ],
  },
  {
    table: "memory_behavior",
    primaryKey: ["id"],
    singleton: true,
    columns: [
      text("id", { minLength: 1 }),
      text("timezone", { minLength: 1 }),
      integer("day_start_hour", { min: 0, max: 23 }),
      updatedAt(),
    ],
  },
  {
    table: "memory_subject",
    primaryKey: ["id"],
    singleton: false,
    columns: [
      text("id", { minLength: 1 }),
      text("role", { values: ["user", "assistant", "relationship"] }),
      boolean("profile_enabled"),
      text("source_label", { prompt: true, minLength: 1 }),
      text("profile_evidence_rule", { prompt: true, minLength: 1 }),
      integer("position", { min: 0 }),
    ],
  },
  {
    table: "memory_prompt",
    primaryKey: ["kind", "version"],
    singleton: false,
    columns: [
      text("kind", {
        values: [
          "fact_extraction",
          "observation_consolidation",
          "temporal_summary",
          "profile_summary",
          "observation_profile",
        ],
      }),
      text("version", { minLength: 1 }),
      text("system_prompt", { prompt: true, minLength: 1 }),
    ],
  },
  {
    table: "response_pattern",
    primaryKey: ["id"],
    singleton: false,
    columns: [
      text("id", { minLength: 1 }),
      boolean("enabled"),
      text("selection_description", { prompt: true, minLength: 1, maxLength: 4000 }),
      text("response_guidance", { prompt: true, minLength: 1 }),
      integer("position", { min: 0 }),
    ],
  },
  {
    table: "prompt_module",
    primaryKey: ["id"],
    singleton: false,
    columns: [
      text("id", { minLength: 1 }),
      text("module_key", {
        minLength: 1,
        maxLength: 64,
        pattern: "^[a-z][a-z0-9_-]{0,63}$",
      }),
      text("decision_description", { prompt: true, minLength: 1, maxLength: 4000 }),
      nullableText("function_definition", { prompt: true, maxLength: 131072 }),
      nullableText("fallback_content", { prompt: true, maxLength: 16000 }),
      boolean("enabled"),
      integer("position", { min: 0 }),
      integer("timeout_ms", { min: 1, max: 30000 }),
      text("activation_mode", { values: ["model_gated", "every_turn"] }),
      text("output_kind", { values: ["thoughts", "authoritative_context"] }),
      text("execution_mode", { values: ["function", "http_post"] }),
      nullableText("http_endpoint_setting", { maxLength: 64, pattern: "^[A-Za-z][A-Za-z0-9_.-]{0,63}$" }),
      nullableText("http_scope_setting", { maxLength: 64, pattern: "^[A-Za-z][A-Za-z0-9_.-]{0,63}$" }),
      nullableText("http_scope_field", { pattern: "^[A-Za-z][A-Za-z0-9_]{0,63}$" }),
      nullableText("http_turn_id_field", { pattern: "^[A-Za-z][A-Za-z0-9_]{0,63}$" }),
      nullableText("http_local_datetime_field", { pattern: "^[A-Za-z][A-Za-z0-9_]{0,63}$" }),
      nullableText("http_previous_assistant_field", { pattern: "^[A-Za-z][A-Za-z0-9_]{0,63}$" }),
      nullableText("http_user_message_field", { pattern: "^[A-Za-z][A-Za-z0-9_]{0,63}$" }),
      nullableText("http_prior_conversation_field", { pattern: "^[A-Za-z][A-Za-z0-9_]{0,63}$" }),
      nullableText("http_response_text_field", { pattern: "^[A-Za-z][A-Za-z0-9_]{0,63}$" }),
      nullableInteger("http_field_max_bytes", { min: 1, max: 262144 }),
      nullableInteger("http_prior_message_limit", { min: 0, max: 200 }),
      nullableInteger("http_request_max_bytes", { min: 128, max: 1048576 }),
      nullableInteger("http_response_max_bytes", { min: 1, max: 1048576 }),
      updatedAt(),
    ],
  },
  {
    table: "routine_settings",
    primaryKey: ["id"],
    singleton: true,
    columns: [
      boolean("id"),
      text("timezone", { minLength: 1 }),
      nullableText("departure_context", { prompt: true }),
      updatedAt(),
    ],
  },
  {
    table: "routine_transition",
    primaryKey: ["id"],
    singleton: false,
    columns: [
      text("id", { minLength: 1 }),
      text("transition_key", { minLength: 1 }),
      integer("weekday", { min: 1, max: 7 }),
      integer("local_minute", { min: 0, max: 1439 }),
      nullableText("location"),
      nullableText("activity"),
      boolean("available"),
      nullableText("interaction_context", { prompt: true }),
      boolean("enabled"),
    ],
  },
  {
    table: "relationship_settings",
    primaryKey: ["id"],
    singleton: true,
    columns: [
      boolean("id"),
      text("relationship_type", { prompt: true, minLength: 1 }),
      text("timezone", { minLength: 1 }),
      integer("day_start_hour", { min: 0, max: 23 }),
      boolean("tier_movement_enabled"),
      nullableInteger("tier_up_min_days", { min: 1 }),
      nullableInteger("tier_up_min_active_streak", { min: 1 }),
      nullableInteger("tier_down_missed_streak", { min: 1 }),
      text("answer_extraction_prompt", { prompt: true, minLength: 1 }),
      text("clarification_guidance", { prompt: true, minLength: 1 }),
      updatedAt(),
    ],
  },
  {
    table: "relationship_tier",
    primaryKey: ["id"],
    singleton: false,
    columns: [
      text("id", { minLength: 1 }),
      text("tier_key", { minLength: 1 }),
      integer("position", { min: 0 }),
      number("minimum_familiarity", { min: 0, max: 1 }),
      text("label", { minLength: 1 }),
      text("prompt", { prompt: true, minLength: 1 }),
      text("behavioral_guidance", { prompt: true, minLength: 1 }),
    ],
  },
  {
    table: "relationship_question_type",
    primaryKey: ["type_key"],
    singleton: false,
    columns: [
      text("type_key", { minLength: 1 }),
      text("interpretation_guidance", { prompt: true, minLength: 1 }),
    ],
  },
  {
    table: "relationship_question",
    primaryKey: ["id"],
    singleton: false,
    columns: [
      text("id", { minLength: 1 }),
      text("question_key", { minLength: 1 }),
      text("type_key", { minLength: 1 }),
      text("tier_id", { minLength: 1 }),
      text("question_text", { prompt: true, minLength: 1 }),
      boolean("enabled"),
      integer("position", { min: 0 }),
    ],
  },
  {
    table: "article_feed",
    primaryKey: ["id"],
    singleton: false,
    columns: [
      text("id", { minLength: 1 }),
      text("url", { minLength: 1 }),
      boolean("enabled"),
      integer("position", { min: 0 }),
    ],
  },
  {
    table: "article_behavior",
    primaryKey: ["id"],
    singleton: true,
    columns: [
      text("id", { minLength: 1 }),
      boolean("enabled"),
      text("model", { minLength: 1 }),
      integer("max_generations_per_run", { min: 1 }),
      integer("max_reaction_attempts", { min: 1 }),
      integer("max_article_age_days", { min: 1 }),
      integer("max_reaction_chars", { min: 100 }),
      integer("max_excerpt_chars", { min: 200 }),
      integer("decision_max_candidates", { min: 1 }),
      integer("share_cooldown_minutes", { min: 0 }),
      updatedAt(),
    ],
  },
  {
    table: "article_prompt",
    primaryKey: ["kind", "version"],
    singleton: false,
    columns: [
      text("kind", {
        values: [
          "reaction_generation",
          "reaction_review",
          "article_interest_consolidation",
        ],
      }),
      text("version", { minLength: 1 }),
      text("system_prompt", { prompt: true, minLength: 1 }),
    ],
  },
];

export const TABLE_BY_NAME = new Map(
  TABLE_REGISTRY.map((def) => [def.table, def]),
);

/** Tables in FK-safe write order (parents first). */
export const TABLE_ORDER = TABLE_REGISTRY.map((def) => def.table);

/** Prompt-bearing column names per table (full-visibility surface). */
export function promptFieldsFor(table: string): readonly string[] {
  const def = TABLE_BY_NAME.get(table);
  if (def === undefined) return [];
  return def.columns.filter((col) => col.prompt === true).map((col) => col.name);
}

/** Client-editable columns (excludes auto bookkeeping). */
export function editableColumnsFor(table: string): readonly ColumnDef[] {
  const def = TABLE_BY_NAME.get(table);
  if (def === undefined) return [];
  return def.columns.filter((col) => col.auto !== true);
}

/**
 * Columns that identify a row for conflict keys. Excludes auto bookkeeping.
 * For boolean-PK singletons the key value is the literal `true`.
 */
export function keyOf(def: TableDef, row: Record<string, unknown>): Record<string, unknown> {
  const key: Record<string, unknown> = {};
  for (const col of def.primaryKey) key[col] = row[col] ?? null;
  return key;
}

export function keyString(key: Record<string, unknown>): string {
  return JSON.stringify(key);
}
