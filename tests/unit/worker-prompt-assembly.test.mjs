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
import { buildDynamicInitiativePrompt } from "../../apps/worker/src/work/initiative.ts";
import { processTurnWork } from "../../apps/worker/src/work/processor.ts";
import { DECISION_QUESTION_ID } from "../../apps/worker/src/work/decision.ts";
import {
  ARTICLE_SHARE_NONE_CHOICE,
  ARTICLE_SHARE_QUESTION_ID,
} from "../../apps/worker/src/articles/share.ts";
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

  it("coalesces consecutive assistant messages so scheduled notices never break speaker alternation while keeping grouped user messages separate", () => {
    const { request, messages } = buildChatPrompt({
      model: "chat-model",
      identity: "IDENTITY",
      history: [
        message(1, "user", "what is your favorite album?"),
        message(2, "assistant", "spirited away soundtrack! your turn!"),
        message(3, "assistant", "mind if i put my phone down for like 10 mins to shower?"),
      ],
      turnMessages: [
        message(4, "user", "Songs for the Deaf"),
        message(5, "user", "and yes go shower"),
      ],
      guidance: null,
    });
    assert.deepEqual(
      request.messages.map((m) => m.role),
      ["system", "user", "assistant", "user", "user"],
    );
    assert.equal(
      request.messages[2].content,
      "spirited away soundtrack! your turn!\n\nmind if i put my phone down for like 10 mins to shower?",
    );
    assert.deepEqual(
      messages.map((m) => m.content),
      request.messages.map((m) => m.content),
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
    // The generic assembly adds no reasoning default.
    assert.equal(request.reasoning, undefined);
  });

  it("passes explicit reasoning through unchanged", () => {
    const { request } = buildChatPrompt({
      model: "chat-model",
      identity: "IDENTITY",
      history: [],
      turnMessages: [message(1, "user", "hi")],
      guidance: null,
      reasoning: { effort: "high", exclude: true },
    });
    assert.deepEqual(request.reasoning, { effort: "high", exclude: true });
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

  it("sends no reasoning when no chat effort is configured (legacy)", async () => {
    let sent;
    const { deps: processorDeps } = deps({
      callChat: async (request) => {
        sent = request;
        return chatResponse("reply");
      },
    });
    await processTurnWork(work, processorDeps);
    assert.equal(sent.reasoning, undefined);
  });

  it("sends the configured chat reasoning effort with reasoning excluded", async () => {
    let sent;
    const { deps: processorDeps } = deps({
      chatReasoningEffort: "high",
      callChat: async (request) => {
        sent = request;
        return chatResponse("reply");
      },
    });
    await processTurnWork(work, processorDeps);
    assert.deepEqual(sent.reasoning, { effort: "high", exclude: true });
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
      assert.deepEqual(payload.request.messages.map(message => message.chunk), expectedChunks);
      assert.deepEqual(payload.request.messages.map(message => message.sourceMessageId), expectedSources);
      assert.equal(payload.identityRevision, 7);
      assert.equal(
        payload.request.messages.map(message => message.chunk).length,
        payload.request.messages.length,
      );
      assert.equal(
        payload.request.messages.map(message => message.sourceMessageId).length,
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

  it("orders all sections as identity -> profiles -> relationship -> temporal -> recall -> guidance -> time -> routine -> prompt_module -> conversation", () => {
    const { messages } = buildChatPrompt({
      model: "chat-model",
      identity: "IDENTITY",
      profiles: "PROFILES",
      relationship: "FAMILIARITY",
      temporal: "TEMPORAL MEMORY",
      recall: "RELATED MEMORIES",
      guidance: "DYNAMIC INITIATIVE",
      time: "CURRENT TIME",
      routine: "ROUTINE STATE",
      promptModules: [
        { moduleId: "mod-outfit", content: "OUTFIT STATE", outputKind: "authoritative_context" },
      ],
      history: [message(1, "user", "q1"), message(2, "assistant", "a1")],
      turnMessages: [message(3, "user", "q2")],
    });
    assert.deepEqual(
      messages.map((m) => m.chunk),
      [
        "identity",
        "profiles",
        "relationship",
        "temporal",
        "recall",
        "guidance",
        "time",
        "routine",
        "prompt_module",
        "conversation",
        "conversation",
        "conversation",
      ],
    );
  });

  it("omits empty or whitespace-only guidance so lean normal chat turns stay uncluttered", () => {
    const { messages } = buildChatPrompt({
      model: "chat-model",
      identity: "IDENTITY",
      guidance: "   ",
      history: [],
      turnMessages: [message(1, "user", "hi")],
    });
    assert.deepEqual(messages.map((m) => m.chunk), ["identity", "conversation"]);
  });

  it("decouples wall-clock time from temporal memory in processor assembly", async () => {
    let trace;
    await processTurnWork(work, baseDeps({
      now: () => new Date("2026-11-21T21:57:00.000Z"),
      temporalSettings: {
        timezone: "America/New_York",
        seasonHemisphere: null,
        birthdayMonth: null,
        birthdayDay: null,
      },
      loadMemoryContext: async () => ({
        profileSection: "PROFILE",
        temporalContext: "<last_night>Talked about music.</last_night>",
        memoryContext: "RELATED",
      }),
      loadRelationshipContext: async () => ({ context: "FAMILIARITY", baseTierOrdinal: 0 }),
      recordChatRequest: async (payload) => { trace = payload; },
    }));
    assert.deepEqual(trace.request.messages.map(message => message.chunk), [
      "identity",
      "profiles",
      "relationship",
      "temporal",
      "recall",
      "time",
      "conversation",
      "conversation",
      "conversation",
      "conversation",
    ]);
    const temporalMsg = trace.request.messages[3];
    const timeMsg = trace.request.messages[5];
    assert.equal(temporalMsg.content, "<last_night>Talked about music.</last_night>");
    assert.match(timeMsg.content, /^Current local date and time:/);
  });

  it("assembles dynamic initiative prompt with article and curated questions only when includeInitiativeContext is true", async () => {
    const candidate = {
      reactionId: "9e3d1f5e-1111-4222-8333-444455556666",
      itemId: "8a2c0e4d-0000-4111-7222-333344445555",
      url: "https://example.com/music",
      title: "Why vinyl keeps growing",
      feedId: "feed-1",
      reaction: "Really liked how it talked about tactile listening.",
      factKey: "article:00000000-0000-4000-8000-000000000001",
      publishedAt: "2026-11-20T00:00:00.000Z",
      generatedAt: "2026-11-21T18:00:00.000Z",
    };
    const inclusions = [];
    let initiativeCalls = 0;
    let trace;
    await processTurnWork(work, baseDeps({
      now: () => new Date("2026-11-21T21:00:00.000Z"),
      loadPatterns: async () => [
        {
          id: "chat",
          selectionDescription: "Normal conversation.",
          responseGuidance: "",
          position: 0,
          includeInitiativeContext: false,
        },
        {
          id: "take_initiative",
          selectionDescription: "Conversation is dying.",
          responseGuidance: "The user seems distracted; try talking about something specific.",
          position: 1,
          includeInitiativeContext: true,
        },
      ],
      loadArticleShareCandidates: async () => [candidate],
      recordArticleShareInclusion: async (entry) => inclusions.push(entry),
      loadInitiativeQuestions: async ({ recentText }) => {
        initiativeCalls += 1;
        assert.ok(recentText.includes("part one"));
        return [
          { questionKey: "fav-color", questionText: "What is the user's favorite color?", reason: "unanswered" },
          { questionKey: "fav-band", questionText: "What is the user's favorite band?", reason: "revisit", priorAnswer: "Radiohead", priorAnswerAgeDays: 45 },
        ];
      },
      callDecisions: async () => ({
        model: "decision-model-build",
        answers: {
          [DECISION_QUESTION_ID]: { type: "choice", choice: "take_initiative" },
          // Even when article_memory_share returns none on a dying conversation,
          // initiative pulls the cooldown-eligible candidate into the dynamic prompt.
          [ARTICLE_SHARE_QUESTION_ID]: { type: "choice", choice: ARTICLE_SHARE_NONE_CHOICE },
        },
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
      recordChatRequest: async (payload) => { trace = payload; },
    }));
    assert.equal(initiativeCalls, 1);
    assert.deepEqual(inclusions, [{ turnId: "turn-1", reactionId: candidate.reactionId }]);
    assert.ok(!trace.request.messages.map(message => message.chunk).includes("article"), "article is folded into dynamic guidance without duplication");
    const guidanceIndex = trace.request.messages.map(message => message.chunk).indexOf("guidance");
    assert.ok(guidanceIndex > 0);
    const guidanceText = trace.request.messages[guidanceIndex].content;
    assert.match(guidanceText, /The user seems distracted/);
    assert.match(guidanceText, /Why vinyl keeps growing/);
    assert.match(guidanceText, /tactile listening/);
    assert.match(guidanceText, /favorite color/);
    assert.match(guidanceText, /answered 45d ago as "Radiohead"/);
    assert.match(guidanceText, /Ask one of these questions or bring up/);

    // On a normal chat turn, questions are omitted completely and blank guidance emits no chunk.
    let normalInitiativeCalls = 0;
    let normalTrace;
    await processTurnWork(work, baseDeps({
      loadPatterns: async () => [
        {
          id: "chat",
          selectionDescription: "Normal conversation.",
          responseGuidance: "",
          position: 0,
          includeInitiativeContext: false,
        },
      ],
      loadInitiativeQuestions: async () => {
        normalInitiativeCalls += 1;
        return [{ questionKey: "q", questionText: "Should not appear", reason: "unanswered" }];
      },
      callDecisions: async () => decisionResponse("chat"),
      recordChatRequest: async (payload) => { normalTrace = payload; },
    }));
    assert.equal(normalInitiativeCalls, 0);
    assert.ok(!normalTrace.request.messages.map(message => message.chunk).includes("guidance"));
  });

  it("buildDynamicInitiativePrompt handles questions-only and article-only cleanly", () => {
    const questionsOnly = buildDynamicInitiativePrompt({
      guidance: "Keep it going.",
      article: null,
      questions: [{ questionKey: "q1", questionText: "Favorite movie?", reason: "unanswered" }],
    });
    assert.match(questionsOnly, /Favorite movie\?/);
    assert.match(questionsOnly, /Ask one of these questions naturally/);
    assert.ok(!questionsOnly.includes("bring up"));

    const empty = buildDynamicInitiativePrompt({
      guidance: "   ",
      article: null,
      questions: [],
    });
    assert.equal(empty, null);
  });
});
