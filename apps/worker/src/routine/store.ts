import { withTransaction, type PostgresPool, type PostgresPoolClient } from "@companion/postgres";
import { isValidTimezone } from "../memory/time.ts";
import {
  type RoutineUnavailablePeriod,
  currentRoutineUnavailablePeriod,
  nextRoutineTransition,
  renderRoutineAnnouncement,
  routineTransitionsAfter,
  scheduledRoutineStateAt,
} from "./runtime.ts";
import type {
  RoutineAnnouncementDraft,
  RoutineAppliedState,
  RoutineConfiguration,
  RoutineOccurrence,
  RoutineSnapshot,
  RoutineTransition,
} from "./types.ts";

const ROUTINE_RECONCILE_LOCK_KEY = 7_142_092_311;

export class RoutineConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RoutineConfigurationError";
  }
}

interface SettingsRow {
  timezone: string | null;
  departure_context: string | null;
}
interface TransitionRow {
  id: string | null;
  transition_key: string;
  weekday: number;
  local_minute: number;
  location: string | null;
  activity: string | null;
  available: boolean;
  interaction_context: string | null;
}
interface AnnouncementRow {
  id: string;
  transition_id: string;
  transition_key: string;
  local_date: string;
  scheduled_at: Date;
  timezone: string;
  departure_context: string | null;
  location: string | null;
  activity: string | null;
  resumes_at: Date | null;
  status: "pending" | "published" | "cancelled";
}
interface AppliedRow {
  transition_id: string;
  transition_key: string;
  local_date: string;
  scheduled_at: Date;
  applied_at: Date;
  location: string | null;
  activity: string | null;
  available: boolean;
  interaction_context: string | null;
}

function nonEmptyOptional(value: string | null): boolean {
  return value === null || value.trim().length > 0;
}

function validateConfiguration(
  settings: SettingsRow,
  transitions: readonly RoutineTransition[],
): void {
  if (settings.timezone === null || !isValidTimezone(settings.timezone)) {
    throw new RoutineConfigurationError("authoritative timezone is not configured or is not a valid IANA timezone");
  }
  if (!nonEmptyOptional(settings.departure_context)) {
    throw new RoutineConfigurationError("routine_settings.departure_context must be null or non-empty");
  }
  if (transitions.length === 0) {
    throw new RoutineConfigurationError("at least one enabled routine_transition is required");
  }
  const keys = new Set<string>();
  const slots = new Set<string>();
  for (const transition of transitions) {
    if (transition.key.trim().length === 0 || keys.has(transition.key)) {
      throw new RoutineConfigurationError("routine transition keys must be non-empty and unique");
    }
    keys.add(transition.key);
    if (!Number.isInteger(transition.weekday) || transition.weekday < 1 || transition.weekday > 7) {
      throw new RoutineConfigurationError("routine_transition.weekday must be ISO weekday 1 through 7");
    }
    if (!Number.isInteger(transition.localMinute) || transition.localMinute < 0 || transition.localMinute > 1439) {
      throw new RoutineConfigurationError("routine_transition.local_minute must be an integer from 0 through 1439");
    }
    const slot = `${String(transition.weekday)}:${String(transition.localMinute)}`;
    if (slots.has(slot)) {
      throw new RoutineConfigurationError("routine transitions cannot share a weekday and local minute");
    }
    slots.add(slot);
    if (!nonEmptyOptional(transition.location) || !nonEmptyOptional(transition.activity) ||
        !nonEmptyOptional(transition.interactionContext)) {
      throw new RoutineConfigurationError("optional routine text fields must be null or non-empty");
    }
  }
}

type RoutineQueryable = Pick<PostgresPool, "query">;

export async function loadRoutineConfiguration(
  pool: RoutineQueryable,
  authoritativeTimezone?: string | null,
): Promise<RoutineConfiguration | null> {
  // One statement is important here: callers such as the claim gate run at
  // READ COMMITTED, where separate settings/transition SELECTs can observe
  // different commits. The configured authoritative zone is read from the
  // singleton; worker composition may pin its startup snapshot so a zone edit
  // takes effect only after a controlled restart.
  const zone = authoritativeTimezone === undefined ? "settings.timezone" : "$1::text";
  const result = await pool.query<SettingsRow & TransitionRow>(
    `SELECT ${zone} AS timezone, s.departure_context,
            t.id, t.transition_key, t.weekday, t.local_minute, t.location,
            t.activity, t.available, t.interaction_context
     FROM routine_settings AS s
     CROSS JOIN companion_time_settings AS settings
     LEFT JOIN routine_transition AS t ON t.enabled = true
     WHERE s.id = true AND settings.id = true
     ORDER BY t.weekday, t.local_minute, t.transition_key`,
    authoritativeTimezone === undefined ? [] : [authoritativeTimezone],
  );
  const first = result.rows[0];
  if (first === undefined) return null;
  const settings: SettingsRow = {
    timezone: first.timezone,
    departure_context: first.departure_context,
  };
  const transitions: RoutineTransition[] = result.rows
    .filter((row) => row.id !== null)
    .map((row) => ({
      id: row.id!,
      key: row.transition_key,
      weekday: Number(row.weekday),
      localMinute: Number(row.local_minute),
      location: row.location,
      activity: row.activity,
      available: row.available,
      interactionContext: row.interaction_context,
    }));
  validateConfiguration(settings, transitions);
  return {
    timezone: settings.timezone!,
    departureContext: settings.departure_context,
    transitions,
  };
}

function sameUnavailablePeriodSince(
  scheduledAt: Date,
  now: Date,
  configuration: RoutineConfiguration,
): boolean {
  return scheduledAt.getTime() <= now.getTime() &&
    !scheduledRoutineStateAt(scheduledAt, configuration).available &&
    routineTransitionsAfter(scheduledAt, now, configuration)
      .every((occurrence) => !occurrence.available);
}

function sameAnnouncementPeriod(
  row: Pick<AnnouncementRow, "transition_id" | "local_date" | "scheduled_at" | "resumes_at">,
  period: RoutineUnavailablePeriod,
  now: Date,
  configuration: RoutineConfiguration,
): boolean {
  const anchor = period.start ?? period.current;
  const sameStartOccurrence = row.transition_id === anchor.transitionId &&
    row.local_date === anchor.localDate;
  const movedStartForward = sameStartOccurrence &&
    anchor.scheduledAt.getTime() > row.scheduled_at.getTime();

  // The original event's saved return boundary is historical evidence even
  // when reconciliation was down and the edited schedule rewrites the past.
  // A moved start at or after that boundary is a new period; if it was moved
  // before the boundary, the edit preserved continuity even after the old
  // return time has passed on the clock.
  if (movedStartForward && row.resumes_at !== null &&
      anchor.scheduledAt.getTime() >= row.resumes_at.getTime()) {
    return false;
  }
  if (sameUnavailablePeriodSince(row.scheduled_at, now, configuration)) return true;

  // Moving an already-applied unavailable start forward edits the current
  // schedule's reconstruction of the past, but does not itself mean
  // availability was observed. Preserve the event when the edited start was
  // before the original return boundary (or there was none) and the edited
  // schedule has remained unavailable through now.
  return sameStartOccurrence &&
    anchor.scheduledAt.getTime() >= row.scheduled_at.getTime() &&
    (row.resumes_at === null || anchor.scheduledAt.getTime() < row.resumes_at.getTime()) &&
    sameUnavailablePeriodSince(anchor.scheduledAt, now, configuration);
}

function mapApplied(row: AppliedRow): RoutineAppliedState {
  return {
    transitionId: row.transition_id,
    transitionKey: row.transition_key,
    localDate: typeof row.local_date === "string" ? row.local_date : new Date(row.local_date).toISOString().slice(0, 10),
    scheduledAt: row.scheduled_at,
    appliedAt: row.applied_at,
    location: row.location,
    activity: row.activity,
    available: row.available,
    interactionContext: row.interaction_context,
  };
}

export interface RoutineStore {
  /** Reconcile every due recurring transition; null means routine is unconfigured. */
  readonly reconcile: (now?: Date) => Promise<RoutineAppliedState | null>;
  /** Evaluate the current runtime configuration at the claim transaction's database time. */
  readonly canStartNewTurn: (client: PostgresPoolClient) => Promise<boolean>;
  /** Read-only scheduled/applied projection at the supplied instant, or null if unconfigured. */
  readonly getSnapshot: (now?: Date) => Promise<RoutineSnapshot | null>;
  /** Prepare the current pending notice on the conversation publication transaction. */
  readonly prepareAnnouncement: (client: PostgresPoolClient) => Promise<RoutineAnnouncementDraft | null>;
  /** Cancel a locked pending event when final pre-insert validation finds it expired. */
  readonly cancelAnnouncement: (
    client: PostgresPoolClient,
    draft: RoutineAnnouncementDraft,
    cancelledAt: Date,
  ) => Promise<void>;
  /** Link a durably published assistant message to its schedule event. */
  readonly recordAnnouncementPublication: (
    client: PostgresPoolClient,
    draft: RoutineAnnouncementDraft,
    messageId: string,
    publishedAt: Date,
  ) => Promise<void>;
}

export function createRoutineStore(input: {
  readonly pool: PostgresPool;
  /** Startup snapshot of the worker-wide timezone; null disables this feature. */
  readonly timezone?: string | null;
}): RoutineStore {
  const { pool } = input;

  const loadConfiguration = (queryable: RoutineQueryable) =>
    loadRoutineConfiguration(queryable, input.timezone);

  async function synchronizeAnnouncement(
    client: PostgresPoolClient,
    configuration: RoutineConfiguration,
    now: Date,
  ): Promise<RoutineAnnouncementDraft | null> {
    const period = currentRoutineUnavailablePeriod(now, configuration);
    if (period === null) {
      await client.query(
        `UPDATE routine_announcement
         SET status = 'cancelled', cancelled_at = $1, updated_at = $1
         WHERE status = 'pending'`,
        [now],
      );
      await client.query(
        `UPDATE routine_announcement
         SET status = 'ended', ended_at = $1, updated_at = $1
         WHERE status = 'published'`,
        [now],
      );
      return null;
    }

    const anchor = period.start ?? period.current;
    const published = await client.query<Pick<AnnouncementRow,
      "id" | "transition_id" | "local_date" | "scheduled_at" | "resumes_at"
    >>(
      `SELECT id, transition_id, local_date::text AS local_date, scheduled_at, resumes_at
       FROM routine_announcement
       WHERE status = 'published' ORDER BY published_at DESC FOR UPDATE`,
    );
    let alreadyAnnounced = false;
    for (const row of published.rows) {
      if (!alreadyAnnounced &&
          sameAnnouncementPeriod(row, period, now, configuration)) {
        alreadyAnnounced = true;
      } else {
        await client.query(
          `UPDATE routine_announcement
           SET status = 'ended', ended_at = $2, updated_at = $2
           WHERE id = $1 AND status = 'published'`,
          [row.id, now],
        );
      }
    }
    if (alreadyAnnounced) {
      await client.query(
        `UPDATE routine_announcement
         SET status = 'cancelled', cancelled_at = $1, updated_at = $1
         WHERE status = 'pending'`,
        [now],
      );
      return null;
    }

    const pending = await client.query<AnnouncementRow>(
      `SELECT id, transition_id, transition_key, local_date::text AS local_date,
              scheduled_at, timezone, departure_context, location, activity,
              resumes_at, status
       FROM routine_announcement
       WHERE status = 'pending'
       ORDER BY created_at DESC
       FOR UPDATE`,
    );
    let reusable: AnnouncementRow | undefined;
    for (const row of pending.rows) {
      if (reusable === undefined &&
          sameAnnouncementPeriod(row, period, now, configuration)) {
        reusable = row;
      } else {
        await client.query(
          `UPDATE routine_announcement
           SET status = 'cancelled', cancelled_at = $2, updated_at = $2
           WHERE id = $1 AND status = 'pending'`,
          [row.id, now],
        );
      }
    }

    const values = [
      anchor.transitionId,
      anchor.transitionKey,
      anchor.localDate,
      anchor.scheduledAt,
      configuration.timezone,
      configuration.departureContext,
      anchor.location,
      anchor.activity,
      period.resumes?.scheduledAt ?? null,
      now,
    ];
    let announcementId: string;
    if (reusable !== undefined) {
      const updated = await client.query<{ id: string }>(
        `UPDATE routine_announcement
         SET transition_id = $1, transition_key = $2, local_date = $3::date,
             scheduled_at = $4, timezone = $5, departure_context = $6,
             location = $7, activity = $8, resumes_at = $9, updated_at = $10
         WHERE id = $11 AND status = 'pending'
         RETURNING id`,
        [...values, reusable.id],
      );
      announcementId = updated.rows[0]?.id ?? (() => {
        throw new Error("pending routine announcement disappeared during synchronization");
      })();
    } else {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO routine_announcement
           (transition_id, transition_key, local_date, scheduled_at, timezone,
            departure_context, location, activity, resumes_at, status, created_at, updated_at)
         VALUES ($1, $2, $3::date, $4, $5, $6, $7, $8, $9, 'pending', $10, $10)
         RETURNING id`,
        values,
      );
      const row = inserted.rows[0];
      if (row === undefined) throw new Error("routine announcement insert returned no row");
      announcementId = row.id;
    }

    return {
      announcementId,
      transitionId: anchor.transitionId,
      localDate: anchor.localDate,
      scheduledAt: anchor.scheduledAt,
      validUntil: period.resumes?.scheduledAt ?? null,
      content: renderRoutineAnnouncement({
        period,
        timezone: configuration.timezone,
        departureContext: configuration.departureContext,
      }),
    };
  }

  async function reconcileInTransaction(
    client: PostgresPoolClient,
    requestedNow?: Date,
  ): Promise<{ readonly configuration: RoutineConfiguration | null; readonly applied: RoutineAppliedState | null; readonly now: Date }> {
    await client.query("SELECT pg_advisory_xact_lock($1)", [ROUTINE_RECONCILE_LOCK_KEY]);
    const clock = requestedNow === undefined
      ? await client.query<{ now: Date }>("SELECT clock_timestamp() AS now")
      : { rows: [{ now: requestedNow }] };
    const now = clock.rows[0]?.now;
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
      throw new Error("routine reconciliation clock query returned no valid timestamp");
    }
    // Load one coherent configuration revision after the lock, then use that
    // in-memory revision for every occurrence recorded by this transaction.
    // Editing schedule data takes effect without requiring a worker restart.
    const configuration = await loadConfiguration(client);
    if (configuration === null) {
      await client.query(
        `UPDATE routine_announcement
         SET status = 'cancelled', cancelled_at = $1, updated_at = $1
         WHERE status = 'pending'`,
        [now],
      );
      await client.query(
        `UPDATE routine_announcement
         SET status = 'ended', ended_at = $1, updated_at = $1
         WHERE status = 'published'`,
        [now],
      );
      return { configuration: null, applied: null, now };
    }

    const stateResult = await client.query<AppliedRow>(
      `SELECT transition_id, transition_key, local_date::text AS local_date,
              scheduled_at, applied_at, location, activity, available, interaction_context
       FROM routine_applied_state WHERE id = true FOR UPDATE`,
    );
    let state = stateResult.rows[0] === undefined ? null : mapApplied(stateResult.rows[0]);
    const occurrences = state === null
      ? [scheduledRoutineStateAt(now, configuration)]
      : routineTransitionsAfter(
          state.scheduledAt,
          now,
          configuration,
          state.transitionKey,
        );
    for (const occurrence of occurrences) {
      const appliedAt = new Date(now);
      await client.query(
        `INSERT INTO routine_applied_transition
           (transition_id, transition_key, local_date, scheduled_at, applied_at,
            location, activity, available, interaction_context)
         VALUES ($1, $2, $3::date, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (transition_id, local_date) DO NOTHING`,
        [
          occurrence.transitionId,
          occurrence.transitionKey,
          occurrence.localDate,
          occurrence.scheduledAt,
          appliedAt,
          occurrence.location,
          occurrence.activity,
          occurrence.available,
          occurrence.interactionContext,
        ],
      );
    }

    // The occurrence identity is (transition_id, local_date). Once an
    // occurrence has been recorded, later edits to that transition do not
    // rewrite its append-only history for that date. In particular, a moved
    // time or changed content can collide with a prior event; derive materialized
    // state from persisted history rather than the attempted (possibly new)
    // configuration values.
    const latestResult = await client.query<AppliedRow>(
      `SELECT transition_id, transition_key, local_date::text AS local_date,
              scheduled_at, applied_at, location, activity, available, interaction_context
       FROM routine_applied_transition
       ORDER BY scheduled_at DESC, transition_key COLLATE "C" DESC
       LIMIT 1`,
    );
    const latest = latestResult.rows[0];
    if (latest === undefined) throw new Error("routine has no applied history after reconciliation");
    state = mapApplied(latest);
    await client.query(
      `INSERT INTO routine_applied_state
         (id, transition_id, transition_key, local_date, scheduled_at, applied_at,
          location, activity, available, interaction_context)
       VALUES (true, $1, $2, $3::date, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (id) DO UPDATE SET
         transition_id = EXCLUDED.transition_id,
         transition_key = EXCLUDED.transition_key,
         local_date = EXCLUDED.local_date,
         scheduled_at = EXCLUDED.scheduled_at,
         applied_at = EXCLUDED.applied_at,
         location = EXCLUDED.location,
         activity = EXCLUDED.activity,
         available = EXCLUDED.available,
         interaction_context = EXCLUDED.interaction_context`,
      [
        state.transitionId,
        state.transitionKey,
        state.localDate,
        state.scheduledAt,
        state.appliedAt,
        state.location,
        state.activity,
        state.available,
        state.interactionContext,
      ],
    );
    await synchronizeAnnouncement(client, configuration, now);
    return { configuration, applied: state, now };
  }

  async function reconcile(requestedNow?: Date): Promise<RoutineAppliedState | null> {
    return withTransaction(pool, async (client) => {
      const result = await reconcileInTransaction(client, requestedNow);
      return result.applied;
    });
  }

  async function canStartNewTurn(client: PostgresPoolClient): Promise<boolean> {
    const configuration = await loadConfiguration(client);
    if (configuration === null) return true;
    const clock = await client.query<{ now: Date }>("SELECT clock_timestamp() AS now");
    const now = clock.rows[0]?.now;
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
      throw new Error("routine availability clock query returned no valid timestamp");
    }
    return scheduledRoutineStateAt(now, configuration).available;
  }

  async function prepareAnnouncement(
    client: PostgresPoolClient,
  ): Promise<RoutineAnnouncementDraft | null> {
    // Serialize lifecycle changes with the reconciler before locking the
    // runtime configuration. Conversation publication already holds the
    // conversation lock; no routine path takes those locks in reverse order.
    await client.query("SELECT pg_advisory_xact_lock($1)", [ROUTINE_RECONCILE_LOCK_KEY]);
    // Prevent an operator edit from changing the schedule after it has been
    // loaded. The publisher samples its final clock only after every lock and
    // row wait involved in preparing this event has completed.
    await client.query(`LOCK TABLE routine_settings, routine_transition IN SHARE MODE`);
    const clock = await client.query<{ now: Date }>("SELECT clock_timestamp() AS now");
    const now = clock.rows[0]?.now;
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
      throw new Error("routine announcement clock query returned no valid timestamp");
    }
    const configuration = await loadConfiguration(client);
    if (configuration === null) {
      await client.query(
        `UPDATE routine_announcement
         SET status = 'cancelled', cancelled_at = $1, updated_at = $1
         WHERE status = 'pending'`,
        [now],
      );
      await client.query(
        `UPDATE routine_announcement
         SET status = 'ended', ended_at = $1, updated_at = $1
         WHERE status = 'published'`,
        [now],
      );
      return null;
    }
    return synchronizeAnnouncement(client, configuration, now);
  }

  async function cancelAnnouncement(
    client: PostgresPoolClient,
    draft: RoutineAnnouncementDraft,
    cancelledAt: Date,
  ): Promise<void> {
    const result = await client.query(
      `UPDATE routine_announcement
       SET status = 'cancelled', cancelled_at = $2, updated_at = $2
       WHERE id = $1 AND status = 'pending'`,
      [draft.announcementId, cancelledAt],
    );
    if (result.rowCount !== 1) {
      throw new Error("pending routine announcement changed during final validation");
    }
  }

  async function recordAnnouncementPublication(
    client: PostgresPoolClient,
    draft: RoutineAnnouncementDraft,
    messageId: string,
    publishedAt: Date,
  ): Promise<void> {
    const result = await client.query(
      `UPDATE routine_announcement
       SET status = 'published', message_id = $2, published_at = $3,
           cancelled_at = NULL, ended_at = NULL, updated_at = $3
       WHERE id = $1 AND status = 'pending'`,
      [draft.announcementId, messageId, publishedAt],
    );
    if (result.rowCount !== 1) {
      throw new Error("routine announcement changed before publication completed");
    }
  }

  async function getSnapshot(requestedNow?: Date): Promise<RoutineSnapshot | null> {
    return withTransaction(
      pool,
      async (client) => {
        const clock = requestedNow === undefined
          ? await client.query<{ now: Date }>("SELECT clock_timestamp() AS now")
          : { rows: [{ now: new Date(requestedNow.getTime()) }] };
        const now = clock.rows[0]?.now;
        if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
          throw new Error("routine snapshot clock query returned no valid timestamp");
        }
        const configuration = await loadConfiguration(client);
        if (configuration === null) return null;
        const appliedResult = await client.query<AppliedRow>(
          `SELECT transition_id, transition_key, local_date::text AS local_date,
                  scheduled_at, applied_at, location, activity, available, interaction_context
           FROM routine_applied_transition
           WHERE applied_at <= $1
           ORDER BY scheduled_at DESC, transition_key COLLATE "C" DESC
           LIMIT 1`,
          [now],
        );
        const row = appliedResult.rows[0];
        return {
          scheduled: scheduledRoutineStateAt(now, configuration),
          applied: row === undefined ? null : mapApplied(row),
          next: nextRoutineTransition(now, configuration),
        };
      },
      { readOnly: true, isolationLevel: "repeatable read" },
    );
  }

  return {
    reconcile,
    canStartNewTurn,
    getSnapshot,
    prepareAnnouncement,
    cancelAnnouncement,
    recordAnnouncementPublication,
  };
}
