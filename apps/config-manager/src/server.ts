/**
 * Loopback-only HTTP surface for the local configuration manager.
 *
 * The browser is an untrusted client with exactly three powers: read the
 * fixed-environment snapshot (full prompt text included), preview a
 * validated diff, and apply a confirmed edit against an optimistic
 * concurrency base. It cannot choose the environment, supply a database
 * URL, pass credentials, or see deployment environment values — the
 * server owns every binding and those concerns never reach a response.
 *
 * Status contract:
 * - 400 malformed request, forbidden client binding attempt, or missing
 *   typed production confirmation
 * - 409 stale base hash (conflict): nothing was written
 * - 422 validation errors on the merged snapshot: nothing was written
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { computeDiff, snapshotHash } from "./diff.ts";
import { promptFieldsFor, TABLE_ORDER } from "./registry.ts";
import { ConflictError, type ConfigStore } from "./store.ts";
import { cloneSnapshotStrict } from "./snapshot.ts";
import { mergeEdits, ValidationError, type ConfigEdit } from "./validation.ts";

export interface ConfigManagerServerOptions {
  readonly environment: "nonprod" | "production";
  readonly store: ConfigStore;
  readonly host: string;
  readonly port: number;
  readonly maxBodyBytes?: number;
  readonly log?: (message: string) => void;
}

export interface RunningServer {
  readonly close: () => Promise<void>;
  readonly address: { port: number };
}

const BASE_HASH_PATTERN = /^[a-f0-9]{64}$/;
const DEFAULT_MAX_BODY_BYTES = 4 * 1024 * 1024;

// Keys a client must never set: the environment, the database binding, and
// every credential. Any of these at the request top level or in the query
// string is a 400 — the server's launch-time binding is the only source.
const FORBIDDEN_TOP_LEVEL = new Set([
  "environment",
  "databaseUrl",
  "database_url",
  "database",
  "host",
  "port",
  "token",
  "apiKey",
  "api_key",
  "apiToken",
  "openrouterApiKey",
  "secret",
  "password",
  "credentials",
  "credential",
  "connectionString",
]);
const FORBIDDEN_KEY_PATTERN = /^(WORKER_|CONFIG_MANAGER_|OPENROUTER_|DATABASE_|WEB_)/;

function isForbiddenKey(key: string): boolean {
  return FORBIDDEN_TOP_LEVEL.has(key) || FORBIDDEN_KEY_PATTERN.test(key);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(text);
}

function sendError(
  res: ServerResponse,
  status: number,
  kind: string,
  message: string,
  extra: Record<string, unknown> = {},
): void {
  sendJson(res, status, { error: kind, message, ...extra });
}

async function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > maxBytes) {
      throw new ValidationError(["request body exceeds the allowed size"]);
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

/**
 * Parse and validate an apply/preview body. Pure: no store access.
 * Throws ValidationError carrying every field-level problem.
 */
export function parseEditRequest(body: unknown): {
  readonly baseHash: string;
  readonly edits: readonly ConfigEdit[];
  readonly confirmation: unknown;
} {
  const errors: string[] = [];
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new ValidationError(["request body must be a JSON object"]);
  }
  const record = body as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (isForbiddenKey(key)) {
      errors.push(`field '${key}' is server-fixed and cannot be set by the client`);
    }
  }
  const baseHash = record["baseHash"];
  if (typeof baseHash !== "string" || !BASE_HASH_PATTERN.test(baseHash)) {
    errors.push("baseHash must be the 64-character snapshot hash from a prior GET");
  }
  const edits = record["edits"];
  if (!Array.isArray(edits)) {
    errors.push("edits must be an array");
  }
  const parsedEdits: ConfigEdit[] = [];
  if (Array.isArray(edits)) {
    for (const [index, entry] of edits.entries()) {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
        errors.push(`edits[${index}] must be an object`);
        continue;
      }
      const item = entry as Record<string, unknown>;
      const table = item["table"];
      const key = item["key"];
      const row = item["row"];
      const del = item["delete"];
      if (typeof table !== "string" || table.length === 0) {
        errors.push(`edits[${index}].table must be a non-empty string`);
        continue;
      }
      if (key === null || typeof key !== "object" || Array.isArray(key)) {
        errors.push(`edits[${index}].key must be an object of primary-key values`);
        continue;
      }
      const edit: ConfigEdit = del === true
        ? { table, key: key as Record<string, unknown>, delete: true }
        : { table, key: key as Record<string, unknown>, row: (row ?? {}) as Record<string, unknown> };
      parsedEdits.push(edit);
    }
  }
  if (errors.length > 0) throw new ValidationError(errors);
  return { baseHash: baseHash as string, edits: parsedEdits, confirmation: record["confirmation"] };
}

function confirmationOk(environment: "nonprod" | "production", confirmation: unknown): boolean {
  // Explicit typed confirmation: the operator must type the environment
  // name the server is bound to. Both environments require it; production
  // differs only in that the typed value is `production`.
  return confirmation === environment;
}

export function createConfigManagerServer(options: ConfigManagerServerOptions): Server {
  const maxBody = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const log = options.log ?? (() => {});

  function handleConfigGet(res: ServerResponse): void {
    void (async () => {
      const snapshot = await options.store.loadSnapshot();
      const tables = TABLE_ORDER.map((table) => ({
        table,
        promptFields: promptFieldsFor(table),
        // Full stored values, prompts included verbatim — never truncated.
        rows: (snapshot[table] ?? []).map((row) => ({ ...row })),
      }));
      sendJson(res, 200, {
        environment: options.environment,
        snapshotHash: snapshotHash(cloneSnapshotStrict(snapshot)),
        tables,
      });
    })().catch((error: unknown) => {
      log(`config GET failed: ${error instanceof Error ? error.message : String(error)}`);
      sendError(res, 500, "internal_error", "the configuration snapshot could not be loaded");
    });
  }

  async function handlePreviewOrApply(
    req: IncomingMessage,
    res: ServerResponse,
    apply: boolean,
  ): Promise<void> {
    let raw: string;
    try {
      raw = await readBody(req, maxBody);
    } catch (error) {
      if (error instanceof ValidationError) {
        sendError(res, 400, "invalid_request", "the request body could not be accepted", {
          errors: error.errors,
        });
        return;
      }
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      sendError(res, 400, "invalid_json", "request body must be valid JSON");
      return;
    }
    let request: ReturnType<typeof parseEditRequest>;
    try {
      request = parseEditRequest(parsed);
    } catch (error) {
      if (error instanceof ValidationError) {
        sendError(res, 400, "invalid_request", "the request could not be accepted", {
          errors: error.errors,
        });
        return;
      }
      throw error;
    }
    const current = await options.store.loadSnapshot();
    const currentHash = snapshotHash(cloneSnapshotStrict(current));
    if (currentHash !== request.baseHash) {
      sendError(res, 409, "conflict", "the configuration changed since this snapshot", {
        snapshotHash: currentHash,
      });
      return;
    }
    const { merged, errors } = mergeEdits(current, request.edits);
    const diff = computeDiff(current, merged);
    if (errors.length > 0) {
      sendError(res, 422, "validation_failed", "the proposed configuration is invalid", {
        errors,
        diff,
      });
      return;
    }
    if (!apply) {
      sendJson(res, 200, { snapshotHash: currentHash, diff });
      return;
    }
    if (!confirmationOk(options.environment, request.confirmation)) {
      sendError(
        res,
        400,
        "confirmation_required",
        `applying requires typed confirmation '${options.environment}' for this server-bound environment`,
      );
      return;
    }
    try {
      const newHash = await options.store.applySnapshot(merged, request.baseHash);
      sendJson(res, 200, { snapshotHash: currentHash, newSnapshotHash: newHash, diff });
    } catch (error) {
      if (error instanceof ConflictError) {
        sendError(res, 409, "conflict", "the configuration changed while applying", {
          snapshotHash: snapshotHash(cloneSnapshotStrict(await options.store.loadSnapshot())),
        });
        return;
      }
      throw error;
    }
  }

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const method = req.method ?? "GET";
      // The environment and credentials are server-side only: any attempt
      // to set them from the query string is rejected before routing.
      for (const key of url.searchParams.keys()) {
        if (isForbiddenKey(key)) {
          sendError(res, 400, "fixed_binding", `query parameter '${key}' is server-fixed and cannot be set by the client`);
          return;
        }
      }

      if (url.pathname === "/") {
        if (method !== "GET") {
          sendError(res, 405, "method_not_allowed", "the index page is GET-only");
          return;
        }
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        res.end(renderIndex(options.environment));
        return;
      }
      if (url.pathname === "/api/health") {
        if (method !== "GET") {
          sendError(res, 405, "method_not_allowed", "health is GET-only");
          return;
        }
        sendJson(res, 200, { status: "ok", environment: options.environment });
        return;
      }
      if (url.pathname === "/api/config") {
        if (method !== "GET") {
          sendError(res, 405, "method_not_allowed", "the snapshot route is GET-only");
          return;
        }
        handleConfigGet(res);
        return;
      }
      if (url.pathname === "/api/config/preview") {
        if (method !== "POST") {
          sendError(res, 405, "method_not_allowed", "preview is POST-only");
          return;
        }
        await handlePreviewOrApply(req, res, false);
        return;
      }
      if (url.pathname === "/api/config/apply") {
        if (method !== "POST") {
          sendError(res, 405, "method_not_allowed", "apply is POST-only");
          return;
        }
        await handlePreviewOrApply(req, res, true);
        return;
      }
      sendError(res, 404, "not_found", "no such route");
    })().catch((error: unknown) => {
      log(`request failed: ${error instanceof Error ? error.message : String(error)}`);
      if (!res.headersSent) {
        sendError(res, 500, "internal_error", "the request could not be completed");
      } else {
        res.end();
      }
    });
  });

  return server;
}

/** Start listening on the fixed loopback bind. */
export async function startConfigManagerServer(
  options: ConfigManagerServerOptions,
): Promise<RunningServer> {
  const server = createConfigManagerServer(options);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("config manager did not acquire a TCP address");
  }
  return {
    address: { port: address.port },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

function renderIndex(environment: "nonprod" | "production"): string {
  const prod = environment === "production";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Companion configuration manager</title>
<style>
:root{color-scheme:dark;--bg:#0f141a;--surface:#161e27;--surface-2:#1d2835;--header-bg:#111a24;--border:#3a4a5e;--text:#e8eef5;--muted:#b6c2d2;--accent:#3b82f6;--accent-strong:#2563eb;--danger:#b91c1c;--danger-strong:#991b1b;--warn-bg:#2e2107;--warn-text:#fcd34d;--warn-border:#92600e;--input-bg:#0a0f15;--input-border:#54687f;--focus:#7dd3fc;--badge-bg:#263449;--radius:.5rem}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font-family:system-ui,-apple-system,"Segoe UI",sans-serif;line-height:1.5}
code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.site-header{position:sticky;top:0;z-index:20;background:var(--header-bg);border-bottom:1px solid var(--border);box-shadow:0 2px 12px rgba(0,0,0,.45);max-height:85vh;overflow-y:auto}
.header-inner{max-width:1100px;margin:0 auto;padding:.85rem 1rem;display:grid;grid-template-columns:minmax(0,1fr);gap:.75rem}
.header-main{display:flex;flex-wrap:wrap;gap:1rem;align-items:flex-start;justify-content:space-between}
.header-main>*{min-width:0}
h1{font-size:1.45rem;line-height:1.2;margin:0 0 .35rem}
.env-context{margin:0;color:var(--muted);overflow-wrap:anywhere}
.env-badge{display:inline-block;background:var(--badge-bg);color:var(--text);border:1px solid var(--border);border-radius:999px;padding:.05rem .55rem}
.warn{margin:.5rem 0 0;background:var(--warn-bg);color:var(--warn-text);border:1px solid var(--warn-border);border-radius:var(--radius);padding:.6rem .75rem;overflow-wrap:anywhere}
.env-hint{margin:.5rem 0 0;color:var(--muted);overflow-wrap:anywhere}
.controls{display:flex;flex-wrap:wrap;gap:.85rem 1.25rem;align-items:flex-end;min-width:0;flex:1 1 26rem}
.confirm-field{display:grid;gap:.3rem;flex:1 1 16rem;min-width:0}
.confirm-field label{font-weight:600}
.hint{margin:0;color:var(--muted);font-size:.88rem}
.actions{display:flex;flex-wrap:wrap;gap:.5rem}
button{font:inherit;font-weight:600;border-radius:var(--radius);border:1px solid var(--border);background:var(--surface-2);color:var(--text);padding:.6rem 1rem;cursor:pointer}
button:hover:not(:disabled){filter:brightness(1.18)}
button:disabled{opacity:.55;cursor:not-allowed}
button.primary{background:var(--accent-strong);border-color:#1e40af;color:#fff}
button.danger{background:var(--danger);border-color:var(--danger-strong);color:#fff}
input,textarea{width:100%;background:var(--input-bg);color:var(--text);border:1px solid var(--input-border);border-radius:.4rem;padding:.55rem .65rem;font:inherit}
textarea{min-height:8rem;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.9rem;white-space:pre-wrap;overflow-wrap:anywhere;resize:vertical}
input[type="checkbox"]{width:1.25rem;height:1.25rem;accent-color:var(--accent);flex:none}
input:focus-visible,textarea:focus-visible,button:focus-visible,summary:focus-visible,pre:focus-visible{outline:3px solid var(--focus);outline-offset:2px}
.status{margin:0;flex-basis:100%;color:var(--muted);overflow-wrap:anywhere;min-width:0}
.results{border:1px solid var(--border);border-radius:var(--radius);background:var(--surface);overflow:hidden}
.results summary{cursor:pointer;padding:.6rem .8rem;font-weight:700;display:flex;flex-wrap:wrap;gap:.4rem 1rem;align-items:center;justify-content:space-between}
.results summary::-webkit-details-marker{color:var(--muted)}
.results-state{font-weight:500;color:var(--muted)}
.results-panel{max-height:min(38vh,22rem);overflow:auto;border-top:1px solid var(--border)}
.results-panel pre{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.86rem;padding:.8rem}
.page{max-width:1100px;margin:0 auto;padding:1.25rem 1rem 3rem}
.intro{color:var(--muted);max-width:70ch}
.table-section{margin:1.75rem 0}
.table-section>h2{font-size:1.2rem;margin:0 0 .3rem;padding-bottom:.35rem;border-bottom:1px solid var(--border);overflow-wrap:anywhere}
.table-meta{color:var(--muted);margin:.35rem 0 1rem}
.row-card{background:var(--surface);border:1px solid var(--border);border-radius:.65rem;padding:1rem;margin:0 0 1rem}
.row-card>h3{margin:0 0 .85rem;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:1rem;overflow-wrap:anywhere}
.fields{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,18rem),1fr));gap:.85rem}
.field{display:grid;gap:.35rem;align-content:start;background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius);padding:.7rem}
.field--prompt{grid-column:1/-1}
.field--boolean{display:flex;align-items:center;gap:.6rem}
.field--boolean label{font-weight:600}
.field label,.field-label{font-weight:600;overflow-wrap:anywhere}
.field output{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;overflow-wrap:anywhere;color:var(--muted)}
.badge{display:inline-block;font-size:.72rem;font-weight:700;letter-spacing:.02em;text-transform:uppercase;background:var(--badge-bg);border:1px solid var(--border);border-radius:999px;padding:.08rem .45rem;vertical-align:middle}
.field .hint{font-size:.82rem}
@media (max-width:40rem){.header-inner{padding:.7rem .75rem}h1{font-size:1.2rem}.controls{min-width:0}.actions,.actions button{flex:1 1 auto}.page{padding:1rem .75rem 2.5rem}.env-hint{display:none}}
@media (max-height:36rem){.header-inner{gap:.5rem;padding:.5rem .75rem}h1{font-size:1rem}.env-context{font-size:.9rem}.warn{margin-top:.35rem;padding:.45rem .6rem}.env-hint,#confirm-hint{display:none}.results-panel{max-height:24vh}.controls{align-items:center;gap:.5rem .85rem}button{padding:.45rem .8rem}input,textarea{padding:.4rem .5rem}}
</style></head><body>
<header class="site-header" id="site-header">
<div class="header-inner">
<div class="header-main">
<div class="header-title">
<h1>Companion configuration manager</h1>
<p class="env-context">Environment (fixed server-side, cannot be changed here): <strong class="env-badge" data-environment="${escapeHtml(environment)}">${escapeHtml(environment)}</strong></p>
${prod ? '<p class="warn"><strong>PRODUCTION binding.</strong> Applying an edit writes production configuration. Type <code>production</code> exactly to confirm.</p>' : `<p class="env-hint">Non-production binding. Type <code>nonprod</code> exactly to confirm an apply.</p>`}
</div>
<div class="controls">
<div class="confirm-field">
<label for="confirm">Confirmation (type the environment name): <code>${escapeHtml(environment)}</code></label>
<input id="confirm" name="confirmation" autocomplete="off" spellcheck="false" aria-describedby="confirm-hint">
<p class="hint" id="confirm-hint">The typed value must match the server-bound environment exactly.</p>
</div>
<div class="actions">
<button type="button" id="preview" disabled>Review diff</button>
<button type="button" id="apply" class="${prod ? "danger" : "primary"}" disabled>Apply edits</button>
</div>
<p id="status" class="status" role="status" aria-live="polite" aria-atomic="true">Loading…</p>
</div>
</div>
<details class="results" id="results">
<summary id="results-summary" aria-controls="diff"><span>Review results</span><span class="results-state" id="results-state">No review yet</span></summary>
<div class="results-panel"><pre id="diff" tabindex="0" aria-label="Review diff output">No review yet.</pre></div>
</details>
</div>
</header>
<main class="page">
<p class="intro">Edit the labelled fields below, then use <strong>Review diff</strong> in the sticky header to preview the validated changes, or <strong>Apply edits</strong> to write them. Prompt fields show the full stored text in the labelled textarea. Fields marked <span class="badge">Server-managed</span> are display-only and cannot be set here. Review results stay available from the sticky header while you scroll.</p>
<div id="tables"></div>
</main>
<script>
const env = ${JSON.stringify(environment)};
// The snapshot API returns no column metadata, so these mirror the
// server registry: auto (server-managed) columns and per-table primary keys.
const SERVER_MANAGED = new Set(['updated_at', 'revision']);
const PRIMARY_KEYS = {
  chat_identity: ['id'],
  companion_time_settings: ['id'],
  engagement_bands: ['id'],
  memory_behavior: ['id'],
  memory_subject: ['id'],
  memory_prompt: ['kind', 'version'],
  response_pattern: ['id'],
  prompt_module: ['id'],
  routine_settings: ['id'],
  routine_transition: ['id'],
  relationship_settings: ['id'],
  relationship_tier: ['id'],
  relationship_question_type: ['type_key'],
  relationship_question: ['id'],
  article_feed: ['id'],
  article_behavior: ['id'],
  article_prompt: ['kind', 'version']
};
let baseHash = null, snapshot = null, inFlight = false;
const previewBtn = document.getElementById('preview');
const applyBtn = document.getElementById('apply');
const confirmInput = document.getElementById('confirm');
const statusEl = document.getElementById('status');
const diffEl = document.getElementById('diff');
const resultsEl = document.getElementById('results');
const resultsStateEl = document.getElementById('results-state');
const headerEl = document.getElementById('site-header');
function esc(s){return String(s ?? '').replace(/[&<>"]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));}
function setStatus(message){ statusEl.textContent = message; }
function setResultsState(message){ resultsStateEl.textContent = message; }
function setBusy(busy, message){
  inFlight = busy;
  previewBtn.disabled = busy || !snapshot;
  applyBtn.disabled = busy || !snapshot;
  confirmInput.disabled = busy;
  headerEl.setAttribute('aria-busy', busy ? 'true' : 'false');
  if (message) setStatus(message);
}
function primaryKeyLabel(table, row, ri){
  const pk = PRIMARY_KEYS[table] || [];
  if (pk.length === 0) return 'Row ' + (ri + 1);
  const parts = pk.map(k => k + ': ' + String(row[k] ?? ''));
  return parts.join(' · ') || ('Row ' + (ri + 1));
}
function fieldId(table, ri, field){
  return 'f-' + String(table).replace(/[^a-zA-Z0-9_-]/g, '-') + '-' + ri + '-' + String(field).replace(/[^a-zA-Z0-9_-]/g, '-');
}
async function load(){
  try {
    const r = await fetch('/api/config');
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.message || ('HTTP ' + r.status));
    snapshot = data;
    baseHash = snapshot.snapshotHash;
    setStatus('snapshot ' + baseHash + ' · ' + snapshot.tables.length + ' tables');
    const host = document.getElementById('tables'); host.innerHTML = '';
    for (const t of snapshot.tables) {
      const sec = document.createElement('section');
      sec.className = 'table-section';
      sec.innerHTML = '<h2>' + esc(t.table) + '</h2><p class="table-meta">Prompt fields (full text): ' + esc(t.promptFields.join(', ') || 'none') + ' · ' + t.rows.length + ' row(s)</p>';
      t.rows.forEach((row, ri) => {
        const div = document.createElement('div');
        div.className = 'row-card';
        div.dataset.table = t.table; div.dataset.row = ri;
        let html = '<h3>' + esc(primaryKeyLabel(t.table, row, ri)) + '</h3><div class="fields">';
        for (const [k, v] of Object.entries(row)) {
          const id = fieldId(t.table, ri, k);
          if (SERVER_MANAGED.has(k)) {
            html += '<div class="field field--server-managed"><span class="field-label">' + esc(k) + ' <span class="badge">Server-managed</span></span><output>' + esc(v ?? '') + '</output><span class="hint">Display only — cannot be set here.</span></div>';
          } else if (t.promptFields.includes(k)) {
            html += '<div class="field field--prompt"><label for="' + id + '">' + esc(k) + ' <span class="badge">Full prompt text</span></label><textarea id="' + id + '" data-field="' + esc(k) + '" spellcheck="false">' + esc(v ?? '') + '</textarea></div>';
          } else if (typeof v === 'boolean') {
            html += '<div class="field field--boolean"><input type="checkbox" id="' + id + '" data-field="' + esc(k) + '"' + (v ? ' checked' : '') + '><label for="' + id + '">' + esc(k) + '</label></div>';
          } else if (v === null || v === undefined) {
            html += '<div class="field"><label for="' + id + '">' + esc(k) + '</label><input id="' + id + '" data-field="' + esc(k) + '" value="" placeholder="(empty — null)"></div>';
          } else {
            html += '<div class="field"><label for="' + id + '">' + esc(k) + '</label><input id="' + id + '" data-field="' + esc(k) + '" value="' + esc(v) + '"></div>';
          }
        }
        div.innerHTML = html + '</div>';
        sec.appendChild(div);
      });
      host.appendChild(sec);
    }
    setBusy(false);
    return true;
  } catch (error) {
    snapshot = null; baseHash = null;
    setBusy(false);
    setStatus('Could not load snapshot: ' + (error && error.message ? error.message : String(error)));
    setResultsState('Load failed');
    diffEl.textContent = 'Could not load snapshot: ' + (error && error.message ? error.message : String(error));
    return false;
  }
}
function collectEdits(){
  const edits = [];
  for (const div of document.querySelectorAll('[data-table]')) {
    const table = div.dataset.table;
    const original = snapshot.tables.find(t=>t.table===table).rows[Number(div.dataset.row)];
    const key = {}; for (const k of Object.keys(original)) key[k] = original[k];
    const row = {};
    let changed = false;
    div.querySelectorAll('[data-field]').forEach(inp => {
      const f = inp.dataset.field; let val = inp.type==='checkbox' ? inp.checked : inp.value;
      if (val === '') val = null;
      else if (original[f] === null && val === null) {}
      else if (typeof original[f] === 'number') val = val === null ? null : Number(val);
      if (String(val) !== String(original[f])) { row[f] = val; changed = true; }
    });
    if (changed) edits.push({table, key, row});
  }
  return edits;
}
async function call(path, body){
  const r = await fetch(path, {method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(body)});
  const data = await r.json().catch(()=>({}));
  diffEl.textContent = JSON.stringify(data, null, 2);
  return {status: r.status, data};
}
previewBtn.onclick = async () => {
  if (inFlight || !snapshot) return;
  setBusy(true, 'Reviewing diff…');
  setResultsState('Reviewing…');
  resultsEl.open = true;
  try {
    const {status, data} = await call('/api/config/preview', {baseHash, edits: collectEdits()});
    if (status === 200) {
      setStatus('Diff reviewed: ' + ((data && data.diff ? data.diff.length : 0)) + ' change(s). Nothing was written.');
      setResultsState('Preview complete');
    } else {
      setStatus('Preview failed (' + status + '): ' + ((data && data.message) || 'see review results'));
      setResultsState('Preview failed');
    }
  } catch (error) {
    const message = 'Preview failed: ' + (error && error.message ? error.message : String(error));
    setStatus(message);
    diffEl.textContent = message;
    setResultsState('Preview failed');
  } finally {
    setBusy(false);
  }
};
applyBtn.onclick = async () => {
  if (inFlight || !snapshot) return;
  const confirmation = confirmInput.value;
  setBusy(true, 'Applying edits…');
  setResultsState('Applying…');
  resultsEl.open = true;
  try {
    const {status, data} = await call('/api/config/apply', {baseHash, edits: collectEdits(), confirmation});
    if (status === 200) {
      const newHash = data.newSnapshotHash;
      const reloaded = await load();
      resultsEl.open = true;
      setResultsState('Apply complete');
      setStatus(reloaded ? ('Applied; new snapshot ' + newHash) : ('Applied; new snapshot ' + newHash + ', but the snapshot could not be reloaded.'));
    } else {
      setStatus('Apply failed (' + status + '): ' + ((data && data.message) || 'see review results'));
      setResultsState('Apply failed');
    }
  } catch (error) {
    const message = 'Apply failed: ' + (error && error.message ? error.message : String(error));
    setStatus(message);
    diffEl.textContent = message;
    setResultsState('Apply failed');
  } finally {
    setBusy(false);
  }
};
load();
</script></body></html>`;
}
