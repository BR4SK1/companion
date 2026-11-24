// Unit tests for canonical recall's deterministic scoring pieces: query
// sanitization, tsquery construction, recency and evidence boosts, input
// validation, and the chat memory-context rendering. Deterministic — no
// database, no network.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  areClaimsNearDuplicate,
  buildRecallQuery,
  buildTsQueryText,
  evidenceBoost,
  normalizedLexicalScore,
  normalizedSemanticScore,
  normalizeRecallInput,
  recallCanonicalDetailed,
  recencyBoost,
  RECENT_RECALL_PENALTY,
  sanitizeTextQuery,
  selectRecallResults,
  DEFAULT_RECALL_LIMIT,
  DEFAULT_RECALL_MAX_ASSISTANT_SHARE,
} from "../../apps/worker/src/memory/recall.ts";
import {
  EMBEDDING_DIMENSIONS,
  EmbeddingRequestError,
  embeddingContentHash,
  renderEmbeddingInput,
} from "../../apps/worker/src/memory/embeddings.ts";
import { loadMemoryConfig } from "../../apps/worker/src/memory/config.ts";
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

  it("OR-joins substantive tokens, filters conversational filler, and neutralizes dash operators", () => {
    assert.equal(buildTsQueryText("coffee mornings"), "coffee OR mornings");
    assert.equal(
      buildTsQueryText("so we talk a lot about like music favorite band lol"),
      "music OR favorite OR band",
    );
    // Pure filler queries fall back to their tokens instead of going empty.
    assert.equal(buildTsQueryText("ok yeah lol"), "ok OR yeah OR lol");
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

  it("uses gentle tie-breaker boosts for explicit facts and strong observations", () => {
    assert.equal(evidenceBoost("fact", "explicit"), 0.03);
    assert.equal(evidenceBoost("fact", "supported"), 0.015);
    assert.equal(evidenceBoost("fact", "inferred"), 0.005);
    assert.equal(evidenceBoost("observation", undefined, "strong"), 0.07);
    assert.equal(evidenceBoost("observation", undefined, "supported"), 0.05);
    assert.equal(evidenceBoost("observation", undefined, "tentative"), 0.02);
    assert.ok(
      evidenceBoost("observation", undefined, "supported") > evidenceBoost("fact", "explicit"),
    );
    // Normalized relevance stays dominant over recency + evidence tie-breakers.
    assert.ok(normalizedSemanticScore(0.75) > normalizedSemanticScore(0.55));
    assert.equal(normalizedSemanticScore(0.45), 0);
    assert.ok(normalizedLexicalScore(0.05) === 0.5);
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

  it("preserves ordinary claims without mid-word truncation and word-bounds very long claims with XML escaping", () => {
    const mediumClaim = `a <tag> & "quote" ${"word ".repeat(50).trim()}`;
    const mediumText = buildCanonicalMemoryContextForPrompt({
      now,
      items: [{
        type: "fact",
        id: "fact-medium",
        subject: "user",
        kind: "fact",
        claim: mediumClaim,
        topics: [],
        observedAt: "2026-06-14T11:00:00Z",
        textScore: 0,
        recencyBoost: 0,
        evidenceBoost: 0,
        score: 0,
      }],
    });
    assert.ok(mediumText.includes("&lt;tag&gt;"));
    assert.ok(mediumText.includes("&amp;"));
    assert.ok(!mediumText.includes("<tag>"));
    assert.ok(!mediumText.includes("..."), "a ~270-char claim must not be truncated");

    const veryLongClaim = Array.from({ length: 220 }, (_, i) => `token${String(i)}`).join(" ");
    const longText = buildCanonicalMemoryContextForPrompt({
      now,
      items: [{
        type: "fact",
        id: "fact-long",
        subject: "user",
        kind: "fact",
        claim: veryLongClaim,
        topics: [],
        observedAt: "2026-06-14T11:00:00Z",
        textScore: 0,
        recencyBoost: 0,
        evidenceBoost: 0,
        score: 0,
      }],
    });
    const claimLine = longText.split("\n").find((line) => line.includes("token0"));
    assert.ok(claimLine.endsWith("..."), "claims over 1000 chars are safety-capped");
    assert.ok(claimLine.length <= 1040);
    // Word-boundary snap: the last token before "..." must be a complete tokenN, never partial "tok...".
    const beforeEllipsis = claimLine.slice(0, -3).trim().split(" ").at(-1);
    assert.match(beforeEllipsis, /^token\d+$/);
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

describe("chat recall query builder, dedupe, assistant cap, and exclusion filters", () => {
  it("keeps substantive user messages focused without diluting them with prior-turn text", () => {
    const topicSwitch =
      "Before college. So we talk a lot about like anime and movies, what about music? What's your favorite band? And no LoFi is not a band lol";
    const query = buildRecallQuery({
      currentUserText: topicSwitch,
      history: [
        { role: "user", content: "old turn should not be included", turnId: "turn-old" },
        { role: "assistant", content: "old reply", turnId: "turn-old" },
        { role: "user", content: "Nah I took 2 years of French in high school", turnId: "turn-prev" },
        { role: "assistant", content: "FRENCH?? two years of high school french is such a specific flavor", turnId: "turn-prev" },
      ],
    });
    assert.equal(query, topicSwitch);
    assert.ok(!query.includes("French"), "topic switch must not pull in prior French turn");
    assert.ok(query.length <= 512);
  });

  it("borrows bounded prior-turn context for short follow-ups while keeping current text first", () => {
    const query = buildRecallQuery({
      currentUserText: "what about dinner?",
      history: [
        { role: "user", content: "old turn should not be included", turnId: "turn-old" },
        { role: "user", content: "pasta or tacos", turnId: "turn-prev" },
        { role: "assistant", content: Array.from({ length: 120 }, (_, i) => `extra${String(i)}`).join(" "), turnId: "turn-prev" },
      ],
    });
    assert.ok(query.startsWith("what about dinner?"));
    assert.ok(query.includes("pasta or tacos"));
    assert.ok(!query.includes("old turn"), "only includes the immediately preceding turn");
    // Prior assistant text is tightly bounded (~160 chars) instead of filling 512 chars.
    assert.ok(query.length <= 240);
    const lastToken = query.split(" ").at(-1);
    assert.match(lastToken, /^extra\d+$/);
  });

  it("detects near-identical claims including slightly reworded observations while keeping distinct claims separate", () => {
    assert.equal(
      areClaimsNearDuplicate("Prefers tea in the morning.", "prefers tea in the morning"),
      true,
    );
    assert.equal(
      areClaimsNearDuplicate(
        "The user is planning a summer hiking trip to Colorado",
        "User planning summer hiking trip to Colorado soon",
      ),
      true,
    );
    assert.equal(
      areClaimsNearDuplicate(
        "My favorite part of getting to know someone is when scattered facts start clicking into one person. I noted we've had a week of daily conversations producing shared lore.",
        "My favorite part of getting to know someone is when scattered facts start clicking into one person. After a week of daily conversations, talking this much has become my favorite part.",
      ),
      true,
    );
    assert.equal(
      areClaimsNearDuplicate("Likes coffee in the morning", "Works as a software engineer"),
      false,
    );
  });

  it("caps assistant-attributed items and deduplicates same-subject near-duplicates", () => {
    const mk = (id, subjectRole, claim, score, type = "fact") => ({
      item: {
        type,
        id,
        subject: subjectRole,
        subjectRole,
        kind: "fact",
        claim,
        topics: [],
        observedAt: "2026-06-01T00:00:00.000Z",
        textScore: score,
        recencyBoost: 0,
        evidenceBoost: 0,
        score,
      },
      score,
      chars: claim.length + 40,
    });
    const scored = [
      mk("a1", "assistant", "Found an article on local-first databases interesting", 10),
      mk("a2", "assistant", "Enjoys reading sci-fi novels in autumn", 9),
      mk("a3", "assistant", "Likes rainy evenings with music", 8),
      mk("a4", "assistant", "Curious about vintage cameras", 7),
      mk("u1", "user", "User loves cycling along the river in summer", 6),
      mk("u2", "user", "User loves cycling along the river during summer.", 5.5),
      mk("u3", "user", "User trained for a half marathon last spring", 5),
      mk("u4", "user", "User enjoys autumn weather", 4),
    ];
    const { results } = selectRecallResults(scored, {
      limit: 8,
      maxChars: 12_000,
      maxAssistantShare: DEFAULT_RECALL_MAX_ASSISTANT_SHARE,
      deduplicateClaims: true,
    });
    const assistantItems = results.filter((item) => item.subjectRole === "assistant");
    assert.equal(assistantItems.length, 2, "assistant items capped at 2 of 8");
    const ids = results.map((item) => item.id);
    assert.ok(ids.includes("u1"));
    assert.ok(!ids.includes("u2"), "near-duplicate user claim is deduplicated");
    assert.ok(ids.includes("u3"));
    assert.ok(ids.includes("u4"));
  });

  it("applies excludeTurnIds and minAgeMs SQL filters and configures a 15-minute default", async () => {
    const config = loadMemoryConfig({});
    assert.equal(config.recallMinAgeMs, 15 * 60_000);

    const calls = [];
    const pool = {
      query: async (sql, params) => {
        calls.push({ sql: String(sql), params });
        return { rows: [] };
      },
    };
    const referenceTime = new Date("2026-06-15T12:30:00.000Z");
    await recallCanonicalDetailed(pool, config, {
      query: "morning coffee",
      referenceTime,
      excludeTurnIds: ["turn-1", "turn-2"],
      minAgeMs: 15 * 60_000,
    });
    assert.equal(calls.length, 2);
    const [factCall, obsCall] = calls;
    assert.match(factCall.sql, /f\.observed_at <= \$\d+::timestamptz/);
    assert.match(factCall.sql, /\(f\.turn_id IS NULL OR f\.turn_id::text <> ALL\(\$\d+::text\[\]\)\)/);
    assert.equal(factCall.params[2].toISOString(), "2026-06-15T12:15:00.000Z");
    assert.deepEqual(factCall.params[3], ["turn-1", "turn-2"]);
    assert.match(obsCall.sql, /o\.last_observed_at <= \$\d+::timestamptz/);
    assert.equal(obsCall.params[2].toISOString(), "2026-06-15T12:15:00.000Z");
  });

  it("runs live pgvector hybrid recall so a 5-day-old relevant fact beats an irrelevant same-day strong observation and filters noise", async () => {
    const config = loadMemoryConfig({});
    assert.equal(config.canonicalRecencyWeight, 0.08);
    assert.equal(config.semanticRecallEnabled, true);
    const referenceTime = new Date("2026-11-23T20:53:07.000Z");
    const qotsaClaim = "Kyle told me Queens of the Stone Age is his favorite band.";
    const sleeperClaim = "Kyle told me he is a professional sleeper with an ADHD brain.";
    const noiseClaim = "Unrelated low-similarity chatter.";

    const qotsaHash = embeddingContentHash(renderEmbeddingInput({ claim: qotsaClaim }));
    const sleeperHash = embeddingContentHash(renderEmbeddingInput({ claim: sleeperClaim }));
    const noiseHash = embeddingContentHash(renderEmbeddingInput({ claim: noiseClaim }));

    const embedCalls = [];
    const embeddingClient = {
      busy: false,
      async embed(texts, inputType) {
        embedCalls.push({ texts, inputType });
        return [[1, ...Array(EMBEDDING_DIMENSIONS - 1).fill(0)]];
      },
    };

    const pool = {
      async query(sql) {
        const text = String(sql);
        if (text.includes("FROM memory_semantic_embedding e") && text.includes("JOIN memory_fact f")) {
          return {
            rows: [
              {
                fact_key: "fact-qotsa",
                subject_id: "kyle",
                subject_role: "user",
                kind: "preference",
                claim: qotsaClaim,
                turn_id: "turn-old",
                source_type: "conversation",
                article_reaction_id: null,
                condition: null,
                consequence: null,
                topics: ["music"],
                observed_at: new Date("2026-11-18T13:32:00.000Z"),
                explicitness: "explicit",
                text_score: null,
                similarity: 0.72,
                embedding_content_hash: qotsaHash,
              },
              {
                fact_key: "fact-noise",
                subject_id: "kyle",
                subject_role: "user",
                kind: "fact",
                claim: noiseClaim,
                turn_id: "turn-old-2",
                source_type: "conversation",
                article_reaction_id: null,
                condition: null,
                consequence: null,
                topics: [],
                observed_at: new Date("2026-11-23T19:00:00.000Z"),
                explicitness: "explicit",
                text_score: null,
                similarity: 0.51,
                embedding_content_hash: noiseHash,
              },
            ],
          };
        }
        if (text.includes("FROM memory_semantic_embedding e") && text.includes("JOIN memory_canonical_observation o")) {
          return { rows: [] };
        }
        if (text.includes("FROM memory_canonical_observation o")) {
          return {
            rows: [
              {
                canonical_observation_id: "obs-sleeper",
                subject_id: "kyle",
                subject_role: "user",
                article_sourced: false,
                kind: "habit",
                claim: sleeperClaim,
                condition: null,
                consequence: null,
                topics: ["sleep"],
                last_observed_at: new Date("2026-11-23T14:00:00.000Z"),
                evidence_strength: "strong",
                support_count: 5,
                distinct_day_count: 3,
                text_score: 0.004,
                similarity: 0.52,
                embedding_content_hash: sleeperHash,
              },
            ],
          };
        }
        return { rows: [] };
      },
    };

    const detailed = await recallCanonicalDetailed(pool, config, {
      query: "what about music? What's your favorite band?",
      referenceTime,
      embeddingClient,
    });
    assert.equal(embedCalls.length, 1);
    assert.equal(embedCalls[0].inputType, "query");
    assert.equal(detailed.response.diagnostics.semanticUsed, true);
    assert.equal(detailed.response.results.length, 1);
    assert.equal(detailed.response.results[0].id, "fact-qotsa");
    assert.equal(detailed.response.results[0].semanticSimilarity, 0.72);

    // Recent-turn cooldown penalizes items already surfaced on previous turns.
    const cooled = await recallCanonicalDetailed(pool, config, {
      query: "what about music? What's your favorite band?",
      referenceTime,
      embeddingClient,
      recentlyRecalledIds: new Set(["fact-qotsa"]),
    });
    assert.ok(
      detailed.response.results[0].score - cooled.response.results[0].score >=
        RECENT_RECALL_PENALTY - 1e-6,
    );
  });

  it("degrades cleanly to lexical recall when live query embedding fails", async () => {
    const config = loadMemoryConfig({});
    const logs = [];
    const pool = {
      async query(sql) {
        if (String(sql).includes("FROM memory_fact f")) {
          return {
            rows: [
              {
                fact_key: "fact-fallback",
                subject_id: "kyle",
                subject_role: "user",
                kind: "preference",
                claim: "Kyle likes coffee in the morning.",
                turn_id: "turn-1",
                source_type: "conversation",
                article_reaction_id: null,
                condition: null,
                consequence: null,
                topics: ["coffee"],
                observed_at: new Date("2026-11-20T12:00:00.000Z"),
                explicitness: "explicit",
                text_score: 0.08,
              },
            ],
          };
        }
        return { rows: [] };
      },
    };
    const failingClient = {
      busy: false,
      async embed() {
        throw new EmbeddingRequestError("embedding_timeout");
      },
    };
    const detailed = await recallCanonicalDetailed(pool, config, {
      query: "coffee",
      referenceTime: new Date("2026-11-23T12:00:00.000Z"),
      embeddingClient: failingClient,
      log: (msg) => logs.push(msg),
    });
    assert.equal(detailed.response.diagnostics.semanticUsed, false);
    assert.equal(detailed.response.results.length, 1);
    assert.equal(detailed.response.results[0].id, "fact-fallback");
    assert.ok(logs.some((line) => line.includes("falling back to lexical recall")));
  });
});
