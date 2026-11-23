// Mock verification for the standalone local config manager
// (apps/config-manager): full prompt visibility, validated diff reviews,
// typed production confirmation, optimistic-concurrency conflicts, and the
// server-side fixed environment binding.
//
// No database, no live target, no deployment: the server under test is
// constructed with the in-memory store only, and every request runs over
// an ephemeral loopback listener. Mock fixtures are synthetic content, not
// provisioned configuration.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

import { MemoryConfigStore, planRowChanges } from "../../apps/config-manager/src/store.ts";
import { startConfigManagerServer } from "../../apps/config-manager/src/server.ts";
import { loadConfigManagerConfig } from "../../apps/config-manager/src/config.ts";
import { snapshotHash } from "../../apps/config-manager/src/diff.ts";
import { validateFullSnapshot } from "../../apps/config-manager/src/validation.ts";

const LONG_PROMPT = `You are a synthetic test persona. ${"This is mock content for verification. ".repeat(200)}END OF MOCK PROMPT`;

function mockSnapshot() {
  return {
    chat_identity: [{ id: "identity", content: LONG_PROMPT, revision: 3, updated_at: "2026-11-01T00:00:00.000Z" }],
    companion_time_settings: [
      { id: true, timezone: "Europe/Berlin", season_hemisphere: "north", birthday_month: 3, birthday_day: 14, day_start_hour: 5, updated_at: "2026-11-01T00:00:00.000Z" },
    ],
    engagement_bands: [{ id: true, lull_ms: 300000, idle_ms: 36000000, gone_ms: 100000000, updated_at: "2026-11-01T00:00:00.000Z" }],
    memory_behavior: [{ id: "behavior", timezone: "Europe/Berlin", day_start_hour: 5, updated_at: "2026-11-01T00:00:00.000Z" }],
    memory_subject: [
      { id: "user", role: "user", profile_enabled: true, source_label: "Mock user", profile_evidence_rule: "Mock evidence rule for user.", position: 0 },
      { id: "assistant", role: "assistant", profile_enabled: true, source_label: "Mock assistant", profile_evidence_rule: "Mock evidence rule for assistant.", position: 1 },
    ],
    memory_prompt: [
      { kind: "fact_extraction", version: "mock-v1", system_prompt: LONG_PROMPT },
    ],
    response_pattern: [
      { id: "mock-pattern", enabled: true, selection_description: "Mock selection", response_guidance: "Mock guidance", position: 0, include_initiative_context: false },
    ],
    prompt_module: [
      {
        id: "11111111-1111-4111-8111-111111111111", module_key: "mock-module", decision_description: "Mock module",
        function_definition: '(context: PromptModuleContext): string => "mock";', fallback_content: null,
        enabled: false, position: 0, timeout_ms: 5000, activation_mode: "model_gated", output_kind: "thoughts",
        execution_mode: "function", http_endpoint_setting: null, http_scope_setting: null, http_scope_field: null,
        http_turn_id_field: null, http_local_datetime_field: null, http_engagement_state_field: null,
        http_previous_assistant_field: null, http_user_message_field: null,
        http_prior_conversation_field: null, http_response_text_field: null, http_unavailable_until_field: null,
        http_field_max_bytes: null, http_prior_message_limit: null, http_request_max_bytes: null, http_response_max_bytes: null,
        updated_at: "2026-11-01T00:00:00.000Z",
      },
    ],
    routine_external_provider: [],
    routine_settings: [{ id: true, timezone: "Europe/Berlin", departure_context: "Mock departure", updated_at: "2026-11-01T00:00:00.000Z" }],
    routine_transition: [
      { id: "22222222-2222-4222-8222-222222222222", transition_key: "mock-morning", weekday: 1, local_minute: 480, location: null, activity: null, available: true, interaction_context: null, enabled: true },
    ],
    relationship_settings: [
      {
        id: true, relationship_type: "mock", timezone: "Europe/Berlin", day_start_hour: 5,
        tier_movement_enabled: false, tier_up_min_days: null, tier_up_min_active_streak: null, tier_down_missed_streak: null,
        answer_extraction_prompt: LONG_PROMPT, clarification_guidance: "Mock guidance", updated_at: "2026-11-01T00:00:00.000Z",
      },
    ],
    relationship_tier: [
      { id: "33333333-3333-4333-8333-333333333333", tier_key: "mock-first", position: 0, minimum_familiarity: 0, label: "first", prompt: LONG_PROMPT, behavioral_guidance: "Mock guidance" },
      { id: "44444444-4444-4444-8444-444444444444", tier_key: "mock-second", position: 100, minimum_familiarity: 0.5, label: "second", prompt: "Second tier mock prompt", behavioral_guidance: "Mock guidance" },
    ],
    relationship_question_type: [
      { type_key: "mock-type", interpretation_guidance: "Mock interpretation guidance" },
    ],
    relationship_question: [
      { id: "55555555-5555-4555-8555-555555555555", question_key: "mock-q", type_key: "mock-type", tier_id: "33333333-3333-4333-8333-333333333333", question_text: "Mock question?", enabled: true, position: 0 },
    ],
    article_feed: [{ id: "mock-feed", url: "https://example.com/mock-feed.xml", enabled: true, position: 0 }],
    article_behavior: [
      {
        id: "behavior", enabled: true, model: "mock/model", max_generations_per_run: 1, max_reaction_attempts: 2,
        max_article_age_days: 7, max_reaction_chars: 280, max_excerpt_chars: 4000, decision_max_candidates: 3,
        share_cooldown_minutes: 60, updated_at: "2026-11-01T00:00:00.000Z",
      },
    ],
    article_prompt: [{ kind: "reaction_generation", version: "mock-v1", system_prompt: LONG_PROMPT }],
  };
}

describe("config manager mock verification", () => {
  /** @type {{close: () => Promise<void>, address: {port: number}}[]} */
  const started = [];

  async function startFor(environment, snapshot = mockSnapshot()) {
    const store = new MemoryConfigStore(snapshot, environment);
    const running = await startConfigManagerServer({
      environment,
      store,
      host: "127.0.0.1",
      port: 0,
    });
    started.push(running);
    return { store, baseUrl: `http://127.0.0.1:${String(running.address.port)}` };
  }

  after(async () => {
    while (started.length > 0) {
      await started.pop().close();
    }
  });

  it("mock snapshot itself is valid under worker loader rules", () => {
    assert.deepEqual(validateFullSnapshot(mockSnapshot()), []);
  });

  it("GET returns full stored prompt text and the fixed environment", async () => {
    const { baseUrl } = await startFor("nonprod");
    const res = await fetch(`${baseUrl}/api/config`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.environment, "nonprod");
    assert.match(body.snapshotHash, /^[a-f0-9]{64}$/);
    const identity = body.tables.find((t) => t.table === "chat_identity");
    assert.ok(identity.promptFields.includes("content"));
    assert.equal(identity.rows[0].content, LONG_PROMPT, "full prompt, never truncated");
    assert.ok(identity.rows[0].content.length > 7000);
  });

  it("responses exclude deployment environment values and credentials", async () => {
    const { baseUrl } = await startFor("nonprod");
    const res = await fetch(`${baseUrl}/api/config`);
    const text = await res.text();
    for (const marker of ["WORKER_", "OPENROUTER_", "DATABASE_URL", "connectionString", "apiKey", "secret"]) {
      assert.ok(!text.includes(marker), `response must not contain ${marker}`);
    }
    const health = await (await fetch(`${baseUrl}/api/health`)).json();
    assert.equal(health.environment, "nonprod");
    assert.ok(!("databaseUrl" in health));
  });

  it("preview returns a validated diff without writing", async () => {
    const { baseUrl, store } = await startFor("nonprod");
    const before = await store.loadSnapshot();
    const hash = snapshotHash(before);
    const res = await fetch(`${baseUrl}/api/config/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        baseHash: hash,
        edits: [{ table: "response_pattern", key: { id: "mock-pattern" }, row: { response_guidance: "Mock guidance v2" } }],
      }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.diff.length, 1);
    assert.deepEqual(
      { table: body.diff[0].table, field: body.diff[0].field, before: body.diff[0].before, after: body.diff[0].after, change: body.diff[0].change },
      { table: "response_pattern", field: "response_guidance", before: "Mock guidance", after: "Mock guidance v2", change: "modified" },
    );
    // Preview wrote nothing.
    assert.deepEqual(await store.loadSnapshot(), before);
  });

  it("apply writes with typed nonprod confirmation and returns the new hash", async () => {
    const { baseUrl, store } = await startFor("nonprod");
    const hash = snapshotHash(await store.loadSnapshot());
    const res = await fetch(`${baseUrl}/api/config/apply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        baseHash: hash,
        edits: [{ table: "response_pattern", key: { id: "mock-pattern" }, row: { response_guidance: "Mock guidance v2" } }],
        confirmation: "nonprod",
      }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.notEqual(body.newSnapshotHash, hash);
    const after = await store.loadSnapshot();
    assert.equal(after.response_pattern[0].response_guidance, "Mock guidance v2");
  });

  it("apply requires the exact bound-environment confirmation (both environments)", async () => {
    for (const [environment, wrong] of [["nonprod", "production"], ["production", "nonprod"]]) {
      const { baseUrl, store } = await startFor(environment);
      const hash = snapshotHash(await store.loadSnapshot());
      const edit = [{ table: "response_pattern", key: { id: "mock-pattern" }, row: { response_guidance: "Must not land" } }];
      const rejected = await fetch(`${baseUrl}/api/config/apply`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ baseHash: hash, edits: edit, confirmation: wrong }),
      });
      assert.equal(rejected.status, 400, `${environment} must reject confirmation '${wrong}'`);
      const missing = await fetch(`${baseUrl}/api/config/apply`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ baseHash: hash, edits: edit }),
      });
      assert.equal(missing.status, 400, `${environment} must reject a missing confirmation`);
      assert.equal((await store.loadSnapshot()).response_pattern[0].response_guidance, "Mock guidance");
      // The exact bound name does apply on both environments.
      const ok = await fetch(`${baseUrl}/api/config/apply`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ baseHash: hash, edits: edit, confirmation: environment }),
      });
      assert.equal(ok.status, 200, `${environment} must accept its exact typed confirmation`);
    }
  });

  it("stale base hash is a 409 conflict and writes nothing", async () => {
    const { baseUrl, store } = await startFor("nonprod");
    const first = snapshotHash(await store.loadSnapshot());
    // A successful apply moves the snapshot forward.
    const applied = await fetch(`${baseUrl}/api/config/apply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        baseHash: first,
        edits: [{ table: "response_pattern", key: { id: "mock-pattern" }, row: { response_guidance: "First writer" } }],
        confirmation: "nonprod",
      }),
    });
    assert.equal(applied.status, 200);
    // A second writer replaying the stale base must conflict, not overwrite.
    const stale = await fetch(`${baseUrl}/api/config/apply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        baseHash: first,
        edits: [{ table: "response_pattern", key: { id: "mock-pattern" }, row: { response_guidance: "Second writer" } }],
        confirmation: "nonprod",
      }),
    });
    assert.equal(stale.status, 409);
    assert.equal((await stale.json()).error, "conflict");
    assert.equal((await store.loadSnapshot()).response_pattern[0].response_guidance, "First writer");
  });

  it("client-supplied environment, database URL, and credentials are rejected", async () => {
    const { baseUrl, store } = await startFor("nonprod");
    const hash = snapshotHash(await store.loadSnapshot());
    const attempts = [
      JSON.stringify({ baseHash: hash, edits: [], environment: "production" }),
      JSON.stringify({ baseHash: hash, edits: [], databaseUrl: "postgres://evil" }),
      JSON.stringify({ baseHash: hash, edits: [], WORKER_CHAT_MODEL: "evil/model" }),
      JSON.stringify({ baseHash: hash, edits: [], credentials: { apiKey: "evil" } }),
    ];
    for (const bodyText of attempts) {
      const res = await fetch(`${baseUrl}/api/config/apply`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: bodyText,
      });
      assert.equal(res.status, 400, `forbidden binding attempt must be rejected: ${bodyText}`);
    }
    const queryAttempt = await fetch(`${baseUrl}/api/config?environment=production`);
    assert.equal(queryAttempt.status, 400);
    const health = await (await fetch(`${baseUrl}/api/health`)).json();
    assert.equal(health.environment, "nonprod", "client attempts must not retarget the server");
  });

  it("validation rejects invalid merged snapshots on both preview and apply", async () => {
    const { baseUrl, store } = await startFor("nonprod");
    const hash = snapshotHash(await store.loadSnapshot());
    const cases = [
      ["empty identity prompt", [{ table: "chat_identity", key: { id: "identity" }, row: { content: "   " } }]],
      ["invalid timezone", [{ table: "companion_time_settings", key: { id: true }, row: { timezone: "Not/AZone" } }]],
      ["unordered engagement bands", [{ table: "engagement_bands", key: { id: true }, row: { lull_ms: 999000000 } }]],
      [
        "duplicate routine slot",
        [
          {
            table: "routine_transition",
            key: { id: "99999999-9999-4999-8999-999999999999" },
            row: {
              id: "99999999-9999-4999-8999-999999999999",
              transition_key: "mock-duplicate",
              weekday: 1,
              local_minute: 480,
              available: true,
              enabled: true,
            },
          },
        ],
      ],
    ];
    for (const [label, edits] of cases) {
      const preview = await fetch(`${baseUrl}/api/config/preview`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ baseHash: hash, edits }),
      });
      assert.equal(preview.status, 422, `${label} must fail validation on preview`);
      assert.ok((await preview.json()).errors.length > 0);
    }
    const apply = await fetch(`${baseUrl}/api/config/apply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        baseHash: hash,
        edits: [{ table: "chat_identity", key: { id: "identity" }, row: { content: "" } }],
        confirmation: "nonprod",
      }),
    });
    assert.equal(apply.status, 422);
    assert.equal((await store.loadSnapshot()).chat_identity[0].content, LONG_PROMPT);
  });

  it("create and delete round-trip through the diff", async () => {
    const { baseUrl, store } = await startFor("nonprod");
    const hash = snapshotHash(await store.loadSnapshot());
    const preview = await fetch(`${baseUrl}/api/config/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        baseHash: hash,
        edits: [
          {
            table: "response_pattern",
            key: { id: "mock-pattern-2" },
            row: { id: "mock-pattern-2", enabled: true, selection_description: "New", response_guidance: "", position: 1, include_initiative_context: true },
          },
        ],
      }),
    });
    assert.equal(preview.status, 200);
    const diff = (await preview.json()).diff;
    assert.ok(diff.every((d) => d.change === "created"));
    const applied = await fetch(`${baseUrl}/api/config/apply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        baseHash: hash,
        edits: [
          {
            table: "response_pattern",
            key: { id: "mock-pattern-2" },
            row: { id: "mock-pattern-2", enabled: true, selection_description: "New", response_guidance: "", position: 1, include_initiative_context: true },
          },
        ],
        confirmation: "nonprod",
      }),
    });
    assert.equal(applied.status, 200);
    assert.equal((await store.loadSnapshot()).response_pattern.length, 2);
  });

  it("server config fails closed and binds loopback only", () => {
    assert.throws(() => loadConfigManagerConfig({}), /CONFIG_MANAGER_ENVIRONMENT/);
    const ok = loadConfigManagerConfig({
      CONFIG_MANAGER_ENVIRONMENT: "nonprod",
      CONFIG_MANAGER_DATABASE_URL: "postgres://x",
    });
    assert.equal(ok.host, "127.0.0.1");
    assert.equal(ok.environment, "nonprod");
    assert.throws(
      () =>
        loadConfigManagerConfig({
          CONFIG_MANAGER_ENVIRONMENT: "nonprod",
          CONFIG_MANAGER_DATABASE_URL: "postgres://x",
          CONFIG_MANAGER_HOST: "0.0.0.0",
        }),
      /loopback/,
    );
  });

  it("browser UI serves HTML bound to the target environment with preview/apply controls", async () => {
    const { baseUrl } = await startFor("nonprod");
    const res = await fetch(`${baseUrl}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/html/);
    const html = await res.text();
    assert.ok(html.includes('data-environment="nonprod"'));
    assert.ok(!html.includes("PRODUCTION binding."));
    for (const id of ["status", "tables", "confirm", "preview", "apply", "diff"]) {
      assert.ok(html.includes(`id="${id}"`), `expected id="${id}"`);
    }
    for (const label of ["Create a row", "Create row", "Delete row", "Add row", "New row"]) {
      assert.ok(!html.includes(label), `unexpected create/delete UI label: ${label}`);
    }
  });

  it("browser UI warns explicitly when bound to production", async () => {
    const { baseUrl } = await startFor("production");
    const html = await (await fetch(`${baseUrl}/`)).text();
    assert.ok(html.includes('data-environment="production"'));
    assert.ok(html.includes("PRODUCTION binding."));
    assert.ok(html.includes('id="apply" class="danger"'));
  });
});

describe("config manager targeted row writes (planRowChanges)", () => {
  function base() {
    return mockSnapshot();
  }

  function planTotals(plan) {
    return {
      inserted: plan.reduce((n, t) => n + t.inserted.length, 0),
      updated: plan.reduce((n, t) => n + t.updated.length, 0),
      deleted: plan.reduce((n, t) => n + t.deleted.length, 0),
    };
  }

  it("identical snapshots produce no writes at all", () => {
    const plan = planRowChanges(base(), base());
    assert.deepEqual(planTotals(plan), { inserted: 0, updated: 0, deleted: 0 });
  });

  it("bookkeeping-only differences (updated_at / revision) produce no writes", () => {
    const before = base();
    const after = base();
    after.chat_identity = [
      { ...after.chat_identity[0], revision: 99, updated_at: "2027-01-01T00:00:00.000Z" },
    ];
    after.engagement_bands = [
      { ...after.engagement_bands[0], updated_at: "2027-01-01T00:00:00.000Z" },
    ];
    const plan = planRowChanges(before, after);
    assert.deepEqual(planTotals(plan), { inserted: 0, updated: 0, deleted: 0 });
  });

  it("a single-field change updates exactly that row and column", () => {
    const before = base();
    const after = base();
    after.response_pattern = [
      { ...after.response_pattern[0], response_guidance: "Mock guidance v2", position: 7 },
    ];
    const plan = planRowChanges(before, after);
    assert.deepEqual(planTotals(plan), { inserted: 0, updated: 1, deleted: 0 });
    const change = plan.find((t) => t.table === "response_pattern");
    assert.equal(change.updated.length, 1);
    assert.deepEqual(change.updated[0].key, { id: "mock-pattern" });
    assert.deepEqual(change.updated[0].changed, ["response_guidance", "position"]);
  });

  it("type-different values count as changed (1 is not \"1\")", () => {
    const before = base();
    const after = base();
    after.response_pattern = [{ ...after.response_pattern[0], position: "0" }];
    const plan = planRowChanges(before, after);
    assert.deepEqual(planTotals(plan), { inserted: 0, updated: 1, deleted: 0 });
  });

  it("creates and deletes are planned without touching other rows", () => {
    const before = base();
    const after = base();
    after.response_pattern = [
      ...after.response_pattern,
      { id: "mock-pattern-2", enabled: true, selection_description: "New", response_guidance: "New guidance", position: 1, include_initiative_context: false },
    ];
    after.article_prompt = [];
    const plan = planRowChanges(before, after);
    assert.deepEqual(planTotals(plan), { inserted: 1, updated: 0, deleted: 1 });
    const created = plan.find((t) => t.table === "response_pattern");
    assert.equal(created.inserted[0].id, "mock-pattern-2");
    const removed = plan.find((t) => t.table === "article_prompt");
    assert.equal(removed.deleted[0].kind, "reaction_generation");
  });

  it("a primary-key rename is a delete plus an insert, never an update", () => {
    const before = base();
    const after = base();
    after.memory_subject = after.memory_subject.map((row) =>
      row.id === "user" ? { ...row, id: "user-renamed" } : row,
    );
    const plan = planRowChanges(before, after);
    assert.deepEqual(planTotals(plan), { inserted: 1, updated: 0, deleted: 1 });
  });

  it("plan order is FK-safe parent-first (registry order)", () => {
    const plan = planRowChanges(base(), base());
    assert.equal(plan[0].table, "chat_identity");
    assert.equal(plan[plan.length - 1].table, "article_prompt");
  });
});
