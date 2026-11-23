/**
 * Fixed error categories for memory-pipeline diagnostics.
 *
 * Operation traces, `memory_run.error`, and memory log lines are durable
 * metadata. Error messages are arbitrary text: provider responses, database
 * constraint details, and internal messages can carry model-derived private
 * content, and no redaction heuristic is trustworthy against arbitrary
 * output. So durable diagnostics never record error text at all — they
 * record one of these fixed categories, plus only structured, trusted
 * values (an HTTP status number, a Postgres SQLSTATE code).
 */

/**
 * The fixed categories (base forms; `llm_http_status_<n>` and `db_<sqlstate>`
 * carry only trusted numeric codes). The set is closed; callers must never
 * interpolate anything else into a category.
 */
export const MEMORY_ERROR_CATEGORIES = [
  "llm_http_status",
  "llm_timeout",
  "llm_network",
  "llm_invalid_json",
  "llm_output_invalid",
  "llm_output_truncated",
  "llm_attribution_invalid",
  "source_budget_exceeded",
  "db_error",
  "config_error",
  "internal_error",
] as const;

/**
 * Closed set of structural-validation sub-reasons for `MemoryLlmOutputError`.
 * Safe for durable operation details and logs: never derived from model output
 * or error message text.
 */
export const MEMORY_LLM_OUTPUT_REASONS = [
  "json_parse",
  "not_object",
  "missing_content",
  "empty_content",
  "content_too_long",
  "unknown_observation_id",
  "schema_mismatch",
  "attribution_invalid",
] as const;

export type MemoryLlmOutputReason = (typeof MEMORY_LLM_OUTPUT_REASONS)[number];

const OUTPUT_REASON_SET: ReadonlySet<string> = new Set(MEMORY_LLM_OUTPUT_REASONS);

/**
 * Return the closed-set structural-validation reason for a `MemoryLlmOutputError`,
 * or null when absent or unrecognized. Never reads `error.message`.
 */
export function memoryOutputErrorReason(error: unknown): MemoryLlmOutputReason | null {
  if (!(error instanceof Error) || error.name !== "MemoryLlmOutputError") {
    return null;
  }
  const reason = (error as { readonly reason?: unknown }).reason;
  return typeof reason === "string" && OUTPUT_REASON_SET.has(reason)
    ? (reason as MemoryLlmOutputReason)
    : null;
}

/** Typed error for LLM responses that stopped due to `finish_reason === "length"`. */
export class MemoryLlmTruncatedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemoryLlmTruncatedError";
  }
}

/** Typed error when even the minimum unit of memory input exceeds its budget. */
export class MemorySourceBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemorySourceBudgetError";
  }
}

interface TransportErrorLike {
  readonly name: string;
  readonly kind?: unknown;
  readonly status?: unknown;
}

interface PgErrorLike {
  readonly name?: unknown;
  readonly code?: unknown;
}

const SQLSTATE_PATTERN = /^[0-9A-Z]{5}$/;

export {
  /** Re-exported so callers can classify without importing the library. */
  OpenRouterTransportError,
} from "@companion/openrouter/transport";

/**
 * Classify an error into a fixed category. The category string is safe for
 * durable metadata and logs: it is built only from closed sets and trusted
 * numeric codes, never from error message text.
 */
export function memoryErrorCategory(error: unknown): string {
  if (error instanceof Error && error.name === "OpenRouterTransportError") {
    const transport = error as unknown as TransportErrorLike;
    switch (transport.kind) {
      case "timeout":
        return "llm_timeout";
      case "network":
        return "llm_network";
      case "invalid_json":
        return "llm_invalid_json";
      case "http_status": {
        const status = transport.status;
        // The status is a trusted numeric code from the transport; only a
        // real HTTP status range is ever interpolated.
        return typeof status === "number" && Number.isInteger(status) &&
            status >= 100 && status <= 599
          ? `llm_http_status_${String(status)}`
          : "llm_http_status";
      }
      default:
        return "llm_http_status";
    }
  }
  if (error instanceof Error && error.name === "MemoryLlmOutputError") {
    return "llm_output_invalid";
  }
  if (error instanceof Error && error.name === "MemoryLlmTruncatedError") {
    return "llm_output_truncated";
  }
  if (error instanceof Error && error.name === "FactExtractionAttributionError") {
    return "llm_attribution_invalid";
  }
  if (error instanceof Error && error.name === "MemorySourceBudgetError") {
    return "source_budget_exceeded";
  }
  if (error instanceof Error && error.name === "MemoryConfigurationError") {
    return "config_error";
  }
  if (error instanceof Error) {
    const candidate = error as unknown as PgErrorLike;
    // Postgres errors carry a fixed five-character SQLSTATE in `code`.
    // That code is a closed vocabulary; the message text is not recorded.
    if (typeof candidate.code === "string" && SQLSTATE_PATTERN.test(candidate.code)) {
      return `db_${candidate.code}`;
    }
  }
  return "internal_error";
}
