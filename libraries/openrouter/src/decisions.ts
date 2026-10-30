/**
 * OpenRouter Decisions contract: typed request and answer variants for the
 * Decisions API (`POST /api/alpha/decisions`, same body as
 * `/api/v1/systemone`).
 *
 * This is a capability contract only. Transport, credentials, client
 * construction, model/provider selection, capability probing, retries,
 * fallback, calibration, thresholds, and numeric normalization do not live
 * here. Validation mirrors the published OpenRouter Decisions schema:
 *
 * - Requests and answers keep their distinct native variants (`choice`,
 *   `noul`, `score`); nothing is flattened into one generic shape.
 * - A `noul` probability stays a number. It is never coerced to a Boolean.
 * - `probabilities`, `confidence`, and `legend` are optional on the wire and
 *   stay optional here: they are read through presence checks and are never
 *   fabricated or defaulted.
 * - Unknown extra properties are accepted (the published schema does not
 *   forbid them) but are not surfaced on parsed values. Exception: a top-level
 *   `assets` image-reference map is in the published schema but outside this
 *   contract's approved scope (text-only choice/noul/score decisions); it is
 *   rejected explicitly rather than silently dropped, because dropping it
 *   would change the meaning of references inside `state`/`instructions`/
 *   `criteria`.
 * - A request must ask at least one question; a `noul` question's optional
 *   `criteria`, when present, has exactly `true` and `false` keys; a `score`
 *   question needs at least one level (published schema `minItems: 1`);
 *   `session_id` and `user` honor the published `maxLength: 256`.
 * - `provider` follows the published `ProviderPreferences` schema, which is
 *   `object | null`: an explicit `null` is valid and is preserved as `null`.
 * - Map-shaped values (questions, answers, criteria, probabilities, legend,
 *   and the `provider`/`trace` pass-through copies) preserve every own
 *   enumerable string key of their input, including keys named `__proto__`,
 *   `constructor`, or `toString`: entries are defined with
 *   `Object.defineProperty`, never assigned through `[[Set]]`, and iterated
 *   with own-key-only operations. Membership checks use `Object.hasOwn`, so
 *   inherited names are never mistaken for entries.
 *
 * Deliberately NOT enforced here, because they are application policy or
 * would invent an unsupported provider contract: probability ranges or sums,
 * correspondence between criteria keys and probability keys, whether a
 * `choice` value names a offered option, thresholds, and top-N selection.
 * Parsed values preserve what the provider returned; no normalization is
 * applied.
 *
 * The `box` primitive (image questions, Jev 1.14) is outside the approved
 * contract scope and is rejected as an unexpected question/answer type, per
 * the official guidance to treat an unexpected `type` as an error rather
 * than a default.
 *
 * Schema sources: the OpenRouter Decisions API reference and the official
 * TypeScript SDK schemas (`DecisionsRequest`, `DecisionsResponse`).
 */

// ---------------------------------------------------------------------------
// JSON value types
// ---------------------------------------------------------------------------

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonObject
  | readonly JsonValue[];

export interface JsonObject {
  readonly [key: string]: JsonValue;
}

/**
 * A free-form entry accepted for `state`, `instructions`, and criteria
 * values: a plain string or a JSON structure (object or array).
 */
export type DecisionsEntry = string | JsonObject | readonly JsonValue[];

/**
 * The content to evaluate: a plain string, or a JSON object or array of
 * related context.
 */
export type DecisionsState = string | JsonObject | readonly JsonValue[];

// ---------------------------------------------------------------------------
// Request variants
// ---------------------------------------------------------------------------

/** One option from a defined set, descriptions keyed by option name. */
export interface DecisionsChoiceQuestion {
  readonly type: "choice";
  readonly instructions: DecisionsEntry;
  readonly criteria: Readonly<Record<string, DecisionsEntry | null>>;
}

/** Whether a condition holds. `criteria` is optional and has exactly `true` and `false`. */
export interface DecisionsNoulQuestion {
  readonly type: "noul";
  readonly instructions: DecisionsEntry;
  readonly criteria?: Readonly<{ true: DecisionsEntry; false: DecisionsEntry }>;
}

/**
 * A degree along ordered levels. `criteria` is an ordered array, lowest
 * level first; the answer's `legend` maps `"0"`, `"1"`, ... back to it.
 */
export interface DecisionsScoreQuestion {
  readonly type: "score";
  readonly instructions: DecisionsEntry;
  readonly criteria: readonly DecisionsEntry[];
}

export type DecisionsQuestion =
  | DecisionsChoiceQuestion
  | DecisionsNoulQuestion
  | DecisionsScoreQuestion;

export interface DecisionsRequest {
  readonly model: string;
  readonly state: DecisionsState;
  readonly questions: Readonly<Record<string, DecisionsQuestion>>;
  /**
   * Routing preferences, per the published `ProviderPreferences` schema
   * (`object | null`): an explicit `null` is valid and preserved. The
   * preference object is forwarded as a shallow copy of its own enumerable
   * keys; per-key validation is not done here.
   */
  readonly provider?: Readonly<Record<string, unknown>> | null;
  readonly session_id?: string;
  readonly user?: string;
  readonly trace?: Readonly<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// Answer variants (native results, preserved)
// ---------------------------------------------------------------------------

export interface DecisionsChoiceAnswer {
  readonly type: "choice";
  /** The selected option, as returned. Not checked against criteria here. */
  readonly choice: string;
  /** Optional per-option probabilities, as returned. Not renormalized. */
  readonly probabilities?: Readonly<Record<string, number>>;
  readonly confidence?: number;
}

/**
 * The probability that the condition holds. A noul value stays a number: 0
 * and 1 are numbers, `noul` near 0.5 means yes and no are similarly likely,
 * and no code here turns it into a Boolean.
 */
export interface DecisionsNoulAnswer {
  readonly type: "noul";
  readonly noul: number;
}

export interface DecisionsScoreAnswer {
  readonly type: "score";
  /**
   * The probability-weighted position on the ordered scale, as returned.
   * Not rounded, clamped, or normalized.
   */
  readonly score: number;
  /** Optional map of level index (`"0"`, `"1"`, ...) to the criteria values sent. */
  readonly legend?: Readonly<Record<string, JsonValue>>;
  /** Optional per-level distribution keyed by level index. */
  readonly probabilities?: Readonly<Record<string, number>>;
  readonly confidence?: number;
}

export type DecisionsAnswer =
  | DecisionsChoiceAnswer
  | DecisionsNoulAnswer
  | DecisionsScoreAnswer;

// ---------------------------------------------------------------------------
// Response envelope
// ---------------------------------------------------------------------------

export interface DecisionsUsage {
  readonly input_tokens: number;
  readonly output_tokens: number;
  /** USD cost, when the provider reports it. */
  readonly cost?: number;
}

export interface DecisionsResponse {
  readonly id?: string;
  /** The exact model build that answered. */
  readonly model: string;
  readonly provider?: string;
  /** Answers keyed by question ID; see `parseDecisionsExchange` for correspondence checks. */
  readonly answers: Readonly<Record<string, DecisionsAnswer>>;
  readonly usage: DecisionsUsage;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Thrown when a value does not satisfy the Decisions contract. */
export class DecisionsContractError extends Error {
  /** Dotted path to the offending value, e.g. `answers.is_bug.type`. Empty at the root. */
  readonly path: string;

  constructor(path: string, message: string) {
    super(path.length > 0 ? `${path}: ${message}` : message);
    this.name = "DecisionsContractError";
    this.path = path;
  }
}

function fail(path: string, message: string): never {
  throw new DecisionsContractError(path, message);
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) return true;
  switch (typeof value) {
    case "string":
    case "boolean":
      return true;
    case "number":
      return Number.isFinite(value);
    case "object":
      if (Array.isArray(value)) return value.every(isJsonValue);
      if (!isPlainObject(value)) return false;
      return Object.values(value).every(isJsonValue);
    default:
      return false;
  }
}

function isEntry(value: unknown): boolean {
  // A string, or a JSON structure (object or array). A bare number, boolean,
  // or null is not a valid entry at the top level.
  if (typeof value === "string") return true;
  return typeof value === "object" && value !== null && isJsonValue(value);
}

function expectObject(value: unknown, path: string): Record<string, unknown> {
  if (value === undefined) fail(path, "missing required field");
  if (!isPlainObject(value)) fail(path, "expected an object");
  return value;
}

function expectString(value: unknown, path: string): string {
  if (value === undefined) fail(path, "missing required field");
  if (typeof value !== "string") fail(path, "expected a string");
  return value;
}

function expectFinite(value: unknown, path: string): number {
  if (value === undefined) fail(path, "missing required field");
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(path, "expected a finite number");
  }
  return value;
}

function expectInteger(value: unknown, path: string): number {
  if (value === undefined) fail(path, "missing required field");
  if (typeof value !== "number" || !Number.isInteger(value)) {
    fail(path, "expected an integer");
  }
  return value;
}

function expectEntry(value: unknown, path: string): DecisionsEntry {
  if (value === undefined) fail(path, "missing required field");
  if (!isEntry(value)) fail(path, "expected a string or a JSON object or array");
  return value as DecisionsEntry;
}

function expectLooseRecord(
  value: unknown,
  path: string,
): Readonly<Record<string, unknown>> {
  const record = expectObject(value, path);
  return copyOwnEntries(record);
}

/**
 * Copy an object's own enumerable string-keyed entries into a fresh plain
 * object using `Object.defineProperty`, so keys like `__proto__` become real
 * own properties instead of prototype manipulation, and inherited names
 * (`toString`, `constructor`, ...) are never copied.
 */
function copyOwnEntries(
  value: Record<string, unknown>,
): Record<string, unknown> {
  const copy: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    defineEntry(copy, key, entry);
  }
  return copy;
}

function defineEntry(
  record: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  Object.defineProperty(record, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

function expectProbabilityRecord(
  value: unknown,
  path: string,
): Readonly<Record<string, number>> {
  const record = expectObject(value, path);
  const parsed: Record<string, number> = {};
  for (const [key, entry] of Object.entries(record)) {
    defineEntry(parsed, key, expectFinite(entry, `${path}.${key}`));
  }
  return parsed;
}

function expectLegendRecord(
  value: unknown,
  path: string,
): Readonly<Record<string, JsonValue>> {
  const record = expectObject(value, path);
  const parsed: Record<string, JsonValue> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (!isJsonValue(entry)) fail(`${path}.${key}`, "expected a JSON value");
    defineEntry(parsed, key, entry);
  }
  return parsed;
}

/** A string honoring the published `maxLength: 256` on `session_id` and `user`. */
function expectBoundedString(value: unknown, path: string): string {
  const parsed = expectString(value, path);
  if (parsed.length > 256) {
    fail(path, `expected a string of at most 256 characters`);
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Request parsing
// ---------------------------------------------------------------------------

function parseQuestion(id: string, value: unknown): DecisionsQuestion {
  const path = `questions.${id}`;
  const record = expectObject(value, path);
  const instructions = expectEntry(record.instructions, `${path}.instructions`);

  if (record.type === "choice") {
    const criteriaRecord = expectObject(record.criteria, `${path}.criteria`);
    const criteria: Record<string, DecisionsEntry | null> = {};
    for (const [key, entry] of Object.entries(criteriaRecord)) {
      defineEntry(
        criteria,
        key,
        entry === null ? null : expectEntry(entry, `${path}.criteria.${key}`),
      );
    }
    return { type: "choice", instructions, criteria };
  }

  if (record.type === "noul") {
    if (record.criteria === undefined) {
      return { type: "noul", instructions };
    }
    const criteriaRecord = expectObject(record.criteria, `${path}.criteria`);
    const keys = Object.keys(criteriaRecord);
    if (keys.length !== 2 || !keys.includes("true") || !keys.includes("false")) {
      fail(`${path}.criteria`, 'expected exactly "true" and "false" keys');
    }
    return {
      type: "noul",
      instructions,
      criteria: {
        true: expectEntry(criteriaRecord["true"], `${path}.criteria.true`),
        false: expectEntry(criteriaRecord["false"], `${path}.criteria.false`),
      },
    };
  }

  if (record.type === "score") {
    if (record.criteria === undefined) {
      fail(`${path}.criteria`, "missing required field");
    }
    if (!Array.isArray(record.criteria)) {
      fail(`${path}.criteria`, "expected an ordered array of levels, lowest level first");
    }
    if (record.criteria.length === 0) {
      fail(`${path}.criteria`, "expected at least one level (minItems 1)");
    }
    const criteria = record.criteria.map((level, index) =>
      expectEntry(level, `${path}.criteria.${index}`),
    );
    return { type: "score", instructions, criteria };
  }

  fail(
    `${path}.type`,
    `unknown question type ${JSON.stringify(record.type) ?? String(record.type)}; expected "choice", "noul", or "score"`,
  );
}

/**
 * Validate an untyped Decisions request body against the published schema.
 * Throws `DecisionsContractError` on the first violation. Optional request
 * fields (`provider`, `session_id`, `user`, `trace`) stay optional and are
 * not invented when absent.
 */
export function parseDecisionsRequest(value: unknown): DecisionsRequest {
  const record = expectObject(value, "request");
  const model = expectString(record.model, "model");

  const state = record.state;
  if (typeof state === "string") {
    // OK: plain string state.
  } else if (typeof state === "object" && state !== null && isJsonValue(state)) {
    // OK: JSON object or array state.
  } else {
    fail("state", "expected a string, JSON object, or JSON array");
  }

  const questionsRecord = expectObject(record.questions, "questions");
  if (Object.keys(questionsRecord).length === 0) {
    fail("questions", "expected at least one question");
  }
  const questions: Record<string, DecisionsQuestion> = {};
  for (const [id, question] of Object.entries(questionsRecord)) {
    defineEntry(questions, id, parseQuestion(id, question));
  }

  // The published schema accepts a top-level `assets` image-reference map,
  // but image decisions are outside this contract's approved scope. Reject it
  // explicitly instead of silently dropping it: dropping it would change the
  // meaning of asset references inside `state`, `instructions`, or `criteria`.
  if (record.assets !== undefined) {
    fail(
      "assets",
      "the assets image-reference map is not supported by this contract; it is rejected rather than silently dropped",
    );
  }

  return {
    model,
    state: state as DecisionsState,
    questions,
    ...(record.provider !== undefined
      ? {
          // Published ProviderPreferences is `object | null`; preserve `null`.
          provider:
            record.provider === null
              ? null
              : expectLooseRecord(record.provider, "provider"),
        }
      : {}),
    ...(record.session_id !== undefined
      ? { session_id: expectBoundedString(record.session_id, "session_id") }
      : {}),
    ...(record.user !== undefined
      ? { user: expectBoundedString(record.user, "user") }
      : {}),
    ...(record.trace !== undefined
      ? { trace: expectLooseRecord(record.trace, "trace") }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

function parseAnswer(id: string, value: unknown): DecisionsAnswer {
  const path = `answers.${id}`;
  const record = expectObject(value, path);

  if (record.type === "choice") {
    return {
      type: "choice",
      choice: expectString(record.choice, `${path}.choice`),
      ...(record.probabilities !== undefined
        ? {
            probabilities: expectProbabilityRecord(
              record.probabilities,
              `${path}.probabilities`,
            ),
          }
        : {}),
      ...(record.confidence !== undefined
        ? { confidence: expectFinite(record.confidence, `${path}.confidence`) }
        : {}),
    };
  }

  if (record.type === "score") {
    return {
      type: "score",
      score: expectFinite(record.score, `${path}.score`),
      ...(record.legend !== undefined
        ? { legend: expectLegendRecord(record.legend, `${path}.legend`) }
        : {}),
      ...(record.probabilities !== undefined
        ? {
            probabilities: expectProbabilityRecord(
              record.probabilities,
              `${path}.probabilities`,
            ),
          }
        : {}),
      ...(record.confidence !== undefined
        ? { confidence: expectFinite(record.confidence, `${path}.confidence`) }
        : {}),
    };
  }

  if (record.type === "noul") {
    return { type: "noul", noul: expectFinite(record.noul, `${path}.noul`) };
  }

  fail(
    `${path}.type`,
    `unexpected answer type ${JSON.stringify(record.type) ?? String(record.type)}; expected "choice", "noul", or "score"`,
  );
}

/**
 * Validate an untyped Decisions response body against the published schema,
 * independent of any request. Throws `DecisionsContractError` on the first
 * violation. Optional fields (`id`, `provider`, `probabilities`,
 * `confidence`, `legend`, `usage.cost`) stay optional and are not invented
 * when absent.
 */
export function parseDecisionsResponse(value: unknown): DecisionsResponse {
  const record = expectObject(value, "response");
  const model = expectString(record.model, "model");

  const answersRecord = expectObject(record.answers, "answers");
  const answers: Record<string, DecisionsAnswer> = {};
  for (const [id, answer] of Object.entries(answersRecord)) {
    defineEntry(answers, id, parseAnswer(id, answer));
  }

  const usageRecord = expectObject(record.usage, "usage");
  const usage = {
    input_tokens: expectInteger(usageRecord.input_tokens, "usage.input_tokens"),
    output_tokens: expectInteger(
      usageRecord.output_tokens,
      "usage.output_tokens",
    ),
    ...(usageRecord.cost !== undefined
      ? { cost: expectFinite(usageRecord.cost, "usage.cost") }
      : {}),
  };

  return {
    model,
    answers,
    usage,
    ...(record.id !== undefined ? { id: expectString(record.id, "id") } : {}),
    ...(record.provider !== undefined
      ? { provider: expectString(record.provider, "provider") }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Request/response correspondence
// ---------------------------------------------------------------------------

/**
 * Validate a raw Decisions response against a validated request: the answer
 * set must correspond one-to-one to the asked question IDs, and each answer
 * must have the type of the question it answers. A missing answer, an extra
 * answer, or a mismatched type is an error rather than a default, per the
 * official Decisions guidance.
 */
export function parseDecisionsExchange(
  request: DecisionsRequest,
  rawResponse: unknown,
): DecisionsResponse {
  const response = parseDecisionsResponse(rawResponse);

  for (const [id, question] of Object.entries(request.questions)) {
    const answer: DecisionsAnswer | undefined = response.answers[id];
    // hasOwn, not an indexed read alone: an inherited name (e.g. "toString")
    // would otherwise be read from the prototype chain instead of reporting a
    // missing answer.
    if (answer === undefined || !Object.hasOwn(response.answers, id)) {
      fail(`answers.${id}`, "missing answer: every asked question must be answered");
    }
    if (answer.type !== question.type) {
      fail(
        `answers.${id}.type`,
        `expected a ${question.type} answer for a ${question.type} question, got ${answer.type}`,
      );
    }
  }

  for (const id of Object.keys(response.answers)) {
    // hasOwn, not `in`: inherited names like "toString" or "constructor" must
    // not be mistaken for asked questions, and own keys named "__proto__"
    // must still be detected.
    if (!Object.hasOwn(request.questions, id)) {
      fail(`answers.${id}`, "unexpected answer: no question with this id was asked");
    }
  }

  return response;
}
