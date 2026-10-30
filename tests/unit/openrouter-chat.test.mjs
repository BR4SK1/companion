// Deterministic contract tests for the OpenRouter Chat Completions contract
// (libraries/openrouter/src/chat.ts).
//
// No network: every payload below is an inline fake response body. These
// tests validate request/response shapes and the no-coercion rules only —
// no transport, provider, retry, or fallback behavior is exercised.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  ChatContractError,
  parseChatRequest,
  parseChatResponse,
} from "../../libraries/openrouter/src/chat.ts";

function assertContractError(fn, pathFragment, messageFragment) {
  assert.throws(fn, (error) => {
    assert.ok(
      error instanceof ChatContractError,
      `expected ChatContractError, got ${error}`,
    );
    if (pathFragment !== undefined) {
      assert.ok(
        error.path.includes(pathFragment),
        `expected path to include "${pathFragment}", got "${error.path}"`,
      );
    }
    if (messageFragment !== undefined) {
      assert.ok(
        error.message.includes(messageFragment),
        `expected message to include "${messageFragment}", got "${error.message}"`,
      );
    }
    return true;
  });
}

describe("chat request contract", () => {
  const baseRequest = {
    model: "openai/gpt-5.2",
    messages: [
      { role: "system", content: "Be concise." },
      { role: "user", content: "Hello." },
    ],
  };

  it("accepts a minimal request with required fields only", () => {
    const parsed = parseChatRequest(baseRequest);
    assert.equal(parsed.model, "openai/gpt-5.2");
    assert.deepEqual(parsed.messages, [
      { role: "system", content: "Be concise." },
      { role: "user", content: "Hello." },
    ]);
    assert.equal(parsed.temperature, undefined);
    assert.equal(parsed.max_tokens, undefined);
  });

  it("keeps optional sampling fields optional and unmodified", () => {
    const parsed = parseChatRequest({
      ...baseRequest,
      temperature: 0.7,
      max_tokens: 512,
    });
    assert.equal(parsed.temperature, 0.7);
    assert.equal(parsed.max_tokens, 512);
  });

  it("rejects missing model, empty messages, and unknown roles", () => {
    assertContractError(
      () => parseChatRequest({ messages: [{ role: "user", content: "x" }] }),
      "model",
    );
    assertContractError(() => parseChatRequest({ model: "m" }), "messages");
    assertContractError(
      () => parseChatRequest({ model: "m", messages: [] }),
      "messages",
      "at least one",
    );
    assertContractError(
      () =>
        parseChatRequest({ model: "m", messages: [{ role: "tool", content: "x" }] }),
      "role",
      "unexpected role",
    );
  });

  it("rejects non-string content (multimodal parts are out of scope)", () => {
    assertContractError(
      () =>
        parseChatRequest({
          model: "m",
          messages: [
            { role: "user", content: [{ type: "text", text: "x" }] },
          ],
        }),
      "content",
      "out of scope",
    );
  });

  it("rejects non-finite temperature and non-positive max_tokens without coercion", () => {
    assertContractError(
      () => parseChatRequest({ ...baseRequest, temperature: "0.7" }),
      "temperature",
      "expected a finite number",
    );
    assertContractError(
      () => parseChatRequest({ ...baseRequest, temperature: Number.NaN }),
      "temperature",
    );
    assertContractError(
      () => parseChatRequest({ ...baseRequest, max_tokens: 0 }),
      "max_tokens",
      ">= 1",
    );
    assertContractError(
      () => parseChatRequest({ ...baseRequest, max_tokens: 1.5 }),
      "max_tokens",
      "integer",
    );
  });
});

describe("chat response contract", () => {
  const baseResponse = {
    id: "resp-1",
    model: "openai/gpt-5.2",
    choices: [
      {
        message: { role: "assistant", content: "Hi there." },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
  };

  it("accepts a full response and preserves values as returned", () => {
    const parsed = parseChatResponse(baseResponse);
    assert.equal(parsed.id, "resp-1");
    assert.equal(parsed.model, "openai/gpt-5.2");
    assert.equal(parsed.choices.length, 1);
    assert.equal(parsed.choices[0].message.content, "Hi there.");
    assert.equal(parsed.choices[0].message.role, "assistant");
    assert.equal(parsed.choices[0].finish_reason, "stop");
    assert.deepEqual(parsed.usage, {
      prompt_tokens: 10,
      completion_tokens: 3,
      total_tokens: 13,
    });
  });

  it("keeps optional fields optional — nothing is fabricated", () => {
    const parsed = parseChatResponse({
      model: "openai/gpt-5.2",
      choices: [{ message: { role: "assistant", content: "Hi." } }],
    });
    assert.equal(parsed.id, undefined);
    assert.equal(parsed.choices[0].finish_reason, undefined);
    assert.equal(parsed.usage, undefined);
  });

  it("rejects missing or empty choices", () => {
    assertContractError(
      () => parseChatResponse({ choices: [{ message: { role: "assistant", content: "x" } }] }),
      "model",
    );
    assertContractError(() => parseChatResponse({ model: "m" }), "choices");
    assertContractError(
      () => parseChatResponse({ model: "m", choices: [] }),
      "choices",
      "at least one",
    );
  });

  it("rejects non-assistant reply roles, missing content, and bad usage", () => {
    assertContractError(
      () =>
        parseChatResponse({
          model: "m",
          choices: [{ message: { role: "user", content: "x" } }],
        }),
      "message.role",
    );
    assertContractError(
      () =>
        parseChatResponse({
          model: "m",
          choices: [{ message: { role: "assistant" } }],
        }),
      "message.content",
    );
    assertContractError(
      () =>
        parseChatResponse({
          model: "m",
          choices: [{ message: { role: "assistant", content: "x" } }],
          usage: { prompt_tokens: 1.5, completion_tokens: 2 },
        }),
      "usage.prompt_tokens",
      "integer",
    );
  });

  it("accepts unknown extra fields without surfacing them", () => {
    const parsed = parseChatResponse({
      ...baseResponse,
      provider: "some-provider",
      system_fingerprint: "fp_123",
    });
    assert.equal(parsed.provider, undefined);
    assert.equal(parsed.system_fingerprint, undefined);
  });
});
