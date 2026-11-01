import { defineConfig } from "@playwright/test";

import { config } from "./helpers/config.mjs";

/**
 * Playwright configuration for the Companion end-to-end suite.
 *
 * The whole application stack (fake provider, throwaway PostgreSQL, worker,
 * web production build with the loopback test gate) is owned by the
 * supervisor started here (`stack.mjs up`): Playwright starts it before the
 * tests, tears it down after every outcome, and the supervisor additionally
 * traps signals and reconciles recorded left-overs on the next run. No
 * existing server is ever reused (`reuseExistingServer: false`) — every run
 * owns a fresh, disposable stack.
 *
 * One worker, no retries, ordered spec files: the specs share one
 * conversation and one database on purpose (a single continuous thread is
 * the product), and each spec's `beforeAll` establishes exactly the seed
 * state it needs, so the suite is repeatable.
 */
export default defineConfig({
  testDir: "./specs",
  timeout: 90_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"], ["html", { outputFolder: "playwright-report", open: "never" }]],
  outputDir: "test-results",
  use: {
    headless: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
    baseURL: `http://127.0.0.1:${String(config.gatePort)}`,
  },
  webServer: {
    command: "node stack.mjs up",
    port: config.gatePort,
    timeout: 180_000,
    reuseExistingServer: false,
    stdout: "ignore",
    stderr: "pipe",
    // Without this, Playwright skips graceful shutdown and SIGKILLs the
    // whole webServer process group instantly, which cuts the supervisor's
    // own cleanup short and leaves the throwaway container behind. With it,
    // the supervisor receives SIGTERM and removes every resource it created.
    gracefulShutdown: { signal: "SIGTERM", timeout: 15_000 },
  },
});
