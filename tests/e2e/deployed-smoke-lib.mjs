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
 * - `planCleanupDecision`: the conservative cleanup state machine. It
 *   deletes only what is provably this run's own data and PRESERVES
 *   (retains) whenever the state is uncertain or a turn is still in flight.
 * - `buildQueuedAtomicDelete` / `buildOwnMessageDelete` / `POD_ACTION_SCRIPT_BODY`:
 *   the exact SQL the runner executes pod-side. The queued delete's
 *   `turn_id IS NULL` predicate is evaluated on the locked row, so against
 *   the worker's claim (`pg_advisory_xact_lock` → pending `SELECT … FOR
 *   UPDATE` → `UPDATE … SET turn_id WHERE turn_id IS NULL`) it is correct
 *   in both interleavings: if the claim holds the row lock, this delete
 *   blocks and re-checks after the claim commits and deletes nothing; if
 *   this delete wins, the claim never sees the row.
 * - `createShutdownController`: SIGINT/SIGTERM become graceful stops — the
 *   journey aborts, the awaited cleanup still runs, and only then does the
 *   process exit (SIGKILL has no handler; the persisted ownership marker is
 *   the recovery trail for that case).
 */

import { createHash, randomBytes } from "node:crypto";

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
 * `own-message-only`, `retain` (with a reason; nothing was deleted).
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
    // Shared with unrelated traffic: remove ONLY this run's own row (id +
    // exact content, turn-scoped); the shared turn, its reply, and every
    // other message stay.
    return {
      mode: "own-message-only",
      retain: false,
      reason: "the turn was shared with unrelated traffic; only this run's own message row is removed and the residual is reported",
    };
  }
  if (turnRow.status === "completed" || turnRow.status === "failed") {
    return { mode: "full-turn", retain: false };
  }
  return { mode: "retain", retain: true, reason: `the turn settled into an unrecognized status (${String(turnRow.status)}); preserving everything` };
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

/**
 * Delete ONLY this run's own row out of a shared turn. Parameterized and
 * turn-scoped so it can never touch another turn's data.
 */
export function buildOwnMessageDelete(messageId, marker, turnId) {
  return {
    sql: "DELETE FROM conversation_message WHERE id = $1 AND content = $2 AND turn_id = $3",
    params: [messageId, marker, turnId],
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
  if (SMOKE_INPUT.action === "preflight") {
    out.tablesOk = await scalar("(SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='conversation_message') AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='conversation_turn'))");
    out.clientKeyIndexed = await scalar("(SELECT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='conversation_message_client_key_key'))");
    out.oneReplyPerTurn = await scalar("(SELECT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='conversation_turn_reply_idx'))");
    out.leftoverSmokeRows = await scalar("(SELECT count(*) FROM conversation_message WHERE client_key LIKE $1 OR content LIKE $1)", [SMOKE_INPUT.smokePrefix + "%"]);
    out.queuedUserMessages = await scalar("(SELECT count(*) FROM conversation_message WHERE role='user' AND turn_id IS NULL)");
    out.inFlightTurns = await scalar("(SELECT count(*) FROM conversation_turn WHERE status='in_flight')");
    out.enabledPatterns = await scalar("(SELECT count(*) FROM response_pattern WHERE enabled)");
    out.baselineMessages = await scalar("(SELECT count(*) FROM conversation_message)");
    out.baselineTurns = await scalar("(SELECT count(*) FROM conversation_turn)");
    out.newestMessageAgeMinutes = await scalar("(SELECT round(extract(epoch FROM (now() - max(created_at))) / 60) FROM conversation_message)");
    out.highestAllocatedSeq = await scalar("(SELECT COALESCE(max(seq), 0) FROM conversation_message)");
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
  } else if (SMOKE_INPUT.action === "delete-queued") {
    // Atomic guarded delete: the turn_id IS NULL predicate is re-evaluated
    // on the locked row, so this can never remove a claimed/claiming row.
    const result = await client.query(
      "DELETE FROM conversation_message WHERE id = $1 AND content = $2 AND turn_id IS NULL",
      [SMOKE_INPUT.messageId, SMOKE_INPUT.marker],
    );
    out.rowCount = result.rowCount;
  } else if (SMOKE_INPUT.action === "delete-own-message") {
    const result = await client.query(
      "DELETE FROM conversation_message WHERE id = $1 AND content = $2 AND turn_id = $3",
      [SMOKE_INPUT.messageId, SMOKE_INPUT.marker, SMOKE_INPUT.turnId],
    );
    out.rowCount = result.rowCount;
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
  } else {
    out.ok = false;
    out.error = "unknown action: " + String(SMOKE_INPUT.action);
  }
} catch (error) {
  out.ok = false;
  out.error = String(error && error.message ? error.message : error).split("\\n", 1)[0];
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
export function buildPodActionScript(payload) {
  return `import pg from "pg";\nconst SMOKE_INPUT = ${JSON.stringify(payload)};\n${POD_ACTION_SCRIPT_BODY}`;
}

// ---------------------------------------------------------------------------
// Graceful shutdown controller
// ---------------------------------------------------------------------------

/**
 * SIGINT/SIGTERM semantics: the first signal requests a graceful stop (the
 * journey's wait loops abort via `waitOrStop`, the awaited cleanup still
 * runs, and the process exits non-zero only after cleanup); a second signal
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
