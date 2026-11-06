/**
 * Observation policy and evidence counting.
 *
 * The policy decides which consolidation candidates may become observations
 * and why rejected candidates are omitted. Evidence counting uses behavioral
 * days (the provisioned behavioral-day boundary), so late-night conversations
 * count for the day
 * they belong to behaviorally.
 */

import { behavioralDay, type BehaviorTime } from "./time.ts";
import type {
  ConsolidationItem,
  EvidenceStrength,
  MemoryFact,
  ObservationOmissionReason,
} from "./types.ts";

export const OBSERVATION_POLICY_VERSION = "memory-observation-policy-v1";

export type ObservationPolicyField = "claim" | "condition" | "consequence";

export type ObservationTemporalAnchorCategory =
  | "deictic_time"
  | "specific_date_or_time"
  | "one_off_schedule_event";

export interface ObservationTemporalAnchorReport {
  readonly fields: readonly ObservationPolicyField[];
  readonly categories: readonly ObservationTemporalAnchorCategory[];
}

export interface ObservationPolicyDecision {
  readonly eligible: boolean;
  readonly reason?: ObservationOmissionReason;
  readonly temporalAnchor?: ObservationTemporalAnchorReport;
}

interface TemporalRule {
  readonly category: ObservationTemporalAnchorCategory;
  readonly pattern: RegExp;
}

const TEMPORAL_RULES: readonly TemporalRule[] = [
  {
    category: "deictic_time",
    pattern: /\b(?:today|tonight|tomorrow|yesterday|right\s+now|at\s+the\s+moment|currently|this\s+(?:morning|afternoon|evening|week|month|year)|last\s+(?:night|week|month|year)|next\s+(?:week|month|year)|that\s+day|earlier\s+today|recently)\b/i,
  },
  {
    category: "deictic_time",
    pattern: /\b(?:this|next|last)\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|weekend)\b/i,
  },
  {
    category: "specific_date_or_time",
    pattern: /\b\d{4}[-/]\d{1,2}[-/]\d{1,2}(?:[t\s]+\d{1,2}:\d{2}(?::\d{2})?(?:z|\s*[ap]m)?)?\b/i,
  },
  {
    category: "specific_date_or_time",
    pattern: /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+\d{4})?\b/i,
  },
  {
    category: "specific_date_or_time",
    pattern: /\b\d{1,2}\s+(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)(?:\s+\d{4})?\b/i,
  },
  {
    category: "specific_date_or_time",
    pattern: /\b(?:at|around|by)\s+\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)\b/i,
  },
  {
    category: "one_off_schedule_event",
    pattern: /\b(?:half[- ]days?|halfday)\b/i,
  },
  {
    category: "one_off_schedule_event",
    pattern: /\b(?:this|that|today['’]s|tomorrow['’]s|yesterday['’]s)\s+(?:appointment|meeting|trip|vacation|day\s+off|shift|event|occasion)\b/i,
  },
  {
    category: "one_off_schedule_event",
    pattern: /\b(?:on|during|after|before)\s+(?:today|that\s+day|this\s+occasion)\b/i,
  },
];

function normalizeTemporalText(value: string): string {
  return value.normalize("NFKC").replace(/[\u2010-\u2015]/g, "-");
}

function temporalFields(item: {
  claim: string;
  condition?: string;
  consequence?: string;
}): ObservationPolicyField[] {
  const fields: Array<[ObservationPolicyField, string | undefined]> = [
    ["claim", item.claim],
    ["condition", item.condition],
    ["consequence", item.consequence],
  ];
  return fields
    .filter(([, value]) => value !== undefined && value !== "")
    .filter(([, value]) =>
      TEMPORAL_RULES.some((rule) => rule.pattern.test(normalizeTemporalText(value!))))
    .map(([field]) => field);
}

export function findEventSpecificTemporalAnchors(item: {
  claim: string;
  condition?: string;
  consequence?: string;
}): ObservationTemporalAnchorReport | undefined {
  const fields = temporalFields(item);
  if (fields.length === 0) return undefined;
  const categories = [
    ...new Set(
      TEMPORAL_RULES
        .filter((rule) =>
          [item.claim, item.condition, item.consequence]
            .some((value) =>
              value !== undefined && value !== "" &&
              rule.pattern.test(normalizeTemporalText(value))))
        .map((rule) => rule.category),
    ),
  ];
  return { fields, categories };
}

export function evaluateObservationCandidate(
  item: ConsolidationItem,
  factsById: ReadonlyMap<string, MemoryFact>,
): ObservationPolicyDecision {
  const temporalAnchor = findEventSpecificTemporalAnchors(item);
  if (temporalAnchor) {
    return { eligible: false, reason: "event_specific_temporal_anchor", temporalAnchor };
  }

  const supportFacts = item.sourceFactIds
    .map((id) => factsById.get(id))
    .filter((fact): fact is MemoryFact => fact !== undefined);

  // Source-aware evidence counting. An observation's support set is
  // single-source by construction (each consolidation run's fact set is one
  // source); a mixed set is a provenance-isolation violation, not a policy
  // outcome. An empty support set (every cited fact missing) classifies as
  // neither source and keeps the legacy breadth rules below.
  const articleSourced = supportFacts.length > 0 &&
    supportFacts.every((fact) => fact.turnKey === null);
  const turnSourced = supportFacts.length > 0 &&
    supportFacts.every((fact) => fact.turnKey !== null);
  if (supportFacts.length > 0 && !articleSourced && !turnSourced) {
    throw new Error("observation candidate has mixed-source support evidence");
  }

  if (articleSourced) {
    // Article-sourced reactions contribute to assistant interests/preferences
    // evidence only: the supported kind is the preference kind, and the
    // evidence breadth is distinct independent reactions — never turns (an
    // article fact has no turn; counting one would be false turn evidence).
    if (item.kind !== "preference") {
      return { eligible: false, reason: "unsupported_kind_for_source" };
    }
    if (distinctReactionCount(supportFacts) < 2) {
      return { eligible: false, reason: "insufficient_independent_sources" };
    }
    return { eligible: true };
  }

  const distinctTurns = new Set(supportFacts.map((fact) => fact.turnKey));
  if (item.kind === "habit" || item.kind === "conditional_pattern") {
    if (distinctTurns.size < 2) {
      return { eligible: false, reason: "insufficient_distinct_turns" };
    }
  }
  if ((item.kind === "preference" || item.kind === "boundary") && distinctTurns.size < 2) {
    if (
      !(supportFacts.length > 0 &&
        supportFacts.every((fact) => fact.evidenceBasis === "direct_statement"))
    ) {
      return { eligible: false, reason: "one_turn_without_direct_statement" };
    }
  }
  return { eligible: true };
}

/**
 * Distinct independent article reactions among support facts. Each accepted
 * reaction produces exactly one fact, so this equals the support count while
 * that invariant holds; the distinct count stays correct even if it ever
 * breaks.
 */
export function distinctReactionCount(
  supportFacts: readonly MemoryFact[],
): number {
  return new Set(
    supportFacts
      .map((fact) => fact.articleReactionId)
      .filter((id): id is string => id !== null),
  ).size;
}

/**
 * Evidence strength from the support facts, with behavioral-day counting:
 * contradictions make a candidate tentative; habits and conditional patterns
 * need breadth (3+ facts across 2+ distinct behavioral days) to be strong.
 */
export function evidenceStrength(
  item: ConsolidationItem,
  supportFacts: readonly MemoryFact[],
  behavior: BehaviorTime,
): EvidenceStrength {
  const days = new Set(
    supportFacts.map((fact) => behavioralDay(fact.observedAt, behavior)),
  ).size;
  if (item.contradictionFactIds !== undefined && item.contradictionFactIds.length > 0) {
    return "tentative";
  }
  if (item.kind === "habit" || item.kind === "conditional_pattern") {
    if (supportFacts.length >= 3 && days >= 2) return "strong";
    if (supportFacts.length >= 2) return "supported";
    return "tentative";
  }
  if (supportFacts.length >= 3 && days >= 2) return "strong";
  return "supported";
}

export const __internal = { TEMPORAL_RULES, temporalFields };
