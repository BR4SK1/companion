/**
 * BFF configuration, parsed from the environment, with fail-closed
 * semantics: when a required variable is missing or malformed, callers
 * treat the service as unavailable rather than degrading to open access.
 *
 * No secret values and no environment files are part of this repository;
 * the operator supplies credentials at runtime. Secret values (OIDC client
 * secret, session signing secret, worker token) arrive through the
 * environment and are never logged or rendered.
 *
 * Authentication identity stays at this edge: the configured values below
 * authorize the owner at the BFF and are never propagated into domain
 * records, worker calls, or job payloads (apps/web/AGENTS.md).
 *
 * The optional non-production-only test gate (see `test-gate.ts`) is parsed
 * here as well, with the same fail-closed semantics: it is enabled only by
 * an explicit `WEB_TEST_GATE_ENABLED=true`, and a malformed gate value
 * fails the whole configuration rather than opening anything. The gate is
 * never inferred from `NODE_ENV` or any other ambient signal.
 */

import { parseTestGateEnv, TEST_GATE_SESSION_SECRET_ENV } from "../../../server/gate-env.mjs";

export interface WebConfig {
  /**
   * The public origin this app is served from (scheme + host, no path).
   * Used for the OIDC redirect URI and for origin checks on
   * state-changing requests.
   */
  readonly publicOrigin: string;
  readonly oidcIssuerUrl: string;
  readonly oidcClientId: string;
  readonly oidcClientSecret: string;
  /** HMAC signing secret for session and flow cookies (>= 32 chars). */
  readonly sessionSecret: string;
  readonly sessionTtlSeconds: number;
  /**
   * Explicit owner allowlist: the only identity-provider subjects that may
   * hold a session. Fail-closed: an empty list denies everyone.
   */
  readonly ownerSubjects: readonly string[];
  /** Base URL of the worker's private HTTP API. */
  readonly workerUrl: string;
  /** Shared service-to-service credential; must match the worker's token. */
  readonly workerToken: string;
  readonly workerTimeoutMs: number;
  /**
   * The non-production-only test gate's configuration, or `null` when the
   * gate is disabled (the default, and the only state a production
   * deployment may run in). Present only when
   * `WEB_TEST_GATE_ENABLED` is explicitly "true"; see `test-gate.ts` for
   * the runtime decisions and apps/web/README.md for the security model.
   */
  readonly testGate: TestGateConfig | null;
}

/** The test gate's validated configuration (loopback-only E2E entry). */
export interface TestGateConfig {
  /** The dedicated listener's port; the listener binds 127.0.0.1 only. */
  readonly port: number;
  /**
   * Dedicated signing secret for test sessions; required to differ from
   * the owner session secret.
   */
  readonly sessionSecret: string;
  readonly sessionTtlSeconds: number;
}

export class WebConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebConfigError";
  }
}

const DEFAULT_SESSION_TTL_SECONDS = 43_200; // 12 hours
const DEFAULT_WORKER_TIMEOUT_MS = 10_000;
const MIN_SESSION_SECRET_LENGTH = 32;

function requireString(
  env: Record<string, string | undefined>,
  name: string,
): string {
  const value = env[name];
  if (value === undefined || value.length === 0) {
    throw new WebConfigError(`missing required environment variable: ${name}`);
  }
  return value;
}

function optionalNumber(
  env: Record<string, string | undefined>,
  name: string,
  fallback: number,
  constraints: { readonly positive?: true },
): number {
  const raw = env[name];
  if (raw === undefined || raw.length === 0) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || (constraints.positive && value <= 0)) {
    throw new WebConfigError(`${name} is not a positive number: ${raw}`);
  }
  return value;
}

function parseHttpUrl(name: string, value: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new WebConfigError(`${name} is not a valid URL: ${value}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new WebConfigError(`${name} must be an http(s) URL: ${value}`);
  }
  return parsed;
}

/**
 * Build the BFF configuration from an environment-like record. Throws
 * `WebConfigError` naming the offending variable on any violation.
 */
export function loadWebConfig(
  env: Record<string, string | undefined>,
): WebConfig {
  // The public origin is normalized to scheme://host[:port] so it can be
  // compared against request origins and used as the redirect URI base
  // regardless of how it was configured.
  const publicUrl = parseHttpUrl("WEB_PUBLIC_URL", requireString(env, "WEB_PUBLIC_URL"));
  const publicOrigin = publicUrl.origin;
  // The issuer is kept exactly as configured (validated, not normalized) so
  // provider-side issuer validation compares the identifier as registered.
  const oidcIssuerUrl = requireString(env, "WEB_OIDC_ISSUER_URL");
  parseHttpUrl("WEB_OIDC_ISSUER_URL", oidcIssuerUrl);
  const oidcClientId = requireString(env, "WEB_OIDC_CLIENT_ID");
  const oidcClientSecret = requireString(env, "WEB_OIDC_CLIENT_SECRET");
  const sessionSecret = requireString(env, "WEB_SESSION_SECRET");
  if (sessionSecret.length < MIN_SESSION_SECRET_LENGTH) {
    throw new WebConfigError(
      `WEB_SESSION_SECRET must be at least ${String(MIN_SESSION_SECRET_LENGTH)} characters`,
    );
  }
  // The worker base URL is stored without a trailing slash so endpoint
  // paths can be appended directly.
  const workerUrl = parseHttpUrl(
    "WEB_WORKER_URL",
    requireString(env, "WEB_WORKER_URL"),
  ).toString().replace(/\/+$/, "");

  const rawSubjects = requireString(env, "WEB_OWNER_SUBJECTS");
  const ownerSubjects = rawSubjects
    .split(",")
    .map((subject) => subject.trim())
    .filter((subject) => subject.length > 0);
  if (ownerSubjects.length === 0) {
    throw new WebConfigError(
      "WEB_OWNER_SUBJECTS must list at least one allowed subject",
    );
  }

  // The non-production-only test gate: disabled unless explicitly enabled,
  // and fully validated when enabled — a malformed gate value fails the
  // whole configuration (fail closed) instead of opening anything.
  let testGate: TestGateConfig | null = null;
  try {
    const gate = parseTestGateEnv(env);
    if (gate.enabled) {
      if (gate.sessionSecret === sessionSecret) {
        throw new Error(
          `${TEST_GATE_SESSION_SECRET_ENV} must differ from WEB_SESSION_SECRET (the test gate must never sign sessions with the owner session secret)`,
        );
      }
      // Port-collision and value validation are shared with the custom
      // server via parseTestGateEnv; only the secret-equality check needs
      // both secrets and therefore lives here.
      testGate = {
        port: gate.port,
        sessionSecret: gate.sessionSecret,
        sessionTtlSeconds: gate.sessionTtlSeconds,
      };
    }
  } catch (error) {
    throw new WebConfigError(
      error instanceof Error ? error.message : "invalid test gate configuration",
    );
  }

  return {
    publicOrigin,
    oidcIssuerUrl,
    oidcClientId,
    oidcClientSecret,
    sessionSecret,
    sessionTtlSeconds: optionalNumber(env, "WEB_SESSION_TTL_SECONDS", DEFAULT_SESSION_TTL_SECONDS, {
      positive: true,
    }),
    ownerSubjects,
    workerUrl,
    workerToken: requireString(env, "WEB_WORKER_TOKEN"),
    workerTimeoutMs: optionalNumber(env, "WEB_WORKER_TIMEOUT_MS", DEFAULT_WORKER_TIMEOUT_MS, {
      positive: true,
    }),
    testGate,
  };
}

/**
 * Non-throwing variant for request paths: a misconfigured deployment is
 * reported as `ok: false` so callers fail closed with a generic
 * "unavailable" surface instead of crashing or degrading to open access.
 */
export type WebConfigResult =
  | { readonly ok: true; readonly config: WebConfig }
  | { readonly ok: false };

export function loadWebConfigSafe(
  env: Record<string, string | undefined>,
): WebConfigResult {
  try {
    return { ok: true, config: loadWebConfig(env) };
  } catch {
    return { ok: false };
  }
}
