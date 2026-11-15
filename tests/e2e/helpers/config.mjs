/**
 * Shared configuration for the end-to-end test stack.
 *
 * One module is the single source of truth for ports, paths, and the
 * environment contract between the stack supervisor (`stack.mjs`, started
 * by Playwright as its web server) and the test specs. Everything is
 * overridable through `E2E_*` environment variables; both processes inherit
 * the same environment, so they always agree. `E2E_RUNS_DIR` is required and
 * must be isolated from the historical shared `.runs` tree.
 *
 * Defaults are high, uncommon loopback ports chosen to avoid colliding with
 * the development defaults of the applications themselves. The supervisor
 * refuses to start when any configured port is already taken — it never
 * hijacks a busy port, and a left-over stack is cleaned by its own run
 * records instead.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveTaskRunsDir } from "./runs-dir.mjs";

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

function baseUrlFromEnv(name) {
  const raw = process.env[name];
  if (raw === undefined || raw.length === 0) return null;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${name} must be a valid HTTP(S) base URL`);
  }
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(`${name} must be an HTTP(S) origin without credentials, path, query, or fragment`);
  }
  return parsed.origin;
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
  /** Explicitly configured internal embedding service; never default to a fake. */
  embeddingBaseUrl: baseUrlFromEnv("WORKER_MEMORY_EMBEDDING_BASE_URL"),

  /** Pinned disposable PostgreSQL image. */
  pgImage: strFromEnv(
    "E2E_PG_IMAGE",
    "pgvector/pgvector:0.8.1-pg17@sha256:3e8b3adfd27b5707128f60956f62a793c3c9326ea8cfaf0eab7adccb5d700b21",
  ),

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
export const runsDirAbsolute = resolveTaskRunsDir();
