/**
 * Validation for DB-backed configuration drafts.
 *
 * Field rules mirror the worker's loader fail-closed checks and the DB
 * CHECK constraints (see the per-domain migrations). Cross-row rules
 * (band ordering, prompt-module execution shape, relationship tier order,
 * routine slot uniqueness) are enforced on the fully merged snapshot, so a
 * multi-edit batch cannot leave the configuration in a state the worker
 * would refuse at load time.
 */

import { TABLE_BY_NAME, keyOf, keyString, type ColumnDef, type TableDef } from "./registry.ts";

export type Row = Record<string, unknown>;
export type Snapshot = Readonly<Record<string, readonly Row[]>>;

export interface ConfigEdit {
  readonly table: string;
  readonly key: Readonly<Record<string, unknown>>;
  /** Partial field set to merge onto the existing row (or full row for creates). */
  readonly row?: Readonly<Record<string, unknown>>;
  readonly delete?: boolean;
}

export class ValidationError extends Error {
  readonly errors: readonly string[];
  constructor(errors: readonly string[]) {
    super(`validation failed: ${errors.join("; ")}`);
    this.name = "ValidationError";
    this.errors = errors;
  }
}

function isValidTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function nonNullText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** Coerce an incoming JSON value to the column's stored shape, or report an error. */
export function coerceValue(
  col: ColumnDef,
  value: unknown,
  context: string,
  errors: string[],
): unknown {
  if (value === null || value === undefined) {
    if (col.nullable) return null;
    errors.push(`${context}.${col.name} must not be null`);
    return null;
  }
  switch (col.type) {
    case "boolean": {
      if (typeof value !== "boolean") {
        errors.push(`${context}.${col.name} must be a boolean`);
        return value;
      }
      return value;
    }
    case "integer": {
      const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
      if (!Number.isInteger(n)) {
        errors.push(`${context}.${col.name} must be an integer`);
        return value;
      }
      if (col.min !== undefined && n < col.min) {
        errors.push(`${context}.${col.name} must be at least ${col.min}`);
      }
      if (col.max !== undefined && n > col.max) {
        errors.push(`${context}.${col.name} must be at most ${col.max}`);
      }
      return n;
    }
    case "number": {
      const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
      if (!Number.isFinite(n)) {
        errors.push(`${context}.${col.name} must be a finite number`);
        return value;
      }
      if (col.min !== undefined && n < col.min) {
        errors.push(`${context}.${col.name} must be at least ${col.min}`);
      }
      if (col.max !== undefined && n > col.max) {
        errors.push(`${context}.${col.name} must be at most ${col.max}`);
      }
      return n;
    }
    case "text": {
      if (typeof value !== "string") {
        errors.push(`${context}.${col.name} must be a string`);
        return value;
      }
      if (!col.nullable && value.trim().length === 0 && (col.minLength ?? 0) > 0) {
        errors.push(`${context}.${col.name} must not be empty`);
      }
      if (col.minLength !== undefined && value.length < col.minLength) {
        errors.push(`${context}.${col.name} must be at least ${col.minLength} characters`);
      }
      if (col.maxLength !== undefined && value.length > col.maxLength) {
        errors.push(`${context}.${col.name} must be at most ${col.maxLength} characters`);
      }
      if (col.values !== undefined && !col.values.includes(value)) {
        errors.push(`${context}.${col.name} must be one of ${col.values.join(", ")}`);
      }
      if (col.pattern !== undefined && !new RegExp(col.pattern).test(value)) {
        errors.push(`${context}.${col.name} has an invalid format`);
      }
      return value;
    }
    default:
      return value;
  }
}

/** Validate one stored row (all editable columns present, already coerced). */
function validateRow(def: TableDef, row: Row, errors: string[]): void {
  const ctx = def.table;
  for (const col of def.columns) {
    if (col.auto === true) continue;
    const value = row[col.name];
    if (value === undefined) {
      if (!col.nullable) errors.push(`${ctx}.${col.name} is required`);
      continue;
    }
    if (value === null) {
      if (!col.nullable) errors.push(`${ctx}.${col.name} must not be null`);
      continue;
    }
    switch (col.type) {
      case "boolean":
        if (typeof value !== "boolean") errors.push(`${ctx}.${col.name} must be a boolean`);
        break;
      case "integer": {
        if (!Number.isInteger(value)) {
          errors.push(`${ctx}.${col.name} must be an integer`);
        } else {
          if (col.min !== undefined && (value as number) < col.min) {
            errors.push(`${ctx}.${col.name} must be at least ${col.min}`);
          }
          if (col.max !== undefined && (value as number) > col.max) {
            errors.push(`${ctx}.${col.name} must be at most ${col.max}`);
          }
        }
        break;
      }
      case "number": {
        if (typeof value !== "number" || !Number.isFinite(value)) {
          errors.push(`${ctx}.${col.name} must be a finite number`);
        } else {
          if (col.min !== undefined && value < col.min) errors.push(`${ctx}.${col.name} must be at least ${col.min}`);
          if (col.max !== undefined && value > col.max) errors.push(`${ctx}.${col.name} must be at most ${col.max}`);
        }
        break;
      }
      case "text": {
        if (typeof value !== "string") {
          errors.push(`${ctx}.${col.name} must be a string`);
          break;
        }
        if (!col.nullable && value.trim().length === 0 && (col.minLength ?? 0) > 0) {
          errors.push(`${ctx}.${col.name} must not be empty`);
        }
        if (col.values !== undefined && !col.values.includes(value)) {
          errors.push(`${ctx}.${col.name} must be one of ${col.values.join(", ")}`);
        }
        if (col.maxLength !== undefined && value.length > col.maxLength) {
          errors.push(`${ctx}.${col.name} must be at most ${col.maxLength} characters`);
        }
        if (col.pattern !== undefined && !new RegExp(col.pattern).test(value)) {
          errors.push(`${ctx}.${col.name} has an invalid format`);
        }
        break;
      }
    }
  }
}

/** Cross-row rules mirroring worker loaders; run on the merged snapshot. */
function validateSnapshot(snapshot: Snapshot): string[] {
  const errors: string[] = [];
  const rowsOf = (table: string): readonly Row[] => snapshot[table] ?? [];
  const one = (table: string): Row | undefined => rowsOf(table)[0];

  // companion_time_settings: timezone/hemisphere/birthday.
  const temporal = one("companion_time_settings");
  if (temporal !== undefined) {
    const tz = temporal["timezone"];
    if (tz !== null && tz !== undefined && (typeof tz !== "string" || !isValidTimezone(tz))) {
      errors.push("companion_time_settings.timezone is not a usable IANA timezone");
    }
    const month = temporal["birthday_month"];
    const day = temporal["birthday_day"];
    if ((month === null) !== (day === null)) {
      errors.push("companion_time_settings birthday month and day must be provisioned together");
    } else if (typeof month === "number" && typeof day === "number") {
      const probe = new Date(Date.UTC(2024, month - 1, day));
      if (
        probe.getUTCMonth() !== month - 1 ||
        probe.getUTCDate() !== day ||
        probe.getUTCFullYear() !== 2024
      ) {
        errors.push("companion_time_settings birthday is not a valid month and day");
      }
    }
  }

  // engagement_bands: strictly increasing cutoffs.
  const bands = one("engagement_bands");
  if (bands !== undefined) {
    const lull = bands["lull_ms"];
    const idle = bands["idle_ms"];
    const gone = bands["gone_ms"];
    if (typeof lull === "number" && typeof idle === "number" && !(idle > lull)) {
      errors.push("engagement_bands.idle_ms must be greater than lull_ms");
    }
    if (typeof idle === "number" && typeof gone === "number" && !(gone > idle)) {
      errors.push("engagement_bands.gone_ms must be greater than idle_ms");
    }
  }

  // memory_behavior: day start hour already ranged; timezone usable.
  const behavior = one("memory_behavior");
  if (behavior !== undefined) {
    const tz = behavior["timezone"];
    if (typeof tz === "string" && !isValidTimezone(tz)) {
      errors.push("memory_behavior.timezone is not a usable IANA timezone");
    }
  }

  // memory_subject: at least one user and one assistant subject; rules non-empty.
  const subjects = rowsOf("memory_subject");
  if (subjects.length > 0) {
    if (!subjects.some((s) => s["role"] === "user")) {
      errors.push("memory_subject must define one 'user' role subject");
    }
    if (!subjects.some((s) => s["role"] === "assistant")) {
      errors.push("memory_subject must define one 'assistant' role subject");
    }
    for (const s of subjects) {
      if (!nonNullText(s["profile_evidence_rule"])) {
        errors.push(`memory_subject '${String(s["id"])}' has an empty profile_evidence_rule`);
      }
    }
  }

  // prompt_module: execution-config shape mirrors the DB CHECK.
  for (const m of rowsOf("prompt_module")) {
    const ctx = `prompt_module '${String(m["module_key"])}'`;
    const mode = m["execution_mode"];
    const fn = m["function_definition"];
    const endpoint = m["http_endpoint_setting"];
    const scopeSetting = m["http_scope_setting"];
    const scopeField = m["http_scope_field"];
    const responseField = m["http_response_text_field"];
    const httpNums = [
      m["http_field_max_bytes"],
      m["http_prior_message_limit"],
      m["http_request_max_bytes"],
      m["http_response_max_bytes"],
    ];
    const requestFields = [
      m["http_turn_id_field"],
      m["http_local_datetime_field"],
      m["http_engagement_state_field"],
      m["http_previous_assistant_field"],
      m["http_user_message_field"],
      m["http_prior_conversation_field"],
    ];
    const publishedKeyField = m["http_published_routine_message_key_field"];
    const patternIdField = m["http_pattern_id_field"];
    const holdField = m["http_unavailable_until_field"];
    const revisionField = m["http_availability_revision_field"];
    if (mode === "function") {
      if (!nonNullText(fn)) errors.push(`${ctx} function_definition must be non-empty for function modules`);
      const stray = [endpoint, scopeSetting, scopeField, responseField, ...requestFields,
        publishedKeyField, patternIdField, holdField, revisionField, ...httpNums];
      if (stray.some((v) => v !== null && v !== undefined)) {
        errors.push(`${ctx} http_post fields must be null for function modules`);
      }
    } else if (mode === "http_post") {
      if (fn !== null && fn !== undefined) {
        errors.push(`${ctx} function_definition must be null for http_post modules`);
      }
      if (!nonNullText(endpoint)) errors.push(`${ctx} http_endpoint_setting is required for http_post modules`);
      if (!nonNullText(responseField)) {
        errors.push(`${ctx} http_response_text_field is required for http_post modules`);
      }
      if (httpNums.some((v) => v === null || v === undefined)) {
        errors.push(`${ctx} http byte-limit fields are required for http_post modules`);
      }
      if ((scopeSetting === null) !== (scopeField === null)) {
        errors.push(`${ctx} http_scope_setting and http_scope_field must be provisioned together`);
      }
      if (scopeSetting !== null && scopeSetting !== undefined && scopeSetting === endpoint) {
        errors.push(`${ctx} http_scope_setting must differ from http_endpoint_setting`);
      }
      if (holdField !== null && holdField !== undefined && holdField === responseField) {
        errors.push(`${ctx} http_unavailable_until_field must differ from http_response_text_field`);
      }
      if (nonNullText(publishedKeyField) && [scopeField, ...requestFields].includes(publishedKeyField)) {
        errors.push(`${ctx} http_published_routine_message_key_field must differ from other request fields`);
      }
      if (nonNullText(patternIdField) && [scopeField, publishedKeyField, ...requestFields].includes(patternIdField)) {
        errors.push(`${ctx} http_pattern_id_field must differ from other request fields`);
      }
      if (nonNullText(revisionField) &&
          (!nonNullText(holdField) || revisionField === holdField || revisionField === responseField)) {
        errors.push(`${ctx} http_availability_revision_field requires a distinct configured hold field and response text field`);
      }
    }
  }

  // routine_external_provider: scope_setting must differ from endpoint_setting.
  const externalRoutine = one("routine_external_provider");
  if (externalRoutine !== undefined) {
    const ep = externalRoutine["endpoint_setting"];
    const sc = externalRoutine["scope_setting"];
    if (sc !== null && sc !== undefined && sc === ep) {
      errors.push("routine_external_provider.scope_setting must differ from endpoint_setting");
    }
  }

  // routine_settings + routine_transition.
  const routine = one("routine_settings");
  if (routine !== undefined) {
    const tz = routine["timezone"];
    if (typeof tz === "string" && !isValidTimezone(tz)) {
      errors.push("routine_settings.timezone is not a usable IANA timezone");
    }
  }
  const transitions = rowsOf("routine_transition").filter((t) => t["enabled"] === true);
  if (routine !== undefined && transitions.length === 0) {
    errors.push("at least one enabled routine_transition is required");
  }
  {
    const slots = new Set<string>();
    for (const t of rowsOf("routine_transition")) {
      const slot = `${String(t["weekday"])}:${String(t["local_minute"])}`;
      if (slots.has(slot)) {
        errors.push("routine transitions cannot share a weekday and local minute");
        break;
      }
      slots.add(slot);
    }
  }

  // relationship_settings + tiers: tier movement thresholds, tier order.
  const relSettings = one("relationship_settings");
  if (relSettings !== undefined) {
    if (relSettings["tier_movement_enabled"] === true) {
      if (
        relSettings["tier_up_min_days"] === null ||
        relSettings["tier_up_min_days"] === undefined ||
        relSettings["tier_up_min_active_streak"] === null ||
        relSettings["tier_up_min_active_streak"] === undefined ||
        relSettings["tier_down_missed_streak"] === null ||
        relSettings["tier_down_missed_streak"] === undefined
      ) {
        errors.push("enabled tier movement requires all three positive thresholds");
      }
    }
    const tz = relSettings["timezone"];
    if (typeof tz === "string" && !isValidTimezone(tz)) {
      errors.push("relationship_settings.timezone is not a usable IANA timezone");
    }
  }
  const tiers = [...rowsOf("relationship_tier")].sort(
    (a, b) => Number(a["position"]) - Number(b["position"]),
  );
  if (tiers.length > 0) {
    if (Number(tiers[0]?.["minimum_familiarity"]) !== 0) {
      errors.push("the first relationship tier must have minimum_familiarity 0");
    }
    for (let i = 1; i < tiers.length; i += 1) {
      if (
        Number(tiers[i]?.["minimum_familiarity"]) <= Number(tiers[i - 1]?.["minimum_familiarity"])
      ) {
        errors.push("relationship tiers must have strictly increasing familiarity thresholds");
      }
    }
  }

  // relationship_question: FK membership (tier + type must exist).
  {
    const tierIds = new Set(rowsOf("relationship_tier").map((t) => String(t["id"])));
    const typeKeys = new Set(rowsOf("relationship_question_type").map((t) => String(t["type_key"])));
    for (const q of rowsOf("relationship_question")) {
      if (!tierIds.has(String(q["tier_id"]))) {
        errors.push(`relationship_question '${String(q["question_key"])}' references a missing tier`);
      }
      if (!typeKeys.has(String(q["type_key"]))) {
        errors.push(`relationship_question '${String(q["question_key"])}' references a missing question type`);
      }
    }
  }

  // article_feed: parseable http(s) URL without embedded credentials.
  for (const feed of rowsOf("article_feed")) {
    const raw = feed["url"];
    if (typeof raw !== "string") continue;
    let parsed: URL | null = null;
    try {
      parsed = new URL(raw);
    } catch {
      parsed = null;
    }
    if (parsed === null || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) {
      errors.push(`article_feed '${String(feed["id"])}' url must be an http(s) URL`);
    } else if (parsed.username !== "" || parsed.password !== "") {
      errors.push(`article_feed '${String(feed["id"])}' url must not contain embedded credentials`);
    }
  }

  return errors;
}

function cloneSnapshot(snapshot: Snapshot): Record<string, Row[]> {
  const out: Record<string, Row[]> = {};
  for (const [table, rows] of Object.entries(snapshot)) {
    out[table] = rows.map((row) => ({ ...row }));
  }
  return out;
}

/**
 * Merge a batch of edits onto a snapshot and validate the result.
 * Returns the merged snapshot (auto bookkeeping untouched) and all errors.
 */
export function mergeEdits(
  current: Snapshot,
  edits: readonly ConfigEdit[],
): { readonly merged: Snapshot; readonly errors: readonly string[] } {
  const errors: string[] = [];
  const merged = cloneSnapshot(current);

  for (const [index, edit] of edits.entries()) {
    const ctx = `edits[${index}]`;
    const def = TABLE_BY_NAME.get(edit.table);
    if (def === undefined) {
      errors.push(`${ctx}: unknown table '${edit.table}'`);
      continue;
    }
    if (merged[def.table] === undefined) merged[def.table] = [];
    const rows = merged[def.table]!;
    const wanted = keyOf(def, edit.key as Row);
    const target = rows.findIndex((row) => keyString(keyOf(def, row)) === keyString(wanted));

    if (edit.delete === true) {
      if (target < 0) {
        errors.push(`${ctx}: ${def.table} row ${JSON.stringify(edit.key)} does not exist`);
        continue;
      }
      if (edit.row !== undefined && Object.keys(edit.row).length > 0) {
        errors.push(`${ctx}: delete edits must not carry a row`);
        continue;
      }
      rows.splice(target, 1);
      continue;
    }

    const supplied = edit.row ?? {};
    // Reject unknown/auto fields; never accept bookkeeping from the client.
    for (const field of Object.keys(supplied)) {
      const col = def.columns.find((c) => c.name === field);
      if (col === undefined) {
        errors.push(`${ctx}: unknown field '${field}' for ${def.table}`);
      } else if (col.auto === true) {
        errors.push(`${ctx}: field '${field}' is server-managed and cannot be set`);
      }
    }

    if (target >= 0) {
      const next: Row = { ...rows[target]! };
      const fieldErrors: string[] = [];
      for (const [field, value] of Object.entries(supplied)) {
        const col = def.columns.find((c) => c.name === field);
        if (col === undefined || col.auto === true) continue;
        const coerced = coerceValue(col, value, ctx, fieldErrors);
        if (fieldErrors.every((e) => !e.startsWith(`${ctx}.${field}`))) {
          next[field] = coerced;
        }
      }
      errors.push(...fieldErrors);
      rows[target] = next;
    } else {
      // Create: key fields plus supplied fields must form a complete row.
      const next: Row = {};
      for (const col of def.columns) {
        if (col.auto === true) continue;
        const raw =
          supplied[col.name] !== undefined ? supplied[col.name] : edit.key[col.name];
        if (raw === undefined) {
          if (!col.nullable) {
            errors.push(`${ctx}: ${def.table}.${col.name} is required to create a row`);
          } else {
            next[col.name] = null;
          }
          continue;
        }
        const fieldErrors: string[] = [];
        next[col.name] = coerceValue(col, raw, ctx, fieldErrors);
        errors.push(...fieldErrors);
      }
      rows.push(next);
    }
  }

  for (const def of [...TABLE_BY_NAME.values()]) {
    for (const row of merged[def.table] ?? []) validateRow(def, row, errors);
  }
  errors.push(...validateSnapshot(merged));

  return { merged, errors };
}

/**
 * Validate a full snapshot (e.g. a stored state) without edits.
 * Exposed for the startup self-check and tests.
 */
export function validateFullSnapshot(snapshot: Snapshot): readonly string[] {
  const errors: string[] = [];
  for (const def of TABLE_BY_NAME.values()) {
    for (const row of snapshot[def.table] ?? []) validateRow(def, row, errors);
  }
  errors.push(...validateSnapshot(snapshot));
  return errors;
}
