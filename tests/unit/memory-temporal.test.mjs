// Unit tests for the temporal summary prompt pieces and the coverage-v4
// selection: response parsing, rendering with the configured user label,
// budget scaling, turn-pair building, and bounded coverage selection.
// Deterministic — no database, no network.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildTemporalSummaryPrompt,
  buildTemporalSummaryResponseFormat,
  getTemporalPrefix,
  parseTemporalSummaryOutput,
  renderTemporalSummary,
} from "../../apps/worker/src/memory/prompts.ts";
import {
  buildTurnPairs,
  getSummaryBudget,
  selectCoveragePairs,
  splitSource,
} from "../../apps/worker/src/memory/temporal/generator.ts";
import { getTemporalPeriod } from "../../apps/worker/src/memory/temporal/periods.ts";

const NY4 = { timezone: "America/New_York", dayStartHour: 4 };

function output(overrides = {}) {
  return {
    eventsAndFeelings: "We talked for a long time and it felt good.",
    learnedFacts: "You are left-handed.",
    discoveredPreferences: "You prefer winter.",
    ...overrides,
  };
}

describe("temporal summary prompts", () => {
  const period = getTemporalPeriod("day", new Date("2026-06-17T18:00:00Z"), NY4);

  it("labels the periods with application-owned openers", () => {
    assert.equal(getTemporalPrefix("night"), "Last night");
    assert.equal(getTemporalPrefix("morning"), "This morning");
    assert.equal(getTemporalPrefix("afternoon"), "This afternoon");
    assert.equal(getTemporalPrefix("day"), "Yesterday");
    assert.equal(getTemporalPrefix("week"), "Last week");
    assert.equal(getTemporalPrefix("month"), "Last month");
  });

  it("embeds the period window and source material in the user message", () => {
    const spec = buildTemporalSummaryPrompt(
      "SYSTEM",
      period,
      "SOURCE BODY",
      1200,
    );
    assert.equal(spec.systemPrompt, "SYSTEM");
    assert.equal(spec.messages.length, 1);
    assert.ok(spec.messages[0].content.includes("Memory period: day"));
    assert.ok(spec.messages[0].content.includes("SOURCE MATERIAL"));
    assert.ok(spec.messages[0].content.includes("SOURCE BODY"));
    assert.ok(spec.messages[0].content.includes(period.startAt.toISOString()));
    assert.ok(spec.messages[0].content.includes(period.endAt.toISOString()));
  });

  it("bounds the schema fields by the memory budget", () => {
    const format = buildTemporalSummaryResponseFormat(1500);
    const properties = format.json_schema.schema.properties;
    assert.equal(properties.eventsAndFeelings.maxLength, 1500);
    assert.deepEqual(format.json_schema.schema.required, [
      "eventsAndFeelings",
      "learnedFacts",
      "discoveredPreferences",
    ]);
  });

  it("parses the three-field output and rejects empty output", () => {
    const parsed = parseTemporalSummaryOutput(JSON.stringify(output()));
    assert.equal(parsed.learnedFacts, "You are left-handed.");
    assert.throws(
      () => parseTemporalSummaryOutput(JSON.stringify({ eventsAndFeelings: "", learnedFacts: "", discoveredPreferences: "" })),
      /empty/,
    );
    assert.throws(
      () => parseTemporalSummaryOutput(JSON.stringify({ eventsAndFeelings: "x", learnedFacts: "y" })),
      /schema/,
    );
    assert.throws(() => parseTemporalSummaryOutput("not json"), /JSON/);
  });

  it("renders with the configured user label and normalizes second person", () => {
    const rendered = renderTemporalSummary(
      period,
      output({
        learnedFacts: "you are left-handed, and your sister visited",
      }),
      2000,
      "Sam",
    );
    assert.ok(rendered.startsWith("Yesterday, "));
    assert.ok(rendered.includes("Sam is left-handed"));
    assert.ok(rendered.includes("Sam's sister visited"));
    assert.ok(!/\byou\b/i.test(rendered));
    // Structured fields keep their labels; events first without one.
    assert.ok(rendered.includes("What I learned:"));
    assert.ok(rendered.includes("Preferences I noticed:"));
  });

  it("strips a model-added repeated opener", () => {
    const rendered = renderTemporalSummary(
      period,
      output({ eventsAndFeelings: "Yesterday, we talked." }),
      2000,
      "Sam",
    );
    assert.ok(!rendered.startsWith("Yesterday, Yesterday"));
    assert.ok(rendered.startsWith("Yesterday, we talked"));
  });

  it("rejects detached attribution and non-first-person prose", () => {
    assert.throws(
      () =>
        renderTemporalSummary(
          period,
          output({ eventsAndFeelings: "The user and the assistant talked." }),
          2000,
          "Sam",
        ),
      /detached third-person attribution/,
    );
    assert.throws(
      () =>
        renderTemporalSummary(
          period,
          output({
            eventsAndFeelings: "Sam and everyone had fun.",
            learnedFacts: "",
            discoveredPreferences: "",
          }),
          2000,
          "Sam",
        ),
      /not written in first person/,
    );
  });

  it("scales the budget with message count and clamps it", () => {
    const small = getSummaryBudget(10);
    assert.equal(small.maxTokens, 3000);
    assert.equal(small.maxMemoryChars, 3000 * 3 > 6000 ? 6000 : Math.floor(3000 * 3));
    assert.deepEqual(getSummaryBudget(0), getSummaryBudget(1));
    const large = getSummaryBudget(1000);
    assert.equal(large.maxTokens, 4000);
    assert.equal(large.maxMemoryChars, 6000);
  });
});

describe("coverage-v4 selection", () => {
  function message(index, turnId, role, content, minutes) {
    return {
      id: `m${String(index)}`,
      turnId,
      role,
      content,
      createdAt: new Date(Date.parse("2026-06-15T08:00:00Z") + minutes * 60_000),
      turnCompleted: true,
    };
  }

  it("groups messages into turn pairs with segments and scores", () => {
    const messages = [];
    for (let turn = 0; turn < 8; turn += 1) {
      messages.push(message(turn * 2, `t${String(turn)}`, "user", `hello ${String(turn)}`, turn * 30));
      messages.push(message(turn * 2 + 1, `t${String(turn)}`, "assistant", `hi ${String(turn)}?`, turn * 30 + 5));
    }
    const pairs = buildTurnPairs(messages);
    assert.equal(pairs.length, 8);
    // Four segments over eight pairs: two pairs per segment.
    assert.deepEqual(
      pairs.map((pair) => pair.segment),
      [0, 0, 1, 1, 2, 2, 3, 3],
    );
    // The last segment outranks earlier ones; unfinished threads (the "?" in
    // each assistant reply) add score.
    for (const pair of pairs) assert.ok(pair.score > 0);
  });

  it("falls back to per-message grouping for unassigned messages", () => {
    const pairs = buildTurnPairs([
      message(0, null, "user", "loose message", 0),
    ]);
    assert.equal(pairs.length, 1);
    assert.equal(pairs[0].id, "message-0");
    assert.equal(pairs[0].userText, "loose message");
    assert.equal(pairs[0].assistantText, "");
  });

  it("caps the selection at twelve pairs with three per segment", () => {
    const messages = [];
    for (let turn = 0; turn < 40; turn += 1) {
      messages.push(message(turn * 2, `t${String(turn)}`, "user", `msg ${String(turn)}`, turn * 10));
      messages.push(message(turn * 2 + 1, `t${String(turn)}`, "assistant", `reply ${String(turn)}`, turn * 10 + 3));
    }
    const pairs = buildTurnPairs(messages);
    const selected = selectCoveragePairs(pairs);
    assert.equal(selected.length, 12);
    const perSegment = [0, 0, 0, 0];
    for (const pair of selected) perSegment[pair.segment] += 1;
    for (const count of perSegment) assert.ok(count <= 3);
    // Selected pairs are returned oldest first.
    for (let index = 1; index < selected.length; index += 1) {
      assert.ok(selected[index - 1].startAt.getTime() <= selected[index].startAt.getTime());
    }
  });

  it("splits oversized unit lists into bounded chunks", () => {
    const units = Array.from({ length: 7 }, (_, index) => ({
      sourceIds: [`s${String(index)}`],
      text: "x".repeat(100),
    }));
    // 400_000 cap: small units stay in one chunk.
    assert.equal(splitSource(units).length, 1);
    const huge = [
      { sourceIds: ["a"], text: "x".repeat(250_000) },
      { sourceIds: ["b"], text: "x".repeat(250_000) },
    ];
    const chunks = splitSource(huge);
    assert.equal(chunks.length, 2);
    assert.deepEqual(splitSource([]), [[]]);
  });
});
