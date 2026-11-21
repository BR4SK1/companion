/**
 * Structured, privacy-safe diagnostics for the main chat boundary.
 *
 * Each completed main-chat call emits exactly one diagnostic record (see
 * `buildChatDiagnostics`) as a single-line JSON log message. The record is
 * correlated to its attempt by turn id + attempt number and captures only
 * allowlisted, bounded metadata:
 *
 * - the request as sent: requested model (the locally configured model,
 *   never a provider-supplied string), effective `max_tokens` (unset kept
 *   distinct), and requested reasoning effort/exclude (unset kept distinct);
 * - the response shape without response content: content shape
 *   (missing/null/non-string/blank/string), choice count, the finish reason
 *   when it is in the documented allowlist (anything else is recorded as
 *   an unrecognized, un-echoed value), and validated token usage
 *   (input/output/total and reasoning tokens when present);
 * - the outcome plus a validation code: the structural validation path for
 *   contract failures, or the fixed transport error kind (plus a trusted
 *   numeric HTTP status) for transport failures.
 *
 * Fields that are individually valid are preserved even when the main response
 * is invalid: an unusable content value does not discard a valid
 * `finish_reason` or usage counts, and one malformed usage field does not
 * discard the valid ones. Extraction from the raw body is defensive and
 * never throws, so diagnostics are available for every invalid response —
 * including when the relational trace write for that attempt fails.
 *
 * Privacy: prompts, replies, reasoning text, arbitrary provider messages,
 * raw response bodies, thrown error messages, secrets, and user data are
 * never read into — or rendered by — this module. Only the structural
 * shape of `choices.0.message.content` is classified; its value is never
 * logged. Provider-supplied strings (response `model`, response `id`,
 * `finish_reason`) are never echoed at all — not even identifier-shaped
 * ones, since single-word or identifier-shaped raw provider data can
 * itself be user data or credentials. The response model contributes only
 * a presence flag and a boolean `responseModelMatchesRequest` (the
 * attempt is already correlated by turn id + attempt), the response id
 * only a presence flag, and the finish reason only when it exactly
 * matches the documented allowlist. No new persisted schema is introduced
 * by these diagnostics: retention stays with the existing feature-owned
 * attempt trace for valid fields, and this log line is the local,
 * attempt-correlated diagnostic surface for invalid ones.
 */

import { ChatContractError } from "@companion/openrouter/chat";
import type {
  ChatReasoningEffort,
  ChatRequest,
} from "@companion/openrouter/chat";
import { OpenRouterTransportError } from "@companion/openrouter/transport";

export type ChatDiagnosticOutcome = "responded" | "failed" | "invalid";

export type ChatContentShape =
  | "string_nonblank"
  | "string_blank"
  | "missing"
  | "null"
  | "non_string"
  | "no_choice"
  | "no_response";

/** Fixed error codes only; never error message text. */
export type ChatDiagnosticErrorKind =
  | "none"
  | "invalid"
  | "network"
  | "timeout"
  | "http_status"
  | "invalid_json"
  | "error";

export type ChatDiagnosticReasoningEffort = ChatReasoningEffort | "unset";
export type ChatDiagnosticReasoningExclude = boolean | "unset";

/** The one structured diagnostic record emitted per completed chat call. */
export interface ChatDiagnosticsRecord {
  readonly event: "chat_diagnostics";
  readonly turnId: string;
  readonly attempt: number;
  readonly identityRevision: number;
  readonly requestModel: string;
  readonly reasoningEffort: ChatDiagnosticReasoningEffort;
  readonly reasoningExclude: ChatDiagnosticReasoningExclude;
  /** Effective `max_tokens` as sent; null means not set (kept unset). */
  readonly maxTokens: number | null;
  readonly maxTokensSet: boolean;
  readonly outcome: ChatDiagnosticOutcome;
  readonly errorKind: ChatDiagnosticErrorKind;
  /** Trusted numeric HTTP status for `http_status` failures; null otherwise. */
  readonly httpStatus: number | null;
  /** Structural path of the first contract violation; null when not applicable. */
  readonly validationPath: string | null;
  readonly responseModelPresent: boolean;
  /**
   * Whether the provider-returned model equals the requested model.
   * False when it differs, null when the response carried no usable model
   * string. The raw provider model string is never recorded.
   */
  readonly responseModelMatchesRequest: boolean | null;
  readonly responseIdPresent: boolean;
  readonly choiceCount: number | null;
  readonly contentShape: ChatContentShape;
  readonly contentPresent: boolean;
  readonly finishReason: string | null;
  readonly finishReasonPresent: boolean;
  /**
   * True only when the finish reason exactly matches the documented
   * allowlist; false when present but anything else (value not recorded);
   * null when absent.
   */
  readonly finishReasonRecognized: boolean | null;
  readonly usagePresent: boolean;
  readonly usageInputTokens: number | null;
  readonly usageOutputTokens: number | null;
  readonly usageTotalTokens: number | null;
  readonly usageReasoningTokens: number | null;
}

export interface ChatDiagnosticsInput {
  readonly turnId: string;
  readonly attempt: number;
  readonly identityRevision: number;
  readonly request: ChatRequest;
  /** Raw response body as returned; absent for transport failures. */
  readonly rawResponse?: unknown;
  readonly outcome: ChatDiagnosticOutcome;
  /** The thrown error for `failed`/`invalid` outcomes, when available. */
  readonly error?: unknown;
}

/**
 * The documented finish reasons (OpenAI-compatible set, plus OpenRouter's
 * normalized `error` for provider failures). Only an exact match is ever
 * recorded; any other value stays absent and is flagged unrecognized —
 * the raw string is never echoed.
 */
const KNOWN_FINISH_REASONS: ReadonlySet<string> = new Set([
  "stop",
  "length",
  "tool_calls",
  "content_filter",
  "function_call",
  "error",
]);

const MAX_MODEL_LENGTH = 256;
const MAX_VALIDATION_PATH_LENGTH = 128;

const SAFE_VALIDATION_PATH_PATTERN = /^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Validates the locally configured requested model before it is emitted.
 * Rejects whitespace and control characters so the value cannot inject
 * extra log lines or fields; returns null when the value is absent or
 * unsafe. Provider-supplied strings never pass through here.
 */
function safeIdentifier(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  if (value.length === 0 || value.length > maxLength) return null;
  if (/[\s\u0000-\u001f\u007f]/.test(value)) return null;
  return value;
}

function validateTokenCount(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value)) return null;
  if (value < 0 || value > Number.MAX_SAFE_INTEGER) return null;
  return value;
}

/** Structural validation path only; never the error message. */
function validationPathFor(error: unknown): string | null {
  if (!(error instanceof ChatContractError)) return null;
  const path = error.path;
  if (path.length === 0 || path.length > MAX_VALIDATION_PATH_LENGTH) {
    return null;
  }
  return SAFE_VALIDATION_PATH_PATTERN.test(path) ? path : null;
}

function httpStatusFor(error: unknown): number | null {
  if (!(error instanceof OpenRouterTransportError)) return null;
  const status = error.status;
  return typeof status === "number" &&
    Number.isInteger(status) &&
    status >= 100 &&
    status <= 599
    ? status
    : null;
}

function errorKindFor(
  outcome: ChatDiagnosticOutcome,
  error: unknown,
): ChatDiagnosticErrorKind {
  if (outcome === "responded") return "none";
  if (outcome === "invalid") return "invalid";
  if (error instanceof OpenRouterTransportError) return error.kind;
  return "error";
}

/**
 * Build the diagnostic record for one completed chat call. Never throws and
 * never includes response content, provider message text, or error text.
 */
export function buildChatDiagnostics(
  input: ChatDiagnosticsInput,
): ChatDiagnosticsRecord {
  const request = input.request;
  const reasoningEffort: ChatDiagnosticReasoningEffort =
    request.reasoning?.effort ?? "unset";
  const reasoningExclude: ChatDiagnosticReasoningExclude =
    request.reasoning?.exclude ?? "unset";
  const maxTokens = request.max_tokens ?? null;

  const base = {
    event: "chat_diagnostics" as const,
    turnId: input.turnId,
    attempt: input.attempt,
    identityRevision: input.identityRevision,
    requestModel: safeIdentifier(request.model, MAX_MODEL_LENGTH) ?? "invalid",
    reasoningEffort,
    reasoningExclude,
    maxTokens,
    maxTokensSet: request.max_tokens !== undefined,
    outcome: input.outcome,
    errorKind: errorKindFor(input.outcome, input.error),
    httpStatus: input.outcome === "failed" ? httpStatusFor(input.error) : null,
    validationPath:
      input.outcome === "invalid" ? validationPathFor(input.error) : null,
  };

  const noResponseFields = {
    responseModelPresent: false,
    responseModelMatchesRequest: null as boolean | null,
    responseIdPresent: false,
    choiceCount: null as number | null,
    contentShape: "no_response" as ChatContentShape,
    contentPresent: false,
    finishReason: null as string | null,
    finishReasonPresent: false,
    finishReasonRecognized: null as boolean | null,
    usagePresent: false,
    usageInputTokens: null as number | null,
    usageOutputTokens: null as number | null,
    usageTotalTokens: null as number | null,
    usageReasoningTokens: null as number | null,
  };

  if (input.outcome === "failed") {
    return { ...base, ...noResponseFields };
  }

  const raw = input.rawResponse;
  if (!isRecord(raw)) {
    return { ...base, ...noResponseFields, contentShape: "no_choice" as const };
  }

  // Provider-supplied model/id strings are never recorded: presence plus
  // request-equality for the model (the attempt is already correlated by
  // turn id + attempt), presence only for the id. Raw provider strings —
  // even identifier-shaped, whitespace-free ones — can themselves be raw
  // user data or credentials and must not reach the log line.
  const responseModelPresent = raw.model !== undefined;
  const responseModelMatchesRequest =
    typeof raw.model === "string" ? raw.model === request.model : null;
  const responseIdPresent = raw.id !== undefined;

  // --- content shape (structure only; the value is never copied out) ---
  let choiceCount: number | null = null;
  let contentShape: ChatContentShape = "no_choice";
  let contentPresent = false;
  let finishReason: string | null = null;
  let finishReasonPresent = false;
  let finishReasonRecognized: boolean | null = null;

  const rawChoices = raw.choices;
  if (Array.isArray(rawChoices)) {
    choiceCount = rawChoices.length;
    const firstChoice = rawChoices[0];
    if (isRecord(firstChoice)) {
      // Finish reason is preserved independently of the message shape —
      // but only when it exactly matches the documented allowlist;
      // anything else is flagged unrecognized and never echoed.
      if (firstChoice.finish_reason !== undefined) {
        finishReasonPresent = true;
        const reason = firstChoice.finish_reason;
        if (typeof reason === "string" && KNOWN_FINISH_REASONS.has(reason)) {
          finishReason = reason;
          finishReasonRecognized = true;
        } else {
          finishReason = null;
          finishReasonRecognized = false;
        }
      }
      const message = firstChoice.message;
      if (isRecord(message)) {
        const content = message.content;
        if (content !== undefined) {
          contentPresent = true;
          if (content === null) {
            contentShape = "null";
          } else if (typeof content === "string") {
            contentShape =
              content.trim().length === 0 ? "string_blank" : "string_nonblank";
          } else {
            contentShape = "non_string";
          }
        } else {
          contentShape = "missing";
        }
      } else {
        contentShape = "missing";
      }
    }
  }

  // --- usage: each field validated independently so one malformed field
  // --- preserves the valid ones; reasoning tokens when present. ---
  let usagePresent = false;
  let usageInputTokens: number | null = null;
  let usageOutputTokens: number | null = null;
  let usageTotalTokens: number | null = null;
  let usageReasoningTokens: number | null = null;
  const rawUsage = raw.usage;
  if (isRecord(rawUsage)) {
    usagePresent = true;
    usageInputTokens = validateTokenCount(rawUsage.prompt_tokens);
    usageOutputTokens = validateTokenCount(rawUsage.completion_tokens);
    usageTotalTokens = validateTokenCount(rawUsage.total_tokens);
    const details = rawUsage.completion_tokens_details;
    const fromDetails = isRecord(details)
      ? validateTokenCount(details.reasoning_tokens)
      : null;
    usageReasoningTokens =
      fromDetails ?? validateTokenCount(rawUsage.reasoning_tokens);
  }

  return {
    ...base,
    responseModelPresent,
    responseModelMatchesRequest,
    responseIdPresent,
    choiceCount,
    contentShape,
    contentPresent,
    finishReason,
    finishReasonPresent,
    finishReasonRecognized,
    usagePresent,
    usageInputTokens,
    usageOutputTokens,
    usageTotalTokens,
    usageReasoningTokens,
  };
}

/** Render the record as the single-line log message (fixed prefix + JSON). */
export function formatChatDiagnostics(record: ChatDiagnosticsRecord): string {
  return `[CHAT_DIAGNOSTIC] ${JSON.stringify(record)}`;
}
