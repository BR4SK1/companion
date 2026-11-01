/**
 * Behavioral tests for the run-owned stack supervisor itself (`stack.mjs`).
 *
 * These are plain `node:test` files (run with `pnpm --filter @companion/e2e
 * test:stack`), not Playwright specs — they live outside the Playwright
 * `testDir` on purpose and drive real stacks (throwaway container, worker,
 * web production build, fake provider) exclusively against local synthetic
 * resources. They demonstrate:
 *
 * - a completed teardown removes the ownership record, and `clean` after
 *   that is an idempotent no-op;
 * - a failed container removal fails visibly and KEEPS the ownership
 *   record, and a retry finishes the job (idempotent, record removed);
 * - cleanup never touches an active run (a live supervisor — possibly a
 *   concurrent suite on other ports) or an unverifiable record, and cleans
 *   only verified-stale runs' securely identified resources;
 * - startup reconciles stale left-overs BEFORE claiming ports, so stale
 *   port holders cannot block every later start;
 * - a supervisor whose parent disappears tears its own stack down
 *   (interruption cleanup), and an explicit SIGTERM does the same.
 *
 * Like the Playwright suite, this file never touches a real deployed
 * database and makes no model-provider calls beyond the local fake.
 */

import { execSync, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import { connect } from "node:net";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import assert from "node:assert/strict";

import { config, e2eDir, runsDirAbsolute } from "./helpers/config.mjs";

/** Alternative port set for a second, concurrent run under test. */
const PORTS_B = {
  E2E_WEB_PORT: "4630",
  E2E_WEB_GATE_PORT: "4631",
  E2E_WORKER_PORT: "4632",
  E2E_PROVIDER_PORT: "4633",
  E2E_PG_PORT: "4634",
};
const GATE_B = Number(PORTS_B.E2E_WEB_GATE_PORT);

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function procStarttime(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${String(pid)}/stat`, "utf8");
    const after = stat.slice(stat.lastIndexOf(")") + 2);
    return after.split(" ")[19];
  } catch {
    return null;
  }
}

function processAlive(pid, expectedStarttime) {
  const starttime = procStarttime(pid);
  return starttime !== null && starttime === expectedStarttime;
}

function httpStatus(port, requestPath = "/") {
  return new Promise((resolve) => {
    const request = http.get(`http://127.0.0.1:${String(port)}${requestPath}`, (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    request.on("error", () => resolve(0));
    request.setTimeout(2000, () => {
      request.destroy();
      resolve(0);
    });
  });
}

async function waitForGate(gatePort, timeoutMs = 120_000, what = "gate") {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = await httpStatus(gatePort);
    if (status > 0 && status < 500) {
      return status;
    }
    if (Date.now() > deadline) {
      assert.fail(`${what} on port ${String(gatePort)} did not become ready`);
    }
    await sleep(300);
  }
}

function portBusy(port) {
  return new Promise((resolve) => {
    const socket = connect(port, "127.0.0.1");
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

async function e2eContainers() {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", ["ps", "-a", "--filter", "name=companion-e2e-", "--format", "{{.Names}}"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error("docker ps failed"));
        return;
      }
      resolve(stdout.split("\n").map((line) => line.trim()).filter((line) => line.length > 0));
    });
  });
}

async function containerExists(name) {
  return (await e2eContainers()).includes(name);
}

async function waitForContainerState(name, present, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if ((await containerExists(name)) === present) {
      return;
    }
    if (Date.now() > deadline) {
      assert.fail(`container ${name} did not ${present ? "appear" : "disappear"} in time`);
    }
    await sleep(300);
  }
}

function runStates() {
  const states = [];
  let entries = [];
  try {
    entries = fs.readdirSync(runsDirAbsolute, { withFileTypes: true });
  } catch {
    return states;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const file = path.join(runsDirAbsolute, entry.name, "state.json");
    try {
      states.push({ runId: entry.name, state: JSON.parse(fs.readFileSync(file, "utf8")) });
    } catch {
      // unreadable records are reported by the code under test
    }
  }
  return states;
}

function runStateExists(runId) {
  return fs.existsSync(path.join(runsDirAbsolute, runId, "state.json"));
}

function runIdByGatePort(gatePort) {
  const matches = runStates().filter(({ state }) => state?.ports?.gate === gatePort);
  assert.equal(matches.length, 1, `expected exactly one run on gate port ${String(gatePort)}`);
  return matches[0];
}

function runStackCli(args, { env = {}, timeoutMs = 90_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn("node", ["stack.mjs", ...args], {
      cwd: e2eDir,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

const liveSupervisors = [];

function spawnSupervisor(env = {}) {
  const child = spawn("node", ["stack.mjs", "up"], {
    cwd: e2eDir,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  liveSupervisors.push({ child, output: () => output });
  return { child, output: () => output };
}

async function stopSupervisor({ child }, { signal = "SIGTERM", timeoutMs = 30_000 } = {}) {
  if (child.exitCode !== null) {
    return;
  }
  child.kill(signal);
  const deadline = Date.now() + timeoutMs;
  while (child.exitCode === null && Date.now() < deadline) {
    await sleep(200);
  }
  if (child.exitCode === null) {
    child.kill("SIGKILL");
  }
  await sleep(200);
}

/**
 * A `docker` shim that refuses to remove run-owned containers but passes
 * everything else through to the real binary — a controlled fault injection
 * for the failed-cleanup path, without touching the code under test.
 */
function makeDockerShim(dir) {
  const realDocker = execSync("command -v docker", { shell: "/bin/sh" }).toString().trim();
  fs.mkdirSync(dir, { recursive: true });
  const shim = path.join(dir, "docker");
  const script = [
    "#!/bin/sh",
    'for arg in "$@"; do',
    '  case "$arg" in',
    "    companion-e2e-*)",
    '      if [ "$1" = "rm" ]; then',
    '        echo "shim: refusing to remove $arg" >&2',
    "        exit 1",
    "      fi",
    "      ;;",
    "  esac",
    "done",
    `exec ${JSON.stringify(realDocker)} "$@"`,
    "",
  ].join("\n");
  fs.writeFileSync(shim, script, { mode: 0o755 });
  return dir;
}

// ---------------------------------------------------------------------------
// Suite-wide setup and teardown
// ---------------------------------------------------------------------------

test.before(async () => {
  const buildId = path.join(config.webDir, ".next", "BUILD_ID");
  assert.ok(fs.existsSync(buildId), "apps/web has no production build; run `pnpm --filter @companion/web build` first");
  // Start from a known slate: clean only touches verified-stale runs.
  const preface = await runStackCli(["clean"]);
  assert.equal(preface.code, 0, `preflight clean failed: ${preface.stderr}`);
  const remaining = await e2eContainers();
  assert.deepEqual(
    remaining,
    [],
    `an e2e stack is already running (containers: ${remaining.join(", ")}); stop it before running these tests`,
  );
});

test.after(async () => {
  for (const supervisor of liveSupervisors.splice(0)) {
    await stopSupervisor(supervisor, { timeoutMs: 20_000 });
  }
  await runStackCli(["clean"]);
  const remaining = await e2eContainers();
  assert.deepEqual(remaining, [], `tests left containers behind: ${remaining.join(", ")}`);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("a completed teardown removes the ownership record, and clean is an idempotent no-op", async (t) => {
  const supervisor = spawnSupervisor();
  t.after(() => stopSupervisor(supervisor));
  await waitForGate(config.gatePort);
  const { runId, state } = runIdByGatePort(config.gatePort);
  assert.equal(state.container, `companion-e2e-pg-${runId}`);
  assert.ok(await containerExists(state.container), "the run's container should exist while active");

  await stopSupervisor(supervisor);
  await waitForContainerState(state.container, false);
  assert.equal(runStateExists(runId), false, "a completed teardown drops the ownership record");
  assert.equal(await portBusy(config.gatePort), false, "the gate port is released");

  const first = await runStackCli(["clean"]);
  assert.equal(first.code, 0, `clean after a completed teardown should succeed: ${first.stderr}`);
  const second = await runStackCli(["clean"]);
  assert.equal(second.code, 0, "a second clean must stay idempotent");
  assert.match(second.stdout, /clean finished/);
  assert.deepEqual(await e2eContainers(), [], "no containers may remain after cleaning twice");
});

test("a failed container removal fails visibly, keeps the ownership record, and a retry finishes the job", async (t) => {
  const supervisor = spawnSupervisor();
  t.after(() => stopSupervisor(supervisor, { timeoutMs: 5_000 }));
  await waitForGate(config.gatePort);
  const { runId, state } = runIdByGatePort(config.gatePort);

  // Simulate a hard interruption: the supervisor dies without cleaning up.
  supervisor.child.kill("SIGKILL");
  await sleep(300);
  assert.equal(runStateExists(runId), true, "an interrupted run keeps its ownership record");
  assert.ok(await containerExists(state.container), "the interrupted run leaves its container behind");

  // Cleanup attempt with docker unable to remove the container.
  const shimDir = makeDockerShim(path.join("/tmp/opencode", `e2e-docker-shim-${String(process.pid)}`));
  t.after(() => fs.rmSync(shimDir, { recursive: true, force: true }));
  const blocked = await runStackCli(["clean", "--run-id", runId], {
    env: { PATH: `${shimDir}:${String(process.env.PATH)}` },
  });
  assert.notEqual(blocked.code, 0, "cleanup must fail visibly when it cannot finish");
  assert.match(blocked.stderr, /could not be removed/, "the failure must name the unfinished resource");
  assert.match(blocked.stderr, /ownership record kept/, "the failure must say the record was kept");
  assert.equal(runStateExists(runId), true, "an incomplete cleanup must NOT drop the ownership record");
  assert.ok(await containerExists(state.container), "the container survives the blocked attempt");
  for (const [name, record] of Object.entries(state.children ?? {})) {
    assert.equal(
      processAlive(record.pid, record.starttime),
      false,
      `recorded child ${name} is still stopped by the blocked attempt (partial progress is real progress)`,
    );
  }

  // Retry with real docker: the same record completes the job.
  const retry = await runStackCli(["clean", "--run-id", runId]);
  assert.equal(retry.code, 0, `the retry must succeed: ${retry.stderr}`);
  assert.equal(await containerExists(state.container), false, "the retry removes the container");
  assert.equal(runStateExists(runId), false, "the retry drops the fulfilled ownership record");
  assert.deepEqual(await e2eContainers(), []);
});

test("cleanup never touches an active run or an unverifiable record, and cleans only verified-stale runs", async (t) => {
  // Run A: active on the default ports for the whole test.
  const active = spawnSupervisor();
  t.after(() => stopSupervisor(active));
  await waitForGate(config.gatePort);
  const activeRun = runIdByGatePort(config.gatePort);

  // Run B: a second, concurrent run on distinct ports — then killed hard, so
  // it is stale with left-overs.
  const doomed = spawnSupervisor(PORTS_B);
  await waitForGate(GATE_B);
  const doomedRun = runIdByGatePort(GATE_B);
  doomed.child.kill("SIGKILL");
  await sleep(300);

  // Unverifiable records must be reported and preserved, never guessed at.
  const bogusCorrupt = path.join(runsDirAbsolute, "bogus-corrupt");
  const bogusNoIdentity = path.join(runsDirAbsolute, "bogus-no-identity");
  fs.mkdirSync(bogusCorrupt, { recursive: true });
  fs.writeFileSync(path.join(bogusCorrupt, "state.json"), "{not json");
  fs.mkdirSync(bogusNoIdentity, { recursive: true });
  fs.writeFileSync(path.join(bogusNoIdentity, "state.json"), JSON.stringify({ note: "no supervisor identity" }));
  t.after(() => {
    for (const dir of [bogusCorrupt, bogusNoIdentity]) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  const result = await runStackCli(["clean"]);
  assert.equal(result.code, 0, `clean should succeed (only skipped runs remain): ${result.stderr}`);
  assert.match(result.stdout, new RegExp(`run ${activeRun.runId} is active`));
  assert.match(result.stdout, /bogus-corrupt/);
  assert.match(result.stdout, /bogus-no-identity/);

  // The active run is untouched: container, supervisor, and children alive.
  assert.ok(await containerExists(activeRun.state.container), "an active run's container must survive");
  assert.equal(
    processAlive(activeRun.state.supervisor.pid, activeRun.state.supervisor.starttime),
    true,
    "an active run's supervisor must survive another run's cleanup",
  );
  for (const [name, record] of Object.entries(activeRun.state.children ?? {})) {
    assert.equal(
      processAlive(record.pid, record.starttime),
      true,
      `an active run's child ${name} must survive another run's cleanup`,
    );
  }
  const gateStatus = await httpStatus(config.gatePort);
  assert.ok(gateStatus > 0 && gateStatus < 500, "an active run's gate must keep serving");

  // The verified-stale run is cleaned: container and recorded children gone.
  assert.equal(await containerExists(doomedRun.state.container), false, "a stale run's container must be removed");
  assert.equal(runStateExists(doomedRun.runId), false, "a cleaned stale run's record is removed");
  for (const [name, record] of Object.entries(doomedRun.state.children ?? {})) {
    assert.equal(
      processAlive(record.pid, record.starttime),
      false,
      `a stale run's recorded child ${name} must be stopped`,
    );
  }
  // Unverifiable records are preserved.
  assert.equal(fs.existsSync(path.join(bogusCorrupt, "state.json")), true);
  assert.equal(fs.existsSync(path.join(bogusNoIdentity, "state.json")), true);
});

test("startup reconciles stale left-overs before claiming ports", async (t) => {
  // A stale run holds every default port: its supervisor is killed hard so
  // worker, web, and container keep running unowned.
  const stale = spawnSupervisor();
  t.after(() => stopSupervisor(stale, { timeoutMs: 5_000 }));
  await waitForGate(config.gatePort);
  const staleRun = runIdByGatePort(config.gatePort);
  stale.child.kill("SIGKILL");
  await sleep(300);
  assert.equal(await portBusy(config.gatePort), true, "the stale run's left-over web still holds the gate port");

  // A new run on the same ports must reconcile first, then start. Wait for
  // the reconciliation to complete (the stale record is fulfilled and
  // removed) before reading the fresh run's record: until then the stale
  // stack is still serving, and a gate probe would answer from it.
  const fresh = spawnSupervisor();
  t.after(() => stopSupervisor(fresh));
  const reconcileDeadline = Date.now() + 90_000;
  while (runStateExists(staleRun.runId) && Date.now() < reconcileDeadline) {
    await sleep(300);
  }
  assert.equal(
    runStateExists(staleRun.runId),
    false,
    "startup reconciliation must fulfill the stale run's record",
  );
  assert.equal(await containerExists(staleRun.state.container), false, "reconciliation removed the stale container");
  await waitForGate(config.gatePort, 120_000);
  const freshRun = runIdByGatePort(config.gatePort);
  assert.notEqual(
    freshRun.runId,
    staleRun.runId,
    "the new run must be a fresh one (the stale record was reconciled away)",
  );
  assert.equal(runStateExists(staleRun.runId), false, "reconciliation removed the fulfilled stale record");

  await stopSupervisor(fresh);
  await waitForContainerState(freshRun.state.container, false);
});

test("a supervisor whose parent disappears tears its stack down (interruption cleanup)", async (t) => {
  // The runner starts the supervisor as its own child, waits for readiness,
  // and exits — orphaning the supervisor, whose parent-death watch must
  // clean everything up without any external signal.
  const runnerPath = path.join("/tmp/opencode", `e2e-parent-exit-runner-${String(process.pid)}.mjs`);
  fs.writeFileSync(
    runnerPath,
    [
      'import { spawn } from "node:child_process";',
      'import http from "node:http";',
      "const [, , e2eDir, gatePort] = process.argv;",
      'const child = spawn("node", ["stack.mjs", "up"], { cwd: e2eDir, stdio: "ignore" });',
      "const deadline = Date.now() + 120_000;",
      "for (;;) {",
      "  const status = await new Promise((resolve) => {",
      "    const request = http.get(`http://127.0.0.1:${gatePort}/`, (response) => {",
      "      response.resume();",
      "      resolve(response.statusCode ?? 0);",
      "    });",
      '    request.on("error", () => resolve(0));',
      "    request.setTimeout(1000, () => request.destroy());",
      "  });",
      "  if (status > 0 && status < 500) break;",
      "  if (Date.now() > deadline) process.exit(3);",
      "  await new Promise((resolve) => setTimeout(resolve, 300));",
      "}",
      "process.exit(0);",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  t.after(() => fs.rmSync(runnerPath, { force: true }));

  const runner = spawn("node", [runnerPath, e2eDir, String(config.gatePort)], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  let runnerStderr = "";
  runner.stderr.on("data", (chunk) => (runnerStderr += chunk));
  t.after(() => {
    if (runner.exitCode === null) {
      runner.kill("SIGKILL");
    }
  });

  // Wait for the run to appear, then for the runner to leave.
  const deadline = Date.now() + 150_000;
  let run;
  for (;;) {
    const candidates = runStates().filter(({ state }) => state?.ports?.gate === config.gatePort);
    if (candidates.length === 1) {
      run = candidates[0];
      break;
    }
    if (Date.now() > deadline) {
      assert.fail(`the orphaned-supervisor run never appeared; runner stderr: ${runnerStderr}`);
    }
    await sleep(300);
  }
  await waitForContainerState(run.state.container, true);
  const runnerExit = new Promise((resolve) => runner.once("exit", (code) => resolve(code)));
  const exitCode = await Promise.race([runnerExit, sleep(60_000).then(() => null)]);
  assert.notEqual(exitCode, null, "the runner never exited");
  assert.equal(exitCode, 0, `the runner failed to confirm readiness: ${runnerStderr}`);

  // The supervisor must notice the parent loss and clean up on its own.
  await waitForContainerState(run.state.container, false, 45_000);
  assert.equal(runStateExists(run.runId), false, "self-cleanup drops the ownership record");
  assert.equal(await portBusy(config.gatePort), false, "self-cleanup releases the gate port");
  const supervisorLog = fs.readFileSync(path.join(runsDirAbsolute, run.runId, "supervisor.log"), "utf8");
  assert.match(supervisorLog, /parent process disappeared; tearing down/);
  assert.match(supervisorLog, /teardown complete/);
});

test("an explicit SIGTERM tears a detached stack down (the runner's teardown path)", async (t) => {
  const supervisor = spawnSupervisor();
  await waitForGate(config.gatePort);
  const { runId, state } = runIdByGatePort(config.gatePort);

  // Detach the supervisor from the test process so teardown is driven purely
  // by the signal, not by parent-death.
  const exitCode = await Promise.race([
    new Promise((resolve) => {
      supervisor.child.once("exit", resolve);
      supervisor.child.kill("SIGTERM");
    }),
    sleep(30_000).then(() => null),
  ]);
  assert.notEqual(
    exitCode,
    null,
    `the supervisor did not exit on SIGTERM\n[supervisor output]\n${supervisor.output()}`,
  );
  assert.equal(
    exitCode,
    0,
    `a successful teardown exits cleanly\n[supervisor output]\n${supervisor.output()}`,
  );
  await waitForContainerState(state.container, false);
  assert.equal(runStateExists(runId), false);
  assert.equal(await portBusy(config.gatePort), false);
});
