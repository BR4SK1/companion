import { defineConfig } from "@playwright/test";

const gatePort = Number(process.env.E2E_GATE_PORT || "3100");

export default defineConfig({
  testDir: "./specs",
  timeout: 150_000,
  expect: { timeout: 15_000 },
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
    baseURL: `http://127.0.0.1:${String(gatePort)}`,
  },
});
