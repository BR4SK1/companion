// Unit tests for the fixed error-category taxonomy (no network): transport
// failures classify into bounded categories, typed output-validation errors
// classify without message sniffing, Postgres SQLSTATE codes map to closed
// categories, and arbitrary error-message text — including short unquoted
// model-derived canary tokens — never appears in any recorded category.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  MEMORY_ERROR_CATEGORIES,
  memoryErrorCategory,
  OpenRouterTransportError,
} from "../../apps/worker/src/memory/errors.ts";
import { MemoryLlmOutputError } from "../../apps/worker/src/memory/prompts.ts";

// A short, unquoted, model-shaped token embedded in fake error text. If any
// classification path ever leaks message content into a category, this shows
// up verbatim in the recorded value.
const CANARY = "CanaryToken42";

function transport(kind, status) {
  return new OpenRouterTransportError(kind, `${CANARY} exploded`, { status });
}

describe("memory error categories", () => {
  it("exposes a closed category set", () => {
    assert.deepEqual([...MEMORY_ERROR_CATEGORIES], [
      "llm_http_status",
      "llm_timeout",
      "llm_network",
      "llm_invalid_json",
      "llm_output_invalid",
      "llm_attribution_invalid",
      "db_error",
      "config_error",
      "internal_error",
    ]);
  });

  it("classifies transport failure kinds without message text", () => {
    assert.equal(memoryErrorCategory(transport("timeout")), "llm_timeout");
    assert.equal(memoryErrorCategory(transport("network")), "llm_network");
    assert.equal(memoryErrorCategory(transport("invalid_json")), "llm_invalid_json");
    assert.equal(memoryErrorCategory(transport("http_status", 429)), "llm_http_status_429");
    // Out-of-range or missing statuses fall back to the base category.
    assert.equal(memoryErrorCategory(transport("http_status", 999)), "llm_http_status");
    assert.equal(memoryErrorCategory(transport("http_status")), "llm_http_status");
    // Unknown kinds cannot smuggle content through.
    assert.equal(
      memoryErrorCategory(transport("mystery")),
      "llm_http_status",
    );
  });

  it("classifies typed output-validation and configuration errors", () => {
    const output = new MemoryLlmOutputError(`claim said ${CANARY}`);
    assert.equal(memoryErrorCategory(output), "llm_output_invalid");

    class FactExtractionAttributionError extends Error {
      constructor() {
        super(`attribution ${CANARY}`);
        this.name = "FactExtractionAttributionError";
      }
    }
    assert.equal(
      memoryErrorCategory(new FactExtractionAttributionError()),
      "llm_attribution_invalid",
    );

    class MemoryConfigurationError extends Error {
      constructor() {
        super(`config ${CANARY}`);
        this.name = "MemoryConfigurationError";
      }
    }
    assert.equal(
      memoryErrorCategory(new MemoryConfigurationError()),
      "config_error",
    );
  });

  it("maps Postgres SQLSTATE codes and falls back to internal", () => {
    const pgError = new Error(`constraint details: ${CANARY}`);
    pgError.name = "error";
    pgError.code = "23505";
    assert.equal(memoryErrorCategory(pgError), "db_23505");

    assert.equal(memoryErrorCategory(new Error(CANARY)), "internal_error");
    assert.equal(memoryErrorCategory("plain string"), "internal_error");
    assert.equal(memoryErrorCategory(undefined), "internal_error");
  });

  it("never records canary message content in any category", () => {
    const errors = [
      transport("timeout"),
      transport("network"),
      transport("invalid_json"),
      transport("http_status", 500),
      new MemoryLlmOutputError(`response: ${CANARY}`),
      new Error(`pg says ${CANARY}`),
      Object.assign(new Error(`boom ${CANARY}`), { code: "23-ish!" }),
    ];
    for (const error of errors) {
      const category = memoryErrorCategory(error);
      assert.ok(
        !category.includes(CANARY),
        `category leaked error text: ${category}`,
      );
      assert.ok(
        MEMORY_ERROR_CATEGORIES.includes(category) ||
          /^(llm_http_status_\d{3}|db_[0-9A-Z]{5})$/.test(category),
        `category is not from the closed set: ${category}`,
      );
    }
  });
});
