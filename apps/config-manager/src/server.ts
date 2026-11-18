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
<html lang="en"><head><meta charset="utf-8"><title>Companion configuration manager</title>
<style>body{font-family:system-ui,sans-serif;max-width:1000px;margin:2rem auto;padding:0 1rem}
pre{white-space:pre-wrap;background:#f4f4f4;padding:.5rem;overflow:auto}
.warn{background:#fff3cd;border:1px solid #c9a227;padding:.75rem}
table{border-collapse:collapse;width:100%}td,th{border:1px solid #ccc;padding:.25rem;vertical-align:top}
textarea{width:100%;min-height:4rem}</style></head><body>
<h1>Companion configuration manager</h1>
<p>Environment (fixed server-side, cannot be changed here): <strong>${escapeHtml(environment)}</strong></p>
${prod ? '<p class="warn"><strong>PRODUCTION binding.</strong> Applying an edit writes production configuration. Type <code>production</code> exactly to confirm.</p>' : `<p>Type <code>nonprod</code> exactly to confirm an apply.</p>`}
<p id="status">Loading…</p>
<div id="tables"></div>
<label>Confirmation (type the environment name): <input id="confirm" autocomplete="off"></label>
<button id="preview">Review diff</button> <button id="apply">Apply edits</button>
<pre id="diff"></pre>
<script>
const env = ${JSON.stringify(environment)};
let baseHash = null, snapshot = null;
function esc(s){return String(s ?? '').replace(/[&<>"]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));}
async function load(){
  const r = await fetch('/api/config'); snapshot = await r.json();
  baseHash = snapshot.snapshotHash;
  document.getElementById('status').textContent = 'snapshot ' + baseHash + ' · ' + snapshot.tables.length + ' tables';
  const host = document.getElementById('tables'); host.innerHTML = '';
  for (const t of snapshot.tables) {
    const sec = document.createElement('section');
    sec.innerHTML = '<h2>' + esc(t.table) + '</h2><p>Prompt fields (full text): ' + esc(t.promptFields.join(', ') || 'none') + '</p>';
    t.rows.forEach((row, ri) => {
      const div = document.createElement('div');
      div.dataset.table = t.table; div.dataset.row = ri;
      let html = '<h3>Row ' + (ri+1) + '</h3><table>';
      for (const [k,v] of Object.entries(row)) {
        html += '<tr><th>' + esc(k) + '</th><td>';
        if (t.promptFields.includes(k)) html += '<pre>' + esc(v ?? '') + '</pre><textarea data-field="' + esc(k) + '">' + esc(v ?? '') + '</textarea>';
        else if (typeof v === 'boolean') html += '<input type="checkbox" data-field="' + esc(k) + '"' + (v ? ' checked' : '') + '>';
        else if (v === null || v === undefined) html += '<input data-field="' + esc(k) + '" value="">';
        else html += '<input data-field="' + esc(k) + '" value="' + esc(v) + '">';
        html += '</td></tr>';
      }
      div.innerHTML = html + '</table>';
      sec.appendChild(div);
    });
    host.appendChild(sec);
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
  document.getElementById('diff').textContent = JSON.stringify(data, null, 2);
  return {status: r.status, data};
}
document.getElementById('preview').onclick = async () => {
  await call('/api/config/preview', {baseHash, edits: collectEdits()});
};
document.getElementById('apply').onclick = async () => {
  const confirmation = document.getElementById('confirm').value;
  const {status, data} = await call('/api/config/apply', {baseHash, edits: collectEdits(), confirmation});
  if (status === 200) { document.getElementById('status').textContent = 'applied; new snapshot ' + data.newSnapshotHash; await load(); }
};
load();
</script></body></html>`;
}
