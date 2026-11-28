// Unit tests for the web client's pure image display preference logic
// (apps/web/src/lib/image-display.ts) and its interaction with thread
// grouping (apps/web/src/lib/grouping.ts). No browser, no network.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { groupThread } from "../../apps/web/src/lib/grouping.ts";
import {
  DEFAULT_IMAGE_DISPLAY_MODE,
  IMAGE_DISPLAY_MODES,
  IMAGE_DISPLAY_STORAGE_KEY,
  filterMessagesForImageDisplay,
  parseImageDisplayMode,
  readStoredImageDisplayMode,
  readStoredImageDisplayModeOrNull,
  writeStoredImageDisplayMode,
} from "../../apps/web/src/lib/image-display.ts";

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem(key) {
      return data.has(key) ? data.get(key) : null;
    },
    setItem(key, value) {
      data.set(key, String(value));
    },
  };
}

function throwingStorage() {
  return {
    getItem() {
      throw new Error("storage blocked");
    },
    setItem() {
      throw new Error("storage blocked");
    },
  };
}

const sampleImage = {
  src: "/api/images/11111111-1111-4111-8111-111111111111",
  alt: "A sunny park bench",
  width: 640,
  height: 480,
};

describe("web image display mode parsing and storage", () => {
  it("accepts all supported modes and defaults to image on unknown input", () => {
    assert.deepEqual(IMAGE_DISPLAY_MODES, ["image", "icon", "none"]);
    assert.equal(DEFAULT_IMAGE_DISPLAY_MODE, "image");
    assert.equal(parseImageDisplayMode("image"), "image");
    assert.equal(parseImageDisplayMode("icon"), "icon");
    assert.equal(parseImageDisplayMode("none"), "none");
    assert.equal(parseImageDisplayMode(""), "image");
    assert.equal(parseImageDisplayMode("hidden"), "image");
    assert.equal(parseImageDisplayMode(null), "image");
    assert.equal(parseImageDisplayMode(undefined), "image");
    assert.equal(parseImageDisplayMode(42), "image");
  });

  it("reads and writes valid preferences via storage", () => {
    const storage = memoryStorage();
    assert.equal(readStoredImageDisplayModeOrNull(storage), null);
    assert.equal(readStoredImageDisplayMode(storage), "image");

    assert.equal(writeStoredImageDisplayMode("icon", storage), true);
    assert.equal(storage.getItem(IMAGE_DISPLAY_STORAGE_KEY), "icon");
    assert.equal(readStoredImageDisplayModeOrNull(storage), "icon");
    assert.equal(readStoredImageDisplayMode(storage), "icon");

    assert.equal(writeStoredImageDisplayMode("none", storage), true);
    assert.equal(readStoredImageDisplayMode(storage), "none");
  });

  it("ignores corrupted values and throwing storage gracefully", () => {
    const corrupted = memoryStorage({ [IMAGE_DISPLAY_STORAGE_KEY]: "bogus" });
    assert.equal(readStoredImageDisplayModeOrNull(corrupted), null);
    assert.equal(readStoredImageDisplayMode(corrupted), "image");

    const blocked = throwingStorage();
    assert.equal(readStoredImageDisplayModeOrNull(blocked), null);
    assert.equal(readStoredImageDisplayMode(blocked), "image");
    assert.equal(writeStoredImageDisplayMode("icon", blocked), false);
    assert.equal(writeStoredImageDisplayMode("icon", null), false);
  });
});

describe("web image display message filtering", () => {
  const messages = [
    {
      id: "m1",
      role: "user",
      text: "Send a photo",
      sentAt: "2026-10-29T08:00:00Z",
    },
    {
      id: "m2",
      role: "assistant",
      text: "Here you go.",
      sentAt: "2026-10-29T08:00:10Z",
    },
    {
      id: "m3",
      role: "assistant",
      text: "",
      images: [sampleImage],
      sentAt: "2026-10-29T08:00:20Z",
    },
    {
      id: "m4",
      role: "assistant",
      images: [sampleImage],
      sentAt: "2026-10-29T08:00:25Z",
    },
    {
      id: "m5",
      role: "assistant",
      text: "Caption alongside image",
      images: [sampleImage],
      sentAt: "2026-10-29T08:00:30Z",
    },
  ];

  it("preserves all messages untouched in image and icon modes", () => {
    assert.equal(filterMessagesForImageDisplay(messages, "image"), messages);
    assert.equal(filterMessagesForImageDisplay(messages, "icon"), messages);
  });

  it("omits image-only messages and strips images from mixed messages in none mode", () => {
    const filtered = filterMessagesForImageDisplay(messages, "none");
    assert.deepEqual(
      filtered.map((m) => m.id),
      ["m1", "m2", "m5"],
    );
    assert.equal(filtered[2].text, "Caption alongside image");
    assert.equal(filtered[2].images, undefined);
  });

  it("avoids empty clusters and orphaned day dividers when composed with groupThread", () => {
    const crossDay = [
      {
        id: "day1-text",
        role: "assistant",
        text: "Goodnight",
        sentAt: "2026-10-29T23:00:00Z",
      },
      {
        id: "day2-image-only",
        role: "assistant",
        text: "",
        images: [sampleImage],
        sentAt: "2026-10-30T09:00:00Z",
      },
      {
        id: "day3-text",
        role: "user",
        text: "Hello again",
        sentAt: "2026-10-31T09:00:00Z",
      },
    ];

    const groupedWithImages = groupThread(
      filterMessagesForImageDisplay(crossDay, "image"),
      "UTC",
    );
    assert.deepEqual(
      groupedWithImages.map((item) => item.kind),
      ["cluster", "divider", "cluster", "divider", "cluster"],
    );

    const groupedHidden = groupThread(
      filterMessagesForImageDisplay(crossDay, "none"),
      "UTC",
    );
    assert.deepEqual(
      groupedHidden.map((item) => item.kind),
      ["cluster", "divider", "cluster"],
    );
    assert.equal(groupedHidden[1].at, "2026-10-31T09:00:00Z");
  });
});
