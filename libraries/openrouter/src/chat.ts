/**
 * OpenRouter Chat Completions contract (OpenAI-compatible
 * `POST /api/v1/chat/completions`, non-streaming).
 *
 * Like `decisions.ts`, this is a capability contract only: it validates
 * request and response shapes without transport, credentials, retries,
 * fallback, or policy. Validation mirrors the published OpenAI-compatible
 * schema:
 *
 * - `model` and at least one message are required; message roles are exactly
 *   `system`, `user`, or `assistant`; message `content` must be a string —
 *   multimodal content-part arrays are outside this contract's approved
 *   text-only scope and are rejected explicitly rather than silently dropped.
 * - `temperature` (finite number) and `max_tokens` (integer >= 1) are
 *   optional and are never invented or defaulted.
 * - `reasoning` is optional and typed as OpenRouter's reasoning options
 *   (`effort` and/or `exclude`); it stays optional and is never invented
 *   or defaulted by this contract — callers that want reasoning must set
 *   it explicitly.
 * - Responses require `model` and at least one choice whose message role is
 *   `assistant` with string `content`. `id`, `finish_reason`, and `usage`
 *   are optional and stay optional: they are read through presence checks,
 *   never fabricated. Usage token counts must be integers when present.
 * - Unknown extra properties are accepted (the published schema does not
 *   forbid them) but are not surfaced on parsed values.
 * - No normalization: content, finish reasons, and counts are preserved as
 *   returned.
 *
 * Tool calls, streaming deltas, logprobs, and image inputs are outside this
 * contract's scope and are rejected as invalid rather than approximated.
 */

export class ChatContractError extends Error {
  /** Dotted path to the offending value, e.g. `choices.0.message`. */
  readonly path: string;

  constructor(path: string, message: string) {
    super(path.length > 0 ? `${path}: ${message}` : message);
    this.name = "ChatContractError";
    this.path = path;
  }
}

function fail(path: string, message: string): never {
  throw new ChatContractError(path, message);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
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

// ---------------------------------------------------------------------------
// Request contract
// ---------------------------------------------------------------------------

export type ChatRole = "system" | "user" | "assistant";

export interface ChatRequestMessage {
  readonly role: ChatRole;
  readonly content: string;
}

/** OpenRouter reasoning effort levels accepted by the chat contract. */
export type ChatReasoningEffort =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

/**
 * OpenRouter `reasoning` options for a chat request. Both fields are
 * optional in the type but at least one must be present in a request:
 * `effort` sets the reasoning budget level and `exclude: true` asks the
 * provider not to return reasoning content in the response. An absent
 * `reasoning` field means no reasoning options are sent — this contract
 * never invents a default.
 */
export interface ChatReasoning {
  readonly effort?: ChatReasoningEffort;
  readonly exclude?: boolean;
}

export interface ChatRequest {
  readonly model: string;
  readonly messages: readonly ChatRequestMessage[];
  readonly temperature?: number;
  readonly max_tokens?: number;
  readonly reasoning?: ChatReasoning;
}

const CHAT_ROLES: readonly ChatRole[] = ["system", "user", "assistant"];

const CHAT_REASONING_EFFORTS: readonly ChatReasoningEffort[] = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

function parseReasoning(value: unknown): ChatReasoning {
  const record = expectObject(value, "reasoning");
  const hasEffort = record.effort !== undefined;
  const hasExclude = record.exclude !== undefined;
  if (!hasEffort && !hasExclude) {
    fail("reasoning", "expected at least one of effort or exclude");
  }
  let effort: ChatReasoningEffort | undefined;
  if (hasEffort) {
    const raw = expectString(record.effort, "reasoning.effort");
    if (!CHAT_REASONING_EFFORTS.includes(raw as ChatReasoningEffort)) {
      fail(
        "reasoning.effort",
        `unexpected effort ${JSON.stringify(raw)}; expected one of ${CHAT_REASONING_EFFORTS.map((level) => JSON.stringify(level)).join(", ")}`,
      );
    }
    effort = raw as ChatReasoningEffort;
  }
  let exclude: boolean | undefined;
  if (hasExclude) {
    if (typeof record.exclude !== "boolean") {
      fail("reasoning.exclude", "expected a boolean");
    }
    exclude = record.exclude;
  }
  return {
    ...(effort !== undefined ? { effort } : {}),
    ...(exclude !== undefined ? { exclude } : {}),
  };
}

function parseRequestMessage(
  index: number,
  value: unknown,
): ChatRequestMessage {
  const path = `messages.${String(index)}`;
  const record = expectObject(value, path);
  const role = expectString(record.role, `${path}.role`);
  if (!CHAT_ROLES.includes(role as ChatRole)) {
    fail(
      `${path}.role`,
      `unexpected role ${JSON.stringify(role)}; expected "system", "user", or "assistant"`,
    );
  }
  if (record.content === undefined) {
    fail(`${path}.content`, "missing required field");
  }
  if (typeof record.content !== "string") {
    // Includes multimodal content-part arrays: out of the text-only scope.
    fail(`${path}.content`, "expected a string (content parts are out of scope)");
  }
  return { role: role as ChatRole, content: record.content };
}

/**
 * Validate an untyped chat request against the published schema. Throws
 * `ChatContractError` on the first violation. Optional request fields
 * (`temperature`, `max_tokens`, `reasoning`) stay optional and are not
 * invented when absent.
 */
export function parseChatRequest(value: unknown): ChatRequest {
  const record = expectObject(value, "request");
  const model = expectString(record.model, "model");

  const rawMessages = record.messages;
  if (rawMessages === undefined) fail("messages", "missing required field");
  if (!Array.isArray(rawMessages)) fail("messages", "expected an array");
  if (rawMessages.length === 0) {
    fail("messages", "expected at least one message");
  }
  const messages = rawMessages.map((message, index) =>
    parseRequestMessage(index, message),
  );

  return {
    model,
    messages,
    ...(record.temperature !== undefined
      ? { temperature: expectFinite(record.temperature, "temperature") }
      : {}),
    ...(record.max_tokens !== undefined
      ? {
          max_tokens: (() => {
            const parsed = expectInteger(record.max_tokens, "max_tokens");
            if (parsed < 1) fail("max_tokens", "expected an integer >= 1");
            return parsed;
          })(),
        }
      : {}),
    ...(record.reasoning !== undefined
      ? { reasoning: parseReasoning(record.reasoning) }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Response contract
// ---------------------------------------------------------------------------

export interface ChatChoiceMessage {
  readonly role: "assistant";
  readonly content: string;
}

export interface ChatChoice {
  readonly message: ChatChoiceMessage;
  readonly finish_reason?: string;
}

export interface ChatUsage {
  readonly prompt_tokens: number;
  readonly completion_tokens: number;
  readonly total_tokens?: number;
}

export interface ChatResponse {
  readonly id?: string;
  readonly model: string;
  readonly choices: readonly ChatChoice[];
  readonly usage?: ChatUsage;
}

function parseChoice(index: number, value: unknown): ChatChoice {
  const path = `choices.${String(index)}`;
  const record = expectObject(value, path);
  const messageRecord = expectObject(record.message, `${path}.message`);
  const role = expectString(messageRecord.role, `${path}.message.role`);
  if (role !== "assistant") {
    fail(
      `${path}.message.role`,
      `unexpected role ${JSON.stringify(role)}; expected "assistant"`,
    );
  }
  const content = expectString(
    messageRecord.content,
    `${path}.message.content`,
  );
  return {
    message: { role: "assistant", content },
    ...(record.finish_reason !== undefined
      ? {
          finish_reason: expectString(
            record.finish_reason,
            `${path}.finish_reason`,
          ),
        }
      : {}),
  };
}

/**
 * Validate an untyped chat response against the published schema. Throws
 * `ChatContractError` on the first violation. Optional fields (`id`,
 * `finish_reason`, `usage`, `usage.total_tokens`) stay optional and are not
 * invented when absent.
 */
export function parseChatResponse(value: unknown): ChatResponse {
  const record = expectObject(value, "response");
  const model = expectString(record.model, "model");

  const rawChoices = record.choices;
  if (rawChoices === undefined) fail("choices", "missing required field");
  if (!Array.isArray(rawChoices)) fail("choices", "expected an array");
  if (rawChoices.length === 0) {
    fail("choices", "expected at least one choice");
  }
  const choices = rawChoices.map((choice, index) => parseChoice(index, choice));

  let usage: ChatUsage | undefined;
  if (record.usage !== undefined) {
    const usageRecord = expectObject(record.usage, "usage");
    usage = {
      prompt_tokens: expectInteger(usageRecord.prompt_tokens, "usage.prompt_tokens"),
      completion_tokens: expectInteger(
        usageRecord.completion_tokens,
        "usage.completion_tokens",
      ),
      ...(usageRecord.total_tokens !== undefined
        ? {
            total_tokens: expectInteger(
              usageRecord.total_tokens,
              "usage.total_tokens",
            ),
          }
        : {}),
    };
  }

  return {
    model,
    choices,
    ...(record.id !== undefined ? { id: expectString(record.id, "id") } : {}),
    ...(usage !== undefined ? { usage } : {}),
  };
}
