import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const configModule = path.join(repoRoot, "tests", "e2e", "helpers", "config.mjs");
const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), "companion-e2e-config-runs-"));
after(() => fs.rmSync(runsDir, { recursive: true, force: true }));

function loadEmbeddingBaseUrl(value) {
  return spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      "const { config } = await import(process.argv[1]); process.stdout.write(config.embeddingBaseUrl ?? \"<missing>\");",
      configModule,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        E2E_RUNS_DIR: runsDir,
        WORKER_MEMORY_EMBEDDING_BASE_URL: value,
      },
    },
  );
}

test("E2E requires an explicit origin for the real embedding dependency", () => {
  const missing = loadEmbeddingBaseUrl("");
  assert.equal(missing.status, 0);
  assert.equal(missing.stdout, "<missing>");

  const configured = loadEmbeddingBaseUrl("https://embedding.example.test/");
  assert.equal(configured.status, 0);
  assert.equal(configured.stdout, "https://embedding.example.test");
});

test("E2E embedding configuration rejects credentials and non-origin URLs without echoing them", () => {
  for (const invalid of [
    "https://user:password@embedding.example.test/",
    "https://embedding.example.test/path",
    "https://embedding.example.test/?token=synthetic",
  ]) {
    const result = loadEmbeddingBaseUrl(invalid);
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stderr, /password|token=synthetic|embedding\.example\.test/);
  }
});

test("E2E run records cannot target or contain the shared historical .runs directory", () => {
  const runsModule = path.join(repoRoot, "tests", "e2e", "helpers", "runs-dir.mjs");
  const historicalRunsDir = path.join(repoRoot, "tests", "e2e", ".runs");
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      "const { resolveTaskRunsDir } = await import(process.argv[1]); process.stdout.write(resolveTaskRunsDir());",
      runsModule,
    ],
    {
      encoding: "utf8",
      env: { ...process.env, E2E_RUNS_DIR: historicalRunsDir },
    },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must not overlap the historical E2E \.runs directory/);
});
