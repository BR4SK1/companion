/**
 * Test-entry gate environment: the shared, dependency-free source of truth
 * for the non-production-only test gate's configuration parsing and
 * channel-attestation constants.
 *
 * The gate is an additional HTTP listener bound strictly to `127.0.0.1`
 * inside the pod's network namespace, serving the full application without
 * Keycloak sign-in for end-to-end testing. It is reachable only through
 * `kubectl port-forward` (a loopback-bound socket is not addressable from
 * outside the pod's network namespace — not through the ClusterIP Service,
 * not through Ingress). See apps/web/README.md for the security model and
 * the safe access procedure.
 *
 * Fail-closed rules implemented here:
 * - The gate is enabled only when `WEB_TEST_GATE_ENABLED` is exactly
 *   "true"; anything else (including unset) is disabled. It is never
 *   inferred from `NODE_ENV` or any other ambient signal.
 * - An enabled gate requires a deployment-purpose attestation: either a
 *   chart-rendered deployment whose declared purpose is exactly
 *   "non-production" in the one authorized non-production namespace
 *   (`AUTHORIZED_NON_PRODUCTION_NAMESPACE`) with the declared namespace
 *   equal to the kubelet-provided pod namespace (downward API), or an
 *   explicit `WEB_TEST_GATE_TRUSTED_LOCAL=true` run outside Kubernetes
 *   with no chart-injected attestation and no Kubernetes context
 *   indicators present. Production, unknown, missing, mismatched,
 *   unauthorized-namespace, and smuggled attestations are errors — the
 *   gate never silently falls back to closed; the process refuses to
 *   start.
 * - The listener enforces channel integrity on every request: the Host
 *   header must be exactly the bound loopback address and port, and
 *   forwarding/proxy headers are refused outright. These checks reject
 *   only (DNS-rebinding defense); they never grant access.
 * - When enabled, the loopback port and a dedicated session secret are
 *   required; malformed values are errors, never degraded access.
 *
 * This module is imported by both the custom server entry (`server.mjs`,
 * plain JavaScript) and the TypeScript server library
 * (`src/lib/server/test-gate.ts` / `config.ts`), so the listener-binding
 * decision and the per-request application decisions share one parser and
 * one set of constants. It must stay framework-free and Node-only.
 */

/**
 * Environment variable that explicitly enables the test gate. Only the
 * exact value "true" enables it.
 */
export const TEST_GATE_ENABLED_ENV = "WEB_TEST_GATE_ENABLED";

/** Environment variable holding the loopback-only listener port. */
export const TEST_GATE_PORT_ENV = "WEB_TEST_GATE_PORT";

/**
 * Environment variable holding the dedicated test-session signing secret.
 * It must differ from the owner session secret (`WEB_SESSION_SECRET`); the
 * equality check needs the main secret, so it is enforced by the callers
 * that have both values (see `src/lib/server/config.ts`).
 */
export const TEST_GATE_SESSION_SECRET_ENV = "WEB_TEST_GATE_SESSION_SECRET";

/** Optional environment variable overriding the test-session lifetime. */
export const TEST_GATE_SESSION_TTL_ENV = "WEB_TEST_GATE_SESSION_TTL_SECONDS";

/**
 * Environment variable for the explicit local-only attestation (a run
 * outside Kubernetes, on the operator's own machine). Only the exact value
 * "true" is honored, and only when no chart-injected deployment attestation
 * is present at all — it can never override or coexist with a rendered
 * deployment's purpose.
 */
export const TEST_GATE_TRUSTED_LOCAL_ENV = "WEB_TEST_GATE_TRUSTED_LOCAL";

/**
 * Chart-rendered deployment-purpose attestation variables. The chart
 * (never operator values — `web.env` may not set `COMPANION_*`) injects
 * the declared purpose and namespace, and the pod's actual namespace
 * arrives through the Kubernetes downward API (kubelet-provided, not a
 * value and not request data). The gate may open only when the declared
 * purpose is exactly "non-production" and the declared namespace equals
 * the pod's actual namespace.
 */
export const DEPLOYMENT_PURPOSE_ENV = "COMPANION_DEPLOYMENT_PURPOSE";
export const DEPLOYMENT_NAMESPACE_ENV = "COMPANION_DEPLOYMENT_NAMESPACE";
export const POD_NAMESPACE_ENV = "COMPANION_POD_NAMESPACE";

/** The only two deployment purposes the chart can render. */
export const PURPOSE_PRODUCTION = "production";
export const PURPOSE_NON_PRODUCTION = "non-production";

/**
 * The only non-production namespace the test-entry gate is authorized to
 * run in, pinned in the chart (which fails rendering when the gate is
 * enabled for any other namespace) and re-verified at runtime. Purpose
 * and downward-API agreement alone are not enough: any namespace could
 * otherwise self-declare itself non-production. The value is
 * deployment-specific policy and deliberately not operator-configurable.
 */
export const AUTHORIZED_NON_PRODUCTION_NAMESPACE = "companion-np";

/**
 * Environment variables the kubelet sets in every pod. Their presence is
 * the standard in-container Kubernetes context signal: when either is
 * set, `WEB_TEST_GATE_TRUSTED_LOCAL` may not attest a local run, because
 * a container inside Kubernetes cannot truthfully declare itself to be a
 * run outside Kubernetes.
 */
export const KUBERNETES_SERVICE_HOST_ENV = "KUBERNETES_SERVICE_HOST";
export const KUBERNET_SERVICE_PORT_ENV = "KUBERNET_SERVICE_PORT";

/**
 * Name of the HTTP header the test listener injects into every request it
 * accepts, carrying the process-random attestation token. The token is
 * generated at server start, kept in process memory only, and never logged
 * or exposed; requests on the main (owner-only) listener can therefore
 * never carry it. This is how the application distinguishes the test
 * channel from the main channel without trusting any client-supplied
 * header, Host, or forwarding header.
 */
export const TEST_ATTESTATION_HEADER = "x-companion-test-entry";

/**
 * `globalThis` property key under which the custom server publishes the
 * process-random attestation token to the Next.js request handlers running
 * in the same process. The token never appears in configuration, code, or
 * logs; this key only names the in-memory slot.
 */
export const TEST_CHANNEL_TOKEN_GLOBAL_KEY = "__companionTestGateChannelToken";

/** Default test-session lifetime in seconds (one hour). */
export const DEFAULT_TEST_SESSION_TTL_SECONDS = 3600;

/** Minimum test-session secret length, matching the owner session secret. */
export const MIN_TEST_SESSION_SECRET_LENGTH = 32;

/**
 * Headers a request on the test channel must never carry. The only
 * legitimate clients reach the loopback listener directly (kubectl
 * port-forward, a local browser or curl on 127.0.0.1), so any
 * proxy/forwarding header is evidence of an unexpected — and potentially
 * hostile — path (a proxy or a spoofing attempt trying to redefine the
 * effective host or scheme). The listener rejects such requests outright,
 * and nothing in the application ever consults forwarding headers for a
 * decision.
 */
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
 * True when any forwarding/proxy header is present. `headers` is a
 * lowercased header record as provided by Node's http server
 * (`request.headers`).
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
 * The exact Host header the test channel expects: `127.0.0.1:<port>` — the
 * address the listener is bound to, with the configured gate port. This is
 * a channel-integrity check against DNS rebinding: a page served from an
 * attacker-controlled domain that re-resolves to 127.0.0.1 arrives with
 * the attacker's Host header and is rejected by the listener before it can
 * reach session issuance or any application route. It is deliberately NOT
 * an authorization factor: authorization comes from the socket-level
 * loopback check, the gate state, and the process-random attestation
 * token; the Host check only ever rejects, never grants. Clients must
 * address the test entry as `http://127.0.0.1:<port>` (the documented
 * access procedure) — `localhost`, a rebinding domain, or any other name
 * is refused.
 *
 * @param {string | null | undefined} hostHeader Raw Host header value.
 * @param {number} port The configured loopback listener port.
 * @returns {boolean}
 */
export function isExpectedTestHost(hostHeader, port) {
  if (typeof hostHeader !== "string" || hostHeader.length === 0) {
    return false;
  }
  if (hostHeader === `127.0.0.1:${String(port)}`) {
    return true;
  }
  // HTTP clients omit the port when it is the scheme's default.
  return port === 80 && hostHeader === "127.0.0.1";
}

/**
 * Parse the test gate's environment. Returns `{ enabled: false }` unless
 * `WEB_TEST_GATE_ENABLED` is exactly "true"; when enabled, every value is
 * validated and a misconfigured value throws (fail closed — a broken gate
 * configuration must not degrade into a partially open listener; callers
 * surface the named-variable error).
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
  // Deployment-purpose attestation, checked before anything else: the gate
  // is meaningful only for an attested non-production deployment (or an
  // explicit local run outside Kubernetes). Production, unknown, missing,
  // and mismatched attestations are errors — never a silent fallback.
  const purpose = resolveDeploymentPurpose(env);
  if (purpose.kind === "none") {
    throw new Error(
      `${TEST_GATE_ENABLED_ENV} requires a deployment-purpose attestation (${DEPLOYMENT_PURPOSE_ENV} with ${DEPLOYMENT_NAMESPACE_ENV} and ${POD_NAMESPACE_ENV}, or an explicit ${TEST_GATE_TRUSTED_LOCAL_ENV}=true local run)`,
    );
  }
  if (purpose.kind === "invalid") {
    throw new Error(`invalid deployment-purpose attestation: ${purpose.reason}`);
  }
  if (purpose.kind === "kubernetes" && purpose.purpose === PURPOSE_PRODUCTION) {
    throw new Error(
      `the test-entry gate must never run in a production deployment (${DEPLOYMENT_PURPOSE_ENV} is "${PURPOSE_PRODUCTION}")`,
    );
  }
  const port = parseOptionalPositiveInt(TEST_GATE_PORT_ENV, env[TEST_GATE_PORT_ENV], Number.NaN);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(
      `${TEST_GATE_PORT_ENV} must be an integer between 1 and 65535 when the test gate is enabled`,
    );
  }
  const mainPort = env["PORT"] === undefined || env["PORT"].length === 0 ? Number.NaN : Number(env["PORT"]);
  if (Number.isInteger(mainPort) && mainPort === port) {
    throw new Error(
      `${TEST_GATE_PORT_ENV} must differ from the main listener port (PORT)`,
    );
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
 * Resolve the deployment-purpose attestation from the environment. The
 * result kinds:
 *
 * - `{ kind: "kubernetes", purpose, namespace }` — a chart-rendered
 *   deployment: the declared purpose ("production" or "non-production",
 *   exact) with the declared namespace equal to the pod's actual
 *   (downward-API) namespace. For the non-production purpose, the
 *   namespace must additionally be the one authorized non-production
 *   namespace (`AUTHORIZED_NON_PRODUCTION_NAMESPACE`) — purpose and
 *   downward-API agreement alone would let any namespace self-declare
 *   itself non-production.
 * - `{ kind: "local" }` — an explicit local-only run outside Kubernetes
 *   (`WEB_TEST_GATE_TRUSTED_LOCAL=true`) with no chart-injected
 *   attestation present at all, so the local declaration can never
 *   override or coexist with a rendered deployment's purpose — and with
 *   no Kubernetes context indicators (`KUBERNETES_SERVICE_HOST` /
 *   `KUBERNET_SERVICE_PORT`, set by the kubelet in every pod), so a
 *   container inside Kubernetes cannot pass itself off as a local run.
 * - `{ kind: "none" }` — no attestation (the gate must then stay closed).
 * - `{ kind: "invalid", reason }` — production/unknown/missing values,
 *   namespace mismatch, unauthorized namespace, missing purpose, or
 *   smuggling attempts; the gate treats every invalid attestation as an
 *   error, never as a silent disable.
 *
 * Never consults NODE_ENV, hosts, or request headers: the attestation is
 * deployment configuration plus the kubelet-provided pod namespace only.
 *
 * Trust limits (documented in apps/web/README.md): the chart-rendered
 * attestation is trusted because it is injected by the version-controlled
 * chart template and operator values cannot inject or override it
 * (`web.env` may not set `COMPANION_*`); the local declaration trusts
 * whoever controls the process environment on a machine outside
 * Kubernetes. An actor able to alter the rendered Deployment or the pod's
 * environment already holds cluster-level access, which is outside this
 * model.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {{
 *   kind: "kubernetes",
 *   purpose: string,
 *   namespace: string,
 * } | {
 *   kind: "local",
 * } | {
 *   kind: "none",
 * } | {
 *   kind: "invalid",
 *   reason: string,
 * }}
 */
export function resolveDeploymentPurpose(env) {
  const purposeEnv = env[DEPLOYMENT_PURPOSE_ENV];
  const declaredNamespace = env[DEPLOYMENT_NAMESPACE_ENV];
  const podNamespace = env[POD_NAMESPACE_ENV];
  if (typeof purposeEnv === "string" && purposeEnv.length > 0) {
    if (purposeEnv !== PURPOSE_PRODUCTION && purposeEnv !== PURPOSE_NON_PRODUCTION) {
      return {
        kind: "invalid",
        reason: `${DEPLOYMENT_PURPOSE_ENV} must be exactly "${PURPOSE_PRODUCTION}" or "${PURPOSE_NON_PRODUCTION}"`,
      };
    }
    if (typeof declaredNamespace !== "string" || declaredNamespace.length === 0) {
      return {
        kind: "invalid",
        reason: `${DEPLOYMENT_NAMESPACE_ENV} must be present alongside ${DEPLOYMENT_PURPOSE_ENV}`,
      };
    }
    if (typeof podNamespace !== "string" || podNamespace.length === 0) {
      return {
        kind: "invalid",
        reason: `${POD_NAMESPACE_ENV} must be present alongside ${DEPLOYMENT_PURPOSE_ENV}`,
      };
    }
    if (declaredNamespace !== podNamespace) {
      return {
        kind: "invalid",
        reason: `${DEPLOYMENT_NAMESPACE_ENV} (${declaredNamespace}) does not match the pod's actual namespace (${podNamespace})`,
      };
    }
    if (
      purposeEnv === PURPOSE_NON_PRODUCTION &&
      declaredNamespace !== AUTHORIZED_NON_PRODUCTION_NAMESPACE
    ) {
      return {
        kind: "invalid",
        reason: `${DEPLOYMENT_NAMESPACE_ENV} (${declaredNamespace}) is not the authorized non-production namespace (${AUTHORIZED_NON_PRODUCTION_NAMESPACE}); the test-entry gate may run only there`,
      };
    }
    return { kind: "kubernetes", purpose: purposeEnv, namespace: declaredNamespace };
  }
  if (
    (typeof declaredNamespace === "string" && declaredNamespace.length > 0) ||
    (typeof podNamespace === "string" && podNamespace.length > 0)
  ) {
    return {
      kind: "invalid",
      reason: `a deployment namespace attestation requires ${DEPLOYMENT_PURPOSE_ENV}`,
    };
  }
  const kubernetesHost = env[KUBERNETES_SERVICE_HOST_ENV];
  const kubernetesPort = env[KUBERNET_SERVICE_PORT_ENV];
  if (
    (typeof kubernetesHost === "string" && kubernetesHost.length > 0) ||
    (typeof kubernetesPort === "string" && kubernetesPort.length > 0)
  ) {
    return {
      kind: "invalid",
      reason: `${TEST_GATE_TRUSTED_LOCAL_ENV} may not attest a local run inside Kubernetes (${KUBERNETES_SERVICE_HOST_ENV}/${KUBERNET_SERVICE_PORT_ENV} are set); a pod cannot declare itself a run outside Kubernetes`,
    };
  }
  if (env[TEST_GATE_TRUSTED_LOCAL_ENV] === "true") {
    return { kind: "local" };
  }
  return { kind: "none" };
}

/**
 * True when the address is a loopback address of the machine: any
 * `127.0.0.0/8` address (dotted), `::1`, or an IPv4-mapped `127.0.0.0/8`
 * address. Everything else — including `0.0.0.0`, unspecified IPv6, and
 * any site/local address — is not loopback. Host *names* are never
 * accepted: the decision is about the actual socket peer address.
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
 * Parse an optional positive integer with a fallback default; the fallback
 * may be `NaN` to force a "required" outcome at the call site. Throws a
 * named-variable error on a present-but-invalid value.
 *
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
