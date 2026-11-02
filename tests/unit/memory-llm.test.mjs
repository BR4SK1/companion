// Unit tests for the memory LLM adapter's request construction (no network):
// task presets carry the pipeline's reasoning/thinking knobs, the
// request body mirrors the source adapter's parameter mapping, and the two
// fallback classifiers recognize the provider errors they exist for.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildMemoryLlmRequestBody,
  modelSupportsThinking,
  taskPresets,
  __internal,
} from "../../apps/worker/src/memory/llm.ts";

const { isStructuredOutputError, isReasoningClampError, getModelMaxTokens } = __internal;

describe("memory task presets", () => {
  it("preserves the source presets' reasoning and thinking knobs", () => {
    const presets = taskPresets({
      observationMaxOutputTokens: 12000,
      profileMaxOutputTokens: 8000,
    });
    // Every task runs at high reasoning effort; consolidation uses max.
    assert.equal(presets.temporalSummaryLeaf.reasoningEffort, "high");
    assert.equal(presets.temporalSummaryAggregate.reasoningEffort, "high");
    assert.equal(presets.profileSummary.reasoningEffort, "high");
    assert.equal(presets.memoryFactExtraction.reasoningEffort, "high");
    assert.equal(presets.memoryObservationConsolidation.reasoningEffort, "max");
    assert.equal(presets.memoryProfileV2.reasoningEffort, "high");
    // Only the aggregate temporal summary enables thinking.
    assert.equal(presets.temporalSummaryLeaf.thinking?.enabled, false);
    assert.equal(presets.temporalSummaryAggregate.thinking?.enabled, true);
    assert.equal(presets.profileSummary.thinking?.enabled, false);
    // Every preset honors its configured max_tokens exactly.
    for (const preset of Object.values(presets)) {
      assert.equal(preset.honorMaxTokens, true);
    }
  });

  it("takes the consolidation and profile output caps from configuration", () => {
    const presets = taskPresets({
      observationMaxOutputTokens: 9000,
      profileMaxOutputTokens: 6500,
    });
    assert.equal(presets.memoryObservationConsolidation.maxTokens, 9000);
    assert.equal(presets.memoryProfileV2.maxTokens, 6500);
  });
});

describe("memory llm request body", () => {
  const base = {
    model: "z-ai/glm-5.3-flash",
    taskPreset: {
      maxTokens: 4000,
      honorMaxTokens: true,
      temperature: 0.3,
      reasoningEffort: "high",
      thinking: { enabled: false, budgetTokens: 0 },
    },
  };

  it("sends reasoning effort and include_reasoning per the thinking flag", () => {
    const body = buildMemoryLlmRequestBody(base);
    assert.equal(body["model"], "z-ai/glm-5.3-flash");
    assert.equal(body["max_tokens"], 4000);
    assert.equal(body["temperature"], 0.3);
    assert.equal(body["include_reasoning"], false);
    assert.deepEqual(body["reasoning"], { effort: "high" });
    assert.ok(!("extended_thinking" in body));
  });

  it("omits the reasoning field when the preset has no reasoning effort", () => {
    const body = buildMemoryLlmRequestBody({
      model: "z-ai/glm-5.3-flash",
      taskPreset: { maxTokens: 100, temperature: 0.1 },
    });
    assert.equal(body["include_reasoning"], false);
    assert.ok(!("reasoning" in body));
  });

  it("enables extended thinking only for claude-family models", () => {
    const thinkingPreset = {
      maxTokens: 12000,
      honorMaxTokens: true,
      temperature: 0.5,
      reasoningEffort: "high",
      thinking: { enabled: true, budgetTokens: 0 },
    };
    const glmBody = buildMemoryLlmRequestBody({ model: "z-ai/glm-5.3-flash", taskPreset: thinkingPreset });
    assert.equal(glmBody["include_reasoning"], true);
    assert.ok(!("extended_thinking" in glmBody));
    const claudeBody = buildMemoryLlmRequestBody({ model: "anthropic/claude-3-5-sonnet", taskPreset: thinkingPreset });
    assert.equal(claudeBody["extended_thinking"], true);
    assert.equal(modelSupportsThinking("anthropic/claude-3-5-sonnet"), true);
    assert.equal(modelSupportsThinking("z-ai/glm-5.3-flash"), false);
  });

  it("clamps reasoning with max_tokens when configured on a non-claude model", () => {
    const body = buildMemoryLlmRequestBody({
      model: "z-ai/glm-5.3-flash",
      taskPreset: {
        maxTokens: 12000,
        honorMaxTokens: true,
        temperature: 0.5,
        reasoningEffort: "high",
        thinking: { enabled: true, budgetTokens: 0, reasoningMaxTokens: 2048 },
      },
    });
    // The thinking clamp overwrites the effort mapping, in source order.
    assert.deepEqual(body["reasoning"], { max_tokens: 2048 });
    assert.ok(!("extended_thinking" in body));
  });

  it("caps max_tokens for hard-capped model families only when honorMaxTokens is false", () => {
    assert.equal(
      buildMemoryLlmRequestBody({
        model: "deepseek/deepseek-chat",
        taskPreset: { maxTokens: 12000, temperature: 0.1 },
      })["max_tokens"],
      8192,
    );
    assert.equal(
      buildMemoryLlmRequestBody({
        model: "deepseek/deepseek-chat",
        taskPreset: { maxTokens: 12000, honorMaxTokens: true, temperature: 0.1 },
      })["max_tokens"],
      12000,
    );
    assert.equal(
      buildMemoryLlmRequestBody({
        model: "z-ai/glm-5.3-flash",
        taskPreset: { maxTokens: 12000, temperature: 0.1 },
      })["max_tokens"],
      12000,
    );
    assert.equal(getModelMaxTokens("moonshotai/kimi", 12000), 8192);
    assert.equal(getModelMaxTokens("qwen/qwen-2.5", 12000), 8192);
    assert.equal(getModelMaxTokens("openai/gpt-4o", 12000), 12000);
  });

  it("carries the response format when provided", () => {
    const format = { type: "json_schema", json_schema: { name: "x" } };
    const body = buildMemoryLlmRequestBody({ ...base, responseFormat: format });
    assert.deepEqual(body["response_format"], format);
    const plain = buildMemoryLlmRequestBody(base);
    assert.ok(!("response_format" in plain));
  });
});

describe("memory llm fallback classifiers", () => {
  it("recognizes structured-output rejection errors", () => {
    assert.equal(isStructuredOutputError("Model does not support response_format"), true);
    assert.equal(isStructuredOutputError("json_schema is not supported"), true);
    assert.equal(isStructuredOutputError("Structured output unavailable for this model"), true);
    assert.equal(isStructuredOutputError("Rate limited"), false);
  });

  it("recognizes reasoning-clamp errors", () => {
    assert.equal(isReasoningClampError("reasoning exceeds the max_tokens budget"), true);
    assert.equal(isReasoningClampError("reasoning too large for max_tokens"), true);
    assert.equal(isReasoningClampError("reasoning unsupported"), false);
    assert.equal(isReasoningClampError("max_tokens too small"), false);
  });
});
