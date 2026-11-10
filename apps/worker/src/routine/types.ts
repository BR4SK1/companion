/** Generic runtime-configured routine state and recurring schedule transitions. */

export interface RoutineTransition {
  readonly id: string;
  readonly key: string;
  /** ISO weekday: Monday=1 through Sunday=7. */
  readonly weekday: number;
  /** Local wall-clock minute of day (0 through 1439). */
  readonly localMinute: number;
  readonly location: string | null;
  readonly activity: string | null;
  readonly available: boolean;
  /** Optional reactive interaction context; never a request to send a message. */
  readonly interactionContext: string | null;
}

export interface RoutineConfiguration {
  readonly timezone: string;
  /** Owner-configured context included only in the durable schedule notice. */
  readonly departureContext: string | null;
  readonly transitions: readonly RoutineTransition[];
}

export interface RoutineOccurrence {
  readonly transitionId: string;
  readonly transitionKey: string;
  readonly localDate: string;
  readonly scheduledAt: Date;
  readonly location: string | null;
  readonly activity: string | null;
  readonly available: boolean;
  readonly interactionContext: string | null;
}

export interface RoutineAppliedState extends RoutineOccurrence {
  readonly appliedAt: Date;
}

export interface RoutineAnnouncementDraft {
  readonly announcementId: string;
  readonly transitionId: string;
  readonly localDate: string;
  readonly scheduledAt: Date;
  /** Null only when the configured schedule has no next available transition. */
  readonly validUntil: Date | null;
  readonly content: string;
}

export interface RoutineSnapshot {
  readonly scheduled: RoutineOccurrence;
  readonly applied: RoutineAppliedState | null;
  readonly next: RoutineOccurrence;
}
