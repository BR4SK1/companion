import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  loadImageConfig,
  ImageConfigError,
  DEFAULT_IMAGE_PATTERN_IDS,
} from "../../apps/worker/src/image/config.ts";
import { isPhotoWorthy } from "../../apps/worker/src/image/gate.ts";
import { parseImageDimensions } from "../../apps/worker/src/image/webp.ts";
import {
  createImageServiceClients,
  ImageClientError,
} from "../../apps/worker/src/image/client.ts";
import { imageMigrations } from "../../apps/worker/src/image/migrations.ts";

function webpVp8x(width, height) {
  const buf = Buffer.alloc(30);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(22, 4);
  buf.write("WEBP", 8, "ascii");
  buf.write("VP8X", 12, "ascii");
  buf.writeUIntLE(width - 1, 24, 3);
  buf.writeUIntLE(height - 1, 27, 3);
  return buf;
}

describe("image configuration", () => {
  it("is disabled when no module settings are supplied", () => {
    const config = loadImageConfig({});
    assert.equal(config.enabled, false);
  });

  it("fails startup on a partial configuration naming the missing variables", () => {
    assert.throws(
      () => loadImageConfig({ WORKER_IMAGE_SERVICE_URL: "http://image:3015" }),
      (error) =>
        error instanceof ImageConfigError &&
        /WORKER_IMPLEMENTATION_SERVICE_URL/.test(error.message) &&
        /WORKER_IMAGE_USER_ID/.test(error.message),
    );
  });

  it("parses a full configuration with defaults and overrides", () => {
    const config = loadImageConfig({
      WORKER_IMPLEMENTATION_SERVICE_URL: "http://implementation:3014/",
      WORKER_IMAGE_SERVICE_URL: "http://image:3015",
      WORKER_IMAGE_USER_ID: "owner-scope",
    });
    assert.equal(config.enabled, true);
    assert.equal(config.implementationUrl, "http://implementation:3014");
    assert.deepEqual(config.patternIds, DEFAULT_IMAGE_PATTERN_IDS);
    assert.equal(config.timeoutMs, 180_000);

    const overridden = loadImageConfig({
      WORKER_IMPLEMENTATION_SERVICE_URL: "http://implementation:3014",
      WORKER_IMAGE_SERVICE_URL: "http://image:3015",
      WORKER_IMAGE_USER_ID: "owner-scope",
      WORKER_IMAGE_PATTERN_IDS: "a, b",
    });
    assert.deepEqual(overridden.patternIds, ["a", "b"]);
  });
});

describe("photo-worthiness gate", () => {
  const patterns = ["cozy_roleplay"];
  it("accepts a configured pattern", () => {
    assert.equal(
      isPhotoWorthy({ patternId: "cozy_roleplay", userText: "hi", patternIds: patterns }),
      true,
    );
  });
  it("accepts an explicit picture request", () => {
    assert.equal(
      isPhotoWorthy({ patternId: "everyday", userText: "send me a selfie?", patternIds: patterns }),
      true,
    );
  });
  it("accepts an active reconciled scene", () => {
    assert.equal(
      isPhotoWorthy({ patternId: "everyday", userText: "hi", patternIds: patterns, roleplayInScene: true }),
      true,
    );
  });
  it("rejects ordinary chat", () => {
    assert.equal(
      isPhotoWorthy({ patternId: "everyday", userText: "what is the weather?", patternIds: patterns, roleplayInScene: false }),
      false,
    );
    assert.equal(
      isPhotoWorthy({ patternId: null, userText: "tell me a story", patternIds: patterns }),
      false,
    );
  });
});

describe("image dimension parsing", () => {
  it("reads WebP VP8X dimensions", () => {
    assert.deepEqual(parseImageDimensions("image/webp", webpVp8x(768, 1344)), {
      width: 768,
      height: 1344,
    });
  });
  it("reads PNG dimensions", () => {
    const png = Buffer.alloc(24);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0);
    png.writeUInt32BE(100, 16);
    png.writeUInt32BE(50, 20);
    assert.deepEqual(parseImageDimensions("image/png", png), { width: 100, height: 50 });
  });
  it("rejects bytes that do not match their mime type", () => {
    assert.equal(parseImageDimensions("image/webp", Buffer.from("not an image")), null);
    assert.equal(parseImageDimensions("image/gif", webpVp8x(10, 10)), null);
  });
});

describe("image service clients", () => {
  function clients(fetchImpl) {
    return createImageServiceClients({
      implementationUrl: "http://implementation:3014",
      imageServiceUrl: "http://image:3015",
      userId: "owner-scope",
      timeoutMs: 1_000,
      fetchImpl,
    });
  }

  it("parses a reconcile snapshot bundle", async () => {
    const seen = [];
    const snapshot = await clients(async (url, init) => {
      seen.push({ url, body: JSON.parse(init.body) });
      return new Response(
        JSON.stringify({
          turnId: "turn-1",
          snapshot: {
            schedule: { date: "2026-11-17", block: "daytime", location: "living room", surface: "couch", activity: "relaxing", balconyDay: false },
            clothing: { occasion: "daytime", items: [{ itemId: "i1", slot: "top", tags: "grey hoodie", state: "on" }], plannedOccasion: "daytime" },
            roleplay: { inScene: true, chapter: "teasing", activity: "kissing" },
          },
          sections: { schedule: "included", clothing: "included", roleplay: "included" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }).reconcile({
      turnId: "turn-1",
      userText: "come here",
      companionResponse: "leaning in",
      localDateTime: "2026-11-17T12:00:00-05:00",
    });
    assert.equal(seen[0].url, "http://implementation:3014/v1/reconcile");
    assert.equal(seen[0].body.userId, "owner-scope");
    assert.equal(seen[0].body.companionResponse, "leaning in");
    assert.equal(snapshot.schedule.location, "living room");
    assert.equal(snapshot.clothing.items[0].tags, "grey hoodie");
    assert.equal(snapshot.roleplay.inScene, true);
  });

  it("parses a render with a real WebP and plan summary", async () => {
    const webp = webpVp8x(768, 1344);
    const result = await clients(async (url, init) => {
      assert.equal(url, "http://image:3015/v1/render");
      const body = JSON.parse(init.body);
      assert.equal(body.schedule.location, "bedroom");
      return new Response(
        JSON.stringify({
          success: true,
          promptId: "prompt-1",
          durationMs: 42,
          plan: { location: "bedroom", timePeriod: "evening", poseCategory: "sitting", poseVariantId: "couch-1", expressionKey: "smile", handGesture: "wave", cameraAngle: "front", intimacy: "casual", clothingSummary: "grey hoodie" },
          images: [{ filename: "a.webp", subfolder: "", mimeType: "image/webp", sizeBytes: webp.byteLength, dataBase64: webp.toString("base64") }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }).render({
      turnId: "turn-1",
      userText: "hi",
      companionResponse: "hello",
      localDateTime: "2026-11-17T12:00:00-05:00",
      snapshot: {
        schedule: { date: "2026-11-17", block: "evening", location: "bedroom", surface: "bed", activity: "relaxing", balconyDay: false },
        clothing: null,
        roleplay: null,
      },
      priorPose: null,
    });
    assert.equal(result.promptId, "prompt-1");
    assert.equal(result.plan.poseVariantId, "couch-1");
    assert.equal(result.images[0].width, 768);
    assert.equal(result.images[0].height, 1344);
  });

  it("maps failures to fixed categories without upstream text", async () => {
    await assert.rejects(
      clients(async () =>
        new Response(JSON.stringify({ error: "secret detail" }), { status: 503 }),
      ).reconcile({ turnId: "t", userText: "u", companionResponse: "r", localDateTime: "2026-11-17T12:00:00-05:00" }),
      (error) => error instanceof ImageClientError && error.category === "reconcile_http_error" && !/secret/.test(error.message),
    );
    await assert.rejects(
      clients(async () => {
        throw new Error("network secret");
      }).reconcile({ turnId: "t", userText: "u", companionResponse: "r", localDateTime: "2026-11-17T12:00:00-05:00" }),
      (error) => error instanceof ImageClientError && error.category === "reconcile_unavailable",
    );
    await assert.rejects(
      clients(async () =>
        new Response(JSON.stringify({ success: true, images: [] }), { status: 200, headers: { "content-type": "application/json" } }),
      ).render({
        turnId: "t", userText: "u", companionResponse: "r", localDateTime: "2026-11-17T12:00:00-05:00",
        snapshot: { schedule: { date: "d", block: "b", location: "bedroom", surface: "bed", activity: "a", balconyDay: false }, clothing: null, roleplay: null },
        priorPose: null,
      }),
      (error) => error instanceof ImageClientError && error.category === "render_invalid_response",
    );
  });
});

describe("image migrations", () => {
  it("creates typed relational job and asset tables without a JSONB payload", () => {
    assert.equal(imageMigrations.length, 1);
    assert.equal(imageMigrations[0].id, "0032_image_generation");
    assert.match(imageMigrations[0].sql, /CREATE TABLE image_job/);
    assert.match(imageMigrations[0].sql, /CREATE TABLE image_asset/);
    assert.match(imageMigrations[0].sql, /data bytea NOT NULL/);
    assert.doesNotMatch(imageMigrations[0].sql, /jsonb/i);
  });
});
