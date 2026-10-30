/**
 * Shared OpenRouter transport: connection-level request concerns only.
 *
 * This module performs one JSON POST with bearer authentication, applies a
 * timeout, and translates transport failures into typed errors. It knows
 * nothing about any capability contract: request and response payloads stay
 * opaque here, and typed validation belongs to the capability modules
 * (`decisions.ts`, `chat.ts`) or the composing application.
 *
 * Deliberately NOT included (application/operations policy): retries,
 * backoff, fallback routing, model or provider selection, credential
 * storage, caching, streaming, and capability probing.
 *
 * Error bodies are truncated before being attached to errors so a hostile or
 * broken endpoint cannot balloon memory; the truncation limit is a transport
 * bound, not response validation.
 */

export type TransportErrorKind =
  | "network"
  | "timeout"
  | "http_status"
  | "invalid_json";

export class OpenRouterTransportError extends Error {
  readonly kind: TransportErrorKind;
  /** HTTP status for `http_status` errors; undefined otherwise. */
  readonly status?: number;
  /** Truncated response body for `http_status` errors; undefined otherwise. */
  readonly body?: string;

  constructor(
    kind: TransportErrorKind,
    message: string,
    options: { status?: number; body?: string; cause?: unknown } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : {});
    this.name = "OpenRouterTransportError";
    this.kind = kind;
    this.status = options.status;
    this.body = options.body;
  }
}

export interface PostJsonOptions {
  /** Bearer token; omit only for endpoints that need no authorization. */
  readonly apiKey?: string;
  /** Abort the request after this many milliseconds. No timeout when absent. */
  readonly timeoutMs?: number;
  /** Injectable fetch for tests; defaults to global `fetch`. */
  readonly fetchImpl?: typeof fetch;
  /** Extra headers merged after the defaults; later keys win. */
  readonly headers?: Readonly<Record<string, string>>;
}

/** Upper bound on response/error text kept on errors, in characters. */
const MAX_RETAINED_BODY_LENGTH = 2000;

function truncate(text: string): string {
  return text.length <= MAX_RETAINED_BODY_LENGTH
    ? text
    : `${text.slice(0, MAX_RETAINED_BODY_LENGTH)}…`;
}

/**
 * POST `body` as JSON and resolve with the parsed JSON response body.
 * Throws `OpenRouterTransportError` for network failure, timeout, non-2xx
 * status, or a non-JSON success body. No status-specific interpretation and
 * no retries happen here.
 */
export async function postJson(
  url: string,
  body: unknown,
  options: PostJsonOptions = {},
): Promise<unknown> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeout =
    options.timeoutMs !== undefined
      ? setTimeout(() => controller.abort(), options.timeoutMs)
      : undefined;

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(options.apiKey !== undefined
          ? { Authorization: `Bearer ${options.apiKey}` }
          : {}),
        ...(options.headers ?? {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new OpenRouterTransportError(
        "timeout",
        `request to ${url} timed out after ${String(options.timeoutMs ?? 0)}ms`,
        { cause: error },
      );
    }
    throw new OpenRouterTransportError(
      "network",
      `request to ${url} failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new OpenRouterTransportError(
      "http_status",
      `request to ${url} returned HTTP ${String(response.status)}`,
      { status: response.status, body: text.length > 0 ? truncate(text) : undefined },
    );
  }

  const text = await response.text();
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new OpenRouterTransportError(
      "invalid_json",
      `response from ${url} is not valid JSON`,
      { cause: error },
    );
  }
}
