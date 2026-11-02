/**
 * Memory operations CLI: canonical observation inspection and the canonical
 * policy review (plan, then token-confirmed apply).
 *
 * Unlike `cli.ts` (which only ever reads), the review's `--execute` step
 * writes: it applies a policy review plan and retracts the canonical
 * observations the policy no longer supports. The write is always an
 * explicit, two-step act — a dry run prints the plan with its confirmation
 * token, and applying requires that exact token, so the plan an operator
 * saw is the plan that is applied (state drift changes the token). No
 * scheduler or runtime path invokes this; it is operator tooling.
 *
 * Requires `WORKER_DATABASE_URL` only; no provider credentials.
 */

import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";

import {
  closePostgresPool,
  createPostgresPool,
} from "@companion/postgres";

import {
  buildCanonicalReviewPlan,
  reviewCanonicalObservations,
  type CanonicalReviewPlanInput,
} from "./memory/review.ts";
import {
  getAllCanonicalObservations,
  getCanonicalObservationsByIds,
} from "./memory/promotion.ts";
import { loadMemoryBehavior } from "./memory/subjects.ts";
import { loadMemoryConfig } from "./memory/config.ts";
import {
  runRecallEval,
  validateEvalCorpus,
  EvalCorpusError,
  type EvalCorpus,
} from "./memory/eval.ts";

export function printUsage(): void {
  console.log("Usage: node src/memory-cli.ts <command> [options]");
  console.log("");
  console.log("Commands:");
  console.log("  observations [--all | --active | --id <canonicalId>]...");
  console.log("      Inspect canonical observations (status, evidence, retraction state).");
  console.log("  review [--id <canonicalId>]... | --all-active");
  console.log("          [--allow-single-turn-reviewed --reviewed-id <id> --reviewed-by <who>");
  console.log("           --review-note <note>]");
  console.log("          [--execute --confirm-token <token>]");
  console.log("  report [--since=YYYY-MM-DD]");
  console.log("      Read-only automation report (metadata only): memory operations");
  console.log("      by kind/outcome in the window, promotion manifest and item");
  console.log("      outcomes, consolidation runs, and canonical state counts.");
  console.log("      Default window starts 7 days ago (UTC).");
  console.log("  recall-eval [--corpus <path>] [--k <n>]");
  console.log("      Recall-ranking evaluation (recall@k, precision@k, MRR, temporal");
  console.log("      violations) over a synthetic generic corpus. WRITES evaluation");
  console.log("      rows and removes them afterwards, so it requires the disposable");
  console.log("      test database (WORKER_TEST_DATABASE_URL) and refuses");
  console.log("      WORKER_DATABASE_URL; memory_behavior must be provisioned.");
  console.log("      Thresholds: MEMORY_EVAL_RECALL_MIN (0.6),");
  console.log("      MEMORY_EVAL_PRECISION_MIN (0.5), MEMORY_EVAL_MRR_MIN (0.5).");
  console.log("      Build the canonical policy review plan (dry run by default). With");
  console.log("      --execute, apply the plan after verifying --confirm-token matches the");
  console.log("      plan's token (copy it from the dry run).");
  console.log("");
  console.log("Requires WORKER_DATABASE_URL in the environment (recall-eval:");
  console.log("WORKER_TEST_DATABASE_URL).");
}

interface ParsedArgs {
  readonly command: string | undefined;
  readonly ids: string[];
  readonly allActive: boolean;
  readonly activeOnly: boolean;
  readonly allowSingleTurnReviewed: boolean;
  readonly reviewedIds: string[];
  readonly reviewedBy: string | undefined;
  readonly reviewNote: string | undefined;
  readonly execute: boolean;
  readonly confirmToken: string | undefined;
  readonly since: string | undefined;
  readonly corpus: string | undefined;
  readonly k: number | undefined;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const parsed: {
    command: string | undefined;
    ids: string[];
    allActive: boolean;
    activeOnly: boolean;
    allowSingleTurnReviewed: boolean;
    reviewedIds: string[];
    reviewedBy: string | undefined;
    reviewNote: string | undefined;
    execute: boolean;
    confirmToken: string | undefined;
    since: string | undefined;
    corpus: string | undefined;
    k: number | undefined;
  } = {
    command: undefined,
    ids: [],
    allActive: false,
    activeOnly: false,
    allowSingleTurnReviewed: false,
    reviewedIds: [],
    reviewedBy: undefined,
    reviewNote: undefined,
    execute: false,
    confirmToken: undefined,
    since: undefined,
    corpus: undefined,
    k: undefined,
  };
  parsed.command = argv[0];
  let index = 1;
  while (index < argv.length) {
    const arg = argv[index];
    if (arg === "--id") {
      const value = argv[index + 1];
      if (value === undefined) throw new Error("--id requires a value");
      parsed.ids.push(value);
      index += 2;
      continue;
    }
    if (arg === "--all" || arg === "--all-active") {
      parsed.allActive = true;
      index += 1;
      continue;
    }
    if (arg === "--active") {
      parsed.activeOnly = true;
      index += 1;
      continue;
    }
    if (arg === "--allow-single-turn-reviewed") {
      parsed.allowSingleTurnReviewed = true;
      index += 1;
      continue;
    }
    if (arg === "--reviewed-id") {
      const value = argv[index + 1];
      if (value === undefined) throw new Error("--reviewed-id requires a value");
      parsed.reviewedIds.push(value);
      index += 2;
      continue;
    }
    if (arg === "--reviewed-by") {
      const value = argv[index + 1];
      if (value === undefined) throw new Error("--reviewed-by requires a value");
      parsed.reviewedBy = value;
      index += 2;
      continue;
    }
    if (arg === "--review-note") {
      const value = argv[index + 1];
      if (value === undefined) throw new Error("--review-note requires a value");
      parsed.reviewNote = value;
      index += 2;
      continue;
    }
    if (arg === "--execute") {
      parsed.execute = true;
      index += 1;
      continue;
    }
    if (arg !== undefined && arg.startsWith("--since=")) {
      parsed.since = arg.slice("--since=".length);
      index += 1;
      continue;
    }
    if (arg === "--since") {
      const value = argv[index + 1];
      if (value === undefined) throw new Error("--since requires a value");
      parsed.since = value;
      index += 2;
      continue;
    }
    if (arg === "--confirm-token") {
      const value = argv[index + 1];
      if (value === undefined) throw new Error("--confirm-token requires a value");
      parsed.confirmToken = value;
      index += 2;
      continue;
    }
    if (arg === "--corpus") {
      const value = argv[index + 1];
      if (value === undefined) throw new Error("--corpus requires a value");
      parsed.corpus = value;
      index += 2;
      continue;
    }
    if (arg === "--k") {
      const value = argv[index + 1];
      if (value === undefined) throw new Error("--k requires a value");
      parsed.k = Number(value);
      if (!Number.isInteger(parsed.k) || parsed.k < 1 || parsed.k > 32) {
        throw new Error("--k must be an integer between 1 and 32");
      }
      index += 2;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return parsed;
}

function renderObservation(observation: {
  canonicalObservationId: string;
  canonicalIdentityKey: string;
  status: string;
  kind: string;
  claim: string;
  evidenceStrength: string;
  supportCount: number;
  distinctTurnCount: number;
  distinctDayCount: number;
  revision: number;
  retraction?: { kind: string; reasonCodes: readonly string[]; operationKey: string };
}): Record<string, unknown> {
  return {
    canonicalObservationId: observation.canonicalObservationId,
    canonicalIdentityKey: observation.canonicalIdentityKey,
    status: observation.status,
    kind: observation.kind,
    evidenceStrength: observation.evidenceStrength,
    supportCount: observation.supportCount,
    distinctTurnCount: observation.distinctTurnCount,
    distinctDayCount: observation.distinctDayCount,
    revision: observation.revision,
    claim: observation.claim,
    ...(observation.retraction !== undefined
      ? {
          retraction: {
            kind: observation.retraction.kind,
            reasonCodes: observation.retraction.reasonCodes,
            operationKey: observation.retraction.operationKey,
          },
        }
      : {}),
  };
}

async function runObservations(pool: import("@companion/postgres").PostgresPool, args: ParsedArgs): Promise<void> {
  if (args.allActive && args.ids.length > 0) {
    throw new Error("--all and --id are mutually exclusive");
  }
  const observations = args.allActive
    ? await getAllCanonicalObservations(pool)
    : await getCanonicalObservationsByIds(pool, args.ids);
  if (!args.allActive && args.ids.length > 0 && observations.length !== args.ids.length) {
    throw new Error("A canonical observation ID was not found");
  }
  const filtered = args.activeOnly
    ? observations.filter((observation) => observation.status === "active")
    : observations;
  console.log(JSON.stringify(
    {
      count: filtered.length,
      observations: filtered.map(renderObservation),
    },
    null,
    2,
  ));
}


/** Read-only automation report over metadata-only memory operations and
 *  promotion/run state. Printed to stdout; nothing is written. */
export async function runReport(
  pool: import("@companion/postgres").PostgresPool,
  args: ParsedArgs,
): Promise<void> {
  const sinceText = args.since ?? new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
  const since = new Date(`${sinceText}T00:00:00Z`);
  if (Number.isNaN(since.getTime())) {
    throw new Error(`--since must be a parseable date: ${sinceText}`);
  }

  const operations = await pool.query<{ kind: string; outcome: string; n: number }>(
    `SELECT kind, outcome, count(*)::int AS n
     FROM memory_operation
     WHERE started_at >= $1
     GROUP BY kind, outcome
     ORDER BY kind, outcome`,
    [since],
  );
  const operationsByDay = await pool.query<{ day: string; kind: string; outcome: string; n: number }>(
    `SELECT to_char(started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
            kind, outcome, count(*)::int AS n
     FROM memory_operation
     WHERE started_at >= $1
     GROUP BY 1, 2, 3
     ORDER BY 1, 2, 3`,
    [since],
  );
  const failures = await pool.query<{ kind: string; started_at: Date; detail: string | null; run_id: string | null; promotion_id: string | null }>(
    `SELECT kind, started_at, detail, run_id, promotion_id
     FROM memory_operation
     WHERE started_at >= $1 AND outcome = 'failed'
     ORDER BY started_at DESC
     LIMIT 20`,
    [since],
  );
  const promotions = await pool.query<{ status: string; n: number }>(
    `SELECT status, count(*)::int AS n
     FROM memory_promotion
     WHERE updated_at >= $1 OR updated_at IS NULL
     GROUP BY status`,
    [since],
  );
  const promotionItems = await pool.query<{ outcome: string; n: number }>(
    `SELECT i.outcome, count(*)::int AS n
     FROM memory_promotion_item i
     JOIN memory_promotion p ON p.promotion_id = i.promotion_id
     WHERE p.updated_at >= $1 OR p.updated_at IS NULL
     GROUP BY i.outcome`,
    [since],
  );
  const runs = await pool.query<{ n: number; observations: number | null }>(
    `SELECT count(*)::int AS n, COALESCE(sum(observation_count), 0)::int AS observations
     FROM memory_run
     WHERE completed_at >= $1`,
    [since],
  );
  const canonical = await pool.query<{ status: string; n: number }>(
    `SELECT status, count(*)::int AS n
     FROM memory_canonical_observation
     GROUP BY status
     ORDER BY status`,
  );
  const ingestState = await pool.query<{ watermark_turn_id: string | null; last_ingest_at: Date | null; last_consolidated_at: Date | null; new_facts_since_consolidation: number }>(
    `SELECT watermark_turn_id, last_ingest_at, last_consolidated_at, new_facts_since_consolidation
     FROM memory_ingest_state WHERE id = true`,
  );

  const lines: string[] = [];
  lines.push(`# Memory automation report`);
  lines.push("");
  lines.push(`Window: ${sinceText}T00:00:00Z .. now (UTC). Metadata only; no memory content.`);
  lines.push("");
  lines.push("## Operations");
  for (const row of operations.rows) {
    lines.push(`- ${row.kind} ${row.outcome}: ${String(row.n)}`);
  }
  if (operations.rows.length === 0) lines.push("- none in window");
  lines.push("");
  lines.push("## Operations by day");
  for (const row of operationsByDay.rows) {
    lines.push(`- ${row.day} ${row.kind} ${row.outcome}: ${String(row.n)}`);
  }
  if (operationsByDay.rows.length === 0) lines.push("- none in window");
  lines.push("");
  lines.push("## Consolidation runs");
  lines.push(`- runs completed in window: ${String(runs.rows[0]?.n ?? 0)}`);
  lines.push(`- observation artifacts produced: ${String(runs.rows[0]?.observations ?? 0)}`);
  lines.push("");
  lines.push("## Promotions");
  for (const row of promotions.rows) {
    lines.push(`- manifests ${row.status}: ${String(row.n)}`);
  }
  if (promotions.rows.length === 0) lines.push("- no manifests updated in window");
  for (const row of promotionItems.rows) {
    lines.push(`- items ${row.outcome}: ${String(row.n)}`);
  }
  lines.push("");
  lines.push("## Canonical state");
  for (const row of canonical.rows) {
    lines.push(`- ${row.status}: ${String(row.n)}`);
  }
  if (canonical.rows.length === 0) lines.push("- empty");
  lines.push("");
  const state = ingestState.rows[0];
  lines.push("## Ingest state");
  if (state === undefined) {
    lines.push("- not initialized");
  } else {
    lines.push(`- watermark turn: ${state.watermark_turn_id ?? "none"}`);
    lines.push(`- last ingest: ${state.last_ingest_at?.toISOString() ?? "never"}`);
    lines.push(`- last consolidation: ${state.last_consolidated_at?.toISOString() ?? "never"}`);
    lines.push(`- new facts since consolidation: ${String(state.new_facts_since_consolidation)}`);
  }
  lines.push("");
  lines.push("## Recent failures");
  if (failures.rows.length === 0) {
    lines.push("- none in window");
  } else {
    for (const row of failures.rows) {
      const refs = [
        row.run_id !== null ? `run=${row.run_id}` : undefined,
        row.promotion_id !== null ? `promotion=${row.promotion_id}` : undefined,
      ].filter((entry) => entry !== undefined).join(" ");
      lines.push(
        `- ${row.started_at.toISOString()} ${row.kind}${refs.length > 0 ? ` (${refs})` : ""}` +
          `${row.detail !== null ? ` — ${row.detail}` : ""}`,
      );
    }
  }
  console.log(lines.join("\n"));
}

async function runReview(pool: import("@companion/postgres").PostgresPool, args: ParsedArgs): Promise<void> {
  if (!args.allActive && args.ids.length === 0) {
    throw new Error("Canonical review requires canonical IDs or --all-active");
  }
  // The review derives behavioral-day evidence counts, so it needs the
  // provisioned behavioral configuration; like the rest of the memory
  // domain it fails closed when the table is unprovisioned.
  const behavior = await loadMemoryBehavior(pool);
  const planInput: CanonicalReviewPlanInput = {
    canonicalObservationIds: args.allActive ? undefined : args.ids,
    allActive: args.allActive,
    behavior,
    allowSingleTurnReviewed: args.allowSingleTurnReviewed,
    reviewedCanonicalIds: args.reviewedIds,
    reviewedBy: args.reviewedBy,
    reviewNote: args.reviewNote,
  };
  const plan = await buildCanonicalReviewPlan(pool, planInput);
  if (!args.execute) {
    console.log(JSON.stringify(
      {
        mode: "dry-run",
        reviewId: plan.reviewId,
        policyVersion: plan.policyVersion,
        selected: plan.summary.selected,
        currentStateDigest: plan.currentStateDigest,
        sourcePlanHash: plan.sourcePlanHash,
        confirmationToken: plan.confirmationToken,
        summary: plan.summary,
        items: plan.items,
      },
      null,
      2,
    ));
    return;
  }
  if (args.confirmToken === undefined) {
    throw new Error("--execute requires --confirm-token (copy it from the dry run)");
  }
  const result = await reviewCanonicalObservations(pool, {
    plan,
    confirmationToken: args.confirmToken,
  });
  console.log(JSON.stringify(result, null, 2));
}

/**
 * Recall-ranking evaluation against the disposable test database. WRITES
 * evaluation rows (one dedicated subject, `eval-` prefixed observations) and
 * removes them afterwards; refuses anything but the test-database channel
 * and requires the provisioned behavioral-day boundary (the temporal queries
 * are meaningless without it).
 */
export async function runRecallEvalCli(
  pool: import("@companion/postgres").PostgresPool,
  args: ParsedArgs,
): Promise<void> {
  const corpusPath = args.corpus ?? new URL("./memory/eval-corpus.json", import.meta.url);
  let corpus: EvalCorpus;
  try {
    corpus = validateEvalCorpus(JSON.parse(readFileSync(corpusPath, "utf8")));
  } catch (error) {
    if (error instanceof EvalCorpusError) throw error;
    throw new Error(`failed to load corpus ${corpusPath}: ${String(error)}`);
  }
  let behavior: Awaited<ReturnType<typeof loadMemoryBehavior>>;
  try {
    behavior = await loadMemoryBehavior(pool);
  } catch {
    throw new Error(
      "recall-eval requires the provisioned behavioral-day boundary (memory_behavior); temporal queries are meaningless without it",
    );
  }
  const k = args.k ?? 5;
  const config = loadMemoryConfig(process.env);
  const run = await runRecallEval(pool, config, corpus, {
    k,
    referenceTime: new Date(),
    timezone: behavior.timezone,
  });
  for (const entry of run.metrics.perQuery) {
    console.log(
      `q: ${entry.query.slice(0, 60).padEnd(62)} recall=${entry.recall.toFixed(2)} rr=${entry.reciprocalRank.toFixed(2)}`,
    );
  }
  console.log(
    `\nmetrics: recall@${String(k)}=${run.metrics.recall.toFixed(3)} precision@${String(k)}=${run.metrics.precision.toFixed(3)} MRR=${run.metrics.mrr.toFixed(3)} temporalViolations=${String(run.metrics.temporalViolations)}`,
  );
  const recallMin = Number(process.env.MEMORY_EVAL_RECALL_MIN || "0.6");
  const precisionMin = Number(process.env.MEMORY_EVAL_PRECISION_MIN || "0.5");
  const mrrMin = Number(process.env.MEMORY_EVAL_MRR_MIN || "0.5");
  const ok =
    run.metrics.recall >= recallMin &&
    run.metrics.precision >= precisionMin &&
    run.metrics.mrr >= mrrMin &&
    run.metrics.temporalViolations === 0;
  console.log(ok ? "eval: PASS" : "eval: FAIL");
  if (!ok) process.exitCode = 1;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === undefined || args.command === "--help" || args.command === "-h") {
    printUsage();
    process.exit(args.command === undefined ? 2 : 0);
  }
  // The recall evaluation writes rows and therefore only ever runs against
  // the disposable test-database channel, never the application database.
  if (args.command === "recall-eval") {
    const testDatabaseUrl = process.env.WORKER_TEST_DATABASE_URL;
    if (testDatabaseUrl === undefined || testDatabaseUrl.length === 0) {
      console.error(
        "recall-eval writes evaluation rows and must run against a disposable test database; set WORKER_TEST_DATABASE_URL (never point it at the application database)",
      );
      process.exit(2);
    }
    const evalPool = createPostgresPool({ connectionString: testDatabaseUrl });
    try {
      await runRecallEvalCli(evalPool, args);
      return;
    } finally {
      await closePostgresPool(evalPool);
    }
  }
  const databaseUrl = process.env.WORKER_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    console.error("WORKER_DATABASE_URL is required");
    process.exit(2);
  }
  const pool = createPostgresPool({ connectionString: databaseUrl });
  try {
    if (args.command === "observations") {
      await runObservations(pool, args);
      return;
    }
    if (args.command === "review") {
      await runReview(pool, args);
      return;
    }
    if (args.command === "report") {
      await runReport(pool, args);
      return;
    }
    throw new Error(`Unknown command: ${args.command}`);
  } finally {
    await closePostgresPool(pool);
  }
}

// Run only when this module is the executed entry point: importing it (for
// example from unit tests) must never start the CLI.
if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
