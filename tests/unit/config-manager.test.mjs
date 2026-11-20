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
      { id: "mock-pattern", enabled: true, selection_description: "Mock selection", response_guidance: "Mock guidance", position: 0 },
    ],
    prompt_module: [
      {
        id: "11111111-1111-4111-8111-111111111111", module_key: "mock-module", decision_description: "Mock module",
        function_definition: '(context: PromptModuleContext): string => "mock";', fallback_content: null,
        enabled: false, position: 0, timeout_ms: 5000, activation_mode: "model_gated", output_kind: "thoughts",
        execution_mode: "function", http_endpoint_setting: null, http_scope_setting: null, http_scope_field: null,
        http_turn_id_field: null, http_local_datetime_field: null, http_previous_assistant_field: null,
        http_user_message_field: null, http_prior_conversation_field: null, http_response_text_field: null,
        http_field_max_bytes: null, http_prior_message_limit: null, http_request_max_bytes: null, http_response_max_bytes: null,
        updated_at: "2026-11-01T00:00:00.000Z",
      },
    ],
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
            row: { id: "mock-pattern-2", enabled: true, selection_description: "New", response_guidance: "New guidance", position: 1 },
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
            row: { id: "mock-pattern-2", enabled: true, selection_description: "New", response_guidance: "New guidance", position: 1 },
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

  it("browser UI: sticky header contains environment, confirmation, actions and results, preserving existing bindings", async () => {
    const { baseUrl } = await startFor("nonprod");
    const res = await fetch(`${baseUrl}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/html/);
    const html = await res.text();
    // Header placement: the sticky header precedes the tables region.
    const headerStart = html.indexOf("<header");
    const headerEnd = html.indexOf("</header>");
    const tablesAt = html.indexOf('id="tables"');
    assert.ok(headerStart >= 0 && headerEnd > headerStart && tablesAt > headerEnd, "header must precede the tables region");
    const header = html.slice(headerStart, headerEnd);
    assert.ok(header.includes('class="site-header"'), "header carries the sticky class");
    assert.ok(html.includes("position:sticky"), "header is sticky");
    assert.ok(html.includes('name="viewport"'), "responsive viewport is declared");
    // Environment context, confirmation, and actions live in the header.
    assert.ok(header.includes("nonprod"), "header shows the bound environment");
    assert.ok(header.includes('data-environment="nonprod"'), "header environment badge is bound");
    assert.ok(!header.includes("PRODUCTION binding."), "nonprod header carries no production warning");
    assert.ok(header.includes('id="confirm"') && header.includes('for="confirm"'), "confirmation is labelled in the header");
    assert.ok(header.includes('id="preview"') && header.includes(">Review diff<"), "Review diff is in the header");
    assert.ok(header.includes('id="apply"') && header.includes(">Apply edits<"), "Apply edits is in the header");
    assert.ok(header.includes('id="status"'), "status region is in the header");
    // Existing bindings are preserved (ids the client and operators rely on).
    for (const id of ["status", "tables", "confirm", "preview", "apply", "diff"]) {
      assert.ok(html.includes(`id="${id}"`), `existing binding id="${id}" is preserved`);
    }
    for (const path of ["/api/config", "/api/config/preview", "/api/config/apply"]) {
      assert.ok(html.includes(path), `client still calls ${path}`);
    }
    assert.ok(html.includes("baseHash") && html.includes("confirmation"), "payload field names are unchanged");
    assert.ok(html.includes("data-field") && html.includes("data-table") && html.includes("collectEdits"), "field collection bindings are preserved");
    // Bounded, accessible review-results disclosure attached to the header.
    assert.ok(header.includes('<details') && header.includes('id="results"'), "results disclosure is in the header");
    assert.ok(header.includes("<summary") && header.includes('id="results-state"'), "results summary names its state");
    assert.ok(header.includes('id="diff"'), "diff output is inside the header results panel");
    assert.ok(html.includes(".results-panel") && html.includes("max-height:min(38vh,22rem)") && html.includes("overflow:auto"), "results panel is bounded and scrollable");
    assert.ok(html.includes("max-height:85vh"), "sticky header is height-capped so it cannot take over short screens");
    assert.ok(html.includes("@media (max-width:40rem)") && html.includes("@media (max-height:36rem)"), "header compacts on narrow/short screens");
  });

  it("browser UI: production header shows the production warning and danger apply", async () => {
    const { baseUrl } = await startFor("production");
    const html = await (await fetch(`${baseUrl}/`)).text();
    const header = html.slice(html.indexOf("<header"), html.indexOf("</header>"));
    assert.ok(header.includes("PRODUCTION binding."), "production warning is in the header");
    assert.ok(header.includes("Applying an edit writes production configuration."), "production warning states the write consequence");
    assert.ok(header.includes('data-environment="production"'), "production badge is bound");
    assert.ok(header.includes('id="apply" class="danger"'), "production apply is marked as dangerous");
    assert.ok(header.includes('for="confirm"') && header.includes("production"), "production confirmation is labelled in the header");
  });

  it("browser UI: fixed dark theme, visible focus, labelled fields, primary-key headings and display-only server-managed fields", async () => {
    const { baseUrl } = await startFor("nonprod");
    const html = await (await fetch(`${baseUrl}/`)).text();
    assert.ok(html.includes("color-scheme:dark"), "fixed dark theme is declared");
    assert.ok(!html.includes("prefers-color-scheme"), "theme does not switch to a light palette");
    assert.ok(html.includes(":focus-visible") && html.includes("outline:3px solid var(--focus)"), "visible focus is styled");
    // Labelled fields: generated labels are bound to generated control ids.
    assert.ok(html.includes('<label for="') && html.includes("fieldId"), "fields render a label bound to a control id");
    // Row headings use primary keys, including composite keys.
    assert.ok(html.includes("PRIMARY_KEYS") && html.includes("primaryKeyLabel"), "row headings are derived from primary keys");
    assert.ok(html.includes("memory_prompt: ['kind', 'version']"), "composite primary key is mapped");
    assert.ok(html.includes("article_prompt: ['kind', 'version']"), "composite article prompt key is mapped");
    assert.ok(html.includes("relationship_question_type: ['type_key']"), "type_key primary key is mapped");
    // Server-managed fields are display-only and never collected as edits.
    assert.ok(html.includes("SERVER_MANAGED") && html.includes("updated_at") && html.includes("revision"), "server-managed fields are named");
    assert.ok(html.includes("field--server-managed") && html.includes("<output>") && html.includes("Display only"), "server-managed fields render as display-only output");
    // Escaping is preserved for rendered values.
    assert.ok(html.includes("&amp;") && html.includes("&lt;") && html.includes("&quot;"), "HTML escaping is preserved");
  });

  it("browser UI: prompt text is a single full-text textarea with no duplicate pre, and there is no create/delete UI", async () => {
    const { baseUrl } = await startFor("nonprod");
    const html = await (await fetch(`${baseUrl}/`)).text();
    // The only static <pre> is the results diff output; prompt fields must
    // not also render a <pre> duplicate alongside their textarea.
    assert.equal((html.match(/<pre/g) ?? []).length, 1, "only the results diff uses <pre>");
    assert.ok(!html.includes("'<pre>' + esc"), "prompt rendering has no duplicate pre");
    assert.ok(html.includes("<textarea id=") && html.includes("data-field="), "prompt fields render a textarea control");
    assert.ok(html.includes("Full prompt text"), "prompt textarea is labelled as full text");
    assert.ok(!html.includes("slice(0"), "prompt text is not truncated in the client");
    for (const label of ["Create a row", "Create row", "Delete row", "Add row", "New row"]) {
      assert.ok(!html.includes(label), `no create/delete UI label: ${label}`);
    }
  });

  it("browser UI: accessible request feedback and duplicate in-flight prevention", async () => {
    const { baseUrl } = await startFor("nonprod");
    const html = await (await fetch(`${baseUrl}/`)).text();
    assert.ok(html.includes('role="status"') && html.includes('aria-live="polite"') && html.includes('aria-atomic="true"'), "status is an atomic polite live region");
    assert.ok(html.includes("aria-busy"), "busy state is exposed on the header");
    assert.ok(html.includes("inFlight"), "in-flight guard is present");
    assert.ok(html.includes("if (inFlight || !snapshot) return;"), "duplicate preview/apply clicks are ignored while a request is in flight");
    assert.ok(html.includes("previewBtn.disabled") && html.includes("applyBtn.disabled"), "actions are disabled while busy");
    assert.ok(html.includes("Reviewing diff…") && html.includes("Applying edits…"), "busy feedback is announced");
    assert.ok(html.includes("Preview failed") && html.includes("Apply failed") && html.includes("Could not load snapshot"), "failure feedback is announced");
    assert.ok(html.includes("resultsEl.open = true"), "results are opened automatically for visibility from the header");
    assert.ok(html.includes('type="button"'), "header actions are explicit buttons");
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
      { id: "mock-pattern-2", enabled: true, selection_description: "New", response_guidance: "New guidance", position: 1 },
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
