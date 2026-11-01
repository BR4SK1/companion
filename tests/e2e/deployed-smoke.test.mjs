/**
 * Regression tests for the deployed non-production smoke's core
 * (`deployed-dev-smoke.mjs` + `deployed-smoke-lib.mjs`).
 *
 * Review-driven coverage (isolated, synthetic, disposable only — no cluster,
 * no real provider, no real conversation data):
 *
 * 1. Output hygiene: the synthetic marker and any captured reply text never
 *    appear in sanitized errors or evidence, including Playwright-shaped
 *    multi-line timeout errors that would otherwise embed matched text and
 *    page snapshots.
 * 2. Cleanup decision state machine: every uncertain state RETAINS (unreadable
 *    turn, in-flight past the wait, shutdown during the wait, guarded delete
 *    that affected no row while still reading unassigned, unrecognized turn
 *    status); only provably-owned rows are ever deleted.
 * 3. The queued-message delete-vs-claim race, executed against a disposable
 *    local PostgreSQL with the worker's real claim semantics (advisory lock →
 *    pending SELECT … FOR UPDATE → UPDATE … SET turn_id WHERE turn_id IS
 *    NULL) racing the smoke's exact guarded DELETE in both orders.
 * 4. Graceful signals: a stop request aborts journey loops and the awaited
 *    cleanup still runs before the process exits (second signal = hard exit);
 *    at the process level via a fake `kubectl` shim, with the runner's REAL
 *    pod-side action script executed against the disposable database.
 * 5. Failure retention + idempotent verified recovery (`--recover`): seeded
 *    queued and completed-turn scenarios clean exactly their own rows and a
 *    second recovery run is a verified no-op; the SIGKILL limitation is
 *    covered by the documented marker-file recovery trail.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import net from "node:net";
import { randomUUID } from "node:crypto";

import test from "node:test";
import assert from "node:assert/strict";

import { config } from "./helpers/config.mjs";
import {
  POD_ACTION_SCRIPT_BODY,
  buildMarker,
  buildOwnMessageDelete,
  buildPodActionScript,
  buildQueuedAtomicDelete,
  createShutdownController,
  fingerprint,
  planCleanupDecision,
  redactText,
  sanitizeError,
} from "./deployed-smoke-lib.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
/** pg is a dependency of libraries/postgres; resolve it from there. */
const requireFromPostgresLib = createRequire(path.join(repoRoot, "libraries", "postgres", "package.json"));
// eslint-disable-next-line no-undef
const pg = requireFromPostgresLib("pg");

const RUNNER = path.join(here, "deployed-dev-smoke.mjs");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Disposable local PostgreSQL (throwaway container; removed in every path)
// ---------------------------------------------------------------------------

const SCHEMA_SQL = `
CREATE TABLE conversation_turn (
  id uuid PRIMARY KEY,
  status text NOT NULL DEFAULT 'in_flight' CHECK (status IN ('in_flight','completed','failed')),
  attempt integer NOT NULL DEFAULT 1 CHECK (attempt >= 1),
  lease_owner text,
  lease_expires_at timestamptz,
  selected_pattern_id text,
  decision jsonb,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT conversation_turn_lease_present
    CHECK (status <> 'in_flight' OR (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL))
);
CREATE TABLE conversation_message (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq bigint GENERATED ALWAYS AS IDENTITY,
  role text NOT NULL CHECK (role IN ('user','assistant')),
  content text NOT NULL,
  client_key text UNIQUE,
  turn_id uuid REFERENCES conversation_turn (id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX conversation_message_seq_idx ON conversation_message (seq);
CREATE INDEX conversation_message_pending_user_idx ON conversation_message (seq) WHERE turn_id IS NULL AND role = 'user';
CREATE UNIQUE INDEX conversation_turn_reply_idx ON conversation_message (turn_id) WHERE role = 'assistant';
CREATE INDEX conversation_turn_in_flight_idx ON conversation_turn (created_at) WHERE status = 'in_flight';
CREATE TABLE response_pattern (
  id text PRIMARY KEY,
  enabled boolean NOT NULL DEFAULT true,
  selection_description text NOT NULL,
  response_guidance text NOT NULL,
  position integer NOT NULL CHECK (position >= 0)
);
`;

function docker(args, { timeoutMs = 120_000 } = {}) {
  const { execFileSync } = requireFromPostgresLib("node:child_process");
  return execFileSync("docker", args, { timeout: timeoutMs, encoding: "utf8" });
}

/** The kernel-unique process identity used for container ownership records. */
function procStarttime(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${String(pid)}/stat`, "utf8");
    const after = stat.slice(stat.lastIndexOf(")") + 2);
    return after.split(" ")[19];
  } catch {
    return "gone";
  }
}

const OWNER_LABEL = "companion.smoketest.owner";
const OWNER_TOKEN = `${String(process.pid)}:${procStarttime(process.pid)}`;
const CONTAINER_PREFIX = "companion-smoketest-pg-";

/**
 * Reconcile stale left-overs from crashed or killed earlier test processes
 * BEFORE claiming anything (same pattern as the stack supervisor): remove
 * containers whose recorded owner process is gone; never touch containers
 * owned by a live process.
 */
function reconcileStaleSmoketestContainers() {
  let listings = "";
  try {
    listings = docker([
      "ps", "-a",
      "--filter", `label=${OWNER_LABEL}`,
      "--format", "{{.Names}}|{{.Labels}}",
    ]);
  } catch {
    return; // docker unavailable: the individual tests will fail visibly
  }
  for (const line of listings.split("\n").filter((entry) => entry.includes("|"))) {
    const [name, labels] = line.split("|", 2);
    if (!name.startsWith(CONTAINER_PREFIX)) {
      continue;
    }
    const owner = (labels ?? "")
      .split(",")
      .map((pair) => pair.split("=", 2))
      .find(([key]) => key === OWNER_LABEL)?.[1] ?? "";
    const [ownerPid, ownerStarttime] = owner.split(":");
    const ownerAlive = ownerPid !== undefined
      && fs.existsSync(`/proc/${ownerPid}`)
      && procStarttime(Number(ownerPid)) === ownerStarttime;
    if (!ownerAlive) {
      try {
        docker(["rm", "-f", name]);
        console.error(`[smoke-test] removed stale container ${name} (owner ${owner || "unknown"} is gone)`);
      } catch (error) {
        console.error(`[smoke-test] could not remove stale container ${name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
}
reconcileStaleSmoketestContainers();

async function freeTcpPort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/**
 * Start a throwaway PostgreSQL container (loopback-only port, random
 * credentials, unique name), apply the deployed migration's schema, and
 * register removal in the test's finally path. Fails the test visibly if
 * removal fails — no silent orphans.
 */
async function withDisposablePostgres(t, use) {
  const runId = randomUUID().slice(0, 8);
  const containerName = `${CONTAINER_PREFIX}${runId}`;
  const port = await freeTcpPort();
  const dbUser = `smoke_${runId.replace(/-/g, "")}`;
  const dbPassword = randomUUID().replace(/-/g, "");
  const dbName = `smoke_${runId.replace(/-/g, "")}`;
  docker([
    "run", "-d", "--rm", "--name", containerName,
    "--label", `${OWNER_LABEL}=${OWNER_TOKEN}`,
    "-p", `127.0.0.1:${String(port)}:5432`,
    "-e", `POSTGRES_USER=${dbUser}`,
    "-e", `POSTGRES_PASSWORD=${dbPassword}`,
    "-e", `POSTGRES_DB=${dbName}`,
    config.pgImage,
  ]);
  let removed = false;
  const remove = () => {
    if (removed) {
      return "already-removed";
    }
    removed = true;
    docker(["rm", "-f", containerName]);
    return "removed";
  };
  t.after(() => {
    try {
      assert.equal(remove(), "removed", "the throwaway container must be removed");
    } catch (error) {
      assert.fail(`container cleanup failed (leak!): ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  const databaseUrl = `postgres://${dbUser}:${dbPassword}@127.0.0.1:${String(port)}/${dbName}`;
  const deadline = Date.now() + 60_000;
  let client = null;
  while (client === null) {
    const attempt = new pg.Client({ connectionString: databaseUrl });
    try {
      await attempt.connect();
      client = attempt;
    } catch (error) {
      await attempt.end().catch(() => {});
      if (Date.now() > deadline) {
        throw new Error(`disposable postgres never became ready: ${error instanceof Error ? error.message : String(error)}`);
      }
      await sleep(500);
    }
  }
  try {
    await client.query(SCHEMA_SQL);
    await use({ client, databaseUrl });
  } finally {
    await client.end().catch(() => {});
  }
}

async function seedQueuedMessage(client, marker) {
  const result = await client.query(
    "INSERT INTO conversation_message (role, content, client_key) VALUES ('user', $1, $2) RETURNING id",
    [marker, randomUUID()],
  );
  return result.rows[0].id;
}

async function seedCompletedTurn(client, marker, replyNote = "synthetic") {
  const turnId = randomUUID();
  await client.query(
    "INSERT INTO conversation_turn (id, status, lease_owner, lease_expires_at, completed_at) VALUES ($1, 'completed', 'test-worker', now() + interval '30 seconds', now())",
    [turnId],
  );
  const user = await client.query(
    "INSERT INTO conversation_message (role, content, client_key, turn_id) VALUES ('user', $1, $2, $3) RETURNING id",
    [marker, randomUUID(), turnId],
  );
  const reply = await client.query(
    "INSERT INTO conversation_message (role, content, turn_id) VALUES ('assistant', $1, $2) RETURNING id",
    [`fake reply for ${marker.slice(-6)} (${replyNote})`, turnId],
  );
  return { turnId, userId: user.rows[0].id, replyId: reply.rows[0].id };
}

// ---------------------------------------------------------------------------
// Fake kubectl: satisfies the runner's read-only preflight and routes pod
// execs to the REAL generated action script against the disposable DB.
// ---------------------------------------------------------------------------

async function makeKubectlShim({ databaseUrl, gatePort }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "companion-smoke-shim-"));
  const libDir = path.join(repoRoot, "libraries", "postgres");
  fs.writeFileSync(path.join(dir, "pods.json"), JSON.stringify({
    items: [
      {
        metadata: { name: "companion-web-test-0", labels: { "app.kubernetes.io/name": "companion-web" } },
        spec: { containers: [{ image: "localhost:5104/companion/web:test-image" }] },
        status: { containerStatuses: [{ imageID: "localhost:5104/companion/web@sha256:testweb" }] },
      },
      {
        metadata: { name: "companion-worker-test-0", labels: { "app.kubernetes.io/name": "companion-worker" } },
        spec: { containers: [{ image: "localhost:5104/companion/worker:test-image" }] },
        status: { containerStatuses: [{ imageID: "localhost:5104/companion/worker@sha256:testworker" }] },
      },
    ],
  }));
  fs.writeFileSync(path.join(dir, "deploy.json"), JSON.stringify({
    spec: { template: { spec: { containers: [{
      env: [
        { name: "WEB_TEST_GATE_ENABLED", value: "true" },
        { name: "WEB_TEST_GATE_PORT", value: String(gatePort) },
        { name: "COMPANION_DEPLOYMENT_PURPOSE", value: "non-production" },
        { name: "COMPANION_DEPLOYMENT_NAMESPACE", value: "companion-np" },
      ],
    }] } } } },
  ));
  // Pod exec: run the REAL generated script (arriving on stdin) from the
  // postgres workspace directory, exactly like the pod's `sh -c` does.
  fs.writeFileSync(path.join(dir, "kubectl"), `#!/bin/sh
if echo "$*" | grep -q "exec -i"; then
  export WORKER_DATABASE_URL="${databaseUrl}"
  echo "exec" >> "${dir}/actions.log"
  cd "${libDir}" && exec node -
fi
case "$*" in
  *"get namespace"*) echo "namespace/companion-np";;
  *"get pods"*) cat "${dir}/pods.json";;
  *"get deploy"*) cat "${dir}/deploy.json";;
  *"get svc"*) echo '{"items":[]}';;
  *"port-forward"*)
    echo "port-forward" >> "${dir}/actions.log"
    sleep 1
    exit 3
    ;;
  *) echo "unexpected kubectl call: $*" >&2; exit 64;;
esac
`);
  fs.chmodSync(path.join(dir, "kubectl"), 0o755);
  return { dir, actionsLog: path.join(dir, "actions.log") };
}

function spawnRunner(args, env, timeoutMs = 120_000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [RUNNER, ...args], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

function parseEvidence(stdout) {
  const index = stdout.indexOf("EVIDENCE ");
  assert.ok(index !== -1, "the runner must print its EVIDENCE block");
  const rest = stdout.slice(index + "EVIDENCE ".length);
  const cut = rest.indexOf("\n[deployed-smoke]");
  return JSON.parse(cut === -1 ? rest : rest.slice(0, cut));
}

// ---------------------------------------------------------------------------
// 1. Output hygiene
// ---------------------------------------------------------------------------

const MARKER = "e2e-deployed-smoke-20261031T120000Z-abc123";
const REPLY_TEXT = "the real assistant reply text lives here";

test("fingerprint is stable, short, and reveals nothing", () => {
  const fp = fingerprint(MARKER);
  assert.equal(fp, fingerprint(MARKER));
  assert.match(fp, /^[0-9a-f]{12}$/);
  assert.notEqual(fp, fingerprint("different"));
  assert.ok(!fp.includes("abc123"));
});

test("redactText removes every secret occurrence", () => {
  const redacted = redactText([MARKER, REPLY_TEXT], `sent ${MARKER} then ${REPLY_TEXT} end ${MARKER}`);
  assert.ok(!redacted.includes(MARKER));
  assert.ok(!redacted.includes(REPLY_TEXT));
  assert.match(redacted, /^sent \[redacted\] then \[redacted\] end \[redacted\]$/);
  assert.equal(redactText([], "plain"), "plain");
});

test("sanitizeError strips Playwright snapshot lines and matched-locator text", () => {
  const leaky = new Error([
    "locator.waitFor: Timeout exceeded 30000ms",
    `waiting for logConsole.getByText("${MARKER}", { exact: true })`,
    "=========================== snapshot ============================",
    `- log "Conversation":`,
    `  - paragraph: ${REPLY_TEXT} and unrelated real conversation content`,
  ].join("\n"));
  const safe = sanitizeError([MARKER, REPLY_TEXT], leaky, "reply visible as the newest bubble");
  assert.ok(!safe.message.includes(MARKER), "the marker must not leak");
  assert.ok(!safe.message.includes(REPLY_TEXT), "reply content must not leak");
  assert.ok(!safe.message.includes("snapshot"), "no snapshot lines may leak");
  assert.ok(!safe.message.includes("unrelated real conversation"), "no page content may leak");
  assert.match(safe.message, /^reply visible as the newest bubble: Error: locator\.waitFor: Timeout exceeded 30000ms$/);
});

test("sanitizeError redacts secrets that appear on the first line and caps length", () => {
  const leaky = new Error(`connection failed for ${MARKER} ${"x".repeat(1000)}`);
  const safe = sanitizeError([MARKER], leaky, "db probe");
  assert.ok(!safe.message.includes(MARKER));
  assert.ok(safe.message.length <= 400);
});

// ---------------------------------------------------------------------------
// 2. Cleanup decision state machine (retain whenever uncertain)
// ---------------------------------------------------------------------------

test("planCleanupDecision: nothing persisted -> nothing-to-clean", () => {
  const decision = planCleanupDecision({ message: null });
  assert.equal(decision.mode, "nothing-to-clean");
  assert.equal(decision.retain, true);
});

test("planCleanupDecision: queued message -> atomic guarded delete", () => {
  const decision = planCleanupDecision({ message: { id: "m1", turnId: null } });
  assert.equal(decision.mode, "queued-atomic-delete");
});

test("planCleanupDecision: guarded delete deleted the row -> queued-message-deleted", () => {
  const decision = planCleanupDecision({ message: { id: "m1", turnId: null }, nowDeleted: true });
  assert.equal(decision.mode, "queued-message-deleted");
  assert.equal(decision.retain, false);
});

test("planCleanupDecision: guarded delete affected no row while still unassigned -> RETAIN (uncertain)", () => {
  const decision = planCleanupDecision({
    message: { id: "m1", turnId: null },
    deleteOutcome: { rowCount: 0 },
  });
  assert.equal(decision.mode, "retain");
  assert.equal(decision.retain, true);
});

test("planCleanupDecision: unreadable turn row -> RETAIN (no delete)", () => {
  const decision = planCleanupDecision({
    message: { id: "m1", turnId: "t1" },
    turn: null,
  });
  assert.equal(decision.mode, "retain");
  assert.equal(decision.retain, true);
});

test("planCleanupDecision: in-flight turn past the bounded wait -> RETAIN", () => {
  const decision = planCleanupDecision({
    message: { id: "m1", turnId: "t1" },
    turn: { status: "in_flight" },
    settleTimedOut: true,
  });
  assert.equal(decision.mode, "retain");
});

test("planCleanupDecision: shutdown requested while in flight -> RETAIN", () => {
  const decision = planCleanupDecision({
    message: { id: "m1", turnId: "t1" },
    turn: { status: "in_flight" },
    stopRequested: true,
  });
  assert.equal(decision.mode, "retain");
});

test("planCleanupDecision: in-flight turn within the wait -> wait then decide again", () => {
  const decision = planCleanupDecision({
    message: { id: "m1", turnId: "t1" },
    turn: { status: "in_flight" },
  });
  assert.equal(decision.mode, "turn-path");
});

test("planCleanupDecision: settled exclusive turn -> full-turn", () => {
  const decision = planCleanupDecision({
    message: { id: "m1", turnId: "t1" },
    turn: { status: "completed" },
    composition: [{ role: "user", id: "m1" }, { role: "assistant", id: "r1" }],
    ourUserMessageInTurn: true,
  });
  assert.equal(decision.mode, "full-turn");
  assert.equal(decision.retain, false);
});

test("planCleanupDecision: shared turn (second user message) -> only our own row", () => {
  const decision = planCleanupDecision({
    message: { id: "m1", turnId: "t1" },
    turn: { status: "completed" },
    composition: [
      { role: "user", id: "m1" },
      { role: "user", id: "other" },
      { role: "assistant", id: "r1" },
    ],
    ourUserMessageInTurn: true,
  });
  assert.equal(decision.mode, "own-message-only");
  assert.equal(decision.retain, false);
});

test("planCleanupDecision: content proof missing -> only our own row", () => {
  const decision = planCleanupDecision({
    message: { id: "m1", turnId: "t1" },
    turn: { status: "completed" },
    composition: [{ role: "user", id: "m1" }, { role: "assistant", id: "r1" }],
    ourUserMessageInTurn: false,
  });
  assert.equal(decision.mode, "own-message-only");
});

test("planCleanupDecision: unrecognized settled status -> RETAIN", () => {
  const decision = planCleanupDecision({
    message: { id: "m1", turnId: "t1" },
    turn: { status: "publishing" },
    composition: [{ role: "user", id: "m1" }],
    ourUserMessageInTurn: true,
  });
  assert.equal(decision.mode, "retain");
});

// ---------------------------------------------------------------------------
// 3. Statement builders and generated pod-script integrity
// ---------------------------------------------------------------------------

test("the guarded delete carries the atomic turn_id IS NULL predicate", () => {
  const { sql, params } = buildQueuedAtomicDelete("m1", MARKER);
  assert.match(sql, /turn_id IS NULL/);
  assert.match(sql, /content = \$2/);
  assert.deepEqual(params, ["m1", MARKER]);
});

test("the own-message delete is turn-scoped", () => {
  const { sql, params } = buildOwnMessageDelete("m1", MARKER, "t1");
  assert.match(sql, /turn_id = \$3/);
  assert.deepEqual(params, ["m1", MARKER, "t1"]);
});

test("the pod-side script embeds exactly the builder statements (no drift)", () => {
  assert.ok(POD_ACTION_SCRIPT_BODY.includes(buildQueuedAtomicDelete("m1", MARKER).sql));
  assert.ok(POD_ACTION_SCRIPT_BODY.includes(buildOwnMessageDelete("m1", MARKER, "t1").sql));
});

test("generated pod scripts parse for every action and leak no marker into SQL", async (t) => {
  const actions = [
    { action: "preflight", smokePrefix: "e2e-deployed-smoke-" },
    { action: "probe", marker: MARKER },
    { action: "delete-queued", messageId: "m1", marker: MARKER },
    { action: "delete-own-message", messageId: "m1", marker: MARKER, turnId: "t1" },
    { action: "delete-full-turn", turnId: "t1", messageId: "m1", marker: MARKER },
    { action: "post-state", smokePrefix: "e2e-deployed-smoke-" },
  ];
  const { execFileSync } = requireFromPostgresLib("node:child_process");
  for (const payload of actions) {
    const script = buildPodActionScript(payload);
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pod-script-")), "action.mjs");
    fs.writeFileSync(file, script);
    t.after(() => fs.rmSync(path.dirname(file), { recursive: true, force: true }));
    execFileSync(process.execPath, ["--check", file], { timeout: 30_000 });
    // The marker (when present) may appear exactly once — inside the
    // injected JSON constant — proving all SQL is parameterized.
    const occurrences = script.split(MARKER).length - 1;
    assert.equal(occurrences, payload.marker === undefined ? 0 : 1, `marker leakage in ${payload.action}`);
  }
});

test("a hostile marker is safely embedded (injection check) and the script still parses", (t) => {
  const hostile = `x'"; \` \n \\ \${'$'}{injection}`;
  const script = buildPodActionScript({ action: "probe", marker: hostile });
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pod-script-")), "hostile.mjs");
  fs.writeFileSync(file, script);
  t.after(() => fs.rmSync(path.dirname(file), { recursive: true, force: true }));
  const { execFileSync } = requireFromPostgresLib("node:child_process");
  execFileSync(process.execPath, ["--check", file], { timeout: 30_000 });
});

// ---------------------------------------------------------------------------
// 4. Graceful shutdown controller semantics
// ---------------------------------------------------------------------------

test("shutdown controller: first signal is graceful and aborts waitOrStop", async () => {
  const handlers = {};
  const controller = createShutdownController({
    registerSignal: (signal, handler) => { handlers[signal] = handler; },
    onHardExit: () => assert.fail("a single graceful signal must not hard-exit"),
  });
  const requested = controller.request("SIGTERM");
  assert.equal(requested, "graceful");
  assert.equal(controller.requested, true);
  assert.equal(controller.signal, "SIGTERM");
  await assert.rejects(() => controller.waitOrStop(0), (error) => error.name === "StopRequested");
});

test("shutdown controller: waitOrStop resolves while no stop is requested", async () => {
  const controller = createShutdownController({
    registerSignal: () => {},
    onHardExit: () => assert.fail("no signal was sent"),
  });
  const started = Date.now();
  await controller.waitOrStop(30);
  assert.ok(Date.now() - started >= 25);
  assert.equal(controller.requested, false);
});

test("shutdown controller: a loop aborts and the awaited cleanup still runs before exit", async () => {
  const handlers = {};
  let hardExits = 0;
  const controller = createShutdownController({
    registerSignal: (signal, handler) => { handlers[signal] = handler; },
    onHardExit: () => { hardExits += 1; },
  });
  // A stand-in for the journey's polling loop.
  const journeyState = { ticks: 0, aborted: false };
  const journeyLoop = (async () => {
    try {
      for (;;) {
        await controller.waitOrStop(5);
        journeyState.ticks += 1;
      }
    } catch (error) {
      if (error.name === "StopRequested") {
        journeyState.aborted = true;
        return "aborted";
      }
      throw error;
    }
  })();
  // The "cleanup" must run before the process would exit.
  const cleanupState = { ran: false };
  const finish = (async () => {
    await journeyLoop;
    cleanupState.ran = true;
    return cleanupState;
  })();
  assert.equal(controller.request("SIGTERM"), "graceful");
  const state = await finish;
  assert.equal(journeyState.aborted, true, "the journey loop must abort on the stop request");
  assert.equal(state.ran, true, "cleanup must run after the journey aborts");
  assert.equal(hardExits, 0);
  // A second signal insists: hard exit.
  assert.equal(controller.request("SIGTERM"), "hard");
  assert.equal(controller.hardExit, true);
  assert.equal(hardExits, 1);
});

test("buildMarker is unique, prefixed, and never contains characters needing SQL escapes", () => {
  const markers = new Set([buildMarker(), buildMarker(), buildMarker()]);
  assert.equal(markers.size, 3);
  for (const marker of markers) {
    assert.match(marker, /^e2e-deployed-smoke-\d{8}T\d{6}Z-[0-9a-f]{6}$/);
  }
});

// ---------------------------------------------------------------------------
// 5. The delete-vs-claim race (disposable PostgreSQL, real claim semantics)
// ---------------------------------------------------------------------------

const CLAIM_ADVISORY_LOCK_KEY = 918273645511;

/**
 * The worker's claim, faithfully modeled from
 * apps/worker/src/conversation/store.ts (claimNextTurn at 139a172):
 * advisory lock -> pending SELECT … FOR UPDATE -> INSERT turn ->
 * UPDATE … SET turn_id WHERE turn_id IS NULL AND seq = ANY(...).
 */
async function claimOnce(client, { holdLockMs = 0, onLocked = () => {}, rollback = false } = {}) {
  await client.query("BEGIN");
  try {
    await client.query("SELECT pg_advisory_xact_lock($1)", [CLAIM_ADVISORY_LOCK_KEY]);
    const pending = await client.query(
      "SELECT id, seq FROM conversation_message WHERE turn_id IS NULL AND role = 'user' ORDER BY seq FOR UPDATE",
    );
    onLocked(pending.rows);
    if (holdLockMs > 0) {
      await sleep(holdLockMs);
    }
    if (rollback) {
      await client.query("ROLLBACK");
      return { claimed: [] };
    }
    if (pending.rows.length === 0) {
      await client.query("COMMIT");
      return { claimed: [] };
    }
    const turnId = randomUUID();
    await client.query(
      "INSERT INTO conversation_turn (id, lease_owner, lease_expires_at) VALUES ($1, 'test-worker', now() + interval '30 seconds')",
      [turnId],
    );
    await client.query(
      "UPDATE conversation_message SET turn_id = $1 WHERE turn_id IS NULL AND seq = ANY($2::bigint[])",
      [turnId, pending.rows.map((row) => Number(row.seq))],
    );
    await client.query("COMMIT");
    return { claimed: pending.rows.map((row) => row.id), turnId };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  }
}

test("race: the claim holds the row lock first; the guarded delete preserves the claimed row", async (t) => {
  await withDisposablePostgres(t, async ({ client: db, databaseUrl }) => {
    const marker = buildMarker();
    const messageId = await seedQueuedMessage(db, marker);
    const guarded = buildQueuedAtomicDelete(messageId, marker);

    const deleter = new pg.Client({ connectionString: databaseUrl });
    const claimer = new pg.Client({ connectionString: databaseUrl });
    await deleter.connect();
    await claimer.connect();
    try {
      let locked;
      const lockedPromise = new Promise((resolve) => { locked = resolve; });
      const claimPromise = claimOnce(claimer, {
        holdLockMs: 400,
        onLocked: (rows) => {
          assert.equal(rows.length, 1, "the claim must see the queued message");
          locked();
        },
      });
      await lockedPromise;
      // The delete runs while the claim transaction holds the row lock; it
      // must block, re-check after the claim commits, and delete NOTHING.
      const deleteResult = await deleter.query(guarded.sql, guarded.params);
      const claim = await claimPromise;
      assert.equal(deleteResult.rowCount, 0, "the guarded delete must not remove a claimed row");
      const row = (await db.query("SELECT turn_id FROM conversation_message WHERE id = $1", [messageId])).rows[0];
      assert.ok(row, "the message must survive");
      assert.equal(row.turn_id, claim.turnId, "the claim must be intact");
    } finally {
      await deleter.end().catch(() => {});
      await claimer.end().catch(() => {});
    }
  });
});

test("race: the guarded delete wins; the claim never sees the row", async (t) => {
  await withDisposablePostgres(t, async ({ client: db, databaseUrl }) => {
    const marker = buildMarker();
    const messageId = await seedQueuedMessage(db, marker);
    const guarded = buildQueuedAtomicDelete(messageId, marker);

    const deleter = new pg.Client({ connectionString: databaseUrl });
    const claimer = new pg.Client({ connectionString: databaseUrl });
    await deleter.connect();
    await claimer.connect();
    try {
      const deleteResult = await deleter.query(guarded.sql, guarded.params);
      assert.equal(deleteResult.rowCount, 1, "an unassigned row must be deletable");
      // A claim that starts after the delete finds nothing pending.
      const claim = await claimOnce(claimer);
      assert.equal(claim.claimed.length, 0, "the claimed set must not include the deleted row");
      const row = await db.query("SELECT id FROM conversation_message WHERE id = $1", [messageId]);
      assert.equal(row.rowCount, 0, "the message must be gone");
      const turns = await db.query("SELECT count(*)::int AS n FROM conversation_turn");
      assert.equal(turns.rows[0].n, 0, "no turn may be created for a deleted message");
    } finally {
      await deleter.end().catch(() => {});
      await claimer.end().catch(() => {});
    }
  });
});

test("race: the claim commits fully, then the guarded delete preserves the row", async (t) => {
  await withDisposablePostgres(t, async ({ client: db, databaseUrl }) => {
    const marker = buildMarker();
    const messageId = await seedQueuedMessage(db, marker);
    const guarded = buildQueuedAtomicDelete(messageId, marker);

    const deleter = new pg.Client({ connectionString: databaseUrl });
    await deleter.connect();
    try {
      const claim = await claimOnce(deleter);
      assert.equal(claim.claimed.length, 1);
      const deleteResult = await deleter.query(guarded.sql, guarded.params);
      assert.equal(deleteResult.rowCount, 0, "a claimed row must be preserved");
      const row = (await db.query("SELECT turn_id FROM conversation_message WHERE id = $1", [messageId])).rows[0];
      assert.equal(row.turn_id, claim.turnId);
    } finally {
      await deleter.end().catch(() => {});
    }
  });
});

test("race: a claim that locks and rolls back leaves the row deletable", async (t) => {
  await withDisposablePostgres(t, async ({ client: db, databaseUrl }) => {
    const marker = buildMarker();
    const messageId = await seedQueuedMessage(db, marker);
    const guarded = buildQueuedAtomicDelete(messageId, marker);

    const deleter = new pg.Client({ connectionString: databaseUrl });
    const claimer = new pg.Client({ connectionString: databaseUrl });
    await deleter.connect();
    await claimer.connect();
    try {
      let locked;
      const lockedPromise = new Promise((resolve) => { locked = resolve; });
      const claimPromise = claimOnce(claimer, { holdLockMs: 200, rollback: true, onLocked: locked });
      await lockedPromise;
      const deletePromise = deleter.query(guarded.sql, guarded.params);
      await claimPromise;
      const deleteResult = await deletePromise;
      assert.equal(deleteResult.rowCount, 1, "after a rolled-back claim the still-unassigned row is deletable");
    } finally {
      await deleter.end().catch(() => {});
      await claimer.end().catch(() => {});
    }
  });
});

test("full-turn deletion transaction: re-verification rolls back on a composition mismatch", async (t) => {
  await withDisposablePostgres(t, async ({ client: db, databaseUrl }) => {
    const marker = buildMarker();
    const seeded = await seedCompletedTurn(db, marker);
    // Simulate a shared turn: another user's message joined before deletion.
    await db.query(
      "INSERT INTO conversation_message (role, content, client_key, turn_id) VALUES ('user', 'another user message (synthetic)', $1, $2)",
      [randomUUID(), seeded.turnId],
    );
    // The pod-side full-turn action, extracted from the generated script.
    const payload = { action: "delete-full-turn", turnId: seeded.turnId, messageId: seeded.userId, marker };
    const script = buildPodActionScript(payload);
    const result = await runPodScript(databaseUrl, script);
    assert.equal(result.deleted, false, "nothing may be deleted when the composition is not exclusive");
    assert.equal(result.reason, "composition-not-exclusive");
    const remaining = await db.query("SELECT count(*)::int AS n FROM conversation_message WHERE turn_id = $1", [seeded.turnId]);
    assert.equal(remaining.rows[0].n, 3, "all three messages must be retained");
  });
});

test("full-turn deletion transaction: deletes exactly the exclusive turn's rows", async (t) => {
  await withDisposablePostgres(t, async ({ client: db, databaseUrl }) => {
    const marker = buildMarker();
    const seeded = await seedCompletedTurn(db, marker);
    const other = await seedCompletedTurn(db, buildMarker());
    const payload = { action: "delete-full-turn", turnId: seeded.turnId, messageId: seeded.userId, marker };
    const script = buildPodActionScript(payload);
    const result = await runPodScript(databaseUrl, script);
    assert.equal(result.deleted, true);
    assert.equal(result.deletedMessageIds.length, 2);
    assert.equal(result.turn.status, "completed");
    const remainingForTurn = await db.query("SELECT count(*)::int AS n FROM conversation_message WHERE turn_id = $1", [seeded.turnId]);
    assert.equal(remainingForTurn.rows[0].n, 0);
    const turnGone = await db.query("SELECT count(*)::int AS n FROM conversation_turn WHERE id = $1", [seeded.turnId]);
    assert.equal(turnGone.rows[0].n, 0);
    // The unrelated turn is untouched.
    const otherRows = await db.query("SELECT count(*)::int AS n FROM conversation_message WHERE turn_id = $1", [other.turnId]);
    assert.equal(otherRows.rows[0].n, 2);
  });
});

/** Execute a generated pod action script the way the pod would: a node ESM
 * process running from the postgres workspace directory. */
async function runPodScript(databaseUrl, script) {
  const child = spawn(process.execPath, ["--input-type=module"], {
    cwd: path.join(repoRoot, "libraries", "postgres"),
    env: { ...process.env, WORKER_DATABASE_URL: databaseUrl },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  child.stdin.write(script);
  child.stdin.end();
  const code = await new Promise((resolve) => child.on("close", resolve));
  if (code !== 0) {
    assert.fail(`pod script failed (${String(code)}): ${stderr.slice(0, 400)}`);
  }
  const line = stdout.split("\n").find((entry) => entry.startsWith("SMOKE_JSON:"));
  assert.ok(line, "the pod script must emit SMOKE_JSON");
  const out = JSON.parse(line.slice("SMOKE_JSON:".length));
  assert.equal(out.ok, true, `pod action failed: ${out.error ?? "unknown"}`);
  return out;
}

// ---------------------------------------------------------------------------
// 6. Runner-level integration through the fake kubectl (real pod script,
//    disposable DB): recovery, idempotency, graceful signals, SIGKILL trail
// ---------------------------------------------------------------------------

function runnerEnv({ shimDir, gatePort, runsDir }) {
  return {
    PATH: `${shimDir}:${process.env.PATH}`,
    E2E_DEPLOYED_NAMESPACE: "companion-np",
    E2E_DEPLOYED_GATE_PORT: String(gatePort),
    E2E_DEPLOYED_GATE_WAIT_MS: "2000",
    E2E_RUNS_DIR: runsDir,
    E2E_DEPLOYED_SMOKE_ALLOWED: "1",
    E2E_DEPLOYED_SMOKE_EXCLUSIVE_DEV_ACCESS: "1",
    // Make sure no ambient allow-flag leaks into inverse assertions below.
  };
}

test("runner --recover: cleans a seeded queued message atomically, then is an idempotent no-op", async (t) => {
  await withDisposablePostgres(t, async ({ client: db, databaseUrl }) => {
    const marker = buildMarker();
    const messageId = await seedQueuedMessage(db, marker);
    const gatePort = await freeTcpPort();
    const shim = await makeKubectlShim({ databaseUrl, gatePort });
    const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-runs-"));
    t.after(() => fs.rmSync(runsDir, { recursive: true, force: true }));

    const first = await spawnRunner(["--recover", marker], runnerEnv({ shimDir: shim.dir, gatePort, runsDir }));
    assert.equal(first.code, 0, `recover run failed: ${first.stderr}`);
    const evidence = parseEvidence(first.stdout);
    assert.equal(evidence.cleanup.mode, "queued-message-deleted");
    assert.equal(evidence.cleanup.messageDeleted, messageId);
    assert.equal(evidence.postState.smokeRows, 0);
    assert.equal(evidence.exclusivity.acknowledgedByOperator, false, "recovery is not a send: no exclusive-access assertion is implied");
    const gone = await db.query("SELECT count(*)::int AS n FROM conversation_message WHERE id = $1", [messageId]);
    assert.equal(gone.rows[0].n, 0);
    assert.ok(fs.existsSync(shim.actionsLog), "the pod exec must have run");

    const second = await spawnRunner(["--recover", marker], runnerEnv({ shimDir: shim.dir, gatePort, runsDir }));
    assert.equal(second.code, 0, `idempotent recover failed: ${second.stderr}`);
    assert.equal(parseEvidence(second.stdout).cleanup.mode, "nothing-to-clean");
  });
});

test("runner --recover: cleans a seeded completed exclusive turn, leaves unrelated rows, idempotent", async (t) => {
  await withDisposablePostgres(t, async ({ client: db, databaseUrl }) => {
    const marker = buildMarker();
    const seeded = await seedCompletedTurn(db, marker);
    // The unrelated turn models the owner's ordinary (non-synthetic)
    // conversation; the deployed preflight guarantees no OTHER smoke rows.
    const other = await seedCompletedTurn(db, randomUUID(), "unrelated owner conversation (synthetic)");
    const gatePort = await freeTcpPort();
    const shim = await makeKubectlShim({ databaseUrl, gatePort });
    const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-runs-"));
    t.after(() => fs.rmSync(runsDir, { recursive: true, force: true }));

    const first = await spawnRunner(["--recover", marker], runnerEnv({ shimDir: shim.dir, gatePort, runsDir }));
    assert.equal(first.code, 0, `recover run failed: ${first.stderr}`);
    const evidence = parseEvidence(first.stdout);
    assert.equal(evidence.cleanup.mode, "full-turn");
    assert.equal(evidence.cleanup.deletedTurnId, seeded.turnId);
    assert.deepEqual(evidence.cleanup.deletedMessageIds.sort(), [seeded.userId, seeded.replyId].sort());
    assert.equal(evidence.postState.smokeRows, 0);
    assert.equal(evidence.postState.messages, 2, "only the unrelated turn's two messages remain");
    assert.equal(evidence.postState.turns, 1);
    assert.equal(evidence.provider.turn.attempt, 1);

    const second = await spawnRunner(["--recover", marker], runnerEnv({ shimDir: shim.dir, gatePort, runsDir }));
    assert.equal(second.code, 0);
    assert.equal(parseEvidence(second.stdout).cleanup.mode, "nothing-to-clean");
  });
});

test("runner --recover: a shared turn retains the shared data and reports the residual", async (t) => {
  await withDisposablePostgres(t, async ({ client: db, databaseUrl }) => {
    const marker = buildMarker();
    const seeded = await seedCompletedTurn(db, marker);
    await db.query(
      "INSERT INTO conversation_message (role, content, client_key, turn_id) VALUES ('user', 'another user message (synthetic)', $1, $2)",
      [randomUUID(), seeded.turnId],
    );
    const gatePort = await freeTcpPort();
    const shim = await makeKubectlShim({ databaseUrl, gatePort });
    const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-runs-"));
    t.after(() => fs.rmSync(runsDir, { recursive: true, force: true }));

    const result = await spawnRunner(["--recover", marker], runnerEnv({ shimDir: shim.dir, gatePort, runsDir }));
    // A conservative cleanup is deliberate but must be VISIBLE: the run
    // exits non-zero and says exactly what was retained.
    assert.equal(result.code, 1, "a residual retention must be reported as a non-zero outcome");
    assert.match(result.stderr, /conservative cleanup: the turn was not exclusive to this run/);
    const evidence = parseEvidence(result.stdout);
    assert.equal(evidence.cleanup.mode, "own-message-only");
    assert.equal(evidence.cleanup.residualTurnId, seeded.turnId);
    assert.equal(evidence.postState.smokeRows, 0, "our synthetic row is gone");
    const residual = await db.query("SELECT count(*)::int AS n FROM conversation_message WHERE turn_id = $1", [seeded.turnId]);
    assert.equal(residual.rows[0].n, 2, "the shared turn's other data (other user + reply) must be retained");
  });
});

test("runner: SIGTERM during startup aborts gracefully and the awaited cleanup still runs", async (t) => {
  await withDisposablePostgres(t, async ({ client: db, databaseUrl }) => {
    const gatePort = await freeTcpPort();
    const shim = await makeKubectlShim({ databaseUrl, gatePort });
    const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-runs-"));
    t.after(() => fs.rmSync(runsDir, { recursive: true, force: true }));

    const child = spawn(process.execPath, [RUNNER], {
      env: { ...process.env, ...runnerEnv({ shimDir: shim.dir, gatePort, runsDir }) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    // Wait until the marker is persisted (pre-send ownership trail), then
    // send SIGTERM while the (failing) port-forward wait is in progress.
    const markerFile = path.join(runsDir, "deployed-smoke-last-marker.txt");
    const deadline = Date.now() + 30_000;
    while (!fs.existsSync(markerFile) && Date.now() < deadline) {
      await sleep(100);
    }
    assert.ok(fs.existsSync(markerFile), "the marker must be persisted before the send");
    const marker = fs.readFileSync(markerFile, "utf8").trim();
    await sleep(300); // now inside the port-forward wait
    child.kill("SIGTERM");
    const code = await new Promise((resolve) => child.on("close", resolve));
    assert.equal(code, 1, "a graceful stop must exit non-zero");
    const evidence = parseEvidence(stdout);
    assert.equal(evidence.exclusivity.acknowledgedByOperator, true);
    assert.equal(evidence.cleanup.mode, "nothing-to-clean", "nothing was sent, so nothing is cleaned");
    assert.match(stderr, /STOPPED \(SIGTERM\) after awaited cleanup/);
    assert.ok(fs.existsSync(shim.actionsLog) && fs.readFileSync(shim.actionsLog, "utf8").includes("exec"),
      "cleanup must have run (pod exec) after the signal");
    assert.ok(!stdout.includes(marker) && !stderr.includes(marker), "the marker itself must never be printed");
  });
});

test("runner: SIGKILL cannot be handled, but the persisted marker enables verified recovery", async (t) => {
  await withDisposablePostgres(t, async ({ client: db, databaseUrl }) => {
    const gatePort = await freeTcpPort();
    const shim = await makeKubectlShim({ databaseUrl, gatePort });
    const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-runs-"));
    t.after(() => fs.rmSync(runsDir, { recursive: true, force: true }));

    const child = spawn(process.execPath, [RUNNER], {
      env: { ...process.env, ...runnerEnv({ shimDir: shim.dir, gatePort, runsDir }) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const markerFile = path.join(runsDir, "deployed-smoke-last-marker.txt");
    const deadline = Date.now() + 30_000;
    while (!fs.existsSync(markerFile) && Date.now() < deadline) {
      await sleep(100);
    }
    await sleep(200);
    child.kill("SIGKILL");
    const signal = await new Promise((resolve) => child.on("close", (code, sig) => resolve(sig)));
    assert.equal(signal, "SIGKILL", "SIGKILL must terminate the process with no handler");
    assert.ok(fs.existsSync(markerFile), "the ownership trail must survive SIGKILL");

    // The send had already reached the worker before the kill (simulated by
    // seeding the row the worker would have persisted): recovery must find
    // and clean exactly that row, with no provider interaction.
    const marker = fs.readFileSync(markerFile, "utf8").trim();
    const messageId = await seedQueuedMessage(db, marker);
    const recovered = await spawnRunner(["--recover"], runnerEnv({ shimDir: shim.dir, gatePort, runsDir }));
    assert.equal(recovered.code, 0, `recovery failed: ${recovered.stderr}`);
    const evidence = parseEvidence(recovered.stdout);
    assert.equal(evidence.cleanup.mode, "queued-message-deleted");
    assert.equal(evidence.cleanup.messageDeleted, messageId);
    const gone = await db.query("SELECT count(*)::int AS n FROM conversation_message WHERE id = $1", [messageId]);
    assert.equal(gone.rows[0].n, 0);
  });
});

test("runner refuses to run without both explicit authorizations", async () => {
  const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-runs-"));
  try {
    const withoutAllow = await spawnRunner([], { E2E_DEPLOYED_SMOKE_EXCLUSIVE_DEV_ACCESS: "1" }, 30_000);
    assert.notEqual(withoutAllow.code, 0);
    assert.match(withoutAllow.stderr, /E2E_DEPLOYED_SMOKE_ALLOWED=1/);

    const withoutAck = await spawnRunner([], { E2E_DEPLOYED_SMOKE_ALLOWED: "1" }, 30_000);
    assert.notEqual(withoutAck.code, 0);
    assert.match(withoutAck.stderr, /E2E_DEPLOYED_SMOKE_EXCLUSIVE_DEV_ACCESS=1/);
    assert.match(withoutAck.stderr, /cannot enforce|not hard-capped/);
  } finally {
    fs.rmSync(runsDir, { recursive: true, force: true });
  }
});
