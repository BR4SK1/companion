/**
 * Access to the live run's ownership record (written by `stack.mjs`).
 *
 * The specs read the newest recorded run: Playwright starts the supervisor
 * immediately before the tests and tears it down afterwards, so exactly one
 * live record exists while tests run. Used for ports, the postgres container
 * name (DB seeding through `docker exec`), and the worker PID (the
 * connection-failure journey pauses and resumes the worker with signals,
 * verified against the recorded /proc start time first).
 */

import fs from "node:fs";
import path from "node:path";

import { runsDirAbsolute } from "./config.mjs";

let cached = null;

export function loadRunState() {
  if (cached !== null) {
    return cached;
  }
  let entries = [];
  try {
    entries = fs.readdirSync(runsDirAbsolute, { withFileTypes: true });
  } catch {
    throw new Error("no e2e run directory found — is the stack supervisor running?");
  }
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const file = path.join(runsDirAbsolute, entry.name, "state.json");
    try {
      const state = JSON.parse(fs.readFileSync(file, "utf8"));
      candidates.push({ mtime: fs.statSync(file).mtimeMs, state });
    } catch {
      // ignore unreadable records
    }
  }
  if (candidates.length === 0) {
    throw new Error("no run state found — is the stack supervisor running?");
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  cached = candidates[0].state;
  return cached;
}

/** The worker child's {pid, starttime} from the run record. */
export function workerProcess() {
  const state = loadRunState();
  const record = state.children?.worker;
  if (typeof record?.pid !== "number" || typeof record?.starttime !== "string") {
    throw new Error("run state has no worker process record");
  }
  return record;
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

/**
 * Send a signal to the recorded worker process, but only after verifying its
 * identity via the recorded /proc start time (never signal by PID alone).
 */
export function signalWorker(signal) {
  const { pid, starttime } = workerProcess();
  if (procStarttime(pid) !== starttime) {
    throw new Error(
      `worker pid ${String(pid)} no longer matches the recorded identity; refusing to signal`,
    );
  }
  process.kill(pid, signal);
}
