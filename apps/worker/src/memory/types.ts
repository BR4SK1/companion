/**
 * Memory-domain types.
 *
 * The memory domain is hosted by the worker deployable and is owner-only:
 * there are no user ids or tenant identifiers anywhere (single-owner product;
 * see the root `AGENTS.md`). Subjects (who a memory is about) are personal
 * configuration stored in the `memory_subject` table, never code constants.
 */

export type FactKind =
  | "fact"
  | "preference"
  | "habit"
  | "conditional_pattern"
  | "observed_interaction"
  | "boundary";

/** Observation kinds exclude raw interaction candidates. */
export type ObservationKind = Exclude<FactKind, "observed_interaction">;

export type Explicitness = "explicit" | "supported" | "inferred";

export type EvidenceBasis =
  | "direct_statement"
  | "observed_behavior"
  | "observed_interaction"
  | "inferred";

export type ObservationOmissionReason =
  | "insufficient_distinct_turns"
  | "one_turn_without_direct_statement"
  | "event_specific_temporal_anchor"
  | "insufficient_independent_sources"
  | "unsupported_kind_for_source";

export type EvidenceStrength = "tentative" | "supported" | "strong";

export type CanonicalStatus = "active" | "superseded" | "retracted";

export type PromotionAction =
  | "created"
  | "revised"
  | "unchanged"
  | "reactivated"
  | "policy_retracted"
  | "manual_retracted";

export type RetractionReason =
  | "single_turn_evidence"
  | "insufficient_recurrence_evidence"
  | "operator_correction"
  | "user_request"
  | "privacy_request"
  | "event_specific_temporal_anchor";

export interface MemorySubject {
  readonly id: string;
  readonly role: "user" | "assistant" | "relationship";
  /** Whether the v2 profile pipelines generate a document for this subject. */
  readonly profileEnabled: boolean;
  /** Label used when rendering the source turn side this subject speaks for. */
  readonly sourceLabel: string;
  /**
   * Per-subject evidence-attribution rule for the v1 profile sheet,
   * provisioned in `memory_subject` (personal configuration, never code).
   */
  readonly profileEvidenceRule: string;
  readonly position: number;
}

export interface PromptConfig {
  readonly kind: string;
  readonly version: string;
  readonly systemPrompt: string;
  /** Content hash of the exact prompt text in use. */
  readonly contentHash: string;
}

/** One complete conversation turn as source material for extraction. */
export interface SourceTurn {
  readonly turnId: string;
  /** `conversation_turn.id`; the turn key is its stable string form. */
  readonly turnKey: string;
  readonly startAt: Date;
  readonly endAt: Date;
  readonly userText: string;
  readonly assistantText: string;
  readonly sourceMessageIds: readonly string[];
}

export interface FactExtractionItem {
  readonly sourceTurnId: string;
  readonly subject: string;
  readonly kind: FactKind;
  readonly claim: string;
  readonly topics: readonly string[];
  readonly condition?: string;
  readonly consequence?: string;
  readonly explicitness: Explicitness;
  readonly evidenceBasis: EvidenceBasis;
}

export interface FactExtractionSource {
  readonly sourceTurnId: string;
  readonly facts: ReadonlyArray<Omit<FactExtractionItem, "sourceTurnId">>;
}

export interface FactExtractionOutput {
  readonly facts: readonly FactExtractionItem[];
  readonly sources?: readonly FactExtractionSource[];
}

/** A durable production fact, linked to its source. A fact has exactly one
 *  source: a conversation turn, or an accepted article reaction (article-
 *  sourced facts carry the reaction id instead of a turn and keep no source
 *  messages). */
export interface MemoryFact {
  readonly id: string;
  readonly factKey: string;
  readonly turnId: string | null;
  readonly turnKey: string | null;
  /** Present for article-sourced facts only; conversation facts have none. */
  readonly articleReactionId: string | null;
  readonly subject: string;
  readonly kind: FactKind;
  readonly claim: string;
  readonly condition: string | null;
  readonly consequence: string | null;
  readonly topics: readonly string[];
  readonly observedAt: Date;
  readonly explicitness: Explicitness;
  readonly evidenceBasis: EvidenceBasis;
  readonly extractionVersion: string;
  readonly ingestVersion: string;
}

export interface ConsolidationItem {
  readonly subject: string;
  readonly kind: ObservationKind;
  readonly claim: string;
  readonly topics: readonly string[];
  readonly condition?: string;
  readonly consequence?: string;
  readonly sourceFactIds: readonly string[];
  readonly contradictionFactIds?: readonly string[];
}

/** One consolidation candidate (accepted artifact), with its evidence. */
export interface ObservationArtifact {
  readonly id: string;
  readonly runId: string;
  readonly observationSetId: string;
  readonly observationKey: string;
  readonly subject: string;
  readonly kind: ObservationKind;
  readonly claim: string;
  readonly condition: string | null;
  readonly consequence: string | null;
  readonly topics: readonly string[];
  readonly supportCount: number;
  readonly distinctTurnCount: number;
  readonly distinctDayCount: number;
  readonly contradictionCount: number;
  readonly firstObservedAt: Date;
  readonly lastObservedAt: Date;
  readonly sourceFactIds: readonly string[];
  readonly contradictionFactIds: readonly string[];
  readonly evidenceStrength: EvidenceStrength;
  readonly status: "active";
  readonly consolidationVersion: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** A candidate rejected by the observation policy, kept for review. */
export interface ObservationOmission {
  readonly id: string;
  readonly omissionId: string;
  readonly runId: string;
  readonly observationSetId: string;
  readonly observationKey: string;
  readonly subject: string;
  readonly kind: ObservationKind;
  readonly claim: string;
  readonly condition: string | null;
  readonly consequence: string | null;
  readonly topics: readonly string[];
  readonly supportCount: number;
  readonly distinctTurnCount: number;
  readonly distinctDayCount: number;
  readonly contradictionCount: number;
  readonly firstObservedAt: Date;
  readonly lastObservedAt: Date;
  readonly sourceFactIds: readonly string[];
  readonly contradictionFactIds: readonly string[];
  readonly reason: ObservationOmissionReason;
  readonly policyVersion: string;
  readonly createdAt: Date;
}

/** The snapshot content of a canonical observation (identity + evidence). */
export interface CanonicalSnapshot {
  readonly canonicalObservationId: string;
  readonly canonicalIdentityKey: string;
  readonly identityVersion: number;
  readonly observationKey: string;
  readonly subject: string;
  readonly kind: ObservationKind;
  readonly claim: string;
  readonly condition?: string;
  readonly consequence?: string;
  readonly topics: readonly string[];
  readonly supportCount: number;
  readonly distinctTurnCount: number;
  readonly distinctDayCount: number;
  readonly contradictionCount: number;
  readonly firstObservedAt: Date;
  readonly lastObservedAt: Date;
  readonly sourceFactIds: readonly string[];
  readonly contradictionFactIds: readonly string[];
  readonly evidenceStrength: EvidenceStrength;
  readonly status: CanonicalStatus;
  readonly consolidationVersion: string;
  readonly contentHash: string;
}

export interface CanonicalSource {
  readonly artifactId: string;
  readonly runId: string;
  readonly observationSetId: string;
  readonly factSetId: string;
  readonly sourceArtifactCreatedAt: Date;
  readonly sourceArtifactUpdatedAt: Date;
}

export interface RetractionRecord {
  readonly kind: "policy" | "manual";
  readonly reasonCodes: readonly RetractionReason[];
  readonly policyVersion?: string;
  readonly operationKey: string;
  readonly at: Date;
}

/** The current canonical projection of one observation identity. */
export interface CanonicalObservation extends CanonicalSnapshot {
  readonly revision: number;
  readonly promotionId: string;
  readonly promotionSequence: number;
  /**
   * Fencing token bumped by every mutation of this row (promotion apply,
   * retraction). Conditional writers CAS on the value they read, so a
   * concurrent retraction can never be silently overwritten.
   */
  readonly mutationSeq: number;
  readonly latestSource: CanonicalSource;
  readonly retraction?: RetractionRecord;
  readonly lastOperationKey?: string;
  readonly canonicalCreatedAt: Date;
  readonly canonicalUpdatedAt: Date;
}

/** One append-only canonical history event. */
export interface CanonicalHistoryEvent {
  readonly historyEventId: string;
  readonly promotionId: string;
  readonly promotionSequence: number;
  readonly action: PromotionAction;
  readonly operationKey?: string;
  readonly changeKind: "content" | "evidence" | "status";
  readonly revision: number;
  readonly canonicalObservationId: string;
  readonly canonicalIdentityKey: string;
  readonly contentHash: string;
  readonly observation: CanonicalSnapshot;
  readonly source: CanonicalSource;
  readonly retraction?: RetractionRecord;
  readonly recordedAt: Date;
}

export interface PromotionItem {
  readonly promotionId: string;
  readonly promotionItemId: string;
  readonly canonicalObservationId: string;
  readonly canonicalIdentityKey: string;
  readonly contentHash: string;
  readonly observation: CanonicalSnapshot;
  readonly source: CanonicalSource;
  /** Apply outcome recorded on the staged row (see memory_promotion_item). */
  readonly outcome: "applied" | "skipped_inactive" | "superseded";
}

export interface PromotionSummary {
  readonly creates: number;
  readonly revisions: number;
  readonly unchanged: number;
  /**
   * Eligible artifacts excluded at planning because their current canonical
   * identity exists but is inactive (retracted): the automatic path never
   * reactivates, and one inactive identity must not block the whole run.
   */
  readonly inactiveCanonicalSkipped: number;
  readonly inactiveArtifactsSkipped: number;
  readonly policyBlocked: number;
  readonly blockedByReason: Readonly<Record<string, number>>;
}

export interface PromotionPlan {
  readonly promotionId: string;
  readonly runId: string;
  readonly observationSetId: string;
  readonly factSetId: string;
  readonly canonicalizationVersion: string;
  readonly sourcePlanHash: string;
  readonly currentStateDigest: string;
  readonly confirmationToken: string;
  readonly itemCount: number;
  readonly blockedArtifactIds: readonly string[];
  readonly evidencePolicyVersion: string;
  readonly summary: PromotionSummary;
  readonly items: readonly PromotionItem[];
}

export interface PromotionResult {
  readonly promotionId: string;
  readonly status: "completed" | "already-completed";
  readonly promotionSequence: number;
  readonly itemCount: number;
  readonly created: number;
  readonly revised: number;
  readonly unchanged: number;
  readonly reactivated: number;
  /** Items skipped because the canonical identity was no longer active at
   *  apply time (a concurrent retraction won); never reactivated. */
  readonly skippedInactive: number;
  /** Items whose identity was already advanced by a later promotion before
   *  this promotion could apply them; the later content stands untouched. */
  readonly superseded: number;
  readonly historyEvents: number;
}

export interface PromotionVerification {
  readonly promotionId: string;
  readonly manifestStatus: string;
  readonly itemCount: number;
  readonly stagedItemCount: number;
  readonly historyEventCount: number;
  readonly currentIdentityCount: number;
  readonly missingHistoryEvents: number;
  readonly currentDocumentsBehindSequence: number;
  /** Skipped items whose canonical identity was not left inactive as expected. */
  readonly skippedNotInactive: number;
  /** Superseded items whose document is not strictly ahead of this promotion
   *  or that unexpectedly carry this promotion's history event. */
  readonly supersededInvalid: number;
  readonly planHashMatches: boolean;
  readonly valid: boolean;
}

// ---------------------------------------------------------------------------
// Temporal memory
// ---------------------------------------------------------------------------

export type TemporalSummaryKind =
  | "morning"
  | "afternoon"
  | "night"
  | "day"
  | "week"
  | "month";

export interface TemporalPeriod {
  readonly kind: TemporalSummaryKind;
  readonly periodKey: string;
  readonly startAt: Date;
  readonly endAt: Date;
}

export interface TemporalSummary {
  readonly id: string;
  readonly kind: TemporalSummaryKind;
  readonly periodKey: string;
  readonly timezone: string;
  readonly startAt: Date;
  readonly endAt: Date;
  readonly content: string;
  readonly messageCount: number;
  readonly fingerprint: string;
  readonly selectionVersion: string | null;
  readonly childSummaryKeys: readonly string[];
  readonly model: string;
  readonly promptVersion: string;
  readonly generatedAt: Date;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly callCount: number;
  readonly status: "complete" | "failed";
  /** Source-message provenance, read back from the links table (aggregate
   *  provenance survives caching; empty for summaries without links). */
  readonly messageIds?: readonly string[];
  /** Selection diagnostics read back from the stored row. */
  readonly selectedPairIds?: readonly string[];
  readonly segmentPairCounts?: readonly number[];
}

/** A completed temporal summary accepted for prompt context. */
export interface TemporalPromptItem {
  readonly kind: TemporalSummaryKind;
  readonly periodKey: string;
  readonly contentLength: number;
}

export interface TemporalPromptContext {
  readonly text?: string;
  readonly recentText?: string;
  readonly summaries: readonly TemporalPromptItem[];
  readonly recentSummaries: readonly TemporalPromptItem[];
}

// ---------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------

/** v1 profile summary: subject sheet distilled from temporal day summaries. */
export interface ProfileSummary {
  readonly subject: string;
  readonly content: string;
  readonly sourceSummaryKeys: readonly string[];
  readonly sourceFingerprint: string;
  readonly model: string;
  readonly promptVersion: string;
  readonly status: "complete" | "failed";
  readonly generatedAt: Date;
}

export interface ProfileSourceObservation {
  readonly observationId: string;
  readonly revision: number;
  readonly status: string;
  readonly contentHash: string;
  readonly subject: string;
  readonly kind: string;
  readonly claim: string;
  readonly condition?: string;
  readonly consequence?: string;
  readonly topics: readonly string[];
  readonly evidenceStrength: string;
  readonly distinctDayCount: number;
  readonly lastObservedAt: string;
}

export interface ProfileClaim {
  readonly observationId: string;
  readonly text: string;
}

/** v2 observation profile: subject sheet distilled from canonical observations. */
export interface ObservationProfile {
  readonly subject: string;
  readonly fingerprint: string;
  readonly promptVersion: string;
  readonly content: string;
  readonly claims: readonly ProfileClaim[];
  readonly sourceCount: number;
  readonly model: string | null;
  readonly generatedAt: Date | null;
}

// ---------------------------------------------------------------------------
// Recall and chat integration
// ---------------------------------------------------------------------------

export interface CanonicalRecallItem {
  readonly type: "fact" | "observation";
  readonly id: string;
  readonly subject: string;
  /**
   * The subject's configured role, read from `memory_subject` at recall
   * time ("user", "assistant", or "relationship"). Recall always populates
   * it; optional so older hand-built items stay valid. Renderers must use
   * it for attribution: an assistant-role memory is the assistant's own
   * record, never user-specific context.
   */
  readonly subjectRole?: "user" | "assistant" | "relationship";
  readonly kind: string;
  readonly claim: string;
  /** Present for conversation-sourced facts only; article facts have none. */
  readonly turnId?: string;
  /**
   * Where the memory came from. Facts default to "conversation";
   * article-sourced reaction facts carry "article" plus their reaction id.
   * Observations carry the source of their support evidence: aggregated
   * conversation facts are "conversation", while observations consolidated
   * from article-reaction facts (assistant interests) carry "article".
   */
  readonly sourceType?: "conversation" | "article";
  readonly articleReactionId?: string;
  readonly condition?: string;
  readonly consequence?: string;
  readonly topics: readonly string[];
  readonly observedAt: string;
  readonly explicitness?: string;
  readonly evidenceStrength?: string;
  readonly supportCount?: number;
  readonly distinctDayCount?: number;
  readonly textScore: number;
  readonly recencyBoost: number;
  readonly evidenceBoost: number;
  readonly score: number;
}

export interface CanonicalRecallResponse {
  readonly query: {
    readonly referenceTime: string;
    readonly emptyQueryFallback: boolean;
    /** keyword (default), hybrid (window AND text), or timeline (window). */
    readonly mode: "keyword" | "hybrid" | "timeline";
    /** Present when the query carried an explicit temporal expression. */
    readonly timeRange?: {
      readonly start: string;
      readonly end: string;
      readonly description: string;
    };
  };
  readonly results: readonly CanonicalRecallItem[];
  readonly diagnostics: {
    readonly factCandidates: number;
    readonly observationCandidates: number;
    readonly truncatedForBudget: number;
    readonly maxChars: number;
    readonly totalMs: number;
  };
}

/** Memory context assembled for one chat turn. */
export interface MemoryChatContext {
  readonly memoryContext?: string;
  readonly temporalContext?: string;
  readonly profileSection?: string;
  /**
   * Fact keys the lexical recall chunk surfaced this turn — the dedupe input
   * for the per-turn article-memory share candidates (a fact the recall
   * chunk already carries is not offered again as a separate article chunk).
   * Never rendered; bookkeeping only.
   */
  readonly recallFactKeys?: readonly string[];
}
