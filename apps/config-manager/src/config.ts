/**
 * Server-side configuration for the local config manager.
 *
 * The target environment and its database credential are fixed by the
 * server process at launch — never by the HTTP client. To edit
 * production, the operator launches a separate process with
 * `CONFIG_MANAGER_ENVIRONMENT=production` and the production
 * `CONFIG_MANAGER_DATABASE_URL`. The browser cannot switch environments,
 * supply a database URL, or pass any credential; requests that try are
 * rejected by the HTTP layer.
 *
 * Excluded by design: every `WORKER_*` deployment setting (models,
 * endpoints, timeouts, pool sizes, feature flags), every secret, and all
 * deployment values. This module never reads or exposes them.
 */

export type ManagerEnvironment = "nonprod" | "production";

export interface ConfigManagerConfig {
  readonly environment: ManagerEnvironment;
  /** Server-side only; never leaves the process, never appears in responses. */
  readonly databaseUrl: string;
  readonly host: string;
  readonly port: number;
  /** Maximum accepted JSON request body size, in bytes. */
  readonly maxBodyBytes: number;
}

export class ConfigManagerConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigManagerConfigError";
  }
}

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 4399;
const DEFAULT_MAX_BODY_BYTES = 4 * 1024 * 1024;

function optionalPort(env: Record<string, string | undefined>): number {
  const raw = env["CONFIG_MANAGER_PORT"];
  if (raw === undefined || raw.length === 0) return DEFAULT_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigManagerConfigError("CONFIG_MANAGER_PORT must be an integer port 1-65535");
  }
  return port;
}

function optionalHost(env: Record<string, string | undefined>): string {
  const raw = env["CONFIG_MANAGER_HOST"];
  if (raw === undefined || raw.length === 0) return DEFAULT_HOST;
  const host = raw.trim();
  if (host.length === 0 || /\s/.test(host)) {
    throw new ConfigManagerConfigError("CONFIG_MANAGER_HOST must be a loopback hostname or address");
  }
  // Loopback-only bind: remote exposure is refused even if requested.
  const normalized = host.toLowerCase();
  if (
    normalized !== "localhost" &&
    normalized !== "127.0.0.1" &&
    normalized !== "::1" &&
    !normalized.startsWith("127.")
  ) {
    throw new ConfigManagerConfigError(
      "CONFIG_MANAGER_HOST must be a loopback address (127.0.0.1, localhost, or ::1); remote exposure is not supported",
    );
  }
  return host;
}

export function loadConfigManagerConfig(
  env: Record<string, string | undefined> = process.env,
): ConfigManagerConfig {
  const environment = env["CONFIG_MANAGER_ENVIRONMENT"];
  if (environment !== "nonprod" && environment !== "production") {
    throw new ConfigManagerConfigError(
      "CONFIG_MANAGER_ENVIRONMENT must be 'nonprod' or 'production' (fixed server-side at launch)",
    );
  }
  const databaseUrl = env["CONFIG_MANAGER_DATABASE_URL"];
  if (databaseUrl === undefined || databaseUrl.trim().length === 0) {
    throw new ConfigManagerConfigError(
      "CONFIG_MANAGER_DATABASE_URL is required (server-side credential for the fixed environment)",
    );
  }
  return {
    environment,
    databaseUrl,
    host: optionalHost(env),
    port: optionalPort(env),
    maxBodyBytes: DEFAULT_MAX_BODY_BYTES,
  };
}
