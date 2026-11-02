// Unit tests for canonical recall's deterministic scoring pieces: query
// sanitization, tsquery construction, recency and evidence boosts, input
// validation, and the chat memory-context rendering. Deterministic — no
// database, no network.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildTsQueryText,
  evidenceBoost,
  normalizeRecallInput,
  recencyBoost,
  sanitizeTextQuery,
  DEFAULT_RECALL_LIMIT,
} from "../../apps/worker/src/memory/recall.ts";
import {
  buildCanonicalMemoryContextForPrompt,
  renderProfileSection,
} from "../../apps/worker/src/memory/chat-context.ts";

describe("recall query sanitization", () => {
  it("strips quotes and $-prefixed tokens", () => {
    assert.equal(sanitizeTextQuery('he said "hello" $where is it'), "he said hello is it");
    assert.equal(sanitizeTextQuery("  multiple   spaces  "), "multiple spaces");
  });

  it("returns an empty string when nothing searchable remains", () => {
    assert.equal(sanitizeTextQuery("'\"$'"), "");
    assert.equal(sanitizeTextQuery(""), "");
  });

  it("OR-joins tokens and neutralizes dash operators", () => {
    assert.equal(buildTsQueryText("coffee mornings"), "coffee OR mornings");
    assert.equal(buildTsQueryText("-negated"), "negated");
    assert.equal(buildTsQueryText("trailing-"), "trailing-".replace(/^-+|-+$/g, "").replace(/-$/, "") || "");
    // An all-dash query degrades to the recency fallback shape.
    assert.equal(buildTsQueryText("---"), "");
  });

  it("validates recall inputs", () => {
    const referenceTime = new Date("2026-06-15T12:00:00Z");
    assert.equal(
      normalizeRecallInput({ query: "q", referenceTime }).limit,
      DEFAULT_RECALL_LIMIT,
    );
    assert.equal(
      normalizeRecallInput({ query: "q", referenceTime, maxChars: undefined }).maxChars,
      12_000,
    );
    assert.throws(
      () => normalizeRecallInput({ query: "", referenceTime }),
      /query is required/,
    );
    assert.throws(
      () => normalizeRecallInput({ query: "x".repeat(513), referenceTime }),
      /must not exceed/,
    );
    assert.throws(
      () => normalizeRecallInput({ query: "q", referenceTime, limit: 0 }),
      /limit must be an integer/,
    );
    assert.throws(
      () => normalizeRecallInput({ query: "q", referenceTime, limit: 33 }),
      /limit must be an integer/,
    );
    assert.throws(
      () => normalizeRecallInput({ query: "q", referenceTime, maxChars: 100 }),
      /maxChars must be an integer/,
    );
    assert.throws(
      () => normalizeRecallInput({ query: "q", referenceTime: new Date("nope") }),
      /referenceTime/,
    );
  });
});

describe("recall scoring pieces", () => {
  const reference = new Date("2026-06-15T12:00:00Z");

  it("halves recency per half-life", () => {
    const now = reference;
    assert.equal(recencyBoost(now, reference, 21), 1);
    const halfLife = 21 * 86_400_000;
    const half = recencyBoost(new Date(reference.getTime() - halfLife), reference, 21);
    assert.ok(Math.abs(half - 0.5) < 1e-9);
    const old = recencyBoost(new Date("2020-01-01T00:00:00Z"), reference, 21);
    assert.ok(old > 0 && old < 0.01);
  });

  it("boosts explicit facts and strong observations", () => {
    assert.equal(evidenceBoost("fact", "explicit"), 0.2);
    assert.equal(evidenceBoost("fact", "supported"), 0);
    assert.equal(evidenceBoost("fact", "inferred"), 0.1);
    assert.equal(evidenceBoost("observation", undefined, "strong"), 0.45);
    assert.equal(evidenceBoost("observation", undefined, "supported"), 0.3);
    assert.equal(evidenceBoost("observation", undefined, "tentative"), 0.15);
  });
});

describe("canonical memory context rendering", () => {
  const now = new Date("2026-06-15T12:00:00Z");

  it("renders deduplicated items with ages and type tags", () => {
    const text = buildCanonicalMemoryContextForPrompt({
      now,
      items: [
        {
          type: "fact",
          id: "fact-1",
          subject: "user",
          kind: "preference",
          claim: "Prefers tea in the morning",
          topics: [],
          observedAt: "2026-06-15T11:00:00Z",
          textScore: 0,
          recencyBoost: 0,
          evidenceBoost: 0,
          score: 0,
        },
        {
          type: "observation",
          id: "fact-1",
          subject: "user",
          kind: "preference",
          claim: "Prefers tea in the morning",
          topics: [],
          observedAt: "2026-06-01T11:00:00Z",
          textScore: 0,
          recencyBoost: 0,
          evidenceBoost: 0,
          score: 0,
        },
      ],
    });
    assert.ok(text.includes("(fact) [1h ago] Prefers tea in the morning"));
    // The duplicate id is rendered once.
    assert.equal(text.split("Prefers tea").length - 1, 1);
    assert.ok(text.startsWith("Use these memories as user-specific context."));
  });

  it("truncates long claims and escapes XML-sensitive characters", () => {
    const text = buildCanonicalMemoryContextForPrompt({
      now,
      items: [{
        type: "fact",
        id: "fact-2",
        subject: "user",
        kind: "fact",
        claim: `a <tag> & "quote" ${"x".repeat(230)}`,
        topics: [],
        observedAt: "2026-06-14T11:00:00Z",
        textScore: 0,
        recencyBoost: 0,
        evidenceBoost: 0,
        score: 0,
      }],
    });
    assert.ok(text.includes("&lt;tag&gt;"));
    assert.ok(text.includes("&amp;"));
    assert.ok(!text.includes("<tag>"));
    // The rendered claim line is bounded: truncation at 220 raw chars plus
    // the "..." marker and XML-escaping expansion.
    const claimLine = text.split("\n").find((line) => line.includes("xxx"));
    assert.ok(claimLine.length <= 260);
  });

  it("returns undefined for empty result sets", () => {
    assert.equal(buildCanonicalMemoryContextForPrompt({ items: [] }), undefined);
    assert.equal(
      buildCanonicalMemoryContextForPrompt({
        items: [{ type: "fact", id: "x", claim: "   ", observedAt: "2026-06-01T00:00:00Z" }],
      }),
      undefined,
    );
  });

  it("renders fingerprint-tagged profile sections with subject-id tags", () => {
    const section = renderProfileSection({
      profile: {
        subject: "user",
        fingerprint: "abc123",
        promptVersion: "v2-1",
        content: "Likes <quiet> mornings",
        claims: [],
        sourceCount: 7,
        model: "m",
        generatedAt: new Date("2026-06-15T08:00:00Z"),
      },
    });
    assert.ok(section.startsWith("<user profile_fingerprint="));
    assert.ok(section.includes("&lt;quiet&gt;"));
    assert.ok(section.endsWith("</user>"));
  });

  it("omits empty profiles", () => {
    assert.equal(
      renderProfileSection({
        profile: {
          subject: "user",
          fingerprint: "abc123",
          promptVersion: "v2-1",
          content: "",
          claims: [],
          sourceCount: 0,
          model: null,
          generatedAt: null,
        },
      }),
      undefined,
    );
    assert.equal(renderProfileSection(undefined), undefined);
    assert.equal(renderProfileSection(null), undefined);
  });
});

// ---------------------------------------------------------------------------
// Timeline/hybrid recall: temporal expression detection (parity slice).
// ---------------------------------------------------------------------------

import { detectRecallTimeRange } from "../../apps/worker/src/memory/recall-time.ts";

const REFERENCE = new Date("2026-06-15T12:00:00Z");
const NY = "America/New_York";

describe("recall temporal expression detection", () => {
  it("returns null for queries without an explicit temporal expression", () => {
    assert.equal(detectRecallTimeRange("morning tea habits", REFERENCE, NY), null);
    assert.equal(detectRecallTimeRange("weekly schedule", REFERENCE, NY), null);
    assert.equal(detectRecallTimeRange("", REFERENCE, NY), null);
  });

  it("disables temporal detection when no timezone is configured", () => {
    assert.equal(detectRecallTimeRange("walk yesterday", REFERENCE), null);
    assert.equal(detectRecallTimeRange("plans for last friday", REFERENCE), null);
  });

  it("parses an ISO date into a single local day and keeps the remaining keywords", () => {
    const range = detectRecallTimeRange("tea on 2026-06-02", REFERENCE, NY);
    assert.notEqual(range, null);
    // June is EDT (UTC-4): the local day bounds sit at 04:00Z.
    assert.equal(range.start.toISOString(), "2026-06-02T04:00:00.000Z");
    assert.equal(range.end.toISOString(), "2026-06-03T04:00:00.000Z");
    // No preposition stripping: only the matched span goes.
    assert.equal(range.remainingQuery, "tea on");
    assert.match(range.description, /\(local day\)/);
  });

  it("parses relative phrases into bounded local windows", () => {
    const lastWeek = detectRecallTimeRange("meetings last week", REFERENCE, NY);
    assert.notEqual(lastWeek, null);
    // 2026-06-15 is a Monday: last week is Mon 2026-06-08 .. Mon 2026-06-15,
    // local midnight bounds (EDT).
    assert.equal(lastWeek.start.toISOString(), "2026-06-08T04:00:00.000Z");
    assert.equal(lastWeek.end.toISOString(), "2026-06-15T04:00:00.000Z");
    assert.equal(lastWeek.remainingQuery, "meetings");

    const yesterday = detectRecallTimeRange("walk yesterday", REFERENCE, NY);
    assert.equal(yesterday.start.toISOString(), "2026-06-14T04:00:00.000Z");
    assert.equal(yesterday.end.toISOString(), "2026-06-15T04:00:00.000Z");
    assert.equal(yesterday.remainingQuery, "walk");
  });

  it("parses weekday phrases with the last/this/next resolution", () => {
    // Reference is Monday 2026-06-15 (NY). last friday = 3 days back.
    const lastFriday = detectRecallTimeRange("plans for last friday", REFERENCE, NY);
    assert.equal(lastFriday.start.toISOString(), "2026-06-12T04:00:00.000Z");
    assert.equal(lastFriday.end.toISOString(), "2026-06-13T04:00:00.000Z");
    assert.equal(lastFriday.remainingQuery, "plans for");

    // this monday = the reference day itself; morning = local 04:00-12:00.
    const mondayMorning = detectRecallTimeRange("this monday morning", REFERENCE, NY);
    assert.equal(mondayMorning.start.toISOString(), "2026-06-15T08:00:00.000Z");
    assert.equal(mondayMorning.end.toISOString(), "2026-06-15T16:00:00.000Z");
    assert.equal(mondayMorning.remainingQuery, "");
  });

  it("parses day parts, including night windows that cross midnight", () => {
    const lastNight = detectRecallTimeRange("what did I cook last night", REFERENCE, NY);
    assert.equal(lastNight.start.toISOString(), "2026-06-14T21:00:00.000Z");
    assert.equal(lastNight.end.toISOString(), "2026-06-15T08:00:00.000Z");
    assert.equal(lastNight.remainingQuery, "what did I cook");
  });

  it("parses an explicit range and enforces the two-year bound", () => {
    const range = detectRecallTimeRange(
      "between 2026-06-01 and 2026-06-03",
      REFERENCE,
      NY,
    );
    assert.equal(range.start.toISOString(), "2026-06-01T04:00:00.000Z");
    assert.equal(range.end.toISOString(), "2026-06-04T04:00:00.000Z");
    assert.equal(range.remainingQuery, "");

    const long = detectRecallTimeRange(
      "between 2020-01-01 and 2025-06-01",
      REFERENCE,
      NY,
    );
    assert.equal(long, null, "an over-two-years range stays in keyword mode");
  });

  it("parses a month-day token in the reference year and rejects impossible dates", () => {
    const named = detectRecallTimeRange("tea on may 3", REFERENCE, NY);
    assert.equal(named.start.toISOString(), "2026-05-03T04:00:00.000Z");
    assert.equal(named.end.toISOString(), "2026-05-04T04:00:00.000Z");
    assert.equal(named.remainingQuery, "tea on");

    assert.equal(
      detectRecallTimeRange("meeting on february 30", REFERENCE, NY),
      null,
      "an impossible civil date stays in keyword mode",
    );
  });

  it("keeps the ordinary word 'may' as a keyword (no bare month parsing)", () => {
    assert.equal(detectRecallTimeRange("may updates", REFERENCE, NY), null);
    assert.equal(
      detectRecallTimeRange("things I may want to revisit", REFERENCE, NY),
      null,
    );
  });

  it("has no bare-year or bare-month windows", () => {
    assert.equal(detectRecallTimeRange("in 2025", REFERENCE, NY), null);
    assert.equal(detectRecallTimeRange("in June 2026 I read a lot", REFERENCE, NY), null);
  });

  it("leaves unsupported date-like phrases in keyword mode", () => {
    // A bare weekday is date-like but unsupported on this surface.
    assert.equal(detectRecallTimeRange("see you monday", REFERENCE, NY), null);
    // "last N days" is not part of the supported grammar.
    assert.equal(detectRecallTimeRange("stress last 14 days", REFERENCE, NY), null);
  });

  it("leaves numbers that are not years alone (keyword mode)", () => {
    assert.equal(detectRecallTimeRange("16 days of data", REFERENCE, NY), null);
  });

  it("resolves calendar bounds across DST transitions", () => {
    // Spring forward 2026-03-08: the reference is 03:00 EDT; yesterday's
    // local day is a full EST day.
    const spring = detectRecallTimeRange(
      "walk yesterday",
      new Date("2026-03-08T07:00:00.000Z"),
      NY,
    );
    assert.equal(spring.start.toISOString(), "2026-03-07T05:00:00.000Z");
    assert.equal(spring.end.toISOString(), "2026-03-08T05:00:00.000Z");

    // Fall back 2026-11-01: yesterday's local day is 25 hours long.
    const fall = detectRecallTimeRange(
      "walk yesterday",
      new Date("2026-11-02T12:00:00.000Z"),
      NY,
    );
    assert.equal(fall.start.toISOString(), "2026-11-01T04:00:00.000Z");
    assert.equal(fall.end.toISOString(), "2026-11-02T05:00:00.000Z");
  });
});
