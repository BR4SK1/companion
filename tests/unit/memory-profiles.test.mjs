// Unit tests for memory configuration parsing and the observation-profile
// fingerprint: flag polarity, numeric validation, and fingerprint stability
// semantics that gate profile regeneration. Deterministic — no database,
// no network.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { loadMemoryConfig, MemoryConfigError } from "../../apps/worker/src/memory/config.ts";
import {
  memoryErrorCategory,
  memoryOutputErrorReason,
  MemoryLlmTruncatedError,
  MemorySourceBudgetError,
} from "../../apps/worker/src/memory/errors.ts";
import {
  buildObservationProfilePrompt,
  buildObservationProfileResponseFormat,
  parseProfileV2Output,
  profileObservationHandle,
  MemoryLlmOutputError,
} from "../../apps/worker/src/memory/prompts.ts";
import {
  computeProfileFingerprint,
  fitObservationsToProfileBudget,
  generateProfileIfNeeded,
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
    assert.equal(config.reasoningEffort, undefined);
    assert.equal(config.recallLimit, 8);
    assert.equal(config.recallMaxChars, 12_000);
    assert.equal(config.embeddingBaseUrl, "http://127.0.0.1:5113");
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

  it("parses the model and reasoning-effort overrides, rejecting bad efforts", () => {
    const config = loadMemoryConfig({
      WORKER_MEMORY_MODEL: "meta/muse-ember",
      WORKER_MEMORY_REASONING_EFFORT: "high",
    });
    assert.equal(config.model, "meta/muse-ember");
    assert.equal(config.reasoningEffort, "high");
    assert.throws(
      () => loadMemoryConfig({ WORKER_MEMORY_REASONING_EFFORT: "ultra" }),
      MemoryConfigError,
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

  it("fits observations newest-first within the source character budget", () => {
    const empty = fitObservationsToProfileBudget([], 100);
    assert.deepEqual(empty, { selected: [], droppedCount: 0, sourceChars: 2 });

    const obs1 = observation({ observationId: "obs-newest", claim: "A".repeat(80) });
    const obs2 = observation({ observationId: "obs-middle", claim: "B".repeat(80) });
    const obs3 = observation({ observationId: "obs-oldest", claim: "C".repeat(80) });

    // All fit when budget covers the full rendered JSON.
    const fullLen = renderProfileSource([obs1, obs2, obs3]).length;
    const allFit = fitObservationsToProfileBudget([obs1, obs2, obs3], fullLen);
    assert.equal(allFit.selected.length, 3);
    assert.equal(allFit.droppedCount, 0);
    assert.equal(allFit.sourceChars, fullLen);

    // Tightening budget by 1 char drops only the oldest observation, and
    // reported sourceChars matches renderProfileSource byte-for-byte.
    const twoFit = fitObservationsToProfileBudget([obs1, obs2, obs3], fullLen - 1);
    assert.deepEqual(
      twoFit.selected.map((item) => item.observationId),
      ["obs-newest", "obs-middle"],
    );
    assert.equal(twoFit.droppedCount, 1);
    assert.equal(twoFit.sourceChars, renderProfileSource(twoFit.selected).length);
    assert.ok(twoFit.sourceChars <= fullLen - 1);

    // Exact 2-item boundary keeps 2 items; 1 char smaller keeps only 1.
    const twoLen = renderProfileSource([obs1, obs2]).length;
    assert.equal(fitObservationsToProfileBudget([obs1, obs2, obs3], twoLen).selected.length, 2);
    const oneFit = fitObservationsToProfileBudget([obs1, obs2, obs3], twoLen - 1);
    assert.deepEqual(
      oneFit.selected.map((item) => item.observationId),
      ["obs-newest"],
    );
    assert.equal(oneFit.droppedCount, 2);
    assert.equal(oneFit.sourceChars, renderProfileSource(oneFit.selected).length);

    // When even the newest single observation cannot fit, throws typed budget error.
    const oneLen = renderProfileSource([obs1]).length;
    assert.throws(
      () => fitObservationsToProfileBudget([obs1, obs2], oneLen - 1),
      (error) =>
        error instanceof MemorySourceBudgetError &&
        memoryErrorCategory(error) === "source_budget_exceeded",
    );
  });

  it("regenerates and saves a trimmed profile consistently across fingerprint and save-time recheck", async () => {
    const now = new Date("2026-11-21T12:00:00Z");
    const obsRows = [
      {
        canonical_observation_id: "obs-1",
        revision: 1,
        status: "active",
        content_hash: "h1",
        subject_id: "user",
        kind: "preference",
        claim: "First newest claim " + "x".repeat(90),
        condition: null,
        consequence: null,
        topics: ["coffee"],
        evidence_strength: "strong",
        distinct_day_count: 3,
        last_observed_at: new Date(now.getTime()),
      },
      {
        canonical_observation_id: "obs-2",
        revision: 1,
        status: "active",
        content_hash: "h2",
        subject_id: "user",
        kind: "preference",
        claim: "Second claim " + "y".repeat(90),
        condition: null,
        consequence: null,
        topics: ["tea"],
        evidence_strength: "strong",
        distinct_day_count: 2,
        last_observed_at: new Date(now.getTime() - 60_000),
      },
      {
        canonical_observation_id: "obs-3",
        revision: 1,
        status: "active",
        content_hash: "h3",
        subject_id: "user",
        kind: "preference",
        claim: "Oldest dropped claim " + "z".repeat(90),
        condition: null,
        consequence: null,
        topics: ["sleep"],
        evidence_strength: "supported",
        distinct_day_count: 2,
        last_observed_at: new Date(now.getTime() - 120_000),
      },
    ];

    // Budget sized to fit obs-1 and obs-2, excluding obs-3.
    const twoSourceBudget = renderProfileSource(
      obsRows.slice(0, 2).map((row) => ({
        observationId: row.canonical_observation_id,
        revision: row.revision,
        status: row.status,
        contentHash: row.content_hash,
        subject: row.subject_id,
        kind: row.kind,
        claim: row.claim,
        topics: row.topics,
        evidenceStrength: row.evidence_strength,
        distinctDayCount: row.distinct_day_count,
        lastObservedAt: row.last_observed_at.toISOString(),
      })),
    ).length;

    let savedProfile = null;
    let savedSources = [];
    let savedClaims = [];

    const runQuery = async (sql, params = []) => {
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
        return { rows: [] };
      }
      if (sql.includes("FROM memory_canonical_observation") && sql.includes("WHERE status = 'active'")) {
        return { rows: obsRows };
      }
      if (sql.includes("FROM memory_observation_profile WHERE subject_id")) {
        return { rows: savedProfile ? [savedProfile] : [] };
      }
      if (sql.includes("FROM memory_observation_profile_claim")) {
        return { rows: savedClaims };
      }
      if (sql.includes("FROM memory_observation_profile_source s")) {
        return {
          rows: savedSources.map((source) => {
            const live = obsRows.find((r) => r.canonical_observation_id === source.observation_id);
            return {
              observation_id: source.observation_id,
              content_hash: source.content_hash,
              revision: source.revision,
              status: live?.status ?? null,
              current_content_hash: live?.content_hash ?? null,
              current_revision: live?.revision ?? null,
            };
          }),
        };
      }
      if (sql.includes("FROM memory_canonical_observation") && sql.includes("canonical_observation_id = ANY")) {
        const ids = params[0] ?? [];
        return {
          rows: obsRows
            .filter((r) => ids.includes(r.canonical_observation_id))
            .map((r) => ({ canonical_observation_id: r.canonical_observation_id, status: r.status })),
        };
      }
      if (sql.includes("INSERT INTO memory_observation_profile\n")) {
        savedProfile = {
          subject_id: params[0],
          fingerprint: params[1],
          prompt_version: params[2],
          prompt_content_hash: params[3],
          content: params[4],
          source_count: params[5],
          model: params[6],
          generated_at: params[7],
        };
        return { rows: [] };
      }
      if (sql.includes("DELETE FROM memory_observation_profile_claim")) {
        savedClaims = [];
        return { rows: [] };
      }
      if (sql.includes("INSERT INTO memory_observation_profile_claim")) {
        savedClaims = params[1].map((id, idx) => ({
          observation_id: id,
          claim_text: params[2][idx],
        }));
        return { rows: [] };
      }
      if (sql.includes("DELETE FROM memory_observation_profile_source")) {
        savedSources = [];
        return { rows: [] };
      }
      if (sql.includes("INSERT INTO memory_observation_profile_source")) {
        savedSources = params[1].map((id, idx) => ({
          observation_id: id,
          content_hash: params[2][idx],
          revision: params[3][idx],
        }));
        return { rows: [] };
      }
      throw new Error(`Unexpected SQL in test mock: ${sql}`);
    };

    const pool = {
      query: runQuery,
      connect: async () => ({
        query: runQuery,
        release: () => undefined,
      }),
    };

    let llmCalls = 0;
    const config = loadMemoryConfig({
      WORKER_MEMORY_PROFILE_MAX_SOURCE_CHARS: String(twoSourceBudget),
    });

    const first = await generateProfileIfNeeded(
      {
        pool,
        config,
        systemPrompt: "Write profile.",
        callLlm: async () => {
          llmCalls += 1;
          return {
            text: JSON.stringify({
              content: "Concise profile grounded in two newest observations.",
              claims: [{ observationId: "obs-1", text: "Enjoys coffee" }],
            }),
            model: "fake-model",
            finishReason: "stop",
            inputTokens: 100,
            outputTokens: 40,
            nativeReasoningTokens: null,
            attemptCount: 1,
            structuredOutputFallback: false,
            reasoningClampFallback: false,
          };
        },
      },
      "user",
    );

    assert.equal(first.regenerated, true);
    assert.equal(first.sourceCount, 2);
    assert.equal(first.trimmedCount, 1);
    assert.equal(first.model, "fake-model");
    assert.equal(first.promptVersion, "v2-1");
    assert.equal(first.inputTokens, 100);
    assert.equal(first.outputTokens, 40);
    assert.equal(first.llmCalls, 1);
    assert.equal(llmCalls, 1);
    assert.deepEqual(
      savedSources.map((s) => s.observation_id),
      ["obs-1", "obs-2"],
    );

    // Re-running with the same trimmed observation set hits the fingerprint cache.
    const second = await generateProfileIfNeeded(
      {
        pool,
        config,
        systemPrompt: "Write profile.",
        callLlm: async () => {
          llmCalls += 1;
          throw new Error("should not call LLM when fingerprint matches");
        },
      },
      "user",
    );
    assert.equal(second.regenerated, false);
    assert.equal(second.skippedReason, "unchanged");
    assert.equal(second.sourceCount, 2);
    assert.equal(second.trimmedCount, 1);
    assert.equal(llmCalls, 1);

    // Concurrent retraction during LLM generation triggers save-time staleness
    // even when trimming is active, refusing to save prose citing retracted input.
    savedProfile = null;
    const staleResult = await generateProfileIfNeeded(
      {
        pool,
        config,
        systemPrompt: "Write profile.",
        callLlm: async () => {
          // Simulate obs-1 getting retracted while the LLM call is in flight.
          obsRows.shift();
          return {
            text: JSON.stringify({
              content: "Stale profile referencing retracted obs-1.",
              claims: [{ observationId: "obs-1", text: "Retracted claim" }],
            }),
            model: "fake-model",
            finishReason: "stop",
            inputTokens: 100,
            outputTokens: 40,
            nativeReasoningTokens: null,
            attemptCount: 1,
            structuredOutputFallback: false,
            reasoningClampFallback: false,
          };
        },
      },
      "user",
    );
    assert.equal(staleResult.regenerated, false);
    assert.equal(staleResult.skippedReason, "stale-at-save");
    assert.equal(savedProfile, null);

    // Truncated LLM response classifies as llm_output_truncated instead of internal_error.
    savedProfile = null;
    await assert.rejects(
      () =>
        generateProfileIfNeeded(
          {
            pool,
            config,
            systemPrompt: "Write profile.",
            callLlm: async () => ({
              text: "{\"content\":\"cut off",
              model: "fake-model",
              finishReason: "length",
              inputTokens: 100,
              outputTokens: 8000,
              nativeReasoningTokens: null,
              attemptCount: 1,
              structuredOutputFallback: false,
              reasoningClampFallback: false,
            }),
          },
          "user",
        ),
      (error) =>
        error instanceof MemoryLlmTruncatedError &&
        memoryErrorCategory(error) === "llm_output_truncated",
    );
  });
});

describe("observation profile v2 schema, handles, and parser hardening", () => {
  it("enforces strict json_schema without imposing an arbitrary character cap on profile content", () => {
    const format = buildObservationProfileResponseFormat();
    assert.equal(format.type, "json_schema");
    assert.equal(format.json_schema.strict, true);
    assert.equal(format.json_schema.schema.additionalProperties, false);
    assert.equal(format.json_schema.schema.properties.content.minLength, 1);
    assert.equal("maxLength" in format.json_schema.schema.properties.content, false);
    assert.equal(format.json_schema.schema.properties.claims.items.properties.text.maxLength, 400);
  });

  it("uses compact prompt-local handles and resolves them back to canonical IDs", () => {
    const observations = [
      observation({ observationId: "memory-observation-v1-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }),
      observation({ observationId: "memory-observation-v1-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", claim: "Prefers tea" }),
    ];
    const prompt = buildObservationProfilePrompt("SYSTEM", observations);
    assert.equal(prompt.messages[0].content.includes(`"observationId":"${profileObservationHandle(0)}"`), true);
    assert.equal(prompt.messages[0].content.includes(`"observationId":"${profileObservationHandle(1)}"`), true);
    assert.equal(prompt.messages[0].content.includes("memory-observation-v1-"), false);

    const parsed = parseProfileV2Output(
      JSON.stringify({
        content: "## Preferences & Tastes\n- Likes mornings and tea.",
        claims: [
          { observationId: "O1", text: "Likes mornings" },
          { observationId: "memory-observation-v1-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", text: "Prefers tea" },
          { observationId: "O999", text: "Hallucinated ID should be dropped" },
        ],
      }),
      observations,
    );
    assert.equal(parsed.droppedClaims, 1);
    assert.deepEqual(parsed.claims, [
      { observationId: "memory-observation-v1-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", text: "Likes mornings" },
      { observationId: "memory-observation-v1-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", text: "Prefers tea" },
    ]);
  });

  it("tolerates markdown-fenced JSON responses", () => {
    const observations = [observation()];
    const fenced = "```json\n" + JSON.stringify({
      content: "## Life & Background\n- Morning person.",
      claims: [{ observationId: "O1", text: "Likes mornings" }],
    }) + "\n```";
    const parsed = parseProfileV2Output(fenced, observations);
    assert.equal(parsed.content, "## Life & Background\n- Morning person.");
    assert.equal(parsed.claims[0].observationId, "obs-1");
  });

  it("preserves full-length multi-section profiles without character-count truncation", () => {
    const longProfile = [
      "## Life & Background",
      ...Array.from({ length: 80 }, (_, idx) => `- Detail ${String(idx + 1)}: ${"word ".repeat(15).trim()}.`),
      "",
      "## Dynamics & How I Feel",
      "- I feel genuinely comfortable and heard in our conversations.",
    ].join("\n");
    assert.ok(longProfile.length > 4500);
    const parsed = parseProfileV2Output(
      JSON.stringify({ content: longProfile, claims: [{ observationId: "O1", text: "Likes mornings" }] }),
      [observation()],
    );
    assert.equal(parsed.content, longProfile);
  });

  it("attaches closed-set validation reasons on genuine output errors", () => {
    const obs = [observation()];
    const cases = [
      ["not json at all", "json_parse"],
      ["[]", "not_object"],
      [JSON.stringify({ claims: [] }), "missing_content"],
      [JSON.stringify({ content: "   ", claims: [] }), "empty_content"],
    ];
    for (const [payload, expectedReason] of cases) {
      assert.throws(
        () => parseProfileV2Output(payload, obs),
        (error) =>
          error instanceof MemoryLlmOutputError &&
          memoryErrorCategory(error) === "llm_output_invalid" &&
          memoryOutputErrorReason(error) === expectedReason,
      );
    }
  });
});
