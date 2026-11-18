/**
 * Engagement-domain state machine: pure logic, no timers.
 *
 * The engagement state is a deterministic function of the durable message
 * history and the configured band cutoffs. There is no background timer to
 * advance state, and no proactive behavior anywhere in this domain:
 *
 * - **Last-activity clock**: inactivity is measured from the LAST user
 *   message's effective time. Every user message moves the clock forward;
 *   assistant messages and idempotent replays never do.
 * - **Advance during silence**: any reader computing the state at a later
 *   instant automatically observes the advanced band — because the state is
 *   recomputed, not mutated by a scheduler.
 * - **Durable restart recovery**: after a process restart the same
 *   recomputation yields the same state; there is no in-memory state to
 *   lose and nothing to replay.
 * - **Stale timer fencing**: nothing writes from a timer, so a stale
 *   callback cannot overwrite a newer state. Readers only ever recompute
 *   from durable data; the domain takes no writes from time alone.
 * - **Assessment retention floor**: a message's assessment is the band its
 *   preceding silence fell into, and it floors the effective state — the
 *   first message after a lull keeps the state at `lull` (the state does
 *   not snap to `engaged` on arrival), and only a subsequent message
 *   arriving inside the engaged band lifts the state to `engaged`. A
 *   message arriving in a deeper band keeps that deeper state until the
 *   next message. Subsequent inactivity transitions measure from the last
 *   message's effective time.
 *
 * Assistant messages and idempotent replays never reset user activity:
 * silence is measured only from user messages, and assessments are written
 * once per new user message (replays return the recorded assessment).
 */

import type {
  EngagementBandMs,
  EngagementState,
} from "./types.ts";
import { ENGAGEMENT_STATES } from "./types.ts";

/**
 * Classify a silence duration into an engagement band from the THREE
 * configured cutoffs. Half-open bands, deeper as silence grows: silence
 * below `lullMs` is `engaged`; at or beyond `lullMs` (but below `idleMs`)
 * is `lull`; at or beyond `idleMs` (but below `goneMs`) is `idle`; at or
 * beyond `goneMs` is `gone`. Every cutoff belongs to the deeper band.
 */
export function classifySilence(
  silenceMs: number,
  bands: EngagementBandMs,
): EngagementState {
  if (silenceMs < bands.lullMs) return "engaged";
  if (silenceMs < bands.idleMs) return "lull";
  if (silenceMs < bands.goneMs) return "idle";
  return "gone";
}

/**
 * The deeper of two engagement states (the one further along the silence
 * timeline). The state ordering is exactly the `ENGAGEMENT_STATES` order:
 * `engaged` < `lull` < `idle` < `gone`.
 */
export function deeperEngagementState(
  a: EngagementState,
  b: EngagementState,
): EngagementState {
  return ENGAGEMENT_STATES.indexOf(a) >= ENGAGEMENT_STATES.indexOf(b) ? a : b;
}

export interface StateAtInput {
  /**
   * The last user message's effective time — the last-activity anchor.
   * null when no user message has ever been ingested: there is no
   * engagement to classify yet.
   */
  readonly lastUserMessageAt: Date | null;
  /**
   * The last user message's own recorded assessment state, when one exists
   * (null for pre-engagement history). This floors the effective state so
   * a single return message cannot overwrite it to `engaged`.
   */
  readonly lastAssessmentState: EngagementState | null;
  readonly observedAt: Date;
  readonly bands: EngagementBandMs;
}

/**
 * The state in force at `observedAt`: the deeper of the activity band
 * (silence measured from the LAST user message's effective time) and that
 * message's own recorded assessment. With no recorded assessment
 * (pre-engagement history) the activity band alone determines the state.
 * null when no user message has ever been ingested.
 */
export function stateAt(input: StateAtInput): EngagementState | null {
  if (input.lastUserMessageAt === null) return null;
  const activity = classifySilence(
    Math.max(0, input.observedAt.getTime() - input.lastUserMessageAt.getTime()),
    input.bands,
  );
  if (input.lastAssessmentState === null) return activity;
  return deeperEngagementState(activity, input.lastAssessmentState);
}

export interface AssessMessageInput {
  /** The new message's effective time. */
  readonly messageEffectiveAt: Date;
  /**
   * The previous user message's effective time; null when this is the first
   * user message of the thread (no silence has elapsed yet).
   */
  readonly previousUserMessageAt: Date | null;
  /**
   * The engagement state recorded on the previous user message's own
   * assessment, when one exists. This is provenance about the transition,
   * not part of the classification.
   */
  readonly previousAssessmentState: EngagementState | null;
  readonly bands: EngagementBandMs;
}

export interface MessageAssessment {
  /** The engagement state recorded for this message. */
  readonly state: EngagementState;
  /** The previous user message's recorded assessment state, if any. */
  readonly previousState: EngagementState | null;
  /** Silence between the previous user message and this one; null for the first. */
  readonly silenceMs: number | null;
  /**
   * True when the assessment retained a lull rather than advancing to
   * `engaged` — this message arrived during a lull band, so the effective
   * engagement is still `lull` until a subsequent message lands inside the
   * engaged band (the no-immediate-engagement rule).
   */
  readonly retainedLull: boolean;
}

/**
 * Assess one new user message. The assessment is the state that was in
 * force at the message's effective time, classified from the silence since
 * the previous user message. This is exactly the rule that keeps the
 * effective engagement from snapping to `engaged` on a message that arrived
 * after a lull: the assessment says "this message arrived during a lull".
 * A subsequent message arriving within the engaged band then assesses as
 * `engaged`, which is when the domain's effective engagement advances.
 *
 * There is deliberately no "on-message-arrival bump to engaged" behavior:
 * the assessment is a function of the elapsed silence alone.
 *
 * The first user message of a thread has no predecessor: it is assessed as
 * `engaged` (no silence has elapsed; there is no prior engagement to
 * retain), with null silence and null previous state.
 */
export function assessMessage(
  input: AssessMessageInput,
): MessageAssessment {
  if (input.previousUserMessageAt === null) {
    return {
      state: classifySilence(0, input.bands),
      previousState: null,
      silenceMs: null,
      retainedLull: false,
    };
  }
  const silenceMs = Math.max(
    0,
    input.messageEffectiveAt.getTime() - input.previousUserMessageAt.getTime(),
  );
  const state = classifySilence(silenceMs, input.bands);
  return {
    state,
    previousState: input.previousAssessmentState,
    silenceMs,
    retainedLull: state === "lull",
  };
}

/**
 * Session scoping of model history (decision + chat + snapshot +
 * prompt-module context) to the current conversation.
 *
 * A recorded `gone` assessment starts a new conversation: the message
 * carrying it is the return message after the configured `gone` silence,
 * so model history for its turn and every later turn begins at that
 * message. The boundary is the RECORDED assessment state at the return
 * message — never the effective state (`stateAt`) at processing time.
 * The effective state floors at the last assessment, so the return
 * message permanently reads `gone` as a floor until a subsequent
 * message lifts it; using that floor as the boundary would reset
 * history on every turn after a return. Here only the return message
 * itself (the one whose recorded state is `gone`) is the boundary, and
 * subsequent turns include the new conversation's own prior messages
 * from that message onward instead of repeatedly resetting.
 *
 * Missing entries (no recorded assessment: pre-engagement history,
 * unprovisioned stretches, assistant messages) are never `gone`, so a
 * deployment without engagement provisioning — or history written
 * before it was provisioned — keeps the existing unbounded behavior.
 * No threshold is fabricated here: `gone` is whatever the recorded
 * assessment says, snapshot with its own bands at ingest time.
 */

export type AssessmentStateMap = ReadonlyMap<
  string,
  EngagementState | null | undefined
>;

/** True when the recorded assessment state is exactly `gone`. */
export function isGoneState(
  state: EngagementState | null | undefined,
): boolean {
  return state === "gone";
}

/**
 * The id of the latest message, in the given chronological order, whose
 * recorded assessment is `gone`; null when none of the ids is recorded
 * `gone`. Later ids win, so callers pass oldest-first order.
 */
export function latestGoneMessageId(
  orderedMessageIds: readonly string[],
  assessmentStates: AssessmentStateMap,
): string | null {
  let latest: string | null = null;
  for (const id of orderedMessageIds) {
    if (assessmentStates.get(id) === "gone") latest = id;
  }
  return latest;
}

/**
 * Whether any of the given message ids is recorded `gone`.
 */
export function hasGoneAssessment(
  messageIds: readonly string[],
  assessmentStates: AssessmentStateMap,
): boolean {
  return messageIds.some((id) => assessmentStates.get(id) === "gone");
}

export interface SessionHistoryMessage {
  readonly id: string;
}

/**
 * Select the current-session slice of prior-turn history (oldest first).
 *
 * - Any `gone` in the current turn's grouped messages empties the
 *   history: grouped messages before the `gone` one in the same turn
 *   are still sent as turn messages by the processor, but no earlier
 *   conversation leaks in. This is deliberately ANY (not last-only as
 *   in `getAssessmentForTurn`'s turn-engagement read): for history
 *   scoping a mixed turn must not leak, even when its last message
 *   carries no assessment.
 * - Otherwise the slice starts at the latest `gone` in the history,
 *   inclusive (that return message and everything after it, including
 *   its assistant reply and follow-ups).
 * - With no `gone` anywhere the history is returned unchanged.
 */
export function selectSessionHistory<T extends SessionHistoryMessage>(
  history: readonly T[],
  assessmentStates: AssessmentStateMap,
  currentTurnMessageIds: readonly string[] = [],
): readonly T[] {
  if (hasGoneAssessment(currentTurnMessageIds, assessmentStates)) return [];
  const boundaryId = latestGoneMessageId(
    history.map((message) => message.id),
    assessmentStates,
  );
  if (boundaryId === null) return history;
  const start = history.findIndex((message) => message.id === boundaryId);
  return start < 0 ? history : history.slice(start);
}

/**
 * Whether the given history message belongs to the current session:
 * at or after the latest recorded `gone` in the history, and no `gone`
 * in the current turn (which would start a new session the history
 * message predates). Messages with no recorded assessment are not
 * boundaries and never exclude a message by themselves.
 */
export function isInCurrentSession(
  messageId: string,
  orderedHistoryIds: readonly string[],
  assessmentStates: AssessmentStateMap,
  currentTurnMessageIds: readonly string[] = [],
): boolean {
  if (hasGoneAssessment(currentTurnMessageIds, assessmentStates)) return false;
  const boundaryId = latestGoneMessageId(orderedHistoryIds, assessmentStates);
  if (boundaryId === null) return true;
  const messageIndex = orderedHistoryIds.indexOf(messageId);
  const boundaryIndex = orderedHistoryIds.indexOf(boundaryId);
  return messageIndex >= boundaryIndex;
}

/**
 * The length of the first contiguous session in a pending backlog
 * (oldest first): messages up to, but not including, the first `gone`
 * after the head. A `gone` at the head starts the claim (it is
 * included, and the claim runs until the next `gone`); a `gone`
 * anywhere later ends the claim (it starts the next claim). With no
 * later `gone` the whole backlog is one session. Used by
 * `claimNextTurn` so a backlog accumulated across a `gone` return
 * (worker downtime, routine unavailability) never groups the old
 * conversation and the return into one turn's prompt. Remaining
 * messages stay unassigned and are claimed next, in order.
 */
export function firstSessionBatchLength(
  orderedPendingIds: readonly string[],
  assessmentStates: AssessmentStateMap,
): number {
  for (let i = 1; i < orderedPendingIds.length; i += 1) {
    const id = orderedPendingIds[i];
    if (id !== undefined && assessmentStates.get(id) === "gone") return i;
  }
  return orderedPendingIds.length;
}

/**
 * The first contiguous session of a pending backlog, in order. See
 * `firstSessionBatchLength`.
 */
export function selectFirstSessionBatch<T extends SessionHistoryMessage>(
  pending: readonly T[],
  assessmentStates: AssessmentStateMap,
): readonly T[] {
  return pending.slice(
    0,
    firstSessionBatchLength(
      pending.map((message) => message.id),
      assessmentStates,
    ),
  );
}
