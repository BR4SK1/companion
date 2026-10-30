// Sanity checks for the web preview's fixture thread
// (apps/web/src/lib/fixtures.ts) and its local image assets. These guard the
// data the preview renders: well-formed, chronological, and pointing at
// assets that actually exist in the app. No rendering and no network.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

import { fixtureThread } from "../../apps/web/src/lib/fixtures.ts";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "../../apps/web");

describe("web preview fixture thread", () => {
  it("is non-empty and chronological", () => {
    assert.ok(fixtureThread.length > 0);
    const times = fixtureThread.map((message) => Date.parse(message.sentAt));
    assert.ok(times.every((time) => !Number.isNaN(time)));
    assert.deepEqual(
      [...times].sort((a, b) => a - b),
      times,
      "messages must be in chronological order",
    );
  });

  it("has unique message ids", () => {
    const ids = fixtureThread.map((message) => message.id);
    assert.equal(new Set(ids).size, ids.length);
  });

  it("only uses known roles and never carries identity fields", () => {
    for (const message of fixtureThread) {
      assert.ok(["user", "assistant"].includes(message.role));
      // Domain-identity guardrail: no owner/user/tenant identifiers on messages.
      for (const key of Object.keys(message)) {
        assert.ok(
          !/user[_-]?id|owner[_-]?id|tenant/i.test(key),
          `unexpected identity-like field: ${key}`,
        );
      }
    }
  });

  it("has text or images on every message", () => {
    for (const message of fixtureThread) {
      const hasText = typeof message.text === "string" && message.text.length > 0;
      const hasImages = Array.isArray(message.images) && message.images.length > 0;
      assert.ok(hasText || hasImages, `message ${message.id} is empty`);
    }
  });

  it("references image assets that exist in the app's public directory", () => {
    for (const message of fixtureThread) {
      for (const image of message.images ?? []) {
        assert.ok(image.alt.length > 0, `image in ${message.id} needs alt text`);
        assert.ok(image.width > 0 && image.height > 0);
        // Only local static assets, never remote URLs (the preview is offline).
        assert.ok(image.src.startsWith("/"), `image src must be app-local: ${image.src}`);
        const asset = normalize(join(webRoot, "public", image.src));
        assert.ok(
          asset.startsWith(join(webRoot, "public")),
          `image path escapes public/: ${image.src}`,
        );
        assert.ok(existsSync(asset), `missing fixture asset: ${image.src}`);
      }
    }
  });

  it("demonstrates both roles, grouping, and a time divider", () => {
    assert.ok(fixtureThread.some((message) => message.role === "user"));
    assert.ok(fixtureThread.some((message) => message.role === "assistant"));
    assert.ok(
      fixtureThread.some((message) => (message.images?.length ?? 0) > 0),
      "the fixture should exercise inline image rendering",
    );
    // Consecutive same-role messages exist so grouping is exercised.
    const roles = fixtureThread.map((message) => message.role);
    assert.ok(roles.some((role, index) => index > 0 && roles[index - 1] === role));
    // A UTC day boundary exists so the time-divider path is exercised, and
    // dividers are only produced at day boundaries (unique labels per day).
    const days = fixtureThread.map((message) =>
      new Date(message.sentAt).toISOString().slice(0, 10),
    );
    assert.ok(
      days.some((day, index) => index > 0 && days[index - 1] !== day),
      "fixture should span a day boundary",
    );
  });
});
