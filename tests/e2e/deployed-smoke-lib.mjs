/**
 * Testable core of the deployed non-production smoke
 * (`deployed-dev-smoke.mjs`).
 *
 * Everything here is pure or injectable so regression tests can exercise it
 * with synthetic data and a disposable local database only — never the
 * cluster, a real provider, or real conversation content:
 *
 * - `fingerprint` / `redactText` / `sanitizeError`: output hygiene. The
 *   synthetic marker and any captured reply text are secrets of this run;
 *   they must never appear in logs, evidence, or error messages (Playwright
 *   timeout errors can embed matched text and page snapshots, so error
 *   output is rebuilt from a step label plus the error's first line only).
 * - `planRetainedScenarioDecision`: verifies a normal-use scenario while
 *   intentionally preserving its conversation and learned state.
 * - `planCleanupDecision` / `POD_ACTION_SCRIPT_BODY`: legacy, explicit-only
 *   recovery for historical scenarios; the ordinary smoke never invokes it.
 * - `buildQueuedAtomicDelete` / `POD_ACTION_SCRIPT_BODY`:
 *   the exact SQL the runner executes pod-side. The queued cleanup runs in
 *   one transaction that takes the SAME advisory lock the worker's claim
 *   path takes (before any row lock, the same order the worker uses), so
 *   the `turn_id IS NULL` predicate is evaluated atomically for the
 *   engagement-assessment delete and the parent delete: against the
 *   worker's claim (`pg_advisory_xact_lock` → pending `SELECT … FOR
 *   UPDATE` → `UPDATE … SET turn_id WHERE turn_id IS NULL`) either the
 *   message is still unassigned (satellite and parent deleted together) or
 *   it was already claimed (both delete nothing) — an assessment is never
 *   removed from a retained message.
 * - `createShutdownController`: SIGINT/SIGTERM become graceful stops — the
 *   journey aborts, retained-state verification still runs, and only then
 *   does the process exit (SIGKILL has no handler; the persisted marker is
 *   the explicit recovery trail for that case).
 */

import { createHash, randomBytes } from "node:crypto";

/**
 * The worker claim path's advisory lock key, mirrored here for the
 * pod-side cleanup: the queued-message cleanup takes the same
 * `pg_advisory_xact_lock` the claim takes, serializing the assessment +
 * parent delete against claims (see the delete-queued action). Drift is
 * guarded by a regression test that compares this value against the
 * worker store's exported `CLAIM_ADVISORY_LOCK_KEY`.
 */
export const SMOKE_CLAIM_ADVISORY_LOCK_KEY = 918273645511;

// ---------------------------------------------------------------------------
// Output hygiene
// ---------------------------------------------------------------------------

/**
 * Stable short fingerprint of a secret value for evidence: proves identity
 * across runs without exposing the value.
 */
export function fingerprint(value) {
  return createHash("sha256").update(String(value)).digest("hex").slice(0, 12);
}

/** Replace every occurrence of each secret with `[redacted]`. */
export function redactText(secrets, text) {
  let output = String(text);
  for (const secret of secrets) {
    if (secret !== null && secret !== undefined && String(secret).length > 0) {
      output = output.split(String(secret)).join("[redacted]");
    }
  }
  return output;
}

/**
 * Rebuild an error for logging: only the step label, the error kind, and the
 * FIRST line of the original message, redacted and length-capped. The first
 * line only is deliberate — Playwright timeout errors append matched-locator
 * text and page accessibility snapshots on later lines, which would leak
 * conversation content.
 */
export function sanitizeError(secrets, error, stepLabel) {
  const original = error instanceof Error ? error.message : String(error);
  const firstLine = original.split("\n", 1)[0] ?? "";
  const kind = error instanceof Error ? error.name : typeof error;
  const safe = redactText(secrets, `${stepLabel}: ${kind}: ${firstLine}`.slice(0, 400));
  return new Error(safe);
}

// ---------------------------------------------------------------------------
// Cleanup decision state machine (conservative: retain when uncertain)
// ---------------------------------------------------------------------------

/**
 * Decide the cleanup action from probe results. Inputs (all content-free):
 *
 * - `message`: { id, turnId } | null — the marker-attributed user message.
 * - `deleteOutcome`: null | { rowCount } — result of the atomic guarded
 *   delete (only meaningful right after it ran against a queued message).
 * - `turn`: { status } | null — the referenced turn row (null: unreadable).
 * - `composition`: [{ role, id }] | null — the turn's messages by seq.
 * - `ourUserMessageInTurn`: boolean — pod-side proof that the turn's single
 *   user message is this run's row (id AND exact marker content).
 * - `settleTimedOut`: boolean — the in-flight wait ran out.
 * - `stopRequested`: boolean — a graceful shutdown was requested during the
 *   wait; nothing is deleted mid-shutdown except provably-safe rows.
 * - `nowDeleted`: boolean — the atomic queued delete reported rowCount 1.
 *
 * Modes: `nothing-to-clean`, `queued-message-deleted`, `turn-path`
 * (caller re-runs the state machine after waiting/probing), `full-turn`,
 * `retain` (with a reason; nothing was deleted).
 */
export function planCleanupDecision(input) {
  const {
    message = null,
    deleteOutcome = null,
    turn = null,
    composition = null,
    ourUserMessageInTurn = false,
    settleTimedOut = false,
    stopRequested = false,
    nowDeleted = false,
  } = input;
  const turnRow = turn ?? null;

  if (nowDeleted) {
    return { mode: "queued-message-deleted", retain: false };
  }
  if (message === null) {
    return { mode: "nothing-to-clean", retain: true, reason: "the synthetic message never persisted" };
  }
  // A queued (unassigned) message whose guarded delete affected no row:
  // uncertain — re-probe and decide again, never blind-delete.
  if (deleteOutcome !== null && deleteOutcome.rowCount === 0 && message.turnId === null) {
    return { mode: "retain", retain: true, reason: "the guarded delete affected no row while the message still reads unassigned; state is uncertain" };
  }
  if (message.turnId === null) {
    // Still queued and no delete outcome recorded: only the atomic guarded
    // delete may remove it.
    return { mode: "queued-atomic-delete", retain: true, reason: "the message is still unassigned; delete atomically with the turn_id IS NULL guard" };
  }
  if (turnRow === null) {
    return { mode: "retain", retain: true, reason: "the referenced turn row could not be read; preserving message and turn" };
  }
  if (turnRow.status === "in_flight") {
    if (stopRequested || settleTimedOut) {
      return { mode: "retain", retain: true, reason: stopRequested
        ? "shutdown requested while the turn is in flight; nothing is deleted"
        : "the turn is still in flight after the bounded wait; nothing was deleted" };
    }
    return { mode: "turn-path", retain: true, reason: "wait for the in-flight turn to settle, then decide again" };
  }
  const userMessages = (composition ?? []).filter((entry) => entry.role === "user");
  const exclusive =
    userMessages.length === 1 &&
    userMessages[0].id === message.id &&
    ourUserMessageInTurn === true;
  if (!exclusive) {
    // Turn-scoped traces and derived memory cannot be cleanly separated from
    // a shared conversation; retain the whole scenario rather than deleting
    // only one message and orphaning its causal artifacts.
    return {
      mode: "retain",
      retain: true,
      reason: "the turn is shared; its turn-scoped memory/trace provenance cannot be separated safely",
    };
  }
  if (turnRow.status === "completed" || turnRow.status === "failed") {
    return { mode: "full-turn", retain: false };
  }
  return { mode: "retain", retain: true, reason: `the turn settled into an unrecognized status (${String(turnRow.status)}); preserving everything` };
}

// ---------------------------------------------------------------------------
// Normal-use retained-scenario verification
// ---------------------------------------------------------------------------

/**
 * Classify evidence for the ordinary smoke, which retains all scenario data.
 * This decision is verification-only and has no delete mode.
 */
export function planRetainedScenarioDecision(input) {
  const {
    message = null,
    turn = null,
    composition = null,
    ourUserMessageInTurn = false,
    backgroundSettled = false,
    configurationInvariant = false,
  } = input;

  if (message === null) {
    return { mode: "failed", retained: true, reason: "the synthetic message was not found" };
  }
  if (turn === null) {
    return { mode: "failed", retained: true, reason: "the synthetic message has no readable turn" };
  }
  if (turn.status !== "completed") {
    return { mode: "failed", retained: true, reason: `the synthetic turn did not complete (${String(turn.status)})` };
  }
  const rows = composition ?? [];
  const users = rows.filter((entry) => entry.role === "user");
  const assistants = rows.filter((entry) => entry.role === "assistant");
  if (
    users.length !== 1 || users[0].id !== message.id ||
    assistants.length < 1 || ourUserMessageInTurn !== true
  ) {
    return { mode: "failed", retained: true, reason: "the synthetic message/reply association did not verify" };
  }
  if (!backgroundSettled) {
    return { mode: "failed", retained: true, reason: "bounded memory/semantic background convergence did not settle" };
  }
  if (!configurationInvariant) {
    return { mode: "failed", retained: true, reason: "provisioned configuration fingerprint changed or was unavailable" };
  }
  return { mode: "retained-intentionally", retained: true, reason: "normal-use scenario and learned effects are preserved" };
}

// ---------------------------------------------------------------------------
// Statement builders (the exact SQL the runner executes pod-side)
// ---------------------------------------------------------------------------

/**
 * Atomic guarded delete for a still-unassigned message. Parameterized; the
 * `turn_id IS NULL` predicate makes the delete-vs-claim race safe (see the
 * module comment).
 */
export function buildQueuedAtomicDelete(messageId, marker) {
  return {
    sql: "DELETE FROM conversation_message WHERE id = $1 AND content = $2 AND turn_id IS NULL",
    params: [messageId, marker],
  };
}

// ---------------------------------------------------------------------------
// Pod-side action script (fixed body; the only per-run part is the single
// JSON constant line, which JSON.stringify makes injection-safe). All SQL is
// parameterized; all results are content-free. Exposed so regression tests
// can syntax-check the generated script and assert it embeds exactly the
// builder statements above.
// ---------------------------------------------------------------------------

export const POD_ACTION_SCRIPT_BODY = `
const client = new pg.Client({ connectionString: process.env.WORKER_DATABASE_URL });
await client.connect();
const { createHmac } = await import("node:crypto");
const configurationTables = [
  "chat_identity", "response_pattern", "prompt_module", "companion_time_settings",
  "engagement_bands", "memory_subject", "memory_behavior", "memory_prompt",
  "routine_settings", "routine_transition", "relationship_settings", "relationship_tier",
  "relationship_question_type", "relationship_question", "article_feed",
  "article_behavior", "article_prompt",
];
const configurationEnvironment = [
  "WORKER_CHAT_MODEL", "WORKER_DECISION_MODEL", "WORKER_OPENROUTER_CHAT_URL",
  "WORKER_OPENROUTER_DECISIONS_URL", "WORKER_CHAT_TIMEOUT_MS", "WORKER_DECISION_TIMEOUT_MS",
  "WORKER_CONTEXT_MESSAGE_LIMIT", "WORKER_CLIENT_TIME_MAX_AHEAD_MS",
  "WORKER_MEMORY_ENABLED", "WORKER_MEMORY_INGEST_ENABLED", "WORKER_MEMORY_AUTOPROMOTE_ENABLED",
  "WORKER_MEMORY_PROFILES_ENABLED", "WORKER_MEMORY_PROFILE_SUMMARIES_ENABLED",
  "WORKER_MEMORY_RECALL_ENABLED", "WORKER_MEMORY_TEMPORAL_CONTEXT_ENABLED",
  "WORKER_MEMORY_TEMPORAL_SUMMARIES_ENABLED", "WORKER_MEMORY_MODEL",
  "WORKER_MEMORY_OPENROUTER_BASE_URL", "WORKER_MEMORY_EMBEDDING_BASE_URL",
  "WORKER_MEMORY_CHAT_TIMEOUT_MS", "WORKER_MEMORY_INGEST_MAX_TURNS",
  "WORKER_MEMORY_INGEST_RECONCILIATION_MS", "WORKER_MEMORY_INGEST_SETTLE_MS",
  "WORKER_MEMORY_FACT_BATCH_TURNS", "WORKER_MEMORY_FACT_BATCH_MAX_CHARS",
  "WORKER_MEMORY_OBSERVATION_MAX_TURNS", "WORKER_MEMORY_OBSERVATION_MAX_FACTS",
  "WORKER_MEMORY_OBSERVATION_MAX_OUTPUT_TOKENS", "WORKER_MEMORY_OBSERVATION_RECENCY_WINDOW_DAYS",
  "WORKER_MEMORY_CONSOLIDATION_NEW_FACTS_THRESHOLD", "WORKER_MEMORY_CONSOLIDATION_INTERVAL_MS",
  "WORKER_MEMORY_CANONICAL_RECENCY_WEIGHT", "WORKER_MEMORY_CANONICAL_RECENCY_HALF_LIFE_DAYS",
  "WORKER_MEMORY_CANONICAL_CANDIDATE_LIMIT", "WORKER_MEMORY_TEMPORAL_RECONCILIATION_MS",
  "WORKER_MEMORY_PROFILES_GENERATE_HOUR", "WORKER_MEMORY_PROFILE_MAX_SOURCE_CHARS",
  "WORKER_MEMORY_PROFILE_MAX_OUTPUT_TOKENS", "WORKER_MEMORY_RECALL_LIMIT",
  "WORKER_MEMORY_RECALL_MAX_CHARS", "WORKER_LEASE_SECONDS", "WORKER_POLL_SECONDS",
];
async function configurationFingerprint() {
  const key = SMOKE_INPUT.configurationFingerprintKey;
  if (typeof key !== "string" || !/^[a-f0-9]{64}$/.test(key)) {
    throw new Error("configuration_fingerprint_key_missing");
  }
  const hmac = createHmac("sha256", Buffer.from(key, "hex"));
  for (const table of configurationTables) {
    const exists = await client.query(
      "SELECT to_regclass($1) IS NOT NULL AS present",
      [\`public.\${table}\`],
    );
    if (exists.rows[0]?.present !== true) throw new Error("configuration_fingerprint_missing_table");
    const rows = await client.query(\`SELECT to_jsonb(row_value)::text AS value FROM public.\${table} AS row_value ORDER BY to_jsonb(row_value)::text\`);
    hmac.update(\`\${table}\\0\`);
    for (const row of rows.rows) hmac.update(\`\${row.value}\\0\`);
  }
  for (const name of configurationEnvironment) {
    hmac.update(\`\${name}\\0\${process.env[name] ?? "<unset>"}\\0\`);
  }
  return hmac.digest("hex");
}
// The worker claim path's advisory lock key (mirrored from the worker
// store; drift-guarded by regression tests). The queued-message cleanup
// takes this lock before any row lock, serializing against claims exactly
// as the worker's own transactions do.
const CLAIM_ADVISORY_LOCK_KEY = ${JSON.stringify(SMOKE_CLAIM_ADVISORY_LOCK_KEY)};
const out = { ok: true, action: SMOKE_INPUT.action };
try {
  const scalar = async (sql, params = []) => {
    const result = await client.query(sql, params);
    let value = result.rows.length > 0 ? Object.values(result.rows[0])[0] : null;
    if (typeof value === "string" && /^-?\\d+$/.test(value)) {
      value = Number(value);
    }
    return value;
  };
  const turnShape = (row) => ({
    id: row.id,
    status: row.status,
    attempt: row.attempt,
    selectedPatternId: row.selected_pattern_id,
    hasError: row.has_error,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  });
  if (SMOKE_INPUT.action === "configuration-fingerprint") {
    out.configurationFingerprint = await configurationFingerprint();
  } else if (SMOKE_INPUT.action === "marker-check") {
    out.markerRows = await scalar(
      "SELECT count(*) FROM conversation_message WHERE content = $1",
      [SMOKE_INPUT.marker],
    );
  } else if (SMOKE_INPUT.action === "preflight") {
    out.tablesOk = await scalar("(SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='conversation_message') AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='conversation_turn'))");
    out.clientKeyIndexed = await scalar("(SELECT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='conversation_message_client_key_key'))");
    out.oneReplyPerTurn = await scalar("(SELECT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='conversation_turn_reply_idx'))");
    out.leftoverSmokeRows = await scalar("(SELECT count(*) FROM conversation_message WHERE client_key LIKE $1 OR content LIKE $1)", [SMOKE_INPUT.smokePrefix + "%"]);
    out.unsettledSmokeRows = await scalar(
      "SELECT count(*) FROM conversation_message message LEFT JOIN conversation_turn turn ON turn.id = message.turn_id"
      + " WHERE (message.client_key LIKE $1 OR message.content LIKE $1)"
      + " AND (message.turn_id IS NULL OR turn.id IS NULL OR turn.status = 'in_flight')",
      [SMOKE_INPUT.smokePrefix + "%"],
    );
    out.queuedUserMessages = await scalar("(SELECT count(*) FROM conversation_message WHERE role='user' AND turn_id IS NULL)");
    out.inFlightTurns = await scalar("(SELECT count(*) FROM conversation_turn WHERE status='in_flight')");
    out.enabledPatterns = await scalar("(SELECT count(*) FROM response_pattern WHERE enabled)");
    out.enabledPromptModules = await scalar(
      "SELECT CASE WHEN to_regclass('public.prompt_module') IS NULL THEN 0"
      + " ELSE (SELECT count(*) FROM prompt_module WHERE enabled) END",
    );
    if (SMOKE_INPUT.expectedHttpModule !== undefined) {
      out.expectedHttpModuleConfigured = await scalar(
        "SELECT EXISTS (SELECT 1 FROM prompt_module WHERE id = $1 AND enabled"
        + " AND execution_mode = 'http_post' AND activation_mode = 'every_turn')",
        [SMOKE_INPUT.expectedHttpModule.id],
      );
    }
    // The chat identity is required runtime configuration: a full turn
    // cannot publish without it, so a smoke run must fail fast here with a
    // clear reason instead of a failed turn mid-journey.
    out.identityProvisioned = await scalar("(SELECT count(*) FROM chat_identity WHERE id = 'identity' AND length(btrim(content)) > 0)");
    out.baselineMessages = await scalar("(SELECT count(*) FROM conversation_message)");
    out.baselineTurns = await scalar("(SELECT count(*) FROM conversation_turn)");
    out.newestMessageAgeMinutes = await scalar("(SELECT round(extract(epoch FROM (now() - max(created_at))) / 60) FROM conversation_message)");
    out.highestAllocatedSeq = await scalar("(SELECT COALESCE(max(seq), 0) FROM conversation_message)");
    out.configurationFingerprint = await configurationFingerprint();
    out.relationshipEnabledQuestions = await scalar(
      "SELECT CASE WHEN to_regclass('public.relationship_question') IS NULL THEN 0"
      + " ELSE (SELECT count(*) FROM relationship_question WHERE enabled) END",
    );
    out.relationshipAnswerRows = await scalar(
      "SELECT CASE WHEN to_regclass('public.relationship_answer') IS NULL THEN 0"
      + " ELSE (SELECT count(*) FROM relationship_answer) END",
    );
    out.memorySchemaPresent = await scalar("SELECT to_regclass('public.memory_ingest_state') IS NOT NULL");
    if (out.memorySchemaPresent === true) {
      out.memoryEnabled = process.env.WORKER_MEMORY_ENABLED !== "false";
      out.memoryIngestEnabled = process.env.WORKER_MEMORY_INGEST_ENABLED === "true";
      out.memoryRecallEnabled = process.env.WORKER_MEMORY_RECALL_ENABLED !== "false";
      out.memoryAutopromoteEnabled = process.env.WORKER_MEMORY_AUTOPROMOTE_ENABLED === "true";
      out.memoryEmbeddingConfigured = typeof process.env.WORKER_MEMORY_EMBEDDING_BASE_URL === "string"
        && process.env.WORKER_MEMORY_EMBEDDING_BASE_URL.startsWith("http");
      out.memoryIngestSettleMs = Number(process.env.WORKER_MEMORY_INGEST_SETTLE_MS ?? 120_000);
      out.memoryChatTimeoutMs = Number(process.env.WORKER_MEMORY_CHAT_TIMEOUT_MS ?? 120_000);
      out.memoryConsolidationThreshold = Number(process.env.WORKER_MEMORY_CONSOLIDATION_NEW_FACTS_THRESHOLD ?? 40);
      out.memoryConsolidationIntervalMs = Number(process.env.WORKER_MEMORY_CONSOLIDATION_INTERVAL_MS ?? 86_400_000);
      out.memoryIngestCursorInitialized = await scalar(
        "SELECT coalesce((SELECT initialized_at IS NOT NULL FROM memory_ingest_state WHERE id), false)",
      );
      out.memoryIngestCursorCaughtUp = await scalar(
        \`WITH latest AS (
           SELECT t.id, max(m.created_at) AS end_at
           FROM conversation_turn t
           JOIN conversation_message m ON m.turn_id = t.id
           WHERE t.status = 'completed'
           GROUP BY t.id
           ORDER BY max(m.created_at) DESC, t.id DESC
           LIMIT 1
         )
         SELECT CASE WHEN latest.id IS NULL THEN true
           ELSE EXISTS (
             SELECT 1 FROM memory_ingest_state s
             WHERE s.initialized_at IS NOT NULL
               AND s.watermark_turn_id IS NOT NULL
               AND s.watermark_end_at IS NOT NULL
               AND (s.watermark_end_at, s.watermark_turn_id) >= (latest.end_at, latest.id)
           ) END
         FROM (SELECT 1) seed LEFT JOIN latest ON true\`,
      );
      out.memoryNewFactsSinceConsolidation = await scalar(
        "SELECT coalesce((SELECT new_facts_since_consolidation FROM memory_ingest_state WHERE id), 0)",
      );
      out.memoryConsolidationMayRun = await scalar(
        \`SELECT coalesce((
           SELECT new_facts_since_consolidation + 12 >= $1::integer
             OR (new_facts_since_consolidation + 12 > 0
                 AND (last_consolidated_at IS NULL
                      OR last_consolidated_at <= now() - $2::bigint * interval '1 millisecond'))
           FROM memory_ingest_state WHERE id
         ), true)\`,
        [out.memoryConsolidationThreshold, out.memoryConsolidationIntervalMs],
      );
      out.memoryActiveConsolidationRuns = await scalar(
        "SELECT count(*) FROM memory_run WHERE status IN ('planned', 'facts-ready')",
      );
      out.memoryUnrecordedPromotionRuns = await scalar(
        "SELECT count(*) FROM memory_run run"
        + " WHERE run.status = 'observations-ready' AND $1::boolean"
        + " AND NOT EXISTS (SELECT 1 FROM memory_operation operation"
        + " WHERE operation.run_id = run.run_id AND operation.kind = 'promotion'"
        + " AND operation.finished_at IS NOT NULL)",
        [out.memoryAutopromoteEnabled],
      );
      out.memoryPendingPromotions = await scalar(
        "SELECT count(*) FROM memory_promotion WHERE status <> 'completed'",
      );
      out.nextTemporalBoundaryMs = await scalar(
        \`WITH c AS (
           SELECT t.timezone, t.day_start_hour, now() AS instant,
                  (now() AT TIME ZONE t.timezone)::date AS local_date
           FROM companion_time_settings t
           WHERE t.id = true
         ), d AS (
           SELECT c.*, day::date AS boundary_date
           FROM c CROSS JOIN LATERAL generate_series(
             c.local_date::timestamp,
             (c.local_date + 2)::timestamp,
             interval '1 day'
           ) AS day
         ), boundaries AS (
           SELECT d.instant,
                  candidate.boundary_at
           FROM d
           CROSS JOIN LATERAL (VALUES
             (make_timestamptz(extract(year FROM boundary_date)::int, extract(month FROM boundary_date)::int, extract(day FROM boundary_date)::int, day_start_hour, 0, 0, timezone)),
             (make_timestamptz(extract(year FROM boundary_date)::int, extract(month FROM boundary_date)::int, extract(day FROM boundary_date)::int, 12, 0, 0, timezone)),
             (make_timestamptz(extract(year FROM boundary_date)::int, extract(month FROM boundary_date)::int, extract(day FROM boundary_date)::int, 17, 0, 0, timezone))
           ) AS candidate(boundary_at)
         )
         SELECT round(extract(epoch FROM (min(boundary_at) - min(instant))) * 1000)::bigint
         FROM boundaries WHERE boundary_at > instant\`,
      );
    }
  } else if (SMOKE_INPUT.action === "probe") {
    const messageId = await scalar("(SELECT id FROM conversation_message WHERE content = $1 LIMIT 1)", [SMOKE_INPUT.marker]);
    out.totalMessages = await scalar("(SELECT count(*) FROM conversation_message)");
    out.totalTurns = await scalar("(SELECT count(*) FROM conversation_turn)");
    if (messageId === null) {
      out.message = null;
    } else {
      const row = (await client.query("SELECT id, seq, turn_id FROM conversation_message WHERE id = $1", [messageId])).rows[0];
      out.message = { id: row.id, seq: Number(row.seq), turnId: row.turn_id };
      if (row.turn_id !== null) {
        const turnRow = (await client.query("SELECT id, status, attempt, selected_pattern_id, (error IS NOT NULL) AS has_error, created_at, completed_at FROM conversation_turn WHERE id = $1", [row.turn_id])).rows[0];
        if (turnRow === undefined) {
          out.turn = null;
          out.turnUnreadable = true;
        } else {
          out.turn = turnShape(turnRow);
          const composition = (await client.query("SELECT json_agg(json_build_object('role', role, 'id', id) ORDER BY seq) AS composition FROM conversation_message WHERE turn_id = $1", [row.turn_id])).rows[0].composition;
          out.composition = composition ?? [];
          out.ourUserMessageInTurn = await scalar("(SELECT EXISTS (SELECT 1 FROM conversation_message WHERE turn_id = $1 AND id = $2 AND role = 'user' AND content = $3))", [row.turn_id, row.id, SMOKE_INPUT.marker]);
        }
      }
    }
  } else if (SMOKE_INPUT.action === "background-status") {
    out.turn = (await client.query(
      "SELECT id, status, completed_at FROM conversation_turn WHERE id = $1",
      [SMOKE_INPUT.turnId],
    )).rows[0] ?? null;
    out.traceAttempts = await scalar(
      "SELECT count(*) FROM trace_attempt WHERE turn_id = $1",
      [SMOKE_INPUT.turnId],
    );
    out.semanticShadowAttempts = await scalar(
      "SELECT count(*) FROM memory_semantic_shadow_attempt WHERE turn_id = $1",
      [SMOKE_INPUT.turnId],
    );
    out.semanticShadowFailures = await scalar(
      "SELECT count(*) FROM memory_semantic_shadow_attempt WHERE turn_id = $1 AND outcome = 'failed'",
      [SMOKE_INPUT.turnId],
    );
    out.recallOperations = await scalar(
      "SELECT count(*) FROM memory_operation WHERE turn_id = $1 AND kind = 'recall' AND finished_at IS NOT NULL",
      [SMOKE_INPUT.turnId],
    );
    out.factExtractionOperations = await scalar(
      \`SELECT count(DISTINCT operation.id)
       FROM memory_operation_turn source
       JOIN memory_operation operation ON operation.id = source.operation_id
       WHERE source.turn_id = $1 AND operation.kind = 'fact_extraction'
         AND operation.finished_at IS NOT NULL\`,
      [SMOKE_INPUT.turnId],
    );
    out.memoryProviderCalls = await scalar(
      \`SELECT coalesce(sum(operation.llm_calls), 0)
       FROM memory_operation_turn source
       JOIN memory_operation operation ON operation.id = source.operation_id
       WHERE source.turn_id = $1 AND operation.kind = 'fact_extraction'
         AND operation.finished_at IS NOT NULL\`,
      [SMOKE_INPUT.turnId],
    );
    out.ingestCursorPassed = await scalar(
      \`SELECT EXISTS (
         SELECT 1 FROM memory_ingest_state state
         JOIN conversation_turn turn ON turn.id = $1
         JOIN conversation_message message ON message.turn_id = turn.id
         WHERE state.id = true AND state.watermark_end_at IS NOT NULL
           AND (state.watermark_end_at, state.watermark_turn_id) >=
               ((SELECT max(created_at) FROM conversation_message WHERE turn_id = $1), $1::uuid)
       )\`,
      [SMOKE_INPUT.turnId],
    );
    out.extractionCacheRows = await scalar(
      "SELECT count(*) FROM memory_turn_extraction WHERE turn_id = $1",
      [SMOKE_INPUT.turnId],
    );
    out.runTurns = await scalar(
      "SELECT count(*) FROM memory_run_turn WHERE turn_id = $1",
      [SMOKE_INPUT.turnId],
    );
    out.sharedOperationRows = await scalar(
      "SELECT count(DISTINCT operation.id) FROM memory_operation operation"
      + " WHERE (operation.turn_id = $1 OR EXISTS (SELECT 1 FROM memory_operation_turn source"
      + " WHERE source.operation_id = operation.id AND source.turn_id = $1))"
      + " AND ((operation.turn_id IS NOT NULL AND operation.turn_id <> $1)"
      + " OR EXISTS (SELECT 1 FROM memory_operation_turn other"
      + " WHERE other.operation_id = operation.id AND other.turn_id <> $1))",
      [SMOKE_INPUT.turnId],
    );
    out.mixedRuns = await scalar(
      \`SELECT count(*) FROM (
         SELECT source.run_id
         FROM memory_run_turn source
         WHERE source.run_id IN (SELECT run_id FROM memory_run_turn WHERE turn_id = $1)
         GROUP BY source.run_id
         HAVING bool_or(source.turn_id <> $1)
       ) mixed\`,
      [SMOKE_INPUT.turnId],
    );
    out.activeRuns = await scalar(
      \`SELECT count(DISTINCT run.run_id)
       FROM memory_run run
       JOIN memory_run_turn source ON source.run_id = run.run_id
       WHERE source.turn_id = $1 AND run.status IN ('planned', 'facts-ready')\`,
      [SMOKE_INPUT.turnId],
    );
    out.unrecordedRunPromotions = await scalar(
      "SELECT count(DISTINCT run.run_id) FROM memory_run run"
      + " JOIN memory_run_turn source ON source.run_id = run.run_id"
      + " WHERE source.turn_id = $1 AND run.status = 'observations-ready'"
      + " AND $2::boolean AND NOT EXISTS (SELECT 1 FROM memory_operation operation"
      + " WHERE operation.run_id = run.run_id AND operation.kind = 'promotion'"
      + " AND operation.finished_at IS NOT NULL)",
      [SMOKE_INPUT.turnId, process.env.WORKER_MEMORY_AUTOPROMOTE_ENABLED === "true"],
    );
    out.pendingPromotions = await scalar(
      \`SELECT count(*) FROM memory_promotion promotion
       WHERE promotion.run_id IN (
         SELECT run_id FROM memory_run_turn WHERE turn_id = $1
       ) AND promotion.status <> 'completed'\`,
      [SMOKE_INPUT.turnId],
    );
    out.appliedPromotionItems = await scalar(
      \`SELECT count(*) FROM memory_promotion_item item
       JOIN memory_promotion promotion USING (promotion_id)
       WHERE promotion.run_id IN (
         SELECT run_id FROM memory_run_turn WHERE turn_id = $1
       ) AND item.outcome = 'applied'\`,
      [SMOKE_INPUT.turnId],
    );
    out.pendingFactEmbeddings = await scalar(
      \`SELECT count(*)
       FROM memory_fact fact
       LEFT JOIN memory_semantic_embedding embedding ON embedding.fact_id = fact.id
       WHERE fact.turn_id = $1 AND embedding.id IS NULL\`,
      [SMOKE_INPUT.turnId],
    );
    out.temporalReferences = await scalar(
      \`SELECT count(*) FROM memory_temporal_summary_message
       WHERE message_id IN (SELECT id FROM conversation_message WHERE turn_id = $1)\`,
      [SMOKE_INPUT.turnId],
    );
  } else if (SMOKE_INPUT.action === "retained-state") {
    const message = (await client.query(
      "SELECT id, seq, turn_id FROM conversation_message WHERE id = $1 AND content = $2",
      [SMOKE_INPUT.messageId, SMOKE_INPUT.marker],
    )).rows[0] ?? null;
    out.message = message === null ? null : { id: message.id, seq: Number(message.seq), turnId: message.turn_id };
    out.turn = message?.turn_id === null || message === null
      ? null
      : (await client.query(
        "SELECT id, status, attempt FROM conversation_turn WHERE id = $1",
        [message.turn_id],
      )).rows[0] ?? null;
    out.composition = message?.turn_id === null || message === null
      ? []
      : (await client.query(
        "SELECT id, role FROM conversation_message WHERE turn_id = $1 ORDER BY seq",
        [message.turn_id],
      )).rows;
    out.ourUserMessageInTurn = message?.turn_id !== null && message !== null && await scalar(
      "SELECT EXISTS (SELECT 1 FROM conversation_message WHERE id = $1 AND content = $2 AND turn_id = $3 AND role = 'user')",
      [SMOKE_INPUT.messageId, SMOKE_INPUT.marker, message.turn_id],
    );
    out.decisionRequests = await scalar(
      "SELECT count(*) FROM trace_attempt_decision decision JOIN trace_attempt attempt ON attempt.id = decision.attempt_id WHERE attempt.turn_id = $1",
      [SMOKE_INPUT.turnId],
    );
    out.decisionResponses = await scalar(
      "SELECT count(*) FROM trace_attempt_decision decision JOIN trace_attempt attempt ON attempt.id = decision.attempt_id WHERE attempt.turn_id = $1 AND decision.state = 'responded'",
      [SMOKE_INPUT.turnId],
    );
    out.chatRequests = await scalar(
      "SELECT count(*) FROM trace_attempt_chat chat JOIN trace_attempt attempt ON attempt.id = chat.attempt_id WHERE attempt.turn_id = $1",
      [SMOKE_INPUT.turnId],
    );
    out.chatResponses = await scalar(
      "SELECT count(*) FROM trace_attempt_chat chat JOIN trace_attempt attempt ON attempt.id = chat.attempt_id WHERE attempt.turn_id = $1 AND chat.state = 'responded'",
      [SMOKE_INPUT.turnId],
    );
    out.promptModuleDecisionRequests = await scalar(
      "SELECT count(DISTINCT attempt_id) FROM trace_attempt_prompt_module WHERE attempt_id IN (SELECT id FROM trace_attempt WHERE turn_id = $1) AND decision_state IN ('requested', 'responded', 'failed', 'invalid')",
      [SMOKE_INPUT.turnId],
    );
    out.memoryProviderCalls = await scalar(
      "SELECT coalesce(sum(operation.llm_calls), 0) FROM memory_operation_turn source JOIN memory_operation operation ON operation.id = source.operation_id WHERE source.turn_id = $1 AND operation.kind = 'fact_extraction' AND operation.finished_at IS NOT NULL",
      [SMOKE_INPUT.turnId],
    );
    out.semanticShadowAttempts = await scalar(
      "SELECT count(*) FROM memory_semantic_shadow_attempt WHERE turn_id = $1",
      [SMOKE_INPUT.turnId],
    );
    out.semanticShadowOutcomes = (await client.query(
      "SELECT outcome, count(*)::int AS count FROM memory_semantic_shadow_attempt WHERE turn_id = $1 GROUP BY outcome ORDER BY outcome",
      [SMOKE_INPUT.turnId],
    )).rows;
    out.semanticOnlyCandidates = await scalar(
      "SELECT count(*) FROM memory_semantic_shadow_candidate candidate JOIN memory_semantic_shadow_attempt attempt ON attempt.id = candidate.attempt_id WHERE attempt.turn_id = $1 AND candidate.candidate_origin = 'semantic_only'",
      [SMOKE_INPUT.turnId],
    );
    out.shadowCandidateCountsByArm = (await client.query(
      "SELECT candidate.arm, count(*)::int AS count FROM memory_semantic_shadow_candidate candidate JOIN memory_semantic_shadow_attempt attempt ON attempt.id = candidate.attempt_id WHERE attempt.turn_id = $1 GROUP BY candidate.arm ORDER BY candidate.arm",
      [SMOKE_INPUT.turnId],
    )).rows;
    out.chatContextChunks = (await client.query(
      "SELECT coalesce(message.chunk, 'unclassified') AS chunk, count(*)::int AS count FROM trace_attempt_chat_message message JOIN trace_attempt_chat chat ON chat.id = message.chat_id JOIN trace_attempt attempt ON attempt.id = chat.attempt_id WHERE attempt.turn_id = $1 GROUP BY message.chunk ORDER BY message.chunk",
      [SMOKE_INPUT.turnId],
    )).rows;
    out.semanticShadowContextMessages = await scalar(
      "SELECT count(*) FROM trace_attempt_chat_message message JOIN trace_attempt_chat chat ON chat.id = message.chat_id JOIN trace_attempt attempt ON attempt.id = chat.attempt_id WHERE attempt.turn_id = $1 AND message.chunk LIKE 'semantic%'",
      [SMOKE_INPUT.turnId],
    );
    out.memoryFacts = await scalar(
      "SELECT count(*) FROM memory_fact WHERE turn_id = $1",
      [SMOKE_INPUT.turnId],
    );
    out.relationshipEnabledQuestions = await scalar(
      "SELECT count(*) FROM relationship_question WHERE enabled",
    );
    out.relationshipAnswerCount = await scalar(
      "SELECT count(*) FROM relationship_answer",
    );
    out.relationshipAnswersUpdatedSinceStart = await scalar(
      "SELECT count(*) FROM relationship_answer WHERE updated_at >= $1::timestamptz",
      [SMOKE_INPUT.startedAt],
    );
    out.relationshipExtractionProviderCalls = out.relationshipEnabledQuestions > 0 && out.chatResponses > 0 ? out.chatResponses : 0;
    out.providerRequestsObserved = out.decisionRequests + out.chatRequests + out.promptModuleDecisionRequests + out.memoryProviderCalls + out.relationshipExtractionProviderCalls;
    out.messages = await scalar("SELECT count(*) FROM conversation_message");
    out.turns = await scalar("SELECT count(*) FROM conversation_turn");
    out.scenarioMarkerRows = await scalar(
      "SELECT count(*) FROM conversation_message WHERE content = $1",
      [SMOKE_INPUT.marker],
    );
    out.scenarioTurnMessages = await scalar(
      "SELECT count(*) FROM conversation_message WHERE turn_id = $1",
      [SMOKE_INPUT.turnId],
    );
    if (SMOKE_INPUT.expectedHttpModule !== undefined) {
      const publishedAttemptCount = await scalar(
        "SELECT count(*) FROM trace_attempt WHERE turn_id = $1 AND outcome = 'published'",
        [SMOKE_INPUT.turnId],
      );
      const moduleRows = await client.query(
        \`SELECT module.execution_mode, module.activation_mode, module.decision_state,
                module.selected, module.execution_state, module.output_ready,
                module.fallback_selected, module.fallback_used, module.included,
                module.execution_ordinal,
                module.function_hash = $3 AS definition_fingerprint_matches,
                association.message_position,
                chat.attempt_id = attempt.id AS chat_belongs_to_attempt,
                message.chunk AS attributed_message_chunk
         FROM trace_attempt AS attempt
         JOIN trace_attempt_prompt_module AS module
           ON module.attempt_id = attempt.id
         LEFT JOIN trace_attempt_prompt_module_chat_message AS association
           ON association.attempt_id = module.attempt_id
          AND association.module_id = module.module_id
         LEFT JOIN trace_attempt_chat AS chat
           ON chat.id = association.chat_id
          AND chat.attempt_id = attempt.id
         LEFT JOIN trace_attempt_chat_message AS message
           ON message.chat_id = chat.id
          AND message.position = association.message_position
         WHERE attempt.turn_id = $1 AND attempt.outcome = 'published'
           AND module.module_id = $2\`,
        [SMOKE_INPUT.turnId, SMOKE_INPUT.expectedHttpModule.id,
          SMOKE_INPUT.expectedHttpModule.definitionFingerprint],
      );
      out.expectedHttpModuleTrace = {
        publishedAttemptCount,
        modules: moduleRows.rows,
      };
    }
    out.configurationFingerprint = await configurationFingerprint();
  } else if (SMOKE_INPUT.action === "delete-queued") {
    // Atomic guarded delete of this run's own still-unassigned message —
    // and, when the engagement schema is present, of that message's own
    // engagement assessment (a 1:1 satellite written atomically with the
    // message at ingest; leaving it behind would dangle or block the
    // parent delete on its foreign key).
    //
    // Serialized against the worker's claim path: this transaction takes
    // the SAME advisory lock the claim path takes (before any row lock, the
    // same order the worker uses), so no claim can interleave between the
    // assessment delete and the parent delete. The turn_id IS NULL
    // predicate is therefore evaluated atomically for both statements:
    // either the message is still unassigned (assessment and parent are
    // deleted together) or it was already claimed (both delete nothing) —
    // an assessment is never removed from a retained message.
    await client.query("BEGIN");
    let settled = false;
    try {
      await client.query("SELECT pg_advisory_xact_lock($1)", [
        CLAIM_ADVISORY_LOCK_KEY,
      ]);
      const engagementPresent = await scalar("(SELECT to_regclass('public.engagement_message_assessment') IS NOT NULL)");
      if (engagementPresent === true) {
        await client.query(
          "DELETE FROM engagement_message_assessment a USING conversation_message m WHERE a.message_id = m.id AND m.id = $1 AND m.content = $2 AND m.turn_id IS NULL",
          [SMOKE_INPUT.messageId, SMOKE_INPUT.marker],
        );
      }
      const result = await client.query(
        "DELETE FROM conversation_message WHERE id = $1 AND content = $2 AND turn_id IS NULL",
        [SMOKE_INPUT.messageId, SMOKE_INPUT.marker],
      );
      await client.query("COMMIT");
      settled = true;
      out.rowCount = result.rowCount;
      out.engagementDeleted = engagementPresent === true;
    } finally {
      if (!settled) {
        try { await client.query("ROLLBACK"); } catch { /* connection-level failure */ }
      }
    }
  } else if (SMOKE_INPUT.action === "delete-full-turn") {
    await client.query("BEGIN");
    let settled = false;
    try {
      const turnRow = (await client.query(
        "SELECT id, status, attempt, selected_pattern_id, (error IS NOT NULL) AS has_error, created_at, completed_at FROM conversation_turn WHERE id = $1 FOR UPDATE",
        [SMOKE_INPUT.turnId],
      )).rows[0];
      if (turnRow === undefined) {
        await client.query("ROLLBACK");
        settled = true;
        out.deleted = false;
        out.reason = "turn-row-vanished";
      } else if (turnRow.status !== "completed" && turnRow.status !== "failed") {
        await client.query("ROLLBACK");
        settled = true;
        out.deleted = false;
        out.reason = "turn-not-settled:" + String(turnRow.status);
      } else {
        const compRows = (await client.query(
          "SELECT id, role FROM conversation_message WHERE turn_id = $1 ORDER BY seq",
          [SMOKE_INPUT.turnId],
        )).rows;
        const users = compRows.filter((entry) => entry.role === "user");
        const contentOk = users.length === 1 && users[0].id === SMOKE_INPUT.messageId
          && (await scalar("(SELECT EXISTS (SELECT 1 FROM conversation_message WHERE id = $1 AND content = $2 AND turn_id = $3))", [SMOKE_INPUT.messageId, SMOKE_INPUT.marker, SMOKE_INPUT.turnId])) === true;
        if (!contentOk) {
          await client.query("ROLLBACK");
          settled = true;
          out.deleted = false;
          out.reason = "composition-not-exclusive";
          out.composition = compRows.map((entry) => ({ role: entry.role, id: entry.id }));
        } else {
          // Trace rows (worker attempt tracing, migration 0002): delete ONLY
          // this turn's own trace rows, inside this same guarded transaction,
          // after the ownership/composition checks above. Refuse when an
          // unrelated turn's trace rows reference this turn's messages (a
          // later turn's context or chat snapshots legitimately cite prior
          // history — destroying those references would corrupt the other
          // turn's trace and is never this cleanup's authority). Legacy
          // compatibility: a pre-tracing schema has no trace tables, so there
          // is nothing to guard or delete and the path is skipped entirely.
          out.trace = { present: false, refused: false, foreignReferences: 0, deletedCounts: {} };
          let traceRefused = false;
          const tracePresent = await scalar("(SELECT to_regclass('public.trace_attempt') IS NOT NULL)");
          if (tracePresent === true) {
            out.trace.present = true;
            const messageIds = compRows.map((entry) => entry.id);
            const foreignContext = await scalar(
              "(SELECT count(*) FROM trace_attempt_context c JOIN trace_attempt a ON a.id = c.attempt_id"
              + " WHERE c.message_id = ANY($1::uuid[]) AND a.turn_id <> $2)",
              [messageIds, SMOKE_INPUT.turnId],
            );
            const foreignChat = await scalar(
              "(SELECT count(*) FROM trace_attempt_chat_message m JOIN trace_attempt_chat ch ON ch.id = m.chat_id"
              + " JOIN trace_attempt a ON a.id = ch.attempt_id"
              + " WHERE m.source_message_id = ANY($1::uuid[]) AND a.turn_id <> $2)",
              [messageIds, SMOKE_INPUT.turnId],
            );
            const foreignTotal = Number(foreignContext ?? 0) + Number(foreignChat ?? 0);
            out.trace.foreignReferences = foreignTotal;
            if (foreignTotal > 0) {
              traceRefused = true;
              out.trace.refused = true;
              out.reason = "foreign-trace-references";
            } else {
              const attemptIds = "(SELECT id FROM trace_attempt WHERE turn_id = $1)";
              const chatIds = "(SELECT ch.id FROM trace_attempt_chat ch WHERE ch.attempt_id IN " + attemptIds + ")";
              const decisionIds = "(SELECT d.id FROM trace_attempt_decision d WHERE d.attempt_id IN " + attemptIds + ")";
              const counts = {};
              const promptModulesPresent = await scalar(
                "SELECT to_regclass('public.trace_attempt_prompt_module') IS NOT NULL",
              );
              if (promptModulesPresent === true) {
                counts.promptModuleChatMessages = (await client.query(
                  "DELETE FROM trace_attempt_prompt_module_chat_message WHERE attempt_id IN " + attemptIds,
                  [SMOKE_INPUT.turnId],
                )).rowCount;
                counts.promptModuleProbabilities = (await client.query(
                  "DELETE FROM trace_attempt_prompt_module_probability WHERE attempt_id IN " + attemptIds,
                  [SMOKE_INPUT.turnId],
                )).rowCount;
                counts.promptModules = (await client.query(
                  "DELETE FROM trace_attempt_prompt_module WHERE attempt_id IN " + attemptIds,
                  [SMOKE_INPUT.turnId],
                )).rowCount;
              }
              counts.chatChoices = (await client.query(
                "DELETE FROM trace_attempt_chat_choice WHERE chat_id IN " + chatIds, [SMOKE_INPUT.turnId])).rowCount;
              counts.chatMessages = (await client.query(
                "DELETE FROM trace_attempt_chat_message WHERE chat_id IN " + chatIds, [SMOKE_INPUT.turnId])).rowCount;
              counts.chat = (await client.query(
                "DELETE FROM trace_attempt_chat WHERE attempt_id IN " + attemptIds, [SMOKE_INPUT.turnId])).rowCount;
              counts.decisionProbabilities = (await client.query(
                "DELETE FROM trace_attempt_decision_probability WHERE decision_id IN " + decisionIds, [SMOKE_INPUT.turnId])).rowCount;
              counts.decisions = (await client.query(
                "DELETE FROM trace_attempt_decision WHERE attempt_id IN " + attemptIds, [SMOKE_INPUT.turnId])).rowCount;
              counts.patterns = (await client.query(
                "DELETE FROM trace_attempt_pattern WHERE attempt_id IN " + attemptIds, [SMOKE_INPUT.turnId])).rowCount;
              counts.contexts = (await client.query(
                "DELETE FROM trace_attempt_context WHERE attempt_id IN " + attemptIds, [SMOKE_INPUT.turnId])).rowCount;
              counts.attempts = (await client.query(
                "DELETE FROM trace_attempt WHERE turn_id = $1", [SMOKE_INPUT.turnId])).rowCount;
              out.trace.deletedCounts = counts;
            }
          }
          // Cleanup the exact source-turn dependency closure. Every child is
          // re-verified under this transaction; anything linked to another
          // turn, a canonical/shared projection, a mixed temporal summary, or
          // an applied promotion is retained. The ingest cursor is deliberately
          // NOT rewound: its watermark UUID is now an ordered position token,
          // not an FK ownership reference, and counters remain normal state.
          out.memory = {
            present: false,
            refused: false,
            deletedCounts: {},
            mixedRuns: 0,
            sharedFactReferences: 0,
            mixedTemporalSummaries: 0,
            sharedOperationRows: 0,
            watermarkPreserved: false,
          };
          let memoryRefused = false;
          const memoryPresent = await scalar("(SELECT to_regclass('public.memory_fact') IS NOT NULL)");
          if (memoryPresent === true) {
            out.memory.present = true;
            const memoryMessageIds = compRows.map((entry) => entry.id);
            const runIds = "(SELECT run_id FROM memory_run_turn WHERE turn_id = $1)";
            out.memory.mixedRuns = await scalar(
              \`SELECT count(*) FROM (
                 SELECT run_id FROM memory_run_turn
                 WHERE run_id IN \${runIds}
                 GROUP BY run_id HAVING bool_or(turn_id <> $1)
               ) mixed\`,
              [SMOKE_INPUT.turnId],
            );
            out.memory.mixedTemporalSummaries = await scalar(
              \`SELECT count(DISTINCT source.summary_id)
               FROM memory_temporal_summary_message source
               WHERE source.message_id = ANY($1::uuid[])
                 AND EXISTS (
                   SELECT 1 FROM memory_temporal_summary_message other
                   WHERE other.summary_id = source.summary_id
                     AND NOT (other.message_id = ANY($1::uuid[]))
                 )\`,
              [memoryMessageIds],
            );
            out.memory.appliedPromotionItems = await scalar(
              \`SELECT count(*) FROM memory_promotion_item item
               JOIN memory_promotion promotion USING (promotion_id)
               WHERE promotion.run_id IN \${runIds} AND item.outcome = 'applied'\`,
              [SMOKE_INPUT.turnId],
            );
            out.memory.pendingPromotions = await scalar(
              \`SELECT count(*) FROM memory_promotion promotion
               WHERE promotion.run_id IN \${runIds} AND promotion.status <> 'completed'\`,
              [SMOKE_INPUT.turnId],
            );
            const sharedFactQuery = \`SELECT count(*) FROM memory_fact fact
       WHERE fact.turn_id = $1
         AND (
           EXISTS (
             SELECT 1 FROM memory_observation_evidence evidence
             JOIN memory_observation observation ON observation.id = evidence.observation_id
             WHERE evidence.fact_id = fact.id AND observation.run_id NOT IN \${runIds}
           ) OR EXISTS (
             SELECT 1 FROM memory_observation_omission_evidence evidence
             JOIN memory_observation_omission omission ON omission.id = evidence.omission_id
             WHERE evidence.fact_id = fact.id AND omission.run_id NOT IN \${runIds}
           ) OR EXISTS (
             SELECT 1 FROM memory_canonical_observation canonical
             WHERE fact.fact_key = ANY(canonical.source_fact_keys || canonical.contradiction_fact_keys)
           ) OR EXISTS (
             SELECT 1 FROM memory_observation_history history
             WHERE fact.fact_key = ANY(history.source_fact_keys || history.contradiction_fact_keys)
           ) OR EXISTS (
             SELECT 1 FROM memory_promotion_item item
             WHERE fact.fact_key = ANY(item.source_fact_keys || item.contradiction_fact_keys)
               AND item.source_run_id NOT IN \${runIds}
           ) OR EXISTS (
             SELECT 1 FROM memory_semantic_shadow_candidate candidate
             JOIN memory_semantic_shadow_attempt attempt ON attempt.id = candidate.attempt_id
             WHERE candidate.fact_key = fact.fact_key
               AND attempt.turn_id IS DISTINCT FROM $1
               AND (
                 attempt.turn_id IS NOT NULL OR NOT EXISTS (
                   SELECT 1 FROM memory_operation recall
                   WHERE recall.id = attempt.recall_operation_id
                     AND (recall.turn_id = $1 OR EXISTS (
                       SELECT 1 FROM memory_operation_turn source
                       WHERE source.operation_id = recall.id AND source.turn_id = $1
                     ))
                 )
               )
           ) OR EXISTS (
             SELECT 1 FROM article_reaction reaction
             WHERE reaction.fact_key = fact.fact_key
           )
         )\`;
            out.memory.sharedFactReferences = await scalar(sharedFactQuery, [SMOKE_INPUT.turnId]);
            out.memory.sharedOperationRows = await scalar(
              "SELECT count(DISTINCT operation.id) FROM memory_operation operation"
              + " WHERE (operation.turn_id = $1 OR EXISTS (SELECT 1 FROM memory_operation_turn source"
              + " WHERE source.operation_id = operation.id AND source.turn_id = $1))"
              + " AND ((operation.turn_id IS NOT NULL AND operation.turn_id <> $1)"
              + " OR EXISTS (SELECT 1 FROM memory_operation_turn other"
              + " WHERE other.operation_id = operation.id AND other.turn_id <> $1))",
              [SMOKE_INPUT.turnId],
            );
            const routineReferences = await scalar(
              \`SELECT count(*) FROM routine_announcement
               WHERE message_id = ANY($1::uuid[])\`,
              [memoryMessageIds],
            );
            if (
              out.memory.mixedRuns > 0 ||
              out.memory.mixedTemporalSummaries > 0 ||
              out.memory.appliedPromotionItems > 0 ||
              out.memory.pendingPromotions > 0 ||
              out.memory.sharedFactReferences > 0 ||
              out.memory.sharedOperationRows > 0 ||
              routineReferences > 0
            ) {
              memoryRefused = true;
              out.memory.refused = true;
              out.reason = "shared-or-mixed-memory-dependency";
            }
            if (!memoryRefused) {
              const counts = out.memory.deletedCounts;
              const shadowAttempts = await client.query(
                "DELETE FROM memory_semantic_shadow_attempt WHERE turn_id = $1",
                [SMOKE_INPUT.turnId],
              );
              counts.semanticShadowAttempts = shadowAttempts.rowCount;

              const exclusiveSummaries = await client.query(
                \`DELETE FROM memory_temporal_summary summary
                 WHERE EXISTS (
                   SELECT 1 FROM memory_temporal_summary_message source
                   WHERE source.summary_id = summary.id
                     AND source.message_id = ANY($1::uuid[])
                 ) AND NOT EXISTS (
                   SELECT 1 FROM memory_temporal_summary_message other
                   WHERE other.summary_id = summary.id
                     AND NOT (other.message_id = ANY($1::uuid[]))
                 )\`,
                [memoryMessageIds],
              );
              counts.temporalSummaries = exclusiveSummaries.rowCount;

              const extractionRows = await client.query(
                "DELETE FROM memory_turn_extraction WHERE turn_id = $1",
                [SMOKE_INPUT.turnId],
              );
              counts.extractions = extractionRows.rowCount;

              const runRows = await client.query(
                \`DELETE FROM memory_observation WHERE run_id IN \${runIds}\`,
                [SMOKE_INPUT.turnId],
              );
              counts.observations = runRows.rowCount;
              const omissionRows = await client.query(
                \`DELETE FROM memory_observation_omission WHERE run_id IN \${runIds}\`,
                [SMOKE_INPUT.turnId],
              );
              counts.omissions = omissionRows.rowCount;
              const promotionItems = await client.query(
                \`DELETE FROM memory_promotion_item
                 WHERE promotion_id IN (SELECT promotion_id FROM memory_promotion WHERE run_id IN \${runIds})\`,
                [SMOKE_INPUT.turnId],
              );
              counts.promotionItems = promotionItems.rowCount;
              const promotionRows = await client.query(
                \`DELETE FROM memory_promotion WHERE run_id IN \${runIds}\`,
                [SMOKE_INPUT.turnId],
              );
              counts.promotions = promotionRows.rowCount;
              const runOperations = await client.query(
                \`DELETE FROM memory_operation WHERE run_id IN \${runIds}\`,
                [SMOKE_INPUT.turnId],
              );
              counts.runOperations = runOperations.rowCount;
              const runTurns = await client.query(
                \`DELETE FROM memory_run_turn WHERE run_id IN \${runIds}\`,
                [SMOKE_INPUT.turnId],
              );
              counts.runTurns = runTurns.rowCount;
              const runs = await client.query(
                \`DELETE FROM memory_run WHERE run_id IN \${runIds}\`,
                [SMOKE_INPUT.turnId],
              );
              counts.runs = runs.rowCount;

              const directOperations = await client.query(
                "DELETE FROM memory_operation WHERE turn_id = $1",
                [SMOKE_INPUT.turnId],
              );
              counts.directOperations = directOperations.rowCount;
              const exclusiveOperations = await client.query(
                \`DELETE FROM memory_operation operation
                 WHERE operation.id IN (
                   SELECT source.operation_id FROM memory_operation_turn source
                   WHERE source.turn_id = $1
                   GROUP BY source.operation_id
                   HAVING count(*) = 1
                 ) AND operation.run_id IS NULL\`,
                [SMOKE_INPUT.turnId],
              );
              counts.exclusiveOperations = exclusiveOperations.rowCount;
              const operationLinks = await client.query(
                "DELETE FROM memory_operation_turn WHERE turn_id = $1",
                [SMOKE_INPUT.turnId],
              );
              counts.operationLinks = operationLinks.rowCount;

              const factSourceMessages = await client.query(
                \`DELETE FROM memory_fact_source_message source
                 USING memory_fact fact
                 WHERE source.fact_id = fact.id AND fact.turn_id = $1\`,
                [SMOKE_INPUT.turnId],
              );
              counts.factSourceMessages = factSourceMessages.rowCount;
              const facts = await client.query(
                "DELETE FROM memory_fact WHERE turn_id = $1",
                [SMOKE_INPUT.turnId],
              );
              counts.facts = facts.rowCount;
              const articleShares = await client.query(
                "DELETE FROM article_share WHERE turn_id = $1",
                [SMOKE_INPUT.turnId],
              );
              counts.articleShares = articleShares.rowCount;
              out.memory.watermarkPreserved = await scalar(
                "SELECT EXISTS (SELECT 1 FROM memory_ingest_state WHERE watermark_turn_id = $1)",
                [SMOKE_INPUT.turnId],
              );
            }
          }
          // Engagement-domain rows (migration 0006): each user message's
          // engagement assessment is that message's own 1:1 ingest-time
          // satellite (written atomically with it), so it is deleted with
          // the turn's messages inside this same guarded transaction. No
          // foreign-reference refusal is needed: an assessment references
          // exactly its own message and never another turn's data. Legacy
          // compatibility: a pre-engagement schema has no assessment table,
          // so the path is skipped entirely, like the trace guard above.
          out.engagement = { present: false, deletedCount: 0 };
          const engagementPresent = await scalar("(SELECT to_regclass('public.engagement_message_assessment') IS NOT NULL)");
          if (engagementPresent === true) {
            out.engagement.present = true;
            const d0 = await client.query(
              "DELETE FROM engagement_message_assessment a USING conversation_message m WHERE a.message_id = m.id AND m.turn_id = $1",
              [SMOKE_INPUT.turnId],
            );
            out.engagement.deletedCount = d0.rowCount;
          }
          if (traceRefused || memoryRefused) {
            // Refused mid-transaction: roll back so nothing — not even the
            // trace phase — is partially deleted.
            await client.query("ROLLBACK");
            settled = true;
            out.deleted = false;
          } else {
            const d1 = await client.query("DELETE FROM conversation_message WHERE turn_id = $1", [SMOKE_INPUT.turnId]);
            const d2 = await client.query("DELETE FROM conversation_turn WHERE id = $1 AND status IN ('completed','failed')", [SMOKE_INPUT.turnId]);
            await client.query("COMMIT");
            settled = true;
            out.deleted = d2.rowCount === 1;
            out.reason = d2.rowCount === 1 ? null : "turn-delete-affected-no-rows";
            out.deletedMessageIds = compRows.map((entry) => entry.id);
            out.deletedMessageCount = d1.rowCount;
            out.turn = turnShape(turnRow);
            out.turn.latencyMs = turnRow.completed_at === null || turnRow.created_at === null
              ? null
              : Number(new Date(turnRow.completed_at) - new Date(turnRow.created_at));
            out.composition = { messages: compRows.length, userMessages: users.length, exclusiveToThisRun: true };
          }
        }
      }
    } finally {
      if (!settled) {
        try { await client.query("ROLLBACK"); } catch { /* connection-level failure */ }
      }
    }
  } else if (SMOKE_INPUT.action === "post-state") {
    out.smokeRows = await scalar("(SELECT count(*) FROM conversation_message WHERE client_key LIKE $1 OR content LIKE $1)", [SMOKE_INPUT.smokePrefix + "%"]);
    out.messages = await scalar("(SELECT count(*) FROM conversation_message)");
    out.turns = await scalar("(SELECT count(*) FROM conversation_turn)");
    out.queuedUserMessages = await scalar("(SELECT count(*) FROM conversation_message WHERE role='user' AND turn_id IS NULL)");
    out.inFlightTurns = await scalar("(SELECT count(*) FROM conversation_turn WHERE status='in_flight')");
    out.configurationFingerprint = await configurationFingerprint();
  } else {
    out.ok = false;
    out.error = "unknown action: " + String(SMOKE_INPUT.action);
  }
} catch (error) {
  out.ok = false;
  out.error = SMOKE_INPUT.expectedHttpModule !== undefined
    && (SMOKE_INPUT.action === "preflight" || SMOKE_INPUT.action === "retained-state")
    ? "expected_http_prompt_module_check_failed"
    : String(error && error.message ? error.message : error).split("\\n", 1)[0];
} finally {
  await client.end();
}
console.log("SMOKE_JSON:" + JSON.stringify(out));
`;

/**
 * Assemble the pod-side script for one action: the fixed body plus one
 * injection-safe JSON constant (the payload carries only strings, numbers,
 * and booleans this script itself produced).
 */
const TEST_CONFIGURATION_FINGERPRINT_KEY = "0".repeat(64);

/**
 * Optional operator-supplied expectation for one provisioned HTTP module.
 * Both values are treated as private run inputs and must never be logged.
 */
/** Extract the sha256 digest from a container imageID (repo@digest or docker-pullable://repo@digest). */
export function digestFromImageId(imageId) {
  const text = String(imageId ?? "");
  const at = text.lastIndexOf("@");
  if (at === -1) return null;
  const digest = text.slice(at + 1);
  return /^sha256:[0-9a-f]{64}$/.test(digest) ? digest : null;
}

/**
 * Optional ship-runner pinning of this smoke to the exact deployed pods and
 * image digests verified at deploy time. When any of the four
 * E2E_DEPLOYED_EXPECT_* values is set, all four must be set and valid;
 * partial or invalid pinning fails closed (never ignored). When none is
 * set (standalone smoke invocation), the smoke retains its original
 * preflight behaviour. Pod names and digests are not secrets.
 */
export function deployedPinFromEnvironment(environment) {
  const webPod = environment.E2E_DEPLOYED_EXPECT_WEB_POD;
  const workerPod = environment.E2E_DEPLOYED_EXPECT_WORKER_POD;
  const webImageId = environment.E2E_DEPLOYED_EXPECT_WEB_IMAGE_ID;
  const workerImageId = environment.E2E_DEPLOYED_EXPECT_WORKER_IMAGE_ID;
  const values = [webPod, workerPod, webImageId, workerImageId];
  if (values.every((value) => value === undefined)) return null;
  const podOk = (value) => typeof value === "string" && value.length > 0 && !/\s/.test(value);
  if (!values.every((value) => typeof value === "string" && value.length > 0) ||
    !podOk(webPod) || !podOk(workerPod) ||
    digestFromImageId(webImageId) === null || digestFromImageId(workerImageId) === null) {
    throw new Error("deployed_pin_configuration_invalid");
  }
  return {
    webPod,
    workerPod,
    webDigest: digestFromImageId(webImageId),
    workerDigest: digestFromImageId(workerImageId),
  };
}

/**
 * Verify preflight deployment evidence against a ship pin. Input is
 * content-free (pod names, image IDs, namespace). Returns a content-free
 * reason; never echoes pod names, image references, or digests in the
 * reason beyond the fixed codes below.
 */
export function verifyDeployedPin(deployment, pin, namespace) {
  if (namespace !== "companion-np") return { passed: false, reason: "namespace_not_pinned_non_production" };
  if (deployment?.webPod !== pin.webPod) return { passed: false, reason: "web_pod_mismatch" };
  if (deployment?.workerPod !== pin.workerPod) return { passed: false, reason: "worker_pod_mismatch" };
  if (digestFromImageId(deployment?.webImageId) !== pin.webDigest) return { passed: false, reason: "web_digest_mismatch" };
  if (digestFromImageId(deployment?.workerImageId) !== pin.workerDigest) return { passed: false, reason: "worker_digest_mismatch" };
  return { passed: true, reason: "verified" };
}

export function expectedHttpPromptModuleFromEnvironment(environment) {
  const id = environment.E2E_DEPLOYED_EXPECT_HTTP_MODULE_ID;
  const definitionFingerprint = environment.E2E_DEPLOYED_EXPECT_HTTP_MODULE_FINGERPRINT;
  if (id === undefined && definitionFingerprint === undefined) return null;
  if (
    typeof id !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id) ||
    typeof definitionFingerprint !== "string" ||
    !/^[a-f0-9]{64}$/.test(definitionFingerprint)
  ) {
    throw new Error("expected_http_prompt_module_configuration_invalid");
  }
  return { id, definitionFingerprint };
}

/** Validate only content-free trace metadata; result reasons are safe to report. */
export function evaluateExpectedHttpPromptModuleTrace(trace) {
  if (trace === null || typeof trace !== "object") return { passed: false, reason: "trace_missing" };
  if (trace.publishedAttemptCount !== 1) {
    return {
      passed: false,
      reason: trace.publishedAttemptCount > 1 ? "published_attempt_ambiguous" : "published_attempt_missing",
    };
  }
  if (!Array.isArray(trace.modules) || trace.modules.length === 0) {
    return { passed: false, reason: "module_trace_missing" };
  }
  if (trace.modules.length !== 1) return { passed: false, reason: "module_trace_ambiguous" };
  const module = trace.modules[0];
  if (module.definition_fingerprint_matches !== true) return { passed: false, reason: "definition_mismatch" };
  if (module.execution_mode !== "http_post") return { passed: false, reason: "execution_mode_mismatch" };
  if (module.activation_mode !== "every_turn" || module.decision_state !== "not_required" || module.selected !== true) {
    return { passed: false, reason: "every_turn_activation_missing" };
  }
  if (module.execution_state !== "succeeded" || module.output_ready !== true || !Number.isInteger(module.execution_ordinal)) {
    return { passed: false, reason: "execution_not_succeeded" };
  }
  if (module.fallback_selected !== false || module.fallback_used !== false) {
    return { passed: false, reason: "fallback_used" };
  }
  if (module.included !== true) return { passed: false, reason: "output_not_included" };
  if (
    !Number.isInteger(module.message_position) ||
    module.message_position < 0 ||
    module.chat_belongs_to_attempt !== true ||
    module.attributed_message_chunk !== "prompt_module"
  ) {
    return { passed: false, reason: "prompt_module_attribution_missing" };
  }
  return { passed: true, reason: "verified" };
}

export function buildPodActionScript(payload) {
  const input = {
    ...payload,
    configurationFingerprintKey:
      payload.configurationFingerprintKey ?? TEST_CONFIGURATION_FINGERPRINT_KEY,
  };
  return `import pg from "pg";\nconst SMOKE_INPUT = ${JSON.stringify(input)};\n${POD_ACTION_SCRIPT_BODY}`;
}

// ---------------------------------------------------------------------------
// Graceful shutdown controller
// ---------------------------------------------------------------------------

/**
 * SIGINT/SIGTERM semantics: the first signal requests a graceful stop (the
 * journey's wait loops abort via `waitOrStop`, retained-state verification
 * still runs, and the process exits non-zero only after verification); a second signal
 * means the operator insists and `onHardExit` runs immediately. SIGKILL
 * cannot be handled at all — the persisted ownership marker is the recovery
 * trail for that case.
 */
export function createShutdownController({
  registerSignal = (signal, handler) => { process.on(signal, handler); },
  /** Invoked when a second signal insists on an immediate exit. */
  onHardExit = () => process.exit(1),
} = {}) {
  const state = {
    requested: false,
    signal: null,
    hardExit: false,
    handlers: [],
  };
  const handle = (signal) => {
    if (!state.requested) {
      state.requested = true;
      state.signal = signal;
      return "graceful";
    }
    state.hardExit = true;
    return "hard";
  };
  for (const signal of ["SIGINT", "SIGTERM"]) {
    registerSignal(signal, () => { applySignal(signal); });
    state.handlers.push(signal);
  }
  /** One entry point for both real signals and programmatic requests. */
  const applySignal = (signal) => {
    const mode = handle(signal);
    if (mode === "hard") {
      onHardExit();
    }
    return mode;
  };
  return {
    /** Request a stop programmatically (used by tests and the runner). */
    request(signal = "SIGTERM") {
      return applySignal(signal);
    },
    get requested() {
      return state.requested;
    },
    get hardExit() {
      return state.hardExit;
    },
    get signal() {
      return state.signal;
    },
    /**
     * Await inside polling loops: resolves normally while no stop is
     * requested; throws a `StopRequested` sentinel the moment one is.
     */
    async waitOrStop(sleepMs = 0) {
      if (state.requested) {
        throwStopRequested();
      }
      if (sleepMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, sleepMs));
      }
      if (state.requested) {
        throwStopRequested();
      }
    },
  };
}

function throwStopRequested() {
  const error = new Error("stop requested");
  error.name = "StopRequested";
  throw error;
}

// ---------------------------------------------------------------------------

/** A fresh unique synthetic marker (content) for one smoke run. */
export function buildMarker(now = new Date()) {
  return `e2e-deployed-smoke-${now.toISOString().replace(/[-:.]/g, "").slice(0, 15)}Z-${randomBytes(3).toString("hex")}`;
}
