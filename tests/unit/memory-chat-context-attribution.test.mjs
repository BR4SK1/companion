// Hermetic unit tests for recall memory-context attribution rendering: an
// assistant-attributed memory (a recorded article reaction, or an interest
// consolidated from them) must never be presented as user-specific context,
// and article-sourced items must be marked as such. Deterministic — no
// database, no network.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildCanonicalMemoryContextForPrompt } from "../../apps/worker/src/memory/chat-context.ts";

const NOW = new Date("2026-11-06T12:00:00Z");

function factItem(overrides = {}) {
  return {
    type: "fact",
    id: "fact-1",
    subject: "user",
    kind: "preference",
    claim: "Prefers tea in the morning",
    topics: [],
    observedAt: "2026-11-06T11:00:00Z",
    textScore: 0,
    recencyBoost: 0,
    evidenceBoost: 0,
    score: 0,
    ...overrides,
  };
}

function observationItem(overrides = {}) {
  return {
    type: "observation",
    id: "obs-1",
    subject: "user",
    kind: "preference",
    claim: "Usually walks in the morning",
    topics: [],
    observedAt: "2026-11-05T11:00:00Z",
    textScore: 0,
    recencyBoost: 0,
    evidenceBoost: 0,
    score: 0,
    ...overrides,
  };
}

describe("recall rendering: user-role conversation memories (legacy shape)", () => {
  it("keeps the user-specific-context header and untagged lines for user facts", () => {
    const text = buildCanonicalMemoryContextForPrompt({
      now: NOW,
      items: [
        factItem({ subjectRole: "user", sourceType: "conversation" }),
      ],
    });
    assert.ok(
      text.startsWith("Use these memories as user-specific context."),
      `expected the legacy header, got:\n${text}`,
    );
    assert.ok(text.includes("- (fact) [1h ago] Prefers tea in the morning"));
    assert.ok(!text.includes("[the assistant's own"));
    assert.ok(!text.includes("[from an article]"));
  });

  it("keeps the legacy shape for items that predate the attribution fields", () => {
    const text = buildCanonicalMemoryContextForPrompt({
      now: NOW,
      items: [factItem(), observationItem()],
    });
    assert.ok(text.startsWith("Use these memories as user-specific context."));
    assert.ok(text.includes("- (fact) [1h ago] Prefers tea in the morning"));
    assert.ok(text.includes("- (observation) [1d ago] Usually walks in the morning"));
  });
});

describe("recall rendering: assistant-attributed article facts", () => {
  it("marks an assistant article fact as the assistant's own, from an article", () => {
    const text = buildCanonicalMemoryContextForPrompt({
      now: NOW,
      items: [
        factItem({
          id: "article:reaction-1",
          subject: "assistant",
          subjectRole: "assistant",
          sourceType: "article",
          articleReactionId: "reaction-1",
          kind: "preference",
          claim: "I find local-first software interesting",
        }),
      ],
    });
    // Not user-specific context, and never a bare user memory line.
    assert.ok(
      text.startsWith("Use these memories as background context."),
      `expected the attributed header, got:\n${text}`,
    );
    assert.ok(!text.includes("user-specific context"));
    assert.ok(
      text.includes(
        "- (fact) [the assistant's own, from an article] [1h ago] I find local-first software interesting",
      ),
      `expected the attributed fact line, got:\n${text}`,
    );
    // The guard sentences name what the item is not.
    assert.ok(text.includes("never present it as the user's memory, preference, or biography"));
    assert.ok(text.includes("not a verified claim or the full article"));
  });

  it("marks an assistant-role conversation fact as the assistant's own", () => {
    const text = buildCanonicalMemoryContextForPrompt({
      now: NOW,
      items: [
        factItem({
          subject: "assistant",
          subjectRole: "assistant",
          sourceType: "conversation",
        }),
      ],
    });
    assert.ok(text.startsWith("Use these memories as background context."));
    assert.ok(
      text.includes("- (fact) [the assistant's own] [1h ago] Prefers tea in the morning"),
    );
    assert.ok(!text.includes("[from an article]"));
  });

  it("preserves the bare article tag for an article-sourced item without role data", () => {
    const text = buildCanonicalMemoryContextForPrompt({
      now: NOW,
      items: [factItem({ sourceType: "article" })],
    });
    assert.ok(text.startsWith("Use these memories as background context."));
    assert.ok(text.includes("- (fact) [from an article] [1h ago] Prefers tea in the morning"));
  });
});

describe("recall rendering: assistant-attributed observations", () => {
  it("marks an article-derived assistant observation with subject and source", () => {
    const text = buildCanonicalMemoryContextForPrompt({
      now: NOW,
      items: [
        observationItem({
          id: "obs-article-1",
          subject: "assistant",
          subjectRole: "assistant",
          sourceType: "article",
          kind: "preference",
          claim: "The assistant keeps circling back to local-first tools",
        }),
      ],
    });
    assert.ok(
      text.startsWith("Use these memories as background context."),
      `expected the attributed header, got:\n${text}`,
    );
    assert.ok(!text.includes("user-specific context"));
    assert.ok(
      text.includes(
        "- (observation) [the assistant's own, from an article] [1d ago] The assistant keeps circling back to local-first tools",
      ),
      `expected the attributed observation line, got:\n${text}`,
    );
    assert.ok(text.includes("recorded reaction or interest"));
  });

  it("marks an assistant-role conversation observation without an article tag", () => {
    const text = buildCanonicalMemoryContextForPrompt({
      now: NOW,
      items: [
        observationItem({
          subject: "assistant",
          subjectRole: "assistant",
          sourceType: "conversation",
        }),
      ],
    });
    assert.ok(text.startsWith("Use these memories as background context."));
    assert.ok(
      text.includes(
        "- (observation) [the assistant's own] [1d ago] Usually walks in the morning",
      ),
    );
  });
});

describe("recall rendering: mixed attribution", () => {
  it("renders user items untagged next to attributed items under the attributed header", () => {
    const text = buildCanonicalMemoryContextForPrompt({
      now: NOW,
      items: [
        factItem({ subjectRole: "user", sourceType: "conversation" }),
        observationItem({
          id: "obs-article-1",
          subject: "assistant",
          subjectRole: "assistant",
          sourceType: "article",
        }),
      ],
    });
    assert.ok(text.startsWith("Use these memories as background context."));
    assert.ok(!text.includes("user-specific context"));
    assert.ok(text.includes("- (fact) [1h ago] Prefers tea in the morning"));
    assert.ok(
      text.includes(
        "- (observation) [the assistant's own, from an article] [1d ago] Usually walks in the morning",
      ),
    );
  });

  it("still deduplicates identical ids across attributed items", () => {
    const text = buildCanonicalMemoryContextForPrompt({
      now: NOW,
      items: [
        factItem({
          subject: "assistant",
          subjectRole: "assistant",
          sourceType: "article",
          id: "article:reaction-1",
        }),
        factItem({
          subject: "assistant",
          subjectRole: "assistant",
          sourceType: "article",
          id: "article:reaction-1",
        }),
      ],
    });
    assert.equal(text.split("Prefers tea").length - 1, 1);
  });
});
