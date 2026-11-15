import path from "node:path";
import { fileURLToPath } from "node:url";

const e2eDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const historicalRunsDir = path.join(e2eDir, ".runs");

/** Require an explicitly isolated root; never let a harness sweep shared history. */
export function resolveTaskRunsDir(value = process.env.E2E_RUNS_DIR) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("E2E_RUNS_DIR must name a unique task-owned runs directory");
  }
  const resolved = path.resolve(value);
  const relative = path.relative(historicalRunsDir, resolved);
  const historicalContainsResolved = relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
  const resolvedContainsHistorical = path.relative(resolved, historicalRunsDir);
  const resolvedIsAncestor = resolvedContainsHistorical === "" ||
    (!resolvedContainsHistorical.startsWith(`..${path.sep}`) && resolvedContainsHistorical !== "..");
  if (historicalContainsResolved || resolvedIsAncestor) {
    throw new Error("E2E_RUNS_DIR must not overlap the historical E2E .runs directory");
  }
  return resolved;
}
