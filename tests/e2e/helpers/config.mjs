/**
 * Shared configuration for the end-to-end test stack.
 *
 * One module is the single source of truth for ports, paths, and the
 * environment contract between the stack supervisor (`stack.mjs`, started
 * by Playwright as its web server) and the test specs. Everything is
 * overridable through `E2E_*` environment variables; both processes inherit
 * the same environment, so they always agree.
 *
 * Defaults are high, uncommon loopback ports chosen to avoid colliding with
 * the development defaults of the applications themselves. The supervisor
 * refuses to start when any configured port is already taken — it never
 * hijacks a busy port, and a left-over stack is cleaned by its own run
 * records instead.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/** Repository root (tests/e2e/helpers → repo root). */
export const repoRoot = path.resolve(here, "..", "..", "..");

/** This directory (tests/e2e). */
export const e2eDir = path.resolve(here, "..");

function intFromEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw.length === 0) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`${name} must be an integer port between 1 and 65535, got: ${raw}`);
  }
  return value;
}

function strFromEnv(name, fallback) {
  const raw = process.env[name];
  return raw === undefined || raw.length === 0 ? fallback : raw;
}

export const config = {
  /** Synthetic authoritative zone used by the disposable stack's UI journeys. */
  temporalTimezone: "America/Los_Angeles",
  /** Web app: main (owner-only) listener. */
  webPort: intFromEnv("E2E_WEB_PORT", 4620),
  /** Web app: loopback-only test-entry gate listener (what the tests drive). */
  gatePort: intFromEnv("E2E_WEB_GATE_PORT", 4621),
  /** Worker private HTTP API. */
  workerPort: intFromEnv("E2E_WORKER_PORT", 4622),
  /** Local fake OpenRouter provider (+ its control API). */
  providerPort: intFromEnv("E2E_PROVIDER_PORT", 4623),
  /** Disposable PostgreSQL container's host port (loopback only). */
  pgPort: intFromEnv("E2E_PG_PORT", 4624),

  /** Pinned disposable PostgreSQL image. */
  pgImage: strFromEnv("E2E_PG_IMAGE", "postgres:17.6-alpine"),

  /** Application source locations. */
  webDir: path.join(repoRoot, "apps", "web"),
  workerDir: path.join(repoRoot, "apps", "worker"),

  /** Synthetic credentials' shape documentation: every run generates fresh
   * random values internally (worker token, session secrets, DB password).
   * They live only in the supervisor's process environment and are never
   * logged or written to the run state. */

  /** Ready-wait budgets (ms). */
  timeouts: {
    postgres: 90_000,
    worker: 60_000,
    web: 120_000,
    teardown: 20_000,
  },
};

/** Where run-owned state and logs live (created per run, gitignored). */
export const runsDirAbsolute = strFromEnv("E2E_RUNS_DIR", path.join(e2eDir, ".runs"));
