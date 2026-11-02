// Deterministic unit tests for the modular chat prompt assembly and the
// fail-closed chat-identity configuration: identity as the leading chunk,
// optional memory sections as separate chunks, selected/no pattern guidance,
// exact chronology (including a larger-than-default window and grouped turn
// messages), preserved roles, and the trace metadata (chunk classification,
// source linkage, identity revision) the processor records.
//
// Sources under apps/worker/src are imported directly (Node type stripping);
// no network calls and no database are involved.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildChatPrompt,
  buildChatRequest,
} from "../../apps/worker/src/work/chat.ts";
import { processTurnWork } from "../../apps/worker/src/work/processor.ts";
import { DECISION_QUESTION_ID } from "../../apps/worker/src/work/decision.ts";
import {
  IdentityConfigurationError,
} from "../../apps/worker/src/conversation/types.ts";

function message(seq, role, content) {
  return {
    id: `id-${String(seq)}`,
    seq,
    role,
    content,
    turnId: null,
    clientKey: null,
    createdAt: "2026-10-30T00:00:00.000Z",
  };
}

function chatResponse(content) {
  return {
    id: "chat-1",
    model: "chat-model-build",
    choices: [
      { message: { role: "assistant", content }, finish_reason: "stop" },
    ],
    usage: { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 },
  };
}

function decisionResponse(choice) {
  return {
    model: "decision-model-build",
    answers: { [DECISION_QUESTION_ID]: { type: "choice", choice } },
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

describe("prompt assembly: identity chunk", () => {
  it("sends the owner-authored identity as the leading system message", () => {
    const { request, messages } = buildChatPrompt({
      model: "chat-model",
      identity: "You are the owner's companion.",
      history: [message(1, "user", "earlier")],
      turnMessages: [message(2, "user", "hi")],
      guidance: null,
    });
    assert.equal(request.messages[0].role, "system");
    assert.equal(request.messages[0].content, "You are the owner's companion.");
    assert.equal(messages[0].chunk, "identity");
    assert.equal(messages[0].sourceMessageId, null);
  });

  it("classifies synthetic chunks and conversation messages, index-aligned", () => {
    const { request, messages } = buildChatPrompt({
      model: "chat-model",
      identity: "IDENTITY",
      profiles: "PROFILES",
      temporal: "TEMPORAL",
      recall: "RECALL",
      guidance: "GUIDANCE",
      history: [message(1, "user", "q1"), message(2, "assistant", "a1")],
      turnMessages: [message(3, "user", "q2")],
    });
    assert.deepEqual(
      messages.map((m) => m.chunk),
      ["identity", "profiles", "temporal", "recall", "guidance", "conversation", "conversation", "conversation"],
    );
    assert.deepEqual(messages.map((m) => m.content), request.messages.map((m) => m.content));
    assert.deepEqual(
      messages.map((m) => m.sourceMessageId),
      [null, null, null, null, null, "id-1", "id-2", "id-3"],
    );
  });
});

describe("prompt assembly: optional memory chunks", () => {
  const base = {
    model: "chat-model",
    identity: "IDENTITY",
    history: [],
    turnMessages: [message(1, "user", "hi")],
    guidance: null,
  };

  it("contributes no chunk for empty memory (no sections)", () => {
    const { request, messages } = buildChatPrompt(base);
    assert.deepEqual(
      messages.map((m) => m.chunk),
      ["identity", "conversation"],
    );
    assert.equal(request.messages.length, 2);
  });

  it("contributes no chunk for empty or whitespace-only sections", () => {
    const { messages } = buildChatPrompt({
      ...base,
      profiles: "",
      temporal: "   ",
      recall: undefined,
    });
    assert.deepEqual(
      messages.map((m) => m.chunk),
      ["identity", "conversation"],
    );
  });

  it("sends each present section as its own separate message", () => {
    const onlyTemporal = buildChatPrompt({ ...base, temporal: "TEMPORAL" });
    assert.deepEqual(
      onlyTemporal.messages.map((m) => `${m.chunk}:${m.content}`),
      ["identity:IDENTITY", "temporal:TEMPORAL", "conversation:hi"],
    );
    const onlyRecall = buildChatPrompt({ ...base, recall: "RECALL" });
    assert.deepEqual(
      onlyRecall.messages.map((m) => `${m.chunk}:${m.content}`),
      ["identity:IDENTITY", "recall:RECALL", "conversation:hi"],
    );
    const all = buildChatPrompt({
      ...base,
      profiles: "PROFILES",
      temporal: "TEMPORAL",
      recall: "RECALL",
    });
    assert.deepEqual(
      all.messages.map((m) => `${m.chunk}:${m.content}`),
      [
        "identity:IDENTITY",
        "profiles:PROFILES",
        "temporal:TEMPORAL",
        "recall:RECALL",
        "conversation:hi",
      ],
    );
  });

  it("keeps profiles a separate chunk between identity and temporal", () => {
    const { messages } = buildChatPrompt({ ...base, profiles: "PROFILES" });
    assert.deepEqual(
      messages.map((m) => m.chunk),
      ["identity", "profiles", "conversation"],
    );
  });
});

describe("prompt assembly: selected and unselected pattern guidance", () => {
  const base = {
    model: "chat-model",
    identity: "IDENTITY",
    history: [],
    turnMessages: [message(1, "user", "hi")],
  };

  it("sends the selected pattern's guidance after the memory chunks", () => {
    const { messages } = buildChatPrompt({
      ...base,
      recall: "RECALL",
      guidance: "Answer in one short paragraph.",
    });
    assert.deepEqual(
      messages.map((m) => `${m.chunk}:${m.content}`),
      [
        "identity:IDENTITY",
        "recall:RECALL",
        "guidance:Answer in one short paragraph.",
        "conversation:hi",
      ],
    );
  });

  it("sends no guidance chunk when no pattern was selected", () => {
    const { messages } = buildChatPrompt({ ...base, guidance: null });
    assert.deepEqual(
      messages.map((m) => m.chunk),
      ["identity", "conversation"],
    );
  });

  it("buildChatRequest returns the same wire request the prompt assembly built", () => {
    const params = {
      model: "chat-model",
      identity: "IDENTITY",
      temporal: "TEMPORAL",
      history: [message(1, "user", "q1")],
      turnMessages: [message(2, "user", "q2")],
      guidance: "GUIDANCE",
    };
    const assembled = buildChatPrompt(params);
    const request = buildChatRequest(params);
    assert.deepEqual(request, assembled.request);
  });
});

describe("processor: fail-closed identity configuration", () => {
  function deps(overrides) {
    const calls = { decisions: 0, chat: 0, snapshot: 0, chatRequest: 0 };
    const base = {
      decisionModel: "decision-model",
      chatModel: "chat-model",
      callDecisions: async (request) => {
        calls.decisions += 1;
        return decisionResponse("concise");
      },
      callChat: async () => {
        calls.chat += 1;
        return chatResponse("reply");
      },
      loadIdentity: async () => ({ content: "IDENTITY", revision: 3 }),
      loadPatterns: async () => [],
      loadContext: async () => [],
      recordSnapshot: async () => {
        calls.snapshot += 1;
      },
      recordChatRequest: async () => {
        calls.chatRequest += 1;
      },
      recordChatOutcome: async () => {},
    };
    return { deps: { ...base, ...overrides }, calls };
  }

  const work = {
    turn: {
      id: "turn-1",
      status: "in_flight",
      attempt: 1,
      leaseOwner: "o",
      leaseExpiresAt: new Date().toISOString(),
      selectedPatternId: null,
      decision: null,
      error: null,
      createdAt: new Date().toISOString(),
      completedAt: null,
    },
    messages: [message(1, "user", "hello")],
  };

  it("fails the attempt with the typed configuration error when identity is missing", async () => {
    const { deps: processorDeps, calls } = deps({
      loadIdentity: async () => {
        throw new IdentityConfigurationError(
          "chat_identity has no 'identity' row; provision the owner-authored identity before chat can run",
        );
      },
    });
    await assert.rejects(
      processTurnWork(work, processorDeps),
      IdentityConfigurationError,
    );
    // Fail-closed: no snapshot, no decision call, no chat call, no request
    // trace — nothing proceeds against a persona-less prompt.
    assert.equal(calls.snapshot, 0);
    assert.equal(calls.decisions, 0);
    assert.equal(calls.chat, 0);
    assert.equal(calls.chatRequest, 0);
  });

  it("propagates an empty-identity configuration error the same way", async () => {
    const { deps: processorDeps, calls } = deps({
      loadIdentity: async () => {
        throw new IdentityConfigurationError(
          "chat_identity row 'identity' has empty content; provision non-empty identity text",
        );
      },
    });
    await assert.rejects(processTurnWork(work, processorDeps), (error) => {
      assert.ok(error instanceof IdentityConfigurationError);
      assert.ok(error.message.includes("empty content"));
      return true;
    });
    assert.equal(calls.chat, 0);
  });

  it("never invents a persona: the identity text is sent exactly as provisioned", async () => {
    let sent;
    const { deps: processorDeps } = deps({
      callChat: async (request) => {
        sent = request;
        return chatResponse("reply");
      },
    });
    await processTurnWork(work, processorDeps);
    assert.equal(sent.messages[0].role, "system");
    assert.equal(sent.messages[0].content, "IDENTITY");
  });
});

describe("processor: modular assembly with memory, patterns, and trace metadata", () => {
  const history = [message(1, "user", "q1"), message(2, "assistant", "a1")];

  function baseDeps(overrides) {
    const base = {
      decisionModel: "decision-model",
      chatModel: "chat-model",
      callDecisions: async () => decisionResponse("concise"),
      callChat: async () => chatResponse("reply"),
      loadIdentity: async () => ({ content: "IDENTITY", revision: 7 }),
      loadPatterns: async () => [],
      loadContext: async () => history,
      recordChatRequest: async () => {},
      recordChatOutcome: async () => {},
    };
    return { ...base, ...overrides };
  }

  const work = {
    turn: {
      id: "turn-1",
      status: "in_flight",
      attempt: 1,
      leaseOwner: "o",
      leaseExpiresAt: new Date().toISOString(),
      selectedPatternId: null,
      decision: null,
      error: null,
      createdAt: new Date().toISOString(),
      completedAt: null,
    },
    messages: [message(3, "user", "part one"), message(4, "user", "part two")],
  };

  it("assembles identity, separated memory chunks, history, and grouped messages in order", async () => {
    let sent;
    const outcome = await processTurnWork(work, baseDeps({
      callChat: async (request) => {
        sent = request;
        return chatResponse("reply");
      },
      loadMemoryContext: async () => ({
        memoryContext: "RECALL",
        temporalContext: "TEMPORAL",
        profileSection: "PROFILES",
      }),
    }));
    assert.equal(outcome.reply, "reply");
    assert.deepEqual(
      sent.messages.map((m) => `${m.role}:${m.content}`),
      [
        "system:IDENTITY",
        "system:PROFILES",
        "system:TEMPORAL",
        "system:RECALL",
        "user:q1",
        "assistant:a1",
        "user:part one",
        "user:part two",
      ],
    );
  });

  it("sends no memory chunk when the loader returns nothing", async () => {
    let sent;
    await processTurnWork(work, baseDeps({
      callChat: async (request) => {
        sent = request;
        return chatResponse("reply");
      },
      loadMemoryContext: async () => ({}),
    }));
    assert.deepEqual(
      sent.messages.map((m) => m.content),
      ["IDENTITY", "q1", "a1", "part one", "part two"],
    );
  });

  it("continues without memory when the loader fails (never fails the turn)", async () => {
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (message) => warnings.push(String(message));
    try {
      let sent;
      const outcome = await processTurnWork(work, baseDeps({
        callChat: async (request) => {
          sent = request;
          return chatResponse("reply");
        },
        loadMemoryContext: async () => {
          throw new Error("memory unavailable");
        },
      }));
      assert.equal(outcome.reply, "reply");
      assert.deepEqual(
        sent.messages.map((m) => m.content),
        ["IDENTITY", "q1", "a1", "part one", "part two"],
      );
      assert.ok(warnings.some((line) => line.includes("[MEMORY]")));
    } finally {
      console.warn = originalWarn;
    }
  });

  it("sends the selected pattern's guidance after identity and memory", async () => {
    let sent;
    await processTurnWork(work, baseDeps({
      loadPatterns: async () => [
        {
          id: "concise",
          selectionDescription: "Short factual replies fit here.",
          responseGuidance: "Answer in one short paragraph.",
          position: 0,
        },
      ],
      callChat: async (request) => {
        sent = request;
        return chatResponse("reply");
      },
      loadMemoryContext: async () => ({ temporalContext: "TEMPORAL" }),
    }));
    assert.deepEqual(
      sent.messages.map((m) => `${m.role}:${m.content}`),
      [
        "system:IDENTITY",
        "system:TEMPORAL",
        "system:Answer in one short paragraph.",
        "user:q1",
        "assistant:a1",
        "user:part one",
        "user:part two",
      ],
    );
  });

  it("records the exact chunk classification, source linkage, and identity revision on both trace boundaries", async () => {
    const requests = [];
    const outcomes = [];
    await processTurnWork(work, baseDeps({
      loadMemoryContext: async () => ({ temporalContext: "TEMPORAL" }),
      recordChatRequest: async (payload) => requests.push(payload),
      recordChatOutcome: async (payload) => outcomes.push(payload),
    }));
    const expectedChunks = [
      "identity",
      "temporal",
      "conversation",
      "conversation",
      "conversation",
      "conversation",
    ];
    const expectedSources = [null, null, "id-1", "id-2", "id-3", "id-4"];
    for (const payload of [...requests, ...outcomes]) {
      assert.deepEqual(payload.messageChunks, expectedChunks);
      assert.deepEqual(payload.messageSources, expectedSources);
      assert.equal(payload.identityRevision, 7);
      assert.equal(
        payload.messageChunks.length,
        payload.request.messages.length,
      );
      assert.equal(
        payload.messageSources.length,
        payload.request.messages.length,
      );
    }
    assert.equal(requests.length, 1);
    assert.equal(outcomes.length, 1);
  });

  it("preserves exact chronology across a larger-than-default bounded window", async () => {
    const longHistory = [];
    for (let seq = 1; seq <= 45; seq += 1) {
      longHistory.push(
        message(seq, seq % 2 === 1 ? "user" : "assistant", `msg-${String(seq)}`),
      );
    }
    let sent;
    await processTurnWork(
      { ...work, messages: [message(46, "user", "latest")] },
      baseDeps({
        loadContext: async () => longHistory,
        callChat: async (request) => {
          sent = request;
          return chatResponse("reply");
        },
      }),
    );
    const conversation = sent.messages.slice(1);
    assert.equal(conversation.length, 46);
    assert.equal(conversation[0].content, "msg-1");
    assert.equal(conversation[44].content, "msg-45");
    assert.equal(conversation[45].content, "latest");
    assert.deepEqual(
      conversation.map((m) => m.role),
      [...longHistory.map((m) => m.role), "user"],
    );
  });
});
