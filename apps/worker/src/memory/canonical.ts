/**
 * Canonical observation identity, content hashing, and history building.
 *
 * Identities and hashes are content-derived: the same observation content
 * always maps to the same canonical identity, so promotions are idempotent
 * and history events are verifiable. The single-owner product has no user
 * dimension in identity keys.
 */

import { canonicalHash, stableStringify } from "./hashing.ts";
import type {
  CanonicalHistoryEvent,
  CanonicalObservation,
  CanonicalSnapshot,
  CanonicalSource,
  ObservationArtifact,
  PromotionAction,
  PromotionItem,
  RetractionReason,
} from "./types.ts";

export const CANONICAL_OBSERVATION_SCHEMA_VERSION = 1;
export const CANONICALIZATION_VERSION = "memory-observations-canonical-v1";
export const CANONICAL_EVIDENCE_POLICY_VERSION = "canonical-evidence-v2";

export function canonicalIdentityKey(observationKey: string): string {
  return canonicalHash("canonical-identity-v1", {
    identityVersion: CANONICAL_OBSERVATION_SCHEMA_VERSION,
    observationKey,
  });
}

export function canonicalObservationId(identityKey: string): string {
  return `memory-observation-v1-${identityKey.replace(/^canonical-identity-v1-/, "")}`;
}

interface ContentPayloadSource {
  observationKey: string;
  subject: string;
  kind: string;
  claim: string;
  topics: readonly string[];
  condition?: string;
  consequence?: string;
  supportCount: number;
  distinctTurnCount: number;
  distinctDayCount: number;
  contradictionCount: number;
  firstObservedAt: Date;
  lastObservedAt: Date;
  evidenceStrength: string;
  status: string;
}

function contentPayload(observation: ContentPayloadSource): Record<string, unknown> {
  return {
    identityVersion: CANONICAL_OBSERVATION_SCHEMA_VERSION,
    observationKey: observation.observationKey,
    subject: observation.subject,
    kind: observation.kind,
    claim: observation.claim,
    topics: [...observation.topics].sort(),
    condition: observation.condition ?? null,
    consequence: observation.consequence ?? null,
    supportCount: observation.supportCount,
    distinctTurnCount: observation.distinctTurnCount,
    distinctDayCount: observation.distinctDayCount,
    contradictionCount: observation.contradictionCount,
    firstObservedAt: observation.firstObservedAt,
    lastObservedAt: observation.lastObservedAt,
    evidenceStrength: observation.evidenceStrength,
    status: observation.status,
  };
}

export function canonicalContentHash(observation: ContentPayloadSource): string {
  return canonicalHash("canonical-content-v1", contentPayload(observation));
}

/** Build the canonical snapshot of one accepted artifact. */
export function snapshotFromArtifact(
  observation: {
    observationKey: string;
    subject: string;
    kind: string;
    claim: string;
    condition: string | null;
    consequence: string | null;
    topics: readonly string[];
    supportCount: number;
    distinctTurnCount: number;
    distinctDayCount: number;
    contradictionCount: number;
    firstObservedAt: Date;
    lastObservedAt: Date;
    sourceFactIds: readonly string[];
    contradictionFactIds: readonly string[];
    evidenceStrength: string;
    status: string;
    consolidationVersion: string;
  },
): CanonicalSnapshot {
  const identityKey = canonicalIdentityKey(observation.observationKey);
  const snapshot: CanonicalSnapshot = {
    canonicalObservationId: canonicalObservationId(identityKey),
    canonicalIdentityKey: identityKey,
    identityVersion: CANONICAL_OBSERVATION_SCHEMA_VERSION,
    observationKey: observation.observationKey,
    subject: observation.subject,
    kind: observation.kind as CanonicalSnapshot["kind"],
    claim: observation.claim,
    topics: [...observation.topics].sort(),
    ...(observation.condition !== null ? { condition: observation.condition } : {}),
    ...(observation.consequence !== null ? { consequence: observation.consequence } : {}),
    supportCount: observation.supportCount,
    distinctTurnCount: observation.distinctTurnCount,
    distinctDayCount: observation.distinctDayCount,
    contradictionCount: observation.contradictionCount,
    firstObservedAt: observation.firstObservedAt,
    lastObservedAt: observation.lastObservedAt,
    sourceFactIds: [...observation.sourceFactIds].sort(),
    contradictionFactIds: [...observation.contradictionFactIds].sort(),
    evidenceStrength: observation.evidenceStrength as CanonicalSnapshot["evidenceStrength"],
    status: observation.status as CanonicalSnapshot["status"],
    consolidationVersion: observation.consolidationVersion,
    contentHash: canonicalContentHash({
      observationKey: observation.observationKey,
      subject: observation.subject,
      kind: observation.kind,
      claim: observation.claim,
      topics: observation.topics,
      ...(observation.condition !== null ? { condition: observation.condition } : {}),
      ...(observation.consequence !== null ? { consequence: observation.consequence } : {}),
      supportCount: observation.supportCount,
      distinctTurnCount: observation.distinctTurnCount,
      distinctDayCount: observation.distinctDayCount,
      contradictionCount: observation.contradictionCount,
      firstObservedAt: observation.firstObservedAt,
      lastObservedAt: observation.lastObservedAt,
      evidenceStrength: observation.evidenceStrength,
      status: observation.status,
    }),
  };
  return snapshot;
}

export function promotionIdForRun(
  runId: string,
  observationSetId: string,
): string {
  return canonicalHash("memory-observation-promotion-v1", {
    canonicalizationVersion: CANONICALIZATION_VERSION,
    runId,
    observationSetId,
  });
}

export function promotionItemId(promotionId: string, identityKey: string): string {
  return canonicalHash("memory-observation-promotion-item-v1", { promotionId, identityKey });
}

export function historyEventId(promotionId: string, identityKey: string): string {
  return canonicalHash("memory-observation-history-v1", { promotionId, identityKey });
}

export function historyEventIdForOperation(operationKey: string): string {
  return canonicalHash("memory-observation-history-operation-v1", { operationKey });
}

export function planHash(items: readonly PromotionItem[]): string {
  return canonicalHash(
    "memory-observation-promotion-plan-v1",
    items
      .map((item) => ({
        promotionItemId: item.promotionItemId,
        canonicalIdentityKey: item.canonicalIdentityKey,
        contentHash: item.contentHash,
        observation: item.observation,
        source: item.source,
      }))
      .sort((left, right) =>
        left.canonicalIdentityKey.localeCompare(right.canonicalIdentityKey)),
  );
}

export function currentStateDigest(
  observations: ReadonlyArray<{
    canonicalIdentityKey: string;
    contentHash: string;
    revision: number;
    status: string;
    promotionSequence: number;
  }>,
): string {
  return canonicalHash(
    "memory-observation-current-state-v1",
    observations
      .map((observation) => ({
        canonicalIdentityKey: observation.canonicalIdentityKey,
        contentHash: observation.contentHash,
        revision: observation.revision,
        status: observation.status,
        promotionSequence: observation.promotionSequence,
      }))
      .sort((left, right) =>
        left.canonicalIdentityKey.localeCompare(right.canonicalIdentityKey)),
  );
}

export function confirmationToken(input: {
  databaseName: string;
  promotionId: string;
  sourcePlanHash: string;
  currentStateDigest: string;
  allowReactivation: boolean;
  evidencePolicyVersion?: string;
  blockedArtifactIds?: readonly string[];
  reviewedArtifactIds?: readonly string[];
  reviewedBy?: string;
  reviewNote?: string;
}): string {
  return canonicalHash("memory-observation-confirm-v1", input);
}

export function buildCurrentObservation(
  snapshot: CanonicalSnapshot,
  source: CanonicalSource,
  promotionId: string,
  promotionSequence: number,
  revision: number,
  now: Date,
): CanonicalObservation {
  return {
    ...snapshot,
    revision,
    promotionId,
    promotionSequence,
    mutationSeq: 0,
    latestSource: source,
    canonicalCreatedAt: now,
    canonicalUpdatedAt: now,
  };
}

export function buildHistoryEvent(input: {
  item: PromotionItem;
  action: PromotionAction;
  revision: number;
  promotionSequence: number;
  recordedAt: Date;
  operationKey?: string;
  changeKind?: CanonicalHistoryEvent["changeKind"];
}): CanonicalHistoryEvent {
  const operationKey =
    input.operationKey ??
    `promotion:${input.item.promotionId}:${input.item.canonicalIdentityKey}`;
  return {
    historyEventId: input.operationKey !== undefined
      ? historyEventIdForOperation(operationKey)
      : historyEventId(input.item.promotionId, input.item.canonicalIdentityKey),
    promotionId: input.item.promotionId,
    promotionSequence: input.promotionSequence,
    action: input.action,
    operationKey,
    changeKind: input.changeKind ?? (input.action === "revised" ? "content" : "evidence"),
    revision: input.revision,
    canonicalObservationId: input.item.canonicalObservationId,
    canonicalIdentityKey: itemIdentityKey(input.item),
    contentHash: input.item.contentHash,
    observation: input.item.observation,
    source: input.item.source,
    recordedAt: input.recordedAt,
  };
}

function itemIdentityKey(item: PromotionItem): string {
  return item.canonicalIdentityKey;
}

export function retractedSnapshot(
  current: CanonicalObservation,
): CanonicalSnapshot {
  const base: Omit<CanonicalSnapshot, "contentHash"> = {
    canonicalObservationId: current.canonicalObservationId,
    canonicalIdentityKey: current.canonicalIdentityKey,
    identityVersion: current.identityVersion,
    observationKey: current.observationKey,
    subject: current.subject,
    kind: current.kind,
    claim: current.claim,
    topics: [...current.topics].sort(),
    ...(current.condition !== undefined ? { condition: current.condition } : {}),
    ...(current.consequence !== undefined ? { consequence: current.consequence } : {}),
    supportCount: current.supportCount,
    distinctTurnCount: current.distinctTurnCount,
    distinctDayCount: current.distinctDayCount,
    contradictionCount: current.contradictionCount,
    firstObservedAt: current.firstObservedAt,
    lastObservedAt: current.lastObservedAt,
    sourceFactIds: [...current.sourceFactIds].sort(),
    contradictionFactIds: [...current.contradictionFactIds].sort(),
    evidenceStrength: current.evidenceStrength,
    status: "retracted",
    consolidationVersion: current.consolidationVersion,
  };
  return { ...base, contentHash: canonicalContentHash(base) };
}

export function buildRetractionHistoryEvent(input: {
  current: CanonicalObservation;
  operationKey: string;
  action: "policy_retracted" | "manual_retracted";
  reasonCodes: readonly RetractionReason[];
  policyVersion?: string;
  recordedAt: Date;
}): CanonicalHistoryEvent {
  const observation = retractedSnapshot(input.current);
  return {
    historyEventId: historyEventIdForOperation(input.operationKey),
    promotionId: input.current.promotionId,
    promotionSequence: input.current.promotionSequence,
    action: input.action,
    operationKey: input.operationKey,
    changeKind: "status",
    revision: input.current.revision + 1,
    canonicalObservationId: input.current.canonicalObservationId,
    canonicalIdentityKey: input.current.canonicalIdentityKey,
    contentHash: observation.contentHash,
    observation,
    source: input.current.latestSource,
    retraction: {
      kind: input.action === "policy_retracted" ? "policy" : "manual",
      reasonCodes: input.reasonCodes,
      ...(input.policyVersion !== undefined ? { policyVersion: input.policyVersion } : {}),
      operationKey: input.operationKey,
      at: input.recordedAt,
    },
    recordedAt: input.recordedAt,
  };
}

export { stableStringify };
