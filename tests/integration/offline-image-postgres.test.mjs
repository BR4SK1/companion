import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import { createPostgresPool } from "../../libraries/postgres/src/index.ts";
import { applyWorkerMigrations } from "../../apps/worker/src/migrations.ts";
import { createConversationStore } from "../../apps/worker/src/conversation/store.ts";
import { createOfflineImageStore } from "../../apps/worker/src/image/offline-store.ts";
import { createImageStore } from "../../apps/worker/src/image/store.ts";
import { IMAGE_MESSAGE_MARKER } from "../../apps/worker/src/image/types.ts";

const databaseUrl = process.env.WORKER_TEST_DATABASE_URL;

function fixture(id) {
  const now = Date.now();
  const time = (minutes) => new Date(now + minutes * 60_000).toISOString();
  const ranks = [3, 1, 4, 2, 5, 0];
  return {
    id: `${id}:${randomUUID()}`,
    startedAt: time(-2),
    returnAt: time(3),
    publishBy: time(8),
    completedAt: null,
    shots: ranks.map((rank, position) => ({
      position,
      rank,
      clothing: { items: [
        { slot: "top", state: ["undressing_top", "off", "off", "dressing_top", "on", "on"][position] },
        { slot: "underwear", state: "on" },
      ] },
      kind: position === 5 ? "outfit" : "sequence",
      localDateTime: time(0),
    })),
  };
}

function render(position, eventId, token) {
  return {
    promptId: `prompt-${position}`,
    plan: {
      location: "bedroom",
      timePeriod: "morning",
      poseCategory: "standing",
      poseVariantId: null,
      expression: null,
      handGesture: null,
      cameraAngle: null,
      intimacy: "casual",
      clothingSummary: `outfit-${position}`,
    },
    images: [
      {
        filename: `shot-${position}.webp`,
        mimeType: "image/webp",
        width: 1,
        height: 1,
        data: Buffer.from([position]),
      },
    ],
    offlineLease: { eventId, token },
  };
}

describe("offline photo jobs (PostgreSQL)", { skip: !databaseUrl }, () => {
  let pool;
  let images;
  let offline;
  let conversations;

  before(async () => {
    pool = createPostgresPool({ connectionString: databaseUrl });
    await applyWorkerMigrations(pool);
    images = createImageStore(pool);
    offline = createOfflineImageStore(pool, images);
    conversations = createConversationStore(pool);
  });

  after(async () => pool?.end());

  async function finish(event) {
    const returnAt = new Date(Date.now() - 1_000).toISOString();
    await pool.query(
      "UPDATE image_offline_event SET return_at = $2 WHERE id = $1",
      [event.id, returnAt],
    );
    await offline.markReturned({
      ...event,
      returnAt,
      completedAt: returnAt,
      shots: [],
    });
  }

  function publish(eventId, access) {
    return conversations.publishScheduledAssistantMessage({
      skipIfUserMessagesQueued: true,
      prepare: async (client) => {
        const album = await offline.prepareAlbum(client, eventId, access);
        if (album === null) return null;
        return {
          content: IMAGE_MESSAGE_MARKER,
          validUntil: album.publishBy,
          cancel: (tx) => offline.cancelAlbum(tx, eventId),
          recordPublication: (tx, messageId) =>
            offline.publishAlbum(tx, album, messageId),
        };
      },
    });
  }

  it("renders six candidates, keeps them private until return, and atomically shares every ready category in order", async () => {
    const event = fixture("worker-album-sequence-test");
    await Promise.all([offline.register(event, 3), offline.register(event, 3)]);
    for (const position of [5, 1, 3, 0, 2, 4]) {
      const claim = await offline.claimShot(event.id, 3, 60_000, 2);
      assert.equal(claim.position, position);
      await images.saveRendered(
        claim.id,
        render(position, event.id, claim.token),
      );
    }
    assert.equal(await offline.claimShot(event.id, 3, 60_000, 2), null);
    assert.equal(await images.nextRendered(), null);
    const queuedAsset = await pool.query(
      `SELECT asset.id FROM image_asset asset JOIN image_job job ON job.id = asset.job_id
       WHERE job.offline_event_id = $1 LIMIT 1`,
      [event.id],
    );
    assert.equal(await images.getImage(queuedAsset.rows[0].id), null);
    assert.equal(await publish(event.id, 3), false);

    await finish(event);
    assert.equal(await offline.nextAlbum(), event.id);
    const queued = await conversations.appendUserMessage({
      content: "Waiting for the scheduled return.",
    });
    try {
      assert.equal(await publish(event.id, 3), false);
    } finally {
      await pool.query("DELETE FROM conversation_message WHERE id = $1", [
        queued.id,
      ]);
    }
    assert.deepEqual(
      (await Promise.all([publish(event.id, 3), publish(event.id, 3)])).sort(),
      [false, true],
    );
    const {
      rows: [{ message_id: messageId }],
    } = await pool.query(
      "SELECT message_id FROM image_offline_event WHERE id = $1",
      [event.id],
    );
    const published = (await images.getImagesForMessages([messageId])).get(
      messageId,
    );
    const positions = await Promise.all(published.map(async (asset) =>
      (await images.getImage(asset.id)).data[0]
    ));
    assert.ok(positions.length >= 3 && positions.length <= 6);
    assert.deepEqual(positions, [...new Set(positions)].sort((a, b) => a - b));
    for (const required of [1, 3, 5]) assert.ok(positions.includes(required));
    const {
      rows: [{ count }],
    } = await pool.query(
      `SELECT count(*)::int AS count FROM image_asset asset JOIN image_job job ON job.id = asset.job_id
       WHERE job.offline_event_id = $1`,
      [event.id],
    );
    assert.equal(count, positions.length);
  });

  it("only claims covered sequence stages at intermediate access", async () => {
    const event = fixture("worker-album-intermediate-test");
    await offline.register(event, 2);
    for (const position of [5, 3, 0, 4]) {
      const claim = await offline.claimShot(event.id, 3, 60_000, 2);
      assert.equal(claim.position, position);
      await images.saveRendered(claim.id, render(position, event.id, claim.token));
    }
    assert.equal(await offline.claimShot(event.id, 3, 60_000, 2), null);
    await finish(event);
    assert.equal(await publish(event.id, 2), true);
    const result = await pool.query(
      "SELECT offline_position FROM image_job WHERE offline_event_id = $1 AND status = 'succeeded' ORDER BY offline_position",
      [event.id],
    );
    const positions = result.rows.map(row => row.offline_position);
    assert.ok(positions.includes(3) && positions.includes(5));
    assert.ok(positions.every(position => [0, 3, 4, 5].includes(position)));
  });

  it("rechecks tiers at delivery and preserves departure limits across retries", async () => {
    const event = fixture("worker-album-outfit-test");
    await offline.register(event, 1);
    await offline.register(event, 3);
    const preferred = await offline.claimShot(event.id, 3, 60_000, 2);
    assert.equal(preferred.position, 5);
    await offline.failShot(preferred, "render_unavailable", 2);
    await pool.query(
      "UPDATE image_job SET next_attempt_at = now() WHERE id = $1",
      [preferred.id],
    );
    const retry = await offline.claimShot(event.id, 3, 60_000, 2);
    assert.equal(retry.position, 5);
    await images.saveRendered(retry.id, render(5, event.id, retry.token));
    assert.equal(await offline.claimShot(event.id, 3, 60_000, 2), null);
    await finish(event);
    assert.equal(await publish(event.id, 3), true);
    const { rows } = await pool.query(
      "SELECT offline_position FROM image_job WHERE offline_event_id = $1 AND status = 'succeeded'",
      [event.id],
    );
    assert.deepEqual(rows, [{ offline_position: 5 }]);

    const downgraded = fixture("worker-album-downgrade-test");
    await offline.register(downgraded, 3);
    for (const position of [5, 1]) {
      const claim = await offline.claimShot(downgraded.id, 3, 60_000, 2);
      assert.equal(claim.position, position);
      await images.saveRendered(
        claim.id,
        render(position, downgraded.id, claim.token),
      );
    }
    await finish(downgraded);
    assert.equal(await publish(downgraded.id, 1), true);
    const published = await pool.query(
      "SELECT offline_position FROM image_job WHERE offline_event_id = $1 AND status = 'succeeded'",
      [downgraded.id],
    );
    assert.deepEqual(published.rows, [{ offline_position: 5 }]);
  });

  it("fences an expired render lease and discards unpublished photos after the return window", async () => {
    const event = fixture("worker-album-lease-test");
    await offline.register(event, 3);
    const first = await offline.claimShot(event.id, 3, 60_000, 2);
    await pool.query(
      "UPDATE image_job SET offline_lease_until = now() - interval '1 second' WHERE id = $1",
      [first.id],
    );
    const second = await offline.claimShot(event.id, 3, 60_000, 2);
    assert.equal(second.id, first.id);
    assert.notEqual(second.token, first.token);
    await images.saveRendered(
      first.id,
      render(first.position, event.id, first.token),
    );
    await images.saveRendered(
      second.id,
      render(second.position, event.id, second.token),
    );
    const assets = await pool.query(
      "SELECT id FROM image_asset WHERE job_id = $1",
      [first.id],
    );
    assert.equal(assets.rowCount, 1);

    await finish(event);
    await pool.query(
      "UPDATE image_offline_event SET publish_by = now() - interval '100 milliseconds' WHERE id = $1",
      [event.id],
    );
    await offline.expireAlbums();
    assert.equal(await publish(event.id, 3), false);
    assert.equal(
      (
        await pool.query("SELECT id FROM image_asset WHERE job_id = $1", [
          first.id,
        ])
      ).rowCount,
      0,
    );
  });
});
