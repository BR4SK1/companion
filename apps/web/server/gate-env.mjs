/**
 * Test-entry gate environment: shared, dependency-free configuration parsing
 * and channel-attestation constants for the loopback-only test gate.
 *
 * The gate is an additional HTTP listener bound strictly to `127.0.0.1`
 * inside the pod's network namespace, serving the full application without
 * Keycloak sign-in for non-production E2E testing (reachable only through
 * `kubectl port-forward`).
 *
 * Fail-closed rules:
 * - Enabled only when `WEB_TEST_GATE_ENABLED` is exactly `"true"`; never
 *   inferred from `NODE_ENV` or any other ambient signal.
 * - When enabled, `WEB_TEST_GATE_PORT` (1..65535, distinct from `PORT`) and
 *   `WEB_TEST_GATE_SESSION_SECRET` (>= 32 chars, distinct from
 *   `WEB_SESSION_SECRET` as enforced by `config.ts`) are required; invalid
 *   values throw.
 * - The listener enforces channel integrity on every request: the Host
 *   header must be `127.0.0.1:<port>` and forwarding/proxy headers are
 *   refused (DNS-rebinding defense).
 */

export const TEST_GATE_ENABLED_ENV = "WEB_TEST_GATE_ENABLED";
export const TEST_GATE_PORT_ENV = "WEB_TEST_GATE_PORT";
export const TEST_GATE_SESSION_SECRET_ENV = "WEB_TEST_GATE_SESSION_SECRET";
export const TEST_GATE_SESSION_TTL_ENV = "WEB_TEST_GATE_SESSION_TTL_SECONDS";

/** Header injected by the loopback test listener carrying the in-memory token. */
export const TEST_ATTESTATION_HEADER = "x-companion-test-entry";

/** `globalThis` key holding the process-random channel attestation token. */
export const TEST_CHANNEL_TOKEN_GLOBAL_KEY = "__companionTestGateChannelToken";

/** Default test-session lifetime in seconds (one hour). */
export const DEFAULT_TEST_SESSION_TTL_SECONDS = 3600;

/** Minimum test-session secret length, matching the owner session secret. */
export const MIN_TEST_SESSION_SECRET_LENGTH = 32;

/** Forwarding/proxy headers refused outright on the test channel. */
export const TEST_CHANNEL_FORBIDDEN_HEADERS = Object.freeze([
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-port",
  "x-forwarded-proto",
  "x-forwarded-scheme",
  "x-forwarded-ssl",
]);

/**
 * True when any forwarding/proxy header is present in a lowercased header map.
 *
 * @param {Record<string, unknown> | null | undefined} headers
 * @returns {boolean}
 */
export function hasTestChannelForbiddenHeaders(headers) {
  if (typeof headers !== "object" || headers === null) {
    return false;
  }
  return TEST_CHANNEL_FORBIDDEN_HEADERS.some((name) => headers[name] !== undefined);
}

/**
 * True when the raw Host header matches `127.0.0.1:<port>` (or `127.0.0.1`
 * for port 80). Rejects DNS-rebinding hosts and `localhost`; only ever rejects,
 * never grants access.
 *
 * @param {string | null | undefined} hostHeader
 * @param {number} port
 * @returns {boolean}
 */
export function isExpectedTestHost(hostHeader, port) {
  if (typeof hostHeader !== "string" || hostHeader.length === 0) {
    return false;
  }
  if (hostHeader === `127.0.0.1:${String(port)}`) {
    return true;
  }
  return port === 80 && hostHeader === "127.0.0.1";
}

/**
 * Parse the test gate's environment. Returns `{ enabled: false }` unless
 * `WEB_TEST_GATE_ENABLED` is exactly `"true"`. Throws a named-variable error
 * when enabled with missing or invalid values.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {{
 *   enabled: false,
 * } | {
 *   enabled: true,
 *   port: number,
 *   sessionSecret: string,
 *   sessionTtlSeconds: number,
 * }}
 */
export function parseTestGateEnv(env) {
  if (env[TEST_GATE_ENABLED_ENV] !== "true") {
    return { enabled: false };
  }
  const port = parseOptionalPositiveInt(TEST_GATE_PORT_ENV, env[TEST_GATE_PORT_ENV], Number.NaN);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(
      `${TEST_GATE_PORT_ENV} must be an integer between 1 and 65535 when the test gate is enabled`,
    );
  }
  const mainPort =
    env["PORT"] === undefined || env["PORT"].length === 0 ? Number.NaN : Number(env["PORT"]);
  if (Number.isInteger(mainPort) && mainPort === port) {
    throw new Error(`${TEST_GATE_PORT_ENV} must differ from the main listener port (PORT)`);
  }
  const sessionSecret = env[TEST_GATE_SESSION_SECRET_ENV];
  if (typeof sessionSecret !== "string" || sessionSecret.length < MIN_TEST_SESSION_SECRET_LENGTH) {
    throw new Error(
      `${TEST_GATE_SESSION_SECRET_ENV} must be at least ${String(MIN_TEST_SESSION_SECRET_LENGTH)} characters when the test gate is enabled`,
    );
  }
  const sessionTtlSeconds = parseOptionalPositiveInt(
    TEST_GATE_SESSION_TTL_ENV,
    env[TEST_GATE_SESSION_TTL_ENV],
    DEFAULT_TEST_SESSION_TTL_SECONDS,
  );
  return { enabled: true, port, sessionSecret, sessionTtlSeconds };
}

/**
 * True when the socket peer address is loopback (`127.0.0.0/8`, `::1`, or
 * IPv4-mapped `::ffff:127.0.0.0/8`).
 *
 * @param {string | null | undefined} remoteAddress
 * @returns {boolean}
 */
export function isLoopbackRemoteAddress(remoteAddress) {
  if (typeof remoteAddress !== "string" || remoteAddress.length === 0) {
    return false;
  }
  if (remoteAddress.startsWith("127.")) {
    return true;
  }
  const lowered = remoteAddress.toLowerCase();
  if (lowered === "::1") {
    return true;
  }
  if (lowered.startsWith("::ffff:")) {
    return isLoopbackRemoteAddress(lowered.slice("::ffff:".length));
  }
  return false;
}

/**
 * @param {string} name
 * @param {string | undefined} raw
 * @param {number} fallback
 * @returns {number}
 */
function parseOptionalPositiveInt(name, raw, fallback) {
  if (raw === undefined || raw.length === 0) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer when the test gate is enabled: ${String(raw)}`);
  }
  return value;
}
