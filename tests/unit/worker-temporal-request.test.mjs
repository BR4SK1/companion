import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { processTurnWork } from "../../apps/worker/src/work/processor.ts";

const response = {
  id: "temporal-chat",
  model: "fake",
  choices: [{ message: { role: "assistant", content: "reply" } }],
};

describe("temporal chat request wiring", () => {
  it("includes current local context in the temporal chunk and traces matching typed values", async () => {
    let capturedRequest;
    let capturedTrace;
    const result = await processTurnWork(
      {
        turn: { id: "turn-temporal" },
        messages: [{ id: "message-1", seq: 1, role: "user", content: "hi" }],
      },
      {
        decisionModel: "decision-model",
        chatModel: "chat-model",
        now: () => new Date("2026-11-01T06:30:45.000Z"),
        temporalSettings: {
          timezone: "America/New_York",
          seasonHemisphere: null,
          birthdayMonth: null,
          birthdayDay: null,
        },
        loadContext: async () => [],
        loadPatterns: async () => [],
        loadIdentity: async () => ({ content: "IDENTITY", revision: 1 }),
        callChat: async (request) => {
          capturedRequest = request;
          return response;
        },
        recordChatRequest: async (payload) => {
          capturedTrace = payload.temporalContext;
        },
      },
    );

    assert.equal(result.reply, "reply");
    assert.ok(capturedTrace);
    assert.equal(capturedTrace.asOf, "2026-11-01T06:30:45.000Z");
    const localParts = Object.fromEntries(
      new Intl.DateTimeFormat("en-CA", {
        timeZone: capturedTrace.timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
      })
        .formatToParts(new Date(capturedTrace.asOf))
        .filter((part) => part.type !== "literal")
        .map((part) => [part.type, part.value]),
    );
    assert.equal(capturedTrace.localDate, `${localParts.year}-${localParts.month}-${localParts.day}`);
    assert.equal(capturedTrace.localTime, `${localParts.hour}:${localParts.minute}:${localParts.second}`);
    assert.equal(capturedTrace.season, "autumn");
    const temporalMessage = capturedRequest.messages.find((message) =>
      message.role === "system" && message.content.startsWith("Current local date and time:"),
    );
    assert.ok(temporalMessage);
    const localDateLabel = new Intl.DateTimeFormat("en-US", {
      timeZone: capturedTrace.timezone,
      month: "long",
      day: "numeric",
      year: "numeric",
    }).format(new Date(capturedTrace.asOf));
    assert.match(temporalMessage.content, new RegExp(localDateLabel));
    assert.match(temporalMessage.content, /America\/New_York/);
  });

  it("records explicit unspecified values and does not derive a browser/host zone", async () => {
    let capturedRequest;
    let capturedTrace;
    await processTurnWork(
      { turn: { id: "turn-unconfigured" }, messages: [{ id: "message-1", seq: 1, role: "user", content: "hi" }] },
      {
        decisionModel: "decision-model",
        chatModel: "chat-model",
        now: () => new Date("2026-11-01T06:30:45.000Z"),
        temporalSettings: {
          timezone: null,
          seasonHemisphere: null,
          birthdayMonth: null,
          birthdayDay: null,
        },
        loadContext: async () => [],
        loadPatterns: async () => [],
        loadIdentity: async () => ({ content: "IDENTITY", revision: 1 }),
        callChat: async (request) => {
          capturedRequest = request;
          return response;
        },
        recordChatRequest: async (payload) => {
          capturedTrace = payload.temporalContext;
        },
      },
    );
    assert.equal(capturedTrace.timezone, null);
    assert.equal(capturedTrace.localDate, null);
    assert.equal(capturedTrace.localTime, null);
    assert.equal(capturedTrace.season, null);
    assert.match(capturedRequest.messages[1].content, /local date, time, and season are unspecified/);
  });
});
