/**
 * Worker configuration, parsed from the environment. No secret values and no
 * environment files are part of this repository; the operator supplies
 * credentials and the database URL at runtime.
 *
 * Numeric defaults are provisional operating points for the first slice, not
 * selected policy; every one of them is configurable and called out in
 * `apps/worker/README.md`.
 */

import { MIN_LEASE_SECONDS } from "./work/timing.ts";
import { isReasoningEffort, type ReasoningEffort } from "./memory/llm.ts";

export interface OpenRouterWorkerConfig {
  readonly apiKey: string;
  readonly chatUrl: string;
  readonly decisionsUrl: string;
  readonly chatModel: string;
  /**
   * Optional reasoning-effort override for main chat. Unset preserves the
   * legacy behavior: no reasoning options are sent.
   */
  readonly chatReasoningEffort?: ReasoningEffort;
  readonly decisionModel: string;
  readonly chatTimeoutMs: number;
  readonly decisionTimeoutMs: number;
}

export interface WorkerConfig {
  readonly databaseUrl: string;
  readonly openrouter: OpenRouterWorkerConfig;
  readonly leaseSeconds: number;
  readonly pollSeconds: number;
  readonly contextMessageLimit: number;
  /**
   * Tolerance for a client clock running ahead of the server clock when
   * accepting a client-reported send time as the message's effective time,
   * in milliseconds (see `conversation/timing.ts`). `0` disables the
   * tolerance entirely.
   */
  readonly clientTimeMaxAheadMs: number;
  /**
   * Private service-to-service API bearer token. Required, never optional:
   * the HTTP API fails closed rather than serving unauthenticated traffic.
   * The web BFF holds the same value (`WEB_WORKER_TOKEN`).
   */
  readonly apiToken: string;
  /** Explicit service credentials supplied only to DB-authored prompt modules. */
  readonly promptModuleCredentials: Readonly<Record<string, string>>;
  /** Private HTTP API listener (cluster-internal only; no public ingress). */
  readonly http: WorkerHttpConfig;
}

export interface WorkerHttpConfig {
  readonly host: string;
  readonly port: number;
}

export class WorkerConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkerConfigError";
  }
}

const DEFAULT_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_DECISIONS_URL = "https://openrouter.ai/api/alpha/decisions";
const DEFAULT_LEASE_SECONDS = 60;
const DEFAULT_POLL_SECONDS = 1;
const DEFAULT_CONTEXT_MESSAGE_LIMIT = 40;
const DEFAULT_CHAT_TIMEOUT_MS = 120_000;
const DEFAULT_DECISION_TIMEOUT_MS = 30_000;
const DEFAULT_HTTP_HOST = "0.0.0.0";
const DEFAULT_HTTP_PORT = 8080;
const DEFAULT_CLIENT_TIME_MAX_AHEAD_MS = 10_000;

function requireString(
  env: Record<string, string | undefined>,
  name: string,
): string {
  const value = env[name];
  if (value === undefined || value.length === 0) {
    throw new WorkerConfigError(`missing required environment variable: ${name}`);
  }
  return value;
}

function optionalUrl(
  env: Record<string, string | undefined>,
  name: string,
  fallback: string,
): string {
  const value = env[name];
  if (value === undefined || value.length === 0) {
    return fallback;
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new WorkerConfigError(`${name} is not a valid URL: ${value}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new WorkerConfigError(
      `${name} must be an http(s) URL, got: ${value}`,
    );
  }
  return value;
}

function optionalNumber(
  env: Record<string, string | undefined>,
  name: string,
  fallback: number,
  constraints: {
    readonly integer?: boolean;
    readonly positive?: boolean;
    readonly minimum?: number;
  },
): number {
  const raw = env[name];
  if (raw === undefined || raw.length === 0) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new WorkerConfigError(`${name} is not a finite number: ${raw}`);
  }
  if (constraints.integer && !Number.isInteger(value)) {
    throw new WorkerConfigError(`${name} must be an integer: ${raw}`);
  }
  if (constraints.positive && value <= 0) {
    throw new WorkerConfigError(`${name} must be positive: ${raw}`);
  }
  if (
    constraints.minimum !== undefined &&
    value < constraints.minimum
  ) {
    throw new WorkerConfigError(
      `${name} must be at least ${String(constraints.minimum)}: ${raw}`,
    );
  }
  return value;
}

function optionalReasoningEffort(
  env: Record<string, string | undefined>,
  name: string,
): ReasoningEffort | undefined {
  const value = env[name];
  if (value === undefined || value.length === 0) return undefined;
  if (!isReasoningEffort(value)) {
    throw new WorkerConfigError(
      `${name} must be one of none, minimal, low, medium, high, xhigh, max: ${value}`,
    );
  }
  return value;
}

function namedPromptModuleValues(
  env: Record<string, string | undefined>,
  name: string,
): Readonly<Record<string, string>> {
  const raw = env[name];
  if (raw === undefined || raw.length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new WorkerConfigError(`${name} must be a JSON object of named strings`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new WorkerConfigError(`${name} must be a JSON object of named strings`);
  }
  const entries = Object.entries(parsed);
  for (const [key, value] of entries) {
    if (!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(key) || typeof value !== "string") {
      throw new WorkerConfigError(`${name} must contain only named strings`);
    }
  }
  return Object.fromEntries(entries);
}

function promptModuleCredentials(
  env: Record<string, string | undefined>,
): Readonly<Record<string, string>> {
  return Object.freeze({
    ...namedPromptModuleValues(env, "WORKER_PROMPT_MODULE_SETTINGS_JSON"),
    ...namedPromptModuleValues(env, "WORKER_PROMPT_MODULE_CREDENTIALS_JSON"),
  });
}

function optionalHttpHost(
  env: Record<string, string | undefined>,
  name: string,
  fallback: string,
): string {
  const value = env[name];
  if (value === undefined || value.length === 0) {
    return fallback;
  }
  return value;
}

function optionalPort(
  env: Record<string, string | undefined>,
  name: string,
  fallback: number,
): number {
  const value = optionalNumber(env, name, fallback, { integer: true, positive: true });
  if (value > 65_535) {
    throw new WorkerConfigError(`${name} must be at most 65535: ${String(value)}`);
  }
  return value;
}

/**
 * Build the worker configuration from an environment-like record. Throws
 * `WorkerConfigError` with the offending variable name on any violation.
 */
export function loadWorkerConfig(
  env: Record<string, string | undefined>,
): WorkerConfig {
  const databaseUrl = requireString(env, "WORKER_DATABASE_URL");
  const apiKey = requireString(env, "OPENROUTER_API_KEY");
  const chatModel = requireString(env, "WORKER_CHAT_MODEL");
  const chatReasoningEffort = optionalReasoningEffort(
    env,
    "WORKER_CHAT_REASONING_EFFORT",
  );
  const decisionModel = requireString(env, "WORKER_DECISION_MODEL");
  // The private HTTP API has no unauthenticated mode: without a configured
  // service credential the worker must fail at startup, not serve openly.
  const apiToken = requireString(env, "WORKER_API_TOKEN");

  return {
    databaseUrl,
    openrouter: {
      apiKey,
      chatUrl: optionalUrl(env, "WORKER_OPENROUTER_CHAT_URL", DEFAULT_CHAT_URL),
      decisionsUrl: optionalUrl(
        env,
        "WORKER_OPENROUTER_DECISIONS_URL",
        DEFAULT_DECISIONS_URL,
      ),
      chatModel,
      ...(chatReasoningEffort !== undefined ? { chatReasoningEffort } : {}),
      decisionModel,
      chatTimeoutMs: optionalNumber(
        env,
        "WORKER_CHAT_TIMEOUT_MS",
        DEFAULT_CHAT_TIMEOUT_MS,
        { integer: true, positive: true },
      ),
      decisionTimeoutMs: optionalNumber(
        env,
        "WORKER_DECISION_TIMEOUT_MS",
        DEFAULT_DECISION_TIMEOUT_MS,
        { integer: true, positive: true },
      ),
    },
    leaseSeconds: optionalNumber(env, "WORKER_LEASE_SECONDS", DEFAULT_LEASE_SECONDS, {
      positive: true,
      // Must leave room for the engine heartbeat (lease/3, at least 1000ms);
      // see `work/timing.ts`. A shorter lease would expire before its first
      // renewal and every turn would be reclaimed and fenced mid-flight.
      minimum: MIN_LEASE_SECONDS,
    }),
    pollSeconds: optionalNumber(env, "WORKER_POLL_SECONDS", DEFAULT_POLL_SECONDS, {
      positive: true,
    }),
    contextMessageLimit: optionalNumber(
      env,
      "WORKER_CONTEXT_MESSAGE_LIMIT",
      DEFAULT_CONTEXT_MESSAGE_LIMIT,
      { integer: true, positive: true },
    ),
    clientTimeMaxAheadMs: optionalNumber(
      env,
      "WORKER_CLIENT_TIME_MAX_AHEAD_MS",
      DEFAULT_CLIENT_TIME_MAX_AHEAD_MS,
      { integer: true, minimum: 0 },
    ),
    apiToken,
    promptModuleCredentials: promptModuleCredentials(env),
    http: {
      host: optionalHttpHost(env, "WORKER_HTTP_HOST", DEFAULT_HTTP_HOST),
      port: optionalPort(env, "WORKER_HTTP_PORT", DEFAULT_HTTP_PORT),
    },
  };
}
