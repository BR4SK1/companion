import assert from "node:assert/strict";
import test from "node:test";

import {
  createEmbeddingClient,
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MODEL,
  EMBEDDING_MODEL_REVISION,
} from "../../apps/worker/src/memory/embeddings.ts";

const baseUrl = process.env.WORKER_MEMORY_EMBEDDING_BASE_URL;

test("the configured real embedding service matches the worker contract", async () => {
  assert.ok(baseUrl, "set WORKER_MEMORY_EMBEDDING_BASE_URL from the approved local infrastructure configuration");
  let origin;
  try {
    const parsed = new URL(baseUrl);
    assert.ok(parsed.protocol === "http:" || parsed.protocol === "https:");
    assert.equal(parsed.username, "");
    assert.equal(parsed.password, "");
    assert.equal(parsed.pathname, "/");
    assert.equal(parsed.search, "");
    assert.equal(parsed.hash, "");
    origin = parsed.origin;
  } catch {
    assert.fail("WORKER_MEMORY_EMBEDDING_BASE_URL must be an HTTP(S) origin; value suppressed");
  }

  let healthResponse;
  try {
    healthResponse = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(5_000) });
  } catch {
    assert.fail("embedding service health request failed; network details suppressed");
  }
  assert.equal(healthResponse.status, 200, "embedding service must be ready");

  let health;
  try {
    health = await healthResponse.json();
  } catch {
    assert.fail("embedding service health response was not valid JSON");
  }
  assert.equal(health.status, "ok");
  assert.equal(health.model, EMBEDDING_MODEL);
  assert.equal(health.model_revision, EMBEDDING_MODEL_REVISION);
  assert.equal(health.dimensions, EMBEDDING_DIMENSIONS);

  const client = createEmbeddingClient({ baseUrl: origin });
  const queryVectors = await client.embed(
    ["synthetic integration query: favorite color of the sky", "synthetic integration query: common fruit"],
    "query",
  );
  const documentVectors = await client.embed(
    ["synthetic integration document: the sky appears blue", "synthetic integration document: apples are fruit"],
    "document",
  );

  assert.equal(queryVectors.length, 2);
  assert.equal(documentVectors.length, 2);
  for (const vector of [...queryVectors, ...documentVectors]) {
    assert.equal(vector.length, EMBEDDING_DIMENSIONS);
    const norm = Math.sqrt(vector.reduce((sum, coordinate) => sum + coordinate * coordinate, 0));
    assert.ok(Math.abs(norm - 1) <= 0.015, "real service vectors must be normalized");
  }
});
