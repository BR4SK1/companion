/**
 * Synthetic seed-data operations for the throwaway PostgreSQL container.
 *
 * Every statement runs inside the run's own container via `docker exec psql`
 * — the only database these helpers can ever reach is the disposable one the
 * run created. No real application database is addressed, and only synthetic
 * values are inserted.
 *
 * The worker's own migrations create the schema (applied at worker startup);
 * these helpers only insert/adjust rows for the journeys under test:
 * response patterns (runtime configuration by design — no rows are seeded by
 * migrations) and, for the history journey, completed past turns.
 */

import { spawn } from "node:child_process";

import { loadRunState } from "./state.mjs";

function psql(sql) {
  const state = loadRunState();
  return new Promise((resolve, reject) => {
    // `execFile`'s async form ignores an `input` option, which would leave
    // psql waiting on stdin forever — spawn explicitly and write the SQL.
    const child = spawn(
      "docker",
      [
        "exec", "-i",
        state.container,
        "psql", "-U", state.db.user, "-d", state.db.database,
        "-v", "ON_ERROR_STOP=1", "-qAt",
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`psql timed out after 30s`));
    }, 30_000);
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`psql spawn failed: ${String(error)}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(String(stdout));
      } else {
        reject(new Error(`psql failed (rc=${String(code)}): ${String(stderr).trim() || stdout.trim() || "no output"}`));
      }
    });
    child.stdin.on("error", () => {
      // EPIPE when docker exits early; the close handler reports it.
    });
    child.stdin.end(sql);
  });
}

export const PATTERNS = [
  {
    id: "e2e-greeting",
    selectionDescription: "The conversation is just starting and a brief friendly greeting fits.",
    responseGuidance: "E2E-GUIDANCE-GREETING: keep the reply short and friendly.",
    position: 0,
  },
  {
    id: "e2e-detail",
    selectionDescription: "The user asked a question that deserves a detailed thorough answer.",
    responseGuidance: "E2E-GUIDANCE-DETAIL: answer thoroughly and completely.",
    position: 1,
  },
];

/** Insert or refresh the synthetic response patterns as enabled rows. */

/** The synthetic identity text the chat prompt requires. Generic fixture
 *  content only: the owner-authored identity is runtime configuration, so
 *  the throwaway stack seeds its own structural value here. */
export const E2E_IDENTITY =
  "E2E-IDENTITY: you are the assistant under test in a disposable stack.";

/** Insert or refresh the synthetic chat identity row the worker requires. */
export async function seedIdentity() {
  await psql(
    `INSERT INTO chat_identity (id, content, revision)
     VALUES ('identity', '${E2E_IDENTITY}', 1)
     ON CONFLICT (id) DO UPDATE SET
       content = EXCLUDED.content, revision = EXCLUDED.revision;`,
  );
  const count = await psql(
    "SELECT count(*) FROM chat_identity WHERE id = 'identity';",
  );
  if (count.trim() !== "1") {
    throw new Error("failed to seed the chat identity row");
  }
}

/** Insert or refresh the synthetic response patterns as enabled rows. */
export async function seedPatterns() {
  const values = PATTERNS.map(
    (pattern) =>
      `('${pattern.id}', true, '${pattern.selectionDescription}', '${pattern.responseGuidance}', ${String(pattern.position)})`,
  ).join(",\n  ");
  await psql(`
    INSERT INTO response_pattern (id, enabled, selection_description, response_guidance, position)
    VALUES ${values}
    ON CONFLICT (id) DO UPDATE SET
      enabled = EXCLUDED.enabled,
      selection_description = EXCLUDED.selection_description,
      response_guidance = EXCLUDED.response_guidance,
      position = EXCLUDED.position;
  `);
  const count = await psql("SELECT count(*) FROM response_pattern WHERE enabled;");
  if (count.trim() !== String(PATTERNS.length)) {
    throw new Error(`expected ${String(PATTERNS.length)} enabled patterns, found ${count.trim()}`);
  }
}

/** Disable every response pattern (the decision step is then skipped). */
export async function disablePatterns() {
  await psql("UPDATE response_pattern SET enabled = false;");
  const count = await psql("SELECT count(*) FROM response_pattern WHERE enabled;");
  if (count.trim() !== "0") {
    throw new Error("failed to disable all response patterns");
  }
}

/**
 * Seed completed past turns (one user message and one assistant reply each)
 * directly as durable history, spread over three distinct UTC days. `seq` is
 * assigned explicitly and the identity sequence is advanced past the seeded
 * maximum so live ingestion continues after it without collision.
 *
 * Three days (rather than two) give two UTC-day boundaries in the visible
 * thread: the day-divider rendering emits a divider at day changes only,
 * never before the first message, so a two-day seed would render exactly
 * one divider.
 *
 * These rows are completed history: they never trigger turns, so the fake
 * provider sees no traffic from them.
 */
export async function seedHistory(turnCount) {
  if (!Number.isInteger(turnCount) || turnCount < 2) {
    throw new Error("turnCount must be an integer >= 2");
  }
  // Idempotent: the hook this runs in can execute more than once in a run,
  // and a fresh throwaway database never contains foreign rows with this
  // synthetic marker prefix.
  const existing = await psql(
    "SELECT count(*) FROM conversation_turn WHERE id::text LIKE '00000000-%';",
  );
  if (Number(existing.trim()) === turnCount) {
    return;
  }
  if (Number(existing.trim()) !== 0) {
    throw new Error(
      `unexpected pre-existing synthetic turns (${existing.trim()}), refusing to seed`,
    );
  }
  // Each day group stays inside its own UTC day: minute offsets are
  // relative to each group's start (10:00 UTC).
  const firstBreak = Math.ceil(turnCount / 3);
  const secondBreak = Math.ceil((2 * turnCount) / 3);
  const selects = [];
  for (let index = 1; index <= turnCount; index += 1) {
    const dayOffset = index <= firstBreak ? 3 : index <= secondBreak ? 2 : 1;
    const minuteOffset =
      index <= firstBreak
        ? index - 1
        : index <= secondBreak
          ? index - 1 - firstBreak
          : index - 1 - secondBreak;
    selects.push(
      `SELECT
        '00000000-0000-4000-8000-${String(index).padStart(12, "0")}'::uuid AS id,
        ${String(index)} AS n,
        ${String(dayOffset)}::int AS day_offset,
        ${String(minuteOffset)}::int AS minute_offset`,
    );
  }

  const sql = `
    WITH seed AS (
      ${selects.join("\n      UNION ALL\n      ")}
    ),
    turns AS (
      INSERT INTO conversation_turn (id, status, created_at, completed_at)
      SELECT
        s.id,
        'completed',
        (date_trunc('day', now() AT TIME ZONE 'UTC') - (s.day_offset * interval '1 day')) AT TIME ZONE 'UTC'
          + interval '10 hours' + (s.minute_offset * interval '1 minute'),
        (date_trunc('day', now() AT TIME ZONE 'UTC') - (s.day_offset * interval '1 day')) AT TIME ZONE 'UTC'
          + interval '10 hours' + (s.minute_offset * interval '1 minute') + interval '1 minute'
      FROM seed s
      RETURNING id, created_at
    ),
    numbered AS (
      SELECT
        t.id AS turn_id,
        t.created_at,
        s.n,
        row_number() OVER (ORDER BY t.created_at) AS seq_slot
      FROM turns t JOIN seed s ON s.id = t.id
    )
    INSERT INTO conversation_message (seq, role, content, turn_id, created_at)
    OVERRIDING SYSTEM VALUE
    SELECT
      n.seq_slot * 2 - 1,
      'user',
      'e2e-history-user-' || n.n,
      n.turn_id,
      n.created_at
    FROM numbered n
    UNION ALL
    SELECT
      n.seq_slot * 2,
      'assistant',
      'e2e-history-reply-' || n.n,
      n.turn_id,
      n.created_at + interval '1 minute'
    FROM numbered n;

    SELECT setval(pg_get_serial_sequence('conversation_message', 'seq'),
      (SELECT COALESCE(MAX(seq), 0) FROM conversation_message));

    SELECT 'seeded_turns=' || count(*) FROM conversation_turn WHERE id::text LIKE '00000000-%';
  `;
  const output = await psql(sql);
  const match = /seeded_turns=(\d+)/.exec(output);
  if (match === null || Number(match[1]) !== turnCount) {
    throw new Error(`history seeding incomplete: ${output.trim()}`);
  }
}

export async function countMessages() {
  const output = await psql("SELECT count(*) FROM conversation_message;");
  return Number(output.trim());
}

export async function messageRows() {
  const output = await psql(
    "SELECT seq, role, content FROM conversation_message ORDER BY seq;",
  );
  return output
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      const [seq, role, content] = line.split("|");
      return { seq: Number(seq), role, content };
    });
}
