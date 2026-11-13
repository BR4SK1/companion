#!/usr/bin/env node
/**
 * The end-to-end test stack supervisor: a run-owned, disposable, isolated
 * local stack for the Playwright suite.
 *
 * Components, all local and synthetic:
 * - a throwaway PostgreSQL in a dedicated Docker container (loopback-only
 *   port, random database user/password, `--rm` so nothing lingers);
 * - the real worker (`apps/worker`) against that throwaway database with a
 *   fresh random service token, pointed at the local fake provider;
 * - the real web app production build (`apps/web/server.mjs`) with the
 *   non-production-only loopback test gate enabled in explicit
 *   `trusted-local` mode (no Kubernetes indicators exist on a workstation).
 *
 * Ownership and cleanup rules:
 * - The run records everything it creates (its own supervisor PID with the
 *   /proc start time, each child's PID with its /proc start time, and the
 *   container name) in `tests/e2e/.runs/<run-id>/state.json`.
 * - On normal exit, failure, SIGINT, or SIGTERM the supervisor tears its
 *   own stack down completely and removes the ownership record — but only
 *   if every recorded resource is verifiably gone. An incomplete teardown
 *   keeps the record, reports the failure visibly, and exits non-zero, so
 *   the run stays re-cleanable instead of becoming an unattributable orphan.
 * - If a run was interrupted hard (its supervisor was SIGKILLed), the next
 *   run reconciles: a run is cleaned only when its recorded supervisor
 *   identity is verifiably dead (the recorded /proc start time makes PID
 *   reuse detectable). Active runs (a live supervisor — possibly a
 *   concurrent suite on other ports) and unverifiable records are reported
 *   and never touched. Cleanup removes exactly the recorded, run-scheme
 *   container and kills exactly the recorded, identity-verified processes.
 *   No broad cleanup; nothing outside the recorded resources is ever
 *   touched. A partially failed reconciliation keeps the record for retry.
 * - `node stack.mjs clean [--run-id <id>]` performs the same targeted,
 *   identity-checked cleanup on demand, fails visibly when it cannot
 *   finish, and is idempotent: repeated invocations are safe.
 * - Startup reconciles BEFORE checking ports, so a stale run's left-over
 *   port holders are cleaned instead of permanently blocking new runs;
 *   a port that remains busy after that belongs to something this tool
 *   does not own and is refused (no hijacking).
 *
 * Secrets: tokens and passwords are generated per run, kept in this
 * process's environment only, and never logged or written anywhere.
 *
 * Boundaries honored: never touches any real application database (the
 * container is created fresh for the run and destroyed with it), makes no
 * external network calls (the only provider is the local fake), and never
 * deploys or mutates anything outside this run's own resources.
 */

import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { connect, createServer } from "node:net";
import { createWriteStream } from "node:fs";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import process from "node:process";

import { config, repoRoot, runsDirAbsolute } from "./helpers/config.mjs";
import { startFakeProvider } from "./fake-provider.mjs";

const GATE_HOST = "127.0.0.1";

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function log(message) {
  const line = `[stack] ${new Date().toISOString()} ${message}`;
  process.stdout.write(`${line}\n`);
  // Mirror into the current run's directory for post-mortem (stdout is
  // discarded by the runner's web-server plumbing). Synchronous appends on
  // purpose: a teardown that ends in process.exit must not lose its own
  // last lines to stream buffering.
  try {
    if (logPath !== null) {
      fs.appendFileSync(logPath, `${line}\n`);
    }
  } catch {
    // never fail the run because of logging
  }
}

let logPath = null;

function fail(message) {
  process.stderr.write(`[stack] ERROR: ${message}\n`);
  process.exit(1);
}

function randomSecret(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

/** /proc/<pid>/stat field 22 — the kernel's process start time. */
function procStarttime(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${String(pid)}/stat`, "utf8");
    // The comm field may contain spaces/parens; parse after its final ")".
    const after = stat.slice(stat.lastIndexOf(")") + 2);
    const fields = after.split(" ");
    // fields[0] is state (field 3); starttime is field 22 → index 19 here.
    return fields[19];
  } catch {
    return null;
  }
}

function processAlive(pid, expectedStarttime) {
  const starttime = procStarttime(pid);
  return starttime !== null && starttime === expectedStarttime;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** True when a TCP port is free to bind on 127.0.0.1. */
function probePort(port) {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, GATE_HOST, () => {
      server.close(() => resolve(true));
    });
  });
}

function connectPort(port) {
  return new Promise((resolve) => {
    const socket = connect(port, GATE_HOST);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

async function waitForConnect(port, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await connectPort(port)) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what} on port ${String(port)}`);
    }
    await sleep(250);
  }
}

/** HTTP GET resolving with {status, body}; rejects on connection errors. */
function httpGet(url, { headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { headers }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () =>
        resolve({
          status: response.statusCode ?? 0,
          body: Buffer.concat(chunks).toString("utf8"),
        }),
      );
    });
    request.on("error", reject);
    request.setTimeout(5000, () => {
      request.destroy(new Error("timeout"));
    });
  });
}

async function waitForHttp(url, timeoutMs, what, expect) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await httpGet(url);
      if (expect === undefined || expect(response)) {
        return response;
      }
    } catch {
      // not ready yet
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what} at ${url}`);
    }
    await sleep(300);
  }
}

async function assertPortFree(port, what) {
  const free = await probePort(port);
  if (!free) {
    fail(
      `${what} port ${String(port)} is already in use — refusing to start (no port hijacking). ` +
        `If this is a left-over run, clean it with: node tests/e2e/stack.mjs clean`,
    );
  }
}

// ---------------------------------------------------------------------------
// Run state (ownership records)
// ---------------------------------------------------------------------------

function runStatePath(runId) {
  return path.join(runsDirAbsolute, runId, "state.json");
}

function writeState(state) {
  fs.mkdirSync(path.dirname(runStatePath(state.runId)), { recursive: true });
  fs.writeFileSync(runStatePath(state.runId), JSON.stringify(state, null, 2));
}

function readStates() {
  let entries = [];
  try {
    entries = fs.readdirSync(runsDirAbsolute, { withFileTypes: true });
  } catch {
    return { states: [], unreadable: [] };
  }
  const states = [];
  const unreadable = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const file = path.join(runsDirAbsolute, entry.name, "state.json");
    if (!fs.existsSync(file)) {
      // A record-less run directory (post-mortem logs only): its ownership
      // record was already fulfilled and dropped. Nothing to reconcile.
      continue;
    }
    try {
      states.push({ runId: entry.name, state: JSON.parse(fs.readFileSync(file, "utf8")) });
    } catch {
      // Unreadable state: report it and leave it alone (never guess
      // ownership).
      unreadable.push(entry.name);
    }
  }
  return { states, unreadable };
}

// ---------------------------------------------------------------------------
// Targeted cleanup (run-owned resources only)
// ---------------------------------------------------------------------------

function docker(args) {
  return new Promise((resolve) => {
    const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function containerExists(name) {
  const result = await docker([
    "ps", "-a", "--filter", `name=^${name}$`, "--format", "{{.Names}}",
  ]);
  return result.code === 0 && result.stdout.trim() === name;
}

/**
 * Remove a run's container. The outcome is explicit — a failed removal must
 * never be mistaken for "nothing to do", because the ownership record's
 * further handling depends on it.
 */
async function removeContainer(name) {
  if (!(await containerExists(name))) {
    return { present: false, removed: false };
  }
  const result = await docker(["rm", "-f", name]);
  if (result.code === 0) {
    log(`removed container ${name}`);
    return { present: true, removed: true };
  }
  log(`failed to remove container ${name}: ${result.stderr.trim()}`);
  return { present: true, removed: false };
}

/**
 * Stop a recorded child process. The outcome is explicit: "gone" (nothing
 * there — including PID reuse, which the recorded /proc start time detects),
 * "stopped" (verified down after the attempt), "failed" (still alive after
 * SIGKILL), or "unverifiable" (the record lacks a usable identity).
 */
async function killRecordedProcess(record) {
  if (
    typeof record?.pid !== "number" ||
    typeof record?.starttime !== "string"
  ) {
    return "unverifiable";
  }
  if (!processAlive(record.pid, record.starttime)) {
    return "gone";
  }
  log(`stopping left-over process pid=${String(record.pid)} (${record.name ?? "recorded child"})`);
  try {
    process.kill(record.pid, "SIGTERM");
  } catch {
    return "gone";
  }
  for (let waited = 0; waited < 8000; waited += 250) {
    if (!processAlive(record.pid, record.starttime)) {
      return "stopped";
    }
    await sleep(250);
  }
  try {
    process.kill(record.pid, "SIGKILL");
  } catch {
    return "stopped";
  }
  for (let waited = 0; waited < 2000; waited += 100) {
    if (!processAlive(record.pid, record.starttime)) {
      return "stopped";
    }
    await sleep(100);
  }
  return "failed";
}

/**
 * The container name this run owns. Cleanup refuses to remove anything
 * outside this exact run-scoped scheme, so a damaged record can never name
 * an unrelated container.
 */
function expectedContainerName(runId) {
  return `companion-e2e-pg-${runId}`;
}

/**
 * Classify a run record's supervisor. Cleanup may proceed only for "stale"
 * runs: ones whose recorded supervisor process is verifiably gone (the
 * recorded /proc start time detects PID reuse). "active" runs belong to a
 * live supervisor (possibly a concurrent suite run with different ports)
 * and are never touched; "unverifiable" records are never guessed at.
 */
function supervisorStatus(state) {
  const supervisor = state?.supervisor;
  if (
    state === null || typeof state !== "object" ||
    typeof supervisor?.pid !== "number" ||
    typeof supervisor?.starttime !== "string"
  ) {
    return "unverifiable";
  }
  return processAlive(supervisor.pid, supervisor.starttime) ? "active" : "stale";
}

/**
 * Clean exactly the run-owned resources a record describes. The caller owns
 * the decision that the run may be cleaned (verified stale); this function
 * owns honest outcomes: every incomplete removal is reported in
 * `failures`, and the ownership record is kept whenever anything failed so
 * a later retry can finish the job. Resources that were already gone are
 * simply progress, not failures — cleanup is retry-safe and idempotent.
 */
async function cleanupRun({ runId, state }) {
  const failures = [];
  let actions = 0;
  if (state === null || typeof state !== "object" || state.runId !== runId) {
    failures.push("record's run id does not match its directory — record integrity cannot be established");
    return { actions, failures };
  }
  if (typeof state.container !== "string" || state.container !== expectedContainerName(runId)) {
    failures.push(
      `record does not name a run-owned container (expected ${expectedContainerName(runId)})`,
    );
  } else {
    const outcome = await removeContainer(state.container);
    if (outcome.removed) {
      actions += 1;
    } else if (outcome.present) {
      failures.push(`container ${state.container} could not be removed`);
    }
  }
  if (state?.children !== null && typeof state?.children === "object") {
    for (const [name, record] of Object.entries(state.children)) {
      const outcome = await killRecordedProcess({ ...record, name });
      if (outcome === "stopped") {
        actions += 1;
      } else if (outcome === "failed") {
        failures.push(`recorded child ${name} (pid ${String(record?.pid)}) survived SIGKILL`);
      } else if (outcome === "unverifiable") {
        failures.push(`recorded child ${name} has no verifiable process identity`);
      }
      // "gone" needs no action and is not a failure.
    }
  }
  return { actions, failures };
}

/** Remove a run's ownership record (only after verified-complete cleanup). */
function dropRunRecord(runId) {
  try {
    fs.rmSync(path.join(runsDirAbsolute, runId), { recursive: true, force: true });
  } catch (error) {
    log(`could not remove run record ${runId}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Reconcile recorded runs from previous (possibly interrupted) executions.
 * Only runs whose supervisor is verifiably dead are cleaned; active runs
 * (a live supervisor — possibly a concurrent suite on other ports) and
 * unverifiable records are reported and left alone. A cleanup that does not
 * finish keeps the run's ownership record so a later `clean` can retry.
 */
async function reconcileStaleRuns(selfRunId) {
  const { states, unreadable } = readStates();
  for (const runId of unreadable) {
    if (runId === selfRunId) {
      // This run's own directory exists already, but its record is written
      // only after reconciliation.
      continue;
    }
    log(`run record ${runId} is unreadable — not touched (never guess ownership)`);
  }
  for (const { runId, state } of states) {
    if (runId === selfRunId) {
      continue;
    }
    const status = supervisorStatus(state);
    if (status === "active") {
      log(
        `run ${runId} has a live supervisor (pid ${String(state.supervisor.pid)}) — active run, not touched`,
      );
      continue;
    }
    if (status === "unverifiable") {
      log(`run ${runId} has no verifiable supervisor identity — not touched (never guess ownership)`);
      continue;
    }
    const { actions, failures } = await cleanupRun({ runId, state });
    if (failures.length > 0) {
      log(
        `stale run ${runId} cleanup incomplete: ${failures.join("; ")} — ownership record kept for retry`,
      );
      continue;
    }
    if (actions > 0) {
      log(`reconciled stale run ${runId}: ${String(actions)} left-over resource(s) cleaned`);
    } else {
      log(`stale run ${runId} left nothing behind; record removed`);
    }
    dropRunRecord(runId);
  }
}

// ---------------------------------------------------------------------------
// Child process management
// ---------------------------------------------------------------------------

function spawnManaged({ name, command, args, cwd, env, envStrip = [], runDir }) {
  const logFile = createWriteStream(path.join(runDir, `${name}.log`), { flags: "a" });
  const childEnv = { ...process.env, ...env };
  for (const key of envStrip) {
    delete childEnv[key];
  }
  const child = spawn(command, args, {
    cwd,
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.pipe(logFile);
  child.stderr.pipe(logFile);
  child.on("error", (error) => {
    log(`${name} failed to start: ${error instanceof Error ? error.message : String(error)}`);
  });
  return child;
}

// ---------------------------------------------------------------------------
// The stack
// ---------------------------------------------------------------------------

async function up() {
  // Reconciliation must run BEFORE the port checks: a stale run's left-over
  // processes hold the ports, and a port check that hard-fails first would
  // make every later start impossible until someone cleaned up by hand.
  // The run record (and its log) exist from the very beginning so even a
  // startup failure leaves an ownership trail behind.
  const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomBytes(4).toString("hex")}`;
  const runDir = path.join(runsDirAbsolute, runId);
  fs.mkdirSync(runDir, { recursive: true });
  logPath = path.join(runDir, "supervisor.log");

  const ports = [
    ["web main", config.webPort],
    ["web test gate", config.gatePort],
    ["worker api", config.workerPort],
    ["fake provider", config.providerPort],
    ["postgres", config.pgPort],
  ];

  await reconcileStaleRuns(runId);

  // Ports are claimed only after reconciliation; a remaining conflict is
  // genuine (something this tool does not own) and is refused — no port
  // hijacking.
  for (const [what, port] of ports) {
    await assertPortFree(port, what);
  }

  // Fresh synthetic credentials for this run only (never logged, never persisted).
  const workerToken = randomSecret();
  const webSessionSecret = randomSecret();
  const gateSessionSecret = randomSecret();
  const providerKey = randomSecret();
  const dbUser = "companion_e2e";
  const dbPassword = randomSecret();
  const dbName = "companion_e2e";
  const containerName = `companion-e2e-pg-${runId}`;

  const buildId = (() => {
    try {
      return fs.readFileSync(path.join(config.webDir, ".next", "BUILD_ID"), "utf8").trim();
    } catch {
      return null;
    }
  })();

  const state = {
    runId,
    startedAt: new Date().toISOString(),
    supervisor: { pid: process.pid, starttime: procStarttime(process.pid) },
    container: containerName,
    children: {},
    ports: {
      web: config.webPort,
      gate: config.gatePort,
      worker: config.workerPort,
      provider: config.providerPort,
      pg: config.pgPort,
    },
    db: { user: dbUser, database: dbName },
    gitHead: readGitHead(),
    webBuildId: buildId,
  };
  writeState(state);

  let provider = null;
  const children = {};
  let exitStatus = 0;
  let teardownPromise = null;
  /** Set by the first shutdown trigger (signal or parent loss), before its
   * teardown is scheduled — the startup path reads it to recognize that an
   * in-flight readiness race was lost to this supervisor's own teardown,
   * not to a genuine startup failure. */
  let shutdownTrigger = null;

  const teardown = (reason) => {
    // One shared teardown: concurrent shutdown triggers (signal + parent
    // watch) must all await the same completion instead of racing
    // process.exit past an in-flight cleanup.
    //
    // Speed matters: the runner (Playwright) escalates to SIGKILL for a slow
    // webServer teardown, which would cut this cleanup short. The container
    // removal is the critical step, so it happens immediately after the
    // children are signalled — the children hold nothing durable that
    // outlives the container.
    if (teardownPromise !== null) {
      return teardownPromise;
    }
    const run = async () => {
      log(`teardown starting (${reason})`);
      const failures = [];
      // 1. worker first: a graceful stop finishes its in-flight cycle; the
      //    web server and the worker are verified gone below.
      for (const name of ["worker", "web"]) {
        const child = children[name];
        if (child !== undefined && child.exitCode === null && !child.killed) {
          child.kill("SIGTERM");
        }
      }
      // 2. the throwaway database container — the run's cleanup guarantee.
      //    A failed removal is a cleanup failure: the ownership record must
      //    survive it so a later `clean` can retry.
      const containerOutcome = await removeContainer(containerName);
      if (containerOutcome.present && !containerOutcome.removed) {
        failures.push(`container ${containerName} could not be removed`);
      }
      // 3. the in-process fake provider listener.
      if (provider !== null) {
        await provider.close();
      }
      // 4. make sure the children are really gone (they hold no durable
      //    state beyond the container, which is already gone). After a
      //    SIGKILL, wait for the kernel to reap the process before the
      //    verification below — a dying process must not read as a
      //    survivor.
      for (const name of ["worker", "web"]) {
        const child = children[name];
        if (child === undefined || child.exitCode !== null) {
          continue;
        }
        const deadline = Date.now() + 2000;
        while (child.exitCode === null && Date.now() < deadline) {
          await sleep(100);
        }
        if (child.exitCode === null) {
          child.kill("SIGKILL");
          const killDeadline = Date.now() + 2000;
          while (child.exitCode === null && Date.now() < killDeadline) {
            await sleep(50);
          }
        }
      }
      // 5. verify against the recorded identities, not just the child
      //    objects: a process that survives a short grace period keeps the
      //    run's ownership record.
      for (const [name, record] of Object.entries(state.children)) {
        const graceDeadline = Date.now() + 1000;
        while (
          typeof record?.pid === "number" &&
          processAlive(record.pid, record.starttime) &&
          Date.now() < graceDeadline
        ) {
          await sleep(100);
        }
        if (processAlive(record.pid, record.starttime)) {
          failures.push(`child ${name} (pid ${String(record.pid)}) survived teardown`);
        }
      }
      if (failures.length > 0) {
        const detail =
          `teardown incomplete: ${failures.join("; ")} — ownership record kept ` +
          `(retry with: node tests/e2e/stack.mjs clean --run-id ${runId})`;
        process.stderr.write(`[stack] ERROR: ${detail}\n`);
        log(detail);
        throw new Error(detail);
      }
      // Keep the run directory's logs for post-mortem; drop the ownership
      // record: its resources are verifiably gone.
      try {
        fs.rmSync(path.join(runDir, "state.json"), { force: true });
      } catch {
        // best effort
      }
      log("teardown complete");
    };
    teardownPromise = run();
    return teardownPromise;
  };

  const shutdown = (signal) => {
    if (shutdownTrigger === null) {
      shutdownTrigger = signal;
    }
    void teardown(signal).then(
      () => process.exit(exitStatus),
      (error) => {
        log(`teardown failed: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
      },
    );
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGHUP", () => shutdown("SIGHUP"));
  process.on("unhandledRejection", (error) => {
    log(`unhandled rejection: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    exitStatus = 1;
    shutdown("unhandled rejection");
  });
  process.on("uncaughtException", (error) => {
    log(`uncaught exception: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    exitStatus = 1;
    shutdown("uncaught exception");
  });

  // If our parent dies without signalling us (e.g. the runner was SIGKILLed),
  // tear the stack down instead of leaving orphans behind.
  const originalPpid = process.ppid;
  const parentWatch = setInterval(() => {
    if (process.ppid !== originalPpid) {
      clearInterval(parentWatch);
      log("parent process disappeared; tearing down");
      shutdown("parent-exit");
    }
  }, 1000);

  try {
    // 1. Fake provider (in-process).
    provider = startFakeProvider({ port: config.providerPort, expectedBearer: providerKey, log });
    await provider.start();
    log(`fake provider listening on ${GATE_HOST}:${String(config.providerPort)}`);

    // 2. Throwaway PostgreSQL container.
    const runResult = await docker([
      "run", "-d", "--rm",
      "--name", containerName,
      "-p", `${GATE_HOST}:${String(config.pgPort)}:5432`,
      "-e", `POSTGRES_USER=${dbUser}`,
      "-e", `POSTGRES_PASSWORD=${dbPassword}`,
      "-e", `POSTGRES_DB=${dbName}`,
      config.pgImage,
    ]);
    if (runResult.code !== 0) {
      throw new Error(`docker run failed: ${runResult.stderr.trim()}`);
    }
    log(
      `postgres container ${containerName} starting (image ${config.pgImage}, loopback port ${String(config.pgPort)})`,
    );
    // Wait for genuine query readiness: `pg_isready` alone can pass while the
    // server is still finishing first-boot initialization, which would fail
    // the worker's first connection. `SELECT 1` through psql is the real bar.
    const pgDeadline = Date.now() + config.timeouts.postgres;
    for (;;) {
      const ready = await docker([
        "exec", containerName,
        "psql", "-U", dbUser, "-d", dbName, "-tAc", "SELECT 1",
      ]);
      if (ready.code === 0 && ready.stdout.trim() === "1") {
        break;
      }
      if (Date.now() > pgDeadline) {
        throw new Error("postgres container did not become ready in time");
      }
      await sleep(500);
    }
    log("postgres ready (accepts queries)");

    // 3. Worker (real application code) against the throwaway database and
    //    the fake provider; strict configuration, no fallbacks. The first
    //    start applies migrations; below we provision a synthetic test zone
    //    and restart so the worker captures it at startup, as production does.
    const startWorker = () =>
      spawnManaged({
        name: "worker",
        command: "node",
        args: ["--experimental-strip-types", "src/main.ts"],
        cwd: config.workerDir,
        env: {
          WORKER_DATABASE_URL: `postgres://${dbUser}:${dbPassword}@${GATE_HOST}:${String(config.pgPort)}/${dbName}`,
          OPENROUTER_API_KEY: providerKey,
          WORKER_CHAT_MODEL: "e2e-fake-chat-model",
          WORKER_DECISION_MODEL: "e2e-fake-decision-model",
          WORKER_API_TOKEN: workerToken,
          WORKER_HTTP_HOST: GATE_HOST,
          WORKER_HTTP_PORT: String(config.workerPort),
          WORKER_OPENROUTER_CHAT_URL: `http://${GATE_HOST}:${String(config.providerPort)}/api/v1/chat/completions`,
          WORKER_OPENROUTER_DECISIONS_URL: `http://${GATE_HOST}:${String(config.providerPort)}/api/alpha/decisions`,
          WORKER_LEASE_SECONDS: "6",
          WORKER_POLL_SECONDS: "1",
          WORKER_CHAT_TIMEOUT_MS: "15000",
          WORKER_DECISION_TIMEOUT_MS: "10000",
        },
        runDir,
      });
    const recordWorker = () => {
      state.children.worker = {
        pid: children.worker.pid,
        starttime: procStarttime(children.worker.pid),
      };
      writeState(state);
    };
    const waitForWorkerReady = async () => {
      await Promise.race([
        childExitPromise(children.worker, "worker"),
        waitForHttp(
          `${urlOfWorker()}/healthz`,
          config.timeouts.worker,
          "worker /healthz",
          (response) => response.status === 200,
        ),
      ]);
      await Promise.race([
        childExitPromise(children.worker, "worker"),
        waitForHttp(
          `${urlOfWorker()}/readyz`,
          config.timeouts.worker,
          "worker /readyz",
          (response) => response.status === 200,
        ),
      ]);
    };
    children.worker = startWorker();
    recordWorker();
    await waitForWorkerReady();
    log("worker healthy and ready (migrations applied)");

    const configuredZone = await docker([
      "exec", containerName, "psql", "-U", dbUser, "-d", dbName,
      "-tAc",
      `UPDATE companion_time_settings SET timezone = '${config.temporalTimezone}', updated_at = now() WHERE id = true RETURNING timezone;`,
    ]);
    if (configuredZone.code !== 0 || configuredZone.stdout.trim() !== config.temporalTimezone) {
      throw new Error(`could not provision the disposable E2E timezone: ${configuredZone.stderr.trim()}`);
    }
    const firstWorker = children.worker;
    firstWorker.kill("SIGTERM");
    for (let waited = 0; firstWorker.exitCode === null && waited < 100; waited += 1) {
      await sleep(100);
    }
    if (firstWorker.exitCode === null) {
      firstWorker.kill("SIGKILL");
      for (let waited = 0; firstWorker.exitCode === null && waited < 30; waited += 1) {
        await sleep(100);
      }
    }
    if (firstWorker.exitCode === null) {
      throw new Error("initial worker did not stop for the disposable timezone restart");
    }
    children.worker = startWorker();
    recordWorker();
    await waitForWorkerReady();
    log(`worker restarted and captured disposable timezone ${config.temporalTimezone}`);

    // 4. Web production build with the loopback test gate (trusted local).
    if (buildId === null) {
      throw new Error(
        "apps/web has no production build (run `pnpm --filter @companion/web build` first); refusing to serve a dev server",
      );
    }
    children.web = spawnManaged({
      name: "web",
      command: "node",
      args: ["server.mjs"],
      cwd: config.webDir,
      env: {
        PORT: String(config.webPort),
        HOSTNAME: GATE_HOST,
        WEB_PUBLIC_URL: `http://${GATE_HOST}:${String(config.webPort)}`,
        // The test channel never runs the OIDC flow, but the BFF configuration
        // must still be complete and well-formed (fail-closed). These are
        // synthetic placeholder values that are never contacted.
        WEB_OIDC_ISSUER_URL: "https://keycloak.e2e.invalid/realms/companion-e2e",
        WEB_OIDC_CLIENT_ID: "companion-e2e-client",
        WEB_OIDC_CLIENT_SECRET: randomSecret(),
        WEB_SESSION_SECRET: webSessionSecret,
        WEB_OWNER_SUBJECTS: "e2e-synthetic-owner-subject",
        WEB_WORKER_URL: `http://${GATE_HOST}:${String(config.workerPort)}`,
        WEB_WORKER_TOKEN: workerToken,
        WEB_WORKER_TIMEOUT_MS: "2000",
        WEB_TEST_GATE_ENABLED: "true",
        WEB_TEST_GATE_PORT: String(config.gatePort),
        WEB_TEST_GATE_SESSION_SECRET: gateSessionSecret,
        WEB_TEST_GATE_SESSION_TTL_SECONDS: "3600",
        // Explicit local attestation: this is a developer-workstation run,
        // outside Kubernetes, with no chart-injected deployment attestation.
        // The kubelet's context indicators are stripped so the trusted-local
        // path is honestly applicable (they cannot legitimately exist here).
        WEB_TEST_GATE_TRUSTED_LOCAL: "true",
      },
      envStrip: ["KUBERNETES_SERVICE_HOST", "KUBERNETES_SERVICE_PORT"],
      runDir,
    });
    state.children.web = {
      pid: children.web.pid,
      starttime: procStarttime(children.web.pid),
    };
    writeState(state);
    await Promise.race([
      childExitPromise(children.web, "web"),
      waitForConnect(config.webPort, config.timeouts.web, "web main listener"),
    ]);
    await Promise.race([
      childExitPromise(children.web, "web"),
      waitForConnect(config.gatePort, config.timeouts.web, "web test gate"),
    ]);
    // The gate must actually answer (not just accept TCP): any non-server-error
    // HTTP response proves the listener is serving.
    await Promise.race([
      childExitPromise(children.web, "web"),
      waitForHttp(
        urlOfGate() + "/",
        config.timeouts.web,
        "web test gate HTTP response",
        (response) => response.status > 0 && response.status < 500,
      ),
    ]);
    log(
      `web ready: main http://${GATE_HOST}:${String(config.webPort)}, gate http://${GATE_HOST}:${String(config.gatePort)}`,
    );

    log(`stack ready (run ${runId})`);
    // Stay alive until signalled; Playwright polls the gate port.
    await new Promise(() => {});
  } catch (error) {
    if (shutdownTrigger !== null) {
      // A signal- or parent-loss-triggered teardown is already in flight and
      // killed a child whose readiness this startup path was still awaiting
      // (or the readiness wait will time out against the shutdown). Losing
      // that race to our own teardown is not a startup failure: the shutdown
      // path owns the exit status (0 after a verified-complete teardown, 1
      // when the teardown itself fails). Do not reclassify and do not exit
      // here — the pending shutdown() completion exits the process.
      log(`startup interrupted by ${shutdownTrigger}; teardown already in progress`);
      return;
    }
    exitStatus = 1;
    log(`startup failed: ${error instanceof Error ? error.message : String(error)}`);
    try {
      await teardown("startup failure");
    } catch (teardownError) {
      log(
        `teardown after startup failure also failed: ${teardownError instanceof Error ? teardownError.message : String(teardownError)}`,
      );
    }
    process.exit(exitStatus);
  }
}

function readGitHead() {
  try {
    const head = fs.readFileSync(path.join(repoRoot, ".git", "HEAD"), "utf8").trim();
    if (head.startsWith("ref: ")) {
      const ref = head.slice(5).trim();
      try {
        return fs.readFileSync(path.join(repoRoot, ".git", ref), "utf8").trim();
      } catch {
        return head;
      }
    }
    return head;
  } catch {
    return null;
  }
}

function urlOfWorker() {
  return `http://${GATE_HOST}:${String(config.workerPort)}`;
}

function urlOfGate() {
  return `http://${GATE_HOST}:${String(config.gatePort)}`;
}

/**
 * Rejects if the managed child exits before the awaited readiness condition
 * holds, so startup fails fast with the child's own exit code instead of
 * waiting out the whole readiness timeout.
 */
function childExitPromise(child, name) {
  return new Promise((_, reject) => {
    child.once("exit", (code, signal) => {
      reject(
        new Error(
          `${name} exited before becoming ready (code=${String(code)}, signal=${String(signal)}); see the run's ${name}.log`,
        ),
      );
    });
  });
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const command = process.argv[2] ?? "up";

if (command === "up") {
  await up();
} else if (command === "clean") {
  const runIdIndex = process.argv.indexOf("--run-id");
  const onlyRunId = runIdIndex >= 0 ? process.argv[runIdIndex + 1] : undefined;
  if (onlyRunId !== undefined && (onlyRunId === undefined || onlyRunId.startsWith("-"))) {
    fail("clean --run-id requires a run id");
  }
  const { states, unreadable } = readStates();
  let cleaned = 0;
  let incomplete = 0;
  let skipped = 0;
  let matched = 0;
  for (const unreadableRunId of unreadable) {
    if (onlyRunId !== undefined && unreadableRunId !== onlyRunId) {
      continue;
    }
    matched += 1;
    log(`run record ${unreadableRunId} is unreadable — not touched (never guess ownership)`);
  }
  for (const { runId, state } of states) {
    if (onlyRunId !== undefined && runId !== onlyRunId) {
      continue;
    }
    matched += 1;
    const status = supervisorStatus(state);
    if (status === "active") {
      log(
        `run ${runId} is active (live supervisor, pid ${String(state.supervisor?.pid)}) — not touched; ` +
          "its own supervisor owns its cleanup",
      );
      skipped += 1;
      continue;
    }
    if (status === "unverifiable") {
      log(`run ${runId} has no verifiable supervisor identity — not touched (never guess ownership)`);
      skipped += 1;
      continue;
    }
    const { actions, failures } = await cleanupRun({ runId, state });
    if (failures.length > 0) {
      incomplete += 1;
      process.stderr.write(
        `[stack] ERROR: cleanup of run ${runId} incomplete: ${failures.join("; ")} — ` +
          "ownership record kept for retry\n",
      );
      continue;
    }
    cleaned += actions;
    dropRunRecord(runId);
    log(`run ${runId} cleaned (${String(actions)} resource(s) this attempt); record removed`);
  }
  if (onlyRunId !== undefined && matched === 0) {
    log(`no recorded run ${onlyRunId}; nothing to clean`);
  }
  log(
    `clean finished: ${String(cleaned)} resource(s) removed, ` +
      `${String(incomplete)} incomplete, ${String(skipped)} skipped (active or unverifiable)`,
  );
  if (incomplete > 0) {
    process.exit(1);
  }
} else {
  fail(`unknown command: ${command} (use "up" or "clean")`);
}
