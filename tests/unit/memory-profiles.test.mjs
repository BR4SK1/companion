// Unit tests for memory configuration parsing and the observation-profile
// fingerprint: flag polarity, numeric validation, and fingerprint stability
// semantics that gate profile regeneration. Deterministic — no database,
// no network.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { loadMemoryConfig, MemoryConfigError } from "../../apps/worker/src/memory/config.ts";
import {
  computeProfileFingerprint,
  renderProfileSource,
} from "../../apps/worker/src/memory/profiles-v2.ts";

describe("memory configuration", () => {
  it("defaults ingest/profiles/autopromote off and recall/temporal on", () => {
    const config = loadMemoryConfig({});
    assert.equal(config.enabled, true);
    assert.equal(config.ingestEnabled, false);
    assert.equal(config.autopromoteEnabled, false);
    assert.equal(config.profilesEnabled, false);
    assert.equal(config.recallEnabled, true);
    assert.equal(config.temporalContextEnabled, true);
    assert.equal(config.temporalSummariesEnabled, true);
    assert.equal(config.model, "z-ai/glm-5.3-flash");
    assert.equal(config.recallLimit, 8);
    assert.equal(config.recallMaxChars, 12_000);
  });

  it("preserves the source flag polarity when set", () => {
    assert.equal(
      loadMemoryConfig({ WORKER_MEMORY_INGEST_ENABLED: "true" }).ingestEnabled,
      true,
    );
    assert.equal(
      loadMemoryConfig({ WORKER_MEMORY_INGEST_ENABLED: "1" }).ingestEnabled,
      false,
    );
    assert.equal(
      loadMemoryConfig({ WORKER_MEMORY_RECALL_ENABLED: "false" }).recallEnabled,
      false,
    );
    assert.equal(
      loadMemoryConfig({ WORKER_MEMORY_ENABLED: "false" }).enabled,
      false,
    );
  });

  it("defaults the v1 profile-summary flag off even when profiles are on", () => {
    // v1 sheets have no chat consumer (the prompt uses recent temporal
    // summaries and v2 profiles), so the generator is separately opted into.
    assert.equal(loadMemoryConfig({}).profileSummariesEnabled, false);
    assert.equal(
      loadMemoryConfig({ WORKER_MEMORY_PROFILES_ENABLED: "true" }).profileSummariesEnabled,
      false,
    );
    assert.equal(
      loadMemoryConfig({ WORKER_MEMORY_PROFILE_SUMMARIES_ENABLED: "true" }).profileSummariesEnabled,
      true,
    );
    assert.equal(
      loadMemoryConfig({ WORKER_MEMORY_PROFILE_SUMMARIES_ENABLED: "1" }).profileSummariesEnabled,
      false,
    );
  });

  it("applies numeric overrides within validation bounds", () => {
    const config = loadMemoryConfig({
      WORKER_MEMORY_INGEST_MAX_TURNS: "25",
      WORKER_MEMORY_CONSOLIDATION_NEW_FACTS_THRESHOLD: "10",
      WORKER_MEMORY_PROFILES_GENERATE_HOUR: "9",
    });
    assert.equal(config.ingestMaxTurns, 25);
    assert.equal(config.consolidationNewFactsThreshold, 10);
    assert.equal(config.profilesGenerateHour, 9);
  });

  it("rejects malformed numbers", () => {
    assert.throws(
      () => loadMemoryConfig({ WORKER_MEMORY_INGEST_MAX_TURNS: "abc" }),
      MemoryConfigError,
    );
    assert.throws(
      () => loadMemoryConfig({ WORKER_MEMORY_INGEST_MAX_TURNS: "0" }),
      MemoryConfigError,
    );
    assert.throws(
      () => loadMemoryConfig({ WORKER_MEMORY_INGEST_MAX_TURNS: "4.5" }),
      MemoryConfigError,
    );
    assert.throws(
      () => loadMemoryConfig({ WORKER_MEMORY_PROFILES_GENERATE_HOUR: "24" }),
      MemoryConfigError,
    );
  });
});

function observation(overrides = {}) {
  return {
    observationId: "obs-1",
    revision: 3,
    status: "active",
    contentHash: "hash-1",
    subject: "user",
    kind: "preference",
    claim: "Likes mornings",
    topics: ["mornings"],
    evidenceStrength: "strong",
    distinctDayCount: 4,
    lastObservedAt: "2026-06-15T08:00:00Z",
    ...overrides,
  };
}

const PROMPT_HASH = "prompt-content-hash-test";
const GENERATION = { model: "fake-memory-model", maxOutputTokens: 8000 };

describe("observation profile fingerprint", () => {
  it("is stable for identical observation sets regardless of order", () => {
    const a = computeProfileFingerprint("v2-1", [observation(), observation({ observationId: "obs-2" })], PROMPT_HASH, GENERATION);
    const b = computeProfileFingerprint("v2-1", [observation({ observationId: "obs-2" }), observation()], PROMPT_HASH, GENERATION);
    assert.equal(a, b);
    assert.equal(a.length, 32);
  });

  it("changes when any fingerprinted field moves", () => {
    const base = computeProfileFingerprint("v2-1", [observation()], PROMPT_HASH, GENERATION);
    for (const changed of [
      observation({ revision: 4 }),
      observation({ status: "superseded" }),
      observation({ contentHash: "hash-2" }),
      observation({ evidenceStrength: "supported" }),
    ]) {
      assert.notEqual(
        computeProfileFingerprint("v2-1", [changed], PROMPT_HASH, GENERATION),
        base,
        `fingerprint should move for ${JSON.stringify(changed)}`,
      );
    }
    // The prompt version participates.
    assert.notEqual(computeProfileFingerprint("v2-2", [observation()], PROMPT_HASH, GENERATION), base);
    // The exact prompt content participates (a re-provisioned same-version
    // prompt must invalidate served profiles).
    assert.notEqual(
      computeProfileFingerprint("v2-1", [observation()], "other-prompt-content", GENERATION),
      base,
    );
    // Unfingerprinted fields do not move it.
    assert.equal(
      computeProfileFingerprint("v2-1", [observation({ claim: "Changed claim wording" })], PROMPT_HASH, GENERATION),
      base,
    );
  });

  it("changes when generation-affecting configuration moves", () => {
    const base = computeProfileFingerprint("v2-1", [observation()], PROMPT_HASH, GENERATION);
    // A changed generation model must invalidate cached profiles.
    assert.notEqual(
      computeProfileFingerprint("v2-1", [observation()], PROMPT_HASH, {
        model: "other-memory-model",
        maxOutputTokens: 8000,
      }),
      base,
    );
    // A changed output cap must invalidate cached profiles.
    assert.notEqual(
      computeProfileFingerprint("v2-1", [observation()], PROMPT_HASH, {
        model: "fake-memory-model",
        maxOutputTokens: 4000,
      }),
      base,
    );
  });

  it("renders compact JSON source material with verbatim claims", () => {
    const source = renderProfileSource([observation()]);
    const parsed = JSON.parse(source);
    assert.deepEqual(parsed, [
      {
        id: "obs-1",
        kind: "preference",
        claim: "Likes mornings",
        topics: ["mornings"],
        evidenceStrength: "strong",
        distinctDayCount: 4,
      },
    ]);
    // Optional relations are included only when present.
    const withRelations = JSON.parse(
      renderProfileSource([observation({ condition: "on weekdays", consequence: "arrives early" })]),
    );
    assert.equal(withRelations[0].condition, "on weekdays");
    assert.equal(withRelations[0].consequence, "arrives early");
  });
});
