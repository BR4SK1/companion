/**
 * Memory prompt contracts: response formats, parsers, and source renderers.
 *
 * The structural contract (JSON schemas, parsing rules, envelope semantics,
 * render layout) is code. The persona-bearing system prompt text for every
 * task is personal configuration loaded from the `memory_prompt` table —
 * never code, never documentation. Subject ids and source-rendering labels
 * come from the `memory_subject` table for the same reason.
 *
 * Prompt versions are identifiers (not content) and stay in code because they
 * participate in the generation signatures that make extraction caching and
 * promotion idempotency work.
 */

import {
  hashArtifact,
} from "./hashing.ts";
import type {
  ConsolidationItem,
  FactExtractionItem,
  FactExtractionOutput,
  ObservationKind,
  SourceTurn,
  TemporalPeriod,
} from "./types.ts";

/**
 * A provider response failed structural validation. Every parse/validation
 * throw in this module uses this class so callers can classify the failure
 * (`llm_output_invalid`) without sniffing message text. Messages are
 * fixed-shape: code-controlled labels only, never model-derived content —
 * these messages can reach durable diagnostics (`memory_run.error`, trace
 * details, logs).
 */
export class MemoryLlmOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemoryLlmOutputError";
  }
}

export const FACT_EXTRACTION_PROMPT_VERSION = "memory-facts-prompt-v7";
export const OBSERVATION_CONSOLIDATION_PROMPT_VERSION = "memory-observations-prompt-v9";
export const TEMPORAL_SUMMARY_PROMPT_VERSION = "temporal-v6";
export const PROFILE_SUMMARY_PROMPT_VERSION = "profile-v1";
export const MEMORY_PROFILE_PROMPT_VERSION = "v2-1";

export const PROMPT_KINDS = {
  factExtraction: "fact_extraction",
  observationConsolidation: "observation_consolidation",
  temporalSummary: "temporal_summary",
  profileSummary: "profile_summary",
  observationProfile: "observation_profile",
} as const;

const FACT_KINDS = [
  "fact",
  "preference",
  "habit",
  "conditional_pattern",
  "observed_interaction",
  "boundary",
] as const;

const OBSERVATION_KINDS = [
  "fact",
  "preference",
  "habit",
  "conditional_pattern",
  "boundary",
] as const;

const EXPLICITNESS = ["explicit", "supported", "inferred"] as const;

const EVIDENCE_BASIS = [
  "direct_statement",
  "observed_behavior",
  "observed_interaction",
  "inferred",
] as const;

const MAX_FACT_CLAIM_CHARS = 1_000;
const MAX_RELATION_CHARS = 500;
const MAX_BATCH_FACTS = 12;
const MAX_OBSERVATIONS = 30;
const TOPIC_PATTERN = /^[a-z0-9][a-z0-9_-]{0,39}$/;

function enumSchema(values: readonly string[]) {
  return { type: "string", enum: [...values] };
}

export interface PromptSpec {
  readonly systemPrompt: string;
  readonly messages: ReadonlyArray<{ role: "user"; content: string }>;
}

// ---------------------------------------------------------------------------
// Fact extraction
// ---------------------------------------------------------------------------

export function buildFactExtractionResponseFormat(subjects: readonly string[]) {
  const factProperties = {
    subject: enumSchema(subjects),
    kind: enumSchema(FACT_KINDS),
    claim: { type: "string", minLength: 1, maxLength: MAX_FACT_CLAIM_CHARS },
    topics: {
      type: "array",
      maxItems: 5,
      items: { type: "string", minLength: 1, maxLength: 40 },
    },
    condition: { type: "string", maxLength: MAX_RELATION_CHARS },
    consequence: { type: "string", maxLength: MAX_RELATION_CHARS },
    explicitness: enumSchema(EXPLICITNESS),
    evidenceBasis: enumSchema(EVIDENCE_BASIS),
  };
  const factRequired = [
    "subject",
    "kind",
    "claim",
    "topics",
    "condition",
    "consequence",
    "explicitness",
    "evidenceBasis",
  ];
  return {
    type: "json_schema",
    json_schema: {
      name: "memory_facts",
      strict: true,
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          sources: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                sourceTurnId: { type: "string", minLength: 1, maxLength: 300 },
                facts: {
                  type: "array",
                  maxItems: MAX_BATCH_FACTS,
                  items: {
                    type: "object",
                    additionalProperties: false,
                    properties: factProperties,
                    required: factRequired,
                  },
                },
              },
              required: ["sourceTurnId", "facts"],
            },
          },
        },
        required: ["sources"],
      },
    },
  } as const;
}

/** Render source turns for the extraction model, with configured side labels. */
export function renderFactSource(
  turns: readonly SourceTurn[],
  userLabel: string,
  assistantLabel: string,
): string {
  return turns
    .map((turn) =>
      [
        `SOURCE TURN ID: ${turn.turnKey}`,
        `TIMESTAMP: [${turn.startAt.toISOString()}, ${turn.endAt.toISOString()}]`,
        `${userLabel}: ${turn.userText}`,
        `${assistantLabel}: ${turn.assistantText}`,
        `END SOURCE TURN: ${turn.turnKey}`,
      ].join("\n"),
    )
    .join("\n\n");
}

export function buildFactExtractionPrompt(
  systemPrompt: string,
  source: string,
): PromptSpec {
  return {
    systemPrompt,
    messages: [
      {
        role: "user",
        content: [
          "SOURCE MATERIAL",
          source,
          "END SOURCE MATERIAL",
          "",
          "Extract only durable evidence from these turns now.",
        ].join("\n"),
      },
    ],
  };
}

function parseObject(text: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new MemoryLlmOutputError(`${label} response was not valid JSON`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new MemoryLlmOutputError(`${label} response was not an object`);
  }
  return parsed as Record<string, unknown>;
}

function requiredString(value: unknown, field: string, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new MemoryLlmOutputError(`${label} field ${field} must be a non-empty string`);
  }
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}

function normalizeTopics(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new MemoryLlmOutputError(`${label} topics must be an array`);
  const topics = value
    .map((topic) => requiredString(topic, "topics", label).toLowerCase())
    .map((topic) => topic.replace(/\s+/g, "-"));
  if (topics.length > 5) throw new MemoryLlmOutputError(`${label} topics must contain at most five items`);
  if (topics.some((topic) => !TOPIC_PATTERN.test(topic))) {
    throw new MemoryLlmOutputError(`${label} topics must be lowercase labels`);
  }
  return [...new Set(topics)];
}

function enumValue<T extends string>(
  value: unknown,
  values: readonly T[],
  field: string,
  label: string,
): T {
  if (typeof value !== "string" || !values.includes(value as T)) {
    throw new MemoryLlmOutputError(`${label} field ${field} was invalid`);
  }
  return value as T;
}

function parseFactFields(
  raw: unknown,
  label: string,
  subjects: readonly string[],
): Omit<FactExtractionItem, "sourceTurnId"> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new MemoryLlmOutputError(`${label} was not an object`);
  }
  const item = raw as Record<string, unknown>;
  return {
    subject: enumValue(item.subject, subjects, "subject", label),
    kind: enumValue(item.kind, FACT_KINDS, "kind", label),
    claim: requiredString(item.claim, "claim", label),
    topics: normalizeTopics(item.topics, label),
    ...(optionalString(item.condition)
      ? { condition: optionalString(item.condition) }
      : {}),
    ...(optionalString(item.consequence)
      ? { consequence: optionalString(item.consequence) }
      : {}),
    explicitness: enumValue(item.explicitness, EXPLICITNESS, "explicitness", label),
    evidenceBasis: enumValue(item.evidenceBasis, EVIDENCE_BASIS, "evidenceBasis", label),
  };
}

export function parseFactExtractionOutput(
  text: string,
  subjects: readonly string[],
): FactExtractionOutput {
  const value = parseObject(text, "Memory fact extraction");
  if (!Array.isArray(value.sources)) {
    throw new MemoryLlmOutputError("Memory fact extraction sources must be an array");
  }
  const sourceIds = new Set<string>();
  const sources = value.sources.map((raw, index) => {
    const label = `Memory fact source ${index + 1}`;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new MemoryLlmOutputError(`${label} was not an object`);
    }
    const source = raw as Record<string, unknown>;
    const sourceTurnId = requiredString(source.sourceTurnId, "sourceTurnId", label);
    if (sourceIds.has(sourceTurnId)) {
      throw new MemoryLlmOutputError(`${label} duplicated sourceTurnId`);
    }
    sourceIds.add(sourceTurnId);
    if (!Array.isArray(source.facts)) {
      throw new MemoryLlmOutputError(`${label} facts must be an array`);
    }
    return {
      sourceTurnId,
      facts: source.facts.map((item, factIndex) =>
        parseFactFields(item, `${label} fact ${factIndex + 1}`, subjects)),
    };
  });
  const facts = sources.flatMap((source) =>
    source.facts.map((item) => ({
      sourceTurnId: source.sourceTurnId,
      ...item,
    })));
  if (facts.length > MAX_BATCH_FACTS) {
    throw new MemoryLlmOutputError("Memory fact extraction returned more than twelve facts");
  }
  return { facts, sources };
}

// ---------------------------------------------------------------------------
// Observation consolidation
// ---------------------------------------------------------------------------

export function buildObservationConsolidationResponseFormat(
  subjects: readonly string[],
) {
  return {
    type: "json_schema",
    json_schema: {
      name: "memory_observations",
      strict: true,
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          observations: {
            type: "array",
            maxItems: MAX_OBSERVATIONS,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                subject: enumSchema(subjects),
                kind: enumSchema(OBSERVATION_KINDS),
                claim: { type: "string", minLength: 1, maxLength: MAX_FACT_CLAIM_CHARS },
                topics: {
                  type: "array",
                  maxItems: 5,
                  items: { type: "string", minLength: 1, maxLength: 40 },
                },
                condition: { type: "string", maxLength: MAX_RELATION_CHARS },
                consequence: { type: "string", maxLength: MAX_RELATION_CHARS },
                sourceFactIds: {
                  type: "array",
                  minItems: 1,
                  maxItems: 80,
                  items: { type: "string", minLength: 1, maxLength: 100 },
                },
                contradictionFactIds: {
                  type: "array",
                  maxItems: 80,
                  items: { type: "string", minLength: 1, maxLength: 100 },
                },
              },
              required: [
                "subject",
                "kind",
                "claim",
                "topics",
                "condition",
                "consequence",
                "sourceFactIds",
                "contradictionFactIds",
              ],
            },
          },
        },
        required: ["observations"],
      },
    },
  } as const;
}

/** Render extracted facts as consolidation input. */
export function renderFactInput(
  facts: ReadonlyArray<{
    id: string;
    subject: string;
    kind: string;
    claim: string;
    topics: readonly string[];
    condition?: string;
    consequence?: string;
    observedAt: Date;
    turnId: string;
  }>,
): string {
  return facts
    .map((fact) =>
      [
        `FACT ID: ${fact.id}`,
        `SOURCE TURN: ${fact.turnId}`,
        `OBSERVED AT: ${fact.observedAt.toISOString()}`,
        `SUBJECT: ${fact.subject}`,
        `KIND: ${fact.kind}`,
        `TOPICS: ${fact.topics.join(", ") || "none"}`,
        `CLAIM: ${fact.claim}`,
        fact.condition ? `CONDITION: ${fact.condition}` : "CONDITION: ",
        fact.consequence ? `CONSEQUENCE: ${fact.consequence}` : "CONSEQUENCE: ",
        `END FACT: ${fact.id}`,
      ].join("\n"),
    )
    .join("\n\n");
}

export function buildObservationConsolidationPrompt(
  systemPrompt: string,
  source: string,
): PromptSpec {
  return {
    systemPrompt,
    messages: [
      {
        role: "user",
        content: [
          "EXTRACTED FACTS",
          source,
          "END EXTRACTED FACTS",
          "",
          "Consolidate only the observations supported by these facts now.",
        ].join("\n"),
      },
    ],
  };
}

export function parseObservationConsolidationOutput(
  text: string,
  subjects: readonly string[],
): { observations: ConsolidationItem[] } {
  const value = parseObject(text, "Memory observation consolidation");
  if (!Array.isArray(value.observations)) {
    throw new MemoryLlmOutputError("Memory observation consolidation observations must be an array");
  }
  return {
    observations: value.observations.map((raw, index) => {
      const label = `Memory observation ${index + 1}`;
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        throw new MemoryLlmOutputError(`${label} was not an object`);
      }
      const item = raw as Record<string, unknown>;
      const sourceFactIds = item.sourceFactIds;
      const contradictionFactIds = item.contradictionFactIds;
      if (!Array.isArray(sourceFactIds) || sourceFactIds.length === 0) {
        throw new MemoryLlmOutputError(`${label} sourceFactIds must not be empty`);
      }
      if (!Array.isArray(contradictionFactIds)) {
        throw new MemoryLlmOutputError(`${label} contradictionFactIds must be an array`);
      }
      return {
        subject: enumValue(item.subject, subjects, "subject", label),
        kind: enumValue(item.kind, OBSERVATION_KINDS, "kind", label) as ObservationKind,
        claim: requiredString(item.claim, "claim", label),
        topics: normalizeTopics(item.topics, label),
        ...(optionalString(item.condition)
          ? { condition: optionalString(item.condition) }
          : {}),
        ...(optionalString(item.consequence)
          ? { consequence: optionalString(item.consequence) }
          : {}),
        sourceFactIds: sourceFactIds.map((id) => requiredString(id, "sourceFactIds", label)),
        contradictionFactIds: contradictionFactIds.map((id) =>
          requiredString(id, "contradictionFactIds", label)),
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// Temporal summaries
// ---------------------------------------------------------------------------

const TEMPORAL_PREFIXES = {
  night: "Last night",
  morning: "This morning",
  afternoon: "This afternoon",
  day: "Yesterday",
  week: "Last week",
  month: "Last month",
} as const;

export function getTemporalPrefix(kind: TemporalPeriod["kind"]): string {
  return TEMPORAL_PREFIXES[kind];
}

export function buildTemporalSummaryResponseFormat(maxMemoryChars: number) {
  return {
    type: "json_schema",
    json_schema: {
      name: "temporal_memory",
      strict: true,
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          eventsAndFeelings: { type: "string", minLength: 0, maxLength: maxMemoryChars },
          learnedFacts: { type: "string", minLength: 0, maxLength: maxMemoryChars },
          discoveredPreferences: { type: "string", minLength: 0, maxLength: maxMemoryChars },
        },
        required: ["eventsAndFeelings", "learnedFacts", "discoveredPreferences"],
      },
    },
  } as const;
}

export interface TemporalSummaryOutput {
  readonly eventsAndFeelings: string;
  readonly learnedFacts: string;
  readonly discoveredPreferences: string;
}

export function buildTemporalSummaryPrompt(
  systemPrompt: string,
  period: TemporalPeriod,
  source: string,
  maxMemoryChars: number,
): PromptSpec {
  const periodDescription = [
    `Memory period: ${period.kind}`,
    `Application-owned opening: ${getTemporalPrefix(period.kind)},`,
    `Memory window: [${period.startAt.toISOString()}, ${period.endAt.toISOString()})`,
    `Target memory length: approximately ${Math.round(maxMemoryChars / 4)} visible tokens, with a hard limit of ${maxMemoryChars} characters.`,
    "Treat the supplied window as the complete memory period and do not repeat its opening in the diary prose.",
  ].join("\n");
  return {
    systemPrompt,
    messages: [
      {
        role: "user",
        content: `${periodDescription}\n\nSOURCE MATERIAL\n${source}\nEND SOURCE MATERIAL\n\nProduce the JSON memory now.`,
      },
    ],
  };
}

export function parseTemporalSummaryOutput(text: string): TemporalSummaryOutput {
  const value = parseObject(text, "Temporal memory");
  const eventsAndFeelings = value.eventsAndFeelings;
  const learnedFacts = value.learnedFacts;
  const discoveredPreferences = value.discoveredPreferences;
  if (
    typeof eventsAndFeelings !== "string" ||
    typeof learnedFacts !== "string" ||
    typeof discoveredPreferences !== "string"
  ) {
    throw new MemoryLlmOutputError("Temporal memory response did not match the expected schema");
  }
  const output = {
    eventsAndFeelings: eventsAndFeelings.trim(),
    learnedFacts: learnedFacts.trim(),
    discoveredPreferences: discoveredPreferences.trim(),
  };
  if (Object.values(output).every((field) => !field)) {
    throw new MemoryLlmOutputError("Temporal memory response was empty");
  }
  return output;
}

function trimAtSentenceBoundary(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  if (maxChars <= 3) return text.slice(0, maxChars);
  const candidate = text.slice(0, maxChars + 1);
  const sentenceEnd = Math.max(
    candidate.lastIndexOf(". "),
    candidate.lastIndexOf("! "),
    candidate.lastIndexOf("? "),
  );
  if (sentenceEnd >= Math.floor(maxChars * 0.55)) {
    return candidate.slice(0, sentenceEnd + 1).trim();
  }
  const wordLimit = maxChars - 3;
  const safeWordEnd = candidate.slice(0, wordLimit + 1).lastIndexOf(" ");
  return `${candidate.slice(0, safeWordEnd > 0 ? safeWordEnd : wordLimit).trim()}...`;
}

/**
 * Render a temporal summary: the application-owned opener plus the three
 * diary fields. Second-person pronouns are normalized to the configured
 * user-subject label (the personal name is configuration, not code).
 */
export function renderTemporalSummary(
  period: TemporalPeriod,
  output: TemporalSummaryOutput,
  maxMemoryChars: number,
  userLabel: string,
): string {
  const prefix = getTemporalPrefix(period.kind);
  const repeatedPrefix =
    /^(last night|this morning|this afternoon|yesterday|last week|last month)\s*,?\s*/i;
  const normalizeSecondPerson = (text: string): string =>
    text
      .replace(/\byou're\b/gi, `${userLabel} is`)
      .replace(/\byou've\b/gi, `${userLabel} has`)
      .replace(/\byou'll\b/gi, `${userLabel} will`)
      .replace(/\byou'd\b/gi, `${userLabel} would`)
      .replace(/\byou are\b/gi, `${userLabel} is`)
      .replace(/\byou were\b/gi, `${userLabel} was`)
      .replace(/\byou have\b/gi, `${userLabel} has`)
      .replace(/\byou had\b/gi, `${userLabel} had`)
      .replace(/\byou will\b/gi, `${userLabel} will`)
      .replace(/\byou would\b/gi, `${userLabel} would`)
      .replace(/\byours\b/gi, `${userLabel}'s`)
      .replace(/\byour\b/gi, `${userLabel}'s`)
      .replace(/\byou\b/gi, userLabel);
  const normalize = (text: string): string =>
    normalizeSecondPerson(text).replace(repeatedPrefix, "").replace(/\s+/g, " ").trim();
  const eventText = normalize(output.eventsAndFeelings);
  const factText = normalize(output.learnedFacts);
  const preferenceText = normalize(output.discoveredPreferences);
  const sections = [
    { key: "events", label: "", text: eventText },
    { key: "facts", label: "What I learned", text: factText },
    { key: "preferences", label: "Preferences I noticed", text: preferenceText },
  ].filter((section) => section.text);
  if (sections.length === 0) {
    throw new MemoryLlmOutputError("Temporal memory body was empty after normalization");
  }

  const fixedChars =
    `${prefix}, `.length +
    sections.reduce(
      (total, section, index) =>
        total + (section.label ? section.label.length + 2 : 0) + (index > 0 ? 2 : 0),
      0,
    );
  const contentBudget = Math.max(1, maxMemoryChars - fixedChars);
  const hasEvents = Boolean(eventText);
  const weights = sections.map((section) => {
    if (sections.length === 1) return 1;
    if (!hasEvents) return 1 / sections.length;
    return section.key === "events" ? 0.55 : 0.45 / (sections.length - 1);
  });
  const weightTotal = weights.reduce((total, weight) => total + weight, 0);
  const renderedSections = sections.map((section, index) => {
    const sectionBudget = Math.max(
      1,
      Math.floor((contentBudget * (weights[index] ?? 0)) / weightTotal),
    );
    const text = trimAtSentenceBoundary(section.text, sectionBudget);
    return `${section.label ? `${section.label}: ` : ""}${text}`;
  });
  const body = renderedSections.join("\n\n");
  if (/\b(the user|the assistant|the companion)\b/i.test(body)) {
    throw new MemoryLlmOutputError("Temporal memory used detached third-person attribution");
  }
  if (!/\b(?:I|I'm|I've|I'd|I'll|me|my|mine|we|our|ours|us)\b/i.test(body)) {
    throw new MemoryLlmOutputError("Temporal memory was not written in first person");
  }

  return trimAtSentenceBoundary(`${prefix}, ${body}`, maxMemoryChars);
}

// ---------------------------------------------------------------------------
// Profile summaries (v1, from temporal day summaries)
// ---------------------------------------------------------------------------

export const PROFILE_RESPONSE_FORMAT = {
  type: "json_schema",
  json_schema: {
    name: "subject_profile",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        profile: { type: "string", minLength: 0 },
        claims: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              text: { type: "string", minLength: 1 },
              evidence: { type: "array", items: { type: "string", minLength: 1 } },
            },
            required: ["text", "evidence"],
          },
        },
      },
      required: ["profile", "claims"],
    },
  },
} as const;

export interface ProfileV1Output {
  readonly profile: string;
  readonly claims: ReadonlyArray<{ text: string; evidence: readonly string[] }>;
}

/** Lenient parse: the v1 profile pipeline degrades to raw text on bad JSON. */
export function parseProfileV1Output(text: string): ProfileV1Output {
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const claims = Array.isArray(parsed.claims)
      ? parsed.claims.flatMap((claim) => {
          if (!claim || typeof claim !== "object") return [];
          const item = claim as Record<string, unknown>;
          if (typeof item.text !== "string" || !Array.isArray(item.evidence)) return [];
          return [{
            text: item.text.trim(),
            evidence: item.evidence.filter((id): id is string => typeof id === "string"),
          }];
        })
      : [];
    return {
      profile: typeof parsed.profile === "string" ? parsed.profile.trim() : "",
      claims,
    };
  } catch {
    return { profile: text.trim(), claims: [] };
  }
}

// ---------------------------------------------------------------------------
// Observation profiles (v2, from canonical observations)
// ---------------------------------------------------------------------------

const MAX_PROFILE_CONTENT_CHARS = 4000;

export function buildObservationProfileResponseFormat() {
  return {
    type: "json_schema",
    json_schema: {
      name: "memory_profile_v2",
      schema: {
        type: "object",
        properties: {
          content: { type: "string" },
          claims: {
            type: "array",
            items: {
              type: "object",
              properties: {
                observationId: { type: "string" },
                text: { type: "string" },
              },
              required: ["observationId", "text"],
              additionalProperties: false,
            },
          },
        },
        required: ["content", "claims"],
        additionalProperties: false,
      },
    },
  };
}

export function buildObservationProfilePrompt(
  systemPrompt: string,
  observations: ReadonlyArray<{
    observationId: string;
    kind: string;
    claim: string;
    condition?: string;
    consequence?: string;
    topics: readonly string[];
    evidenceStrength: string;
    distinctDayCount: number;
  }>,
): PromptSpec {
  return {
    systemPrompt,
    messages: [
      {
        role: "user",
        content: [
          "REVIEWED OBSERVATIONS",
          JSON.stringify(observations),
          "",
          "Write the reference sheet in your voice, then list every observation you used in claims.",
        ].join("\n"),
      },
    ],
  };
}

export interface ParsedProfileV2 {
  readonly content: string;
  readonly claims: ReadonlyArray<{ observationId: string; text: string }>;
}

export function parseProfileV2Output(
  text: string,
  observations: ReadonlyArray<{ observationId: string }>,
): ParsedProfileV2 {
  const parsed = parseObject(text, "Profile");
  if (typeof parsed.content !== "string") {
    throw new MemoryLlmOutputError("Profile response was missing content");
  }
  const content = parsed.content.trim();
  if (!content) throw new MemoryLlmOutputError("Profile content was empty");
  if (content.length > MAX_PROFILE_CONTENT_CHARS) {
    throw new MemoryLlmOutputError(
      `Profile content exceeded ${MAX_PROFILE_CONTENT_CHARS} characters`,
    );
  }
  const knownIds = new Set(observations.map((observation) => observation.observationId));
  const claims: Array<{ observationId: string; text: string }> = [];
  if (Array.isArray(parsed.claims)) {
    for (const rawClaim of parsed.claims) {
      if (!rawClaim || typeof rawClaim !== "object" || Array.isArray(rawClaim)) continue;
      const record = rawClaim as Record<string, unknown>;
      const observationId = typeof record.observationId === "string" ? record.observationId : "";
      const claimText = typeof record.text === "string" ? record.text.trim() : "";
      if (!observationId || !claimText) continue;
      if (!knownIds.has(observationId)) {
        throw new MemoryLlmOutputError(
          "Profile claim referenced an unknown observation id",
        );
      }
      claims.push({ observationId, text: claimText.slice(0, 400) });
    }
  }
  return { content, claims };
}

// ---------------------------------------------------------------------------
// Generation signatures
// ---------------------------------------------------------------------------

export interface FactSignatureInput {
  readonly model: string;
  readonly providerBaseUrl: string;
  readonly taskMaxTokens: number;
  readonly taskTemperature: number;
  readonly batchTurns: number;
  readonly batchMaxChars: number;
  /** Hash of the exact system-prompt content in use (not just its version). */
  readonly promptContentHash: string;
}

/** Content hash of the exact prompt text in use: generation signatures and
 *  fingerprints bind to what was actually sent, not just to a version label
 *  (a re-provisioned same-version prompt must invalidate caches). */
export function promptContentHash(systemPrompt: string): string {
  return hashArtifact("memory-prompt-content-v1", systemPrompt);
}

export function factGenerationSignature(
  version: string,
  input: FactSignatureInput,
): string {
  return hashArtifact(
    "fact-generation",
    JSON.stringify({
      schemaVersion: "memory-facts-schema-v1",
      outputContract: "source-envelope-v1",
      promptVersion: version,
      promptContentHash: input.promptContentHash,
      model: input.model,
      providerBaseUrl: input.providerBaseUrl,
      taskPreset: { maxTokens: input.taskMaxTokens, temperature: input.taskTemperature },
      batchTurns: input.batchTurns,
      batchMaxChars: input.batchMaxChars,
    }),
  );
}

export interface ObservationSignatureInput {
  readonly model: string;
  readonly taskMaxTokens: number;
  readonly taskTemperature: number;
  readonly maxFacts: number;
  readonly maxSourceChars: number;
  /** Hash of the exact system-prompt content in use (not just its version). */
  readonly promptContentHash: string;
}

export function observationGenerationSignature(
  version: string,
  input: ObservationSignatureInput,
): string {
  return hashArtifact(
    "observation-generation",
    JSON.stringify({
      schemaVersion: "memory-observations-schema-v1",
      promptVersion: version,
      promptContentHash: input.promptContentHash,
      model: input.model,
      taskPreset: { maxTokens: input.taskMaxTokens, temperature: input.taskTemperature },
      maxFacts: input.maxFacts,
      maxSourceChars: input.maxSourceChars,
    }),
  );
}

/** Production fact identity: deterministic per turn, subject, and content. */
export function factKeyOf(item: {
  turnKey: string;
  subject: string;
  kind: string;
  claim: string;
  condition?: string;
  consequence?: string;
  topics: readonly string[];
  explicitness: string;
}): string {
  return hashArtifact(
    "fact",
    item.turnKey,
    item.subject,
    item.kind,
    item.claim.toLowerCase(),
    (item.condition ?? "").toLowerCase(),
    (item.consequence ?? "").toLowerCase(),
    item.topics.join(","),
    item.explicitness,
  );
}

export function observationKeyOf(item: {
  subject: string;
  kind: string;
  claim: string;
  condition?: string;
  consequence?: string;
}): string {
  return hashArtifact(
    "observation",
    item.subject,
    item.kind,
    item.claim.toLowerCase(),
    (item.condition ?? "").toLowerCase(),
    (item.consequence ?? "").toLowerCase(),
  );
}

export const __internal = {
  FACT_KINDS,
  OBSERVATION_KINDS,
  EXPLICITNESS,
  EVIDENCE_BASIS,
  MAX_BATCH_FACTS,
  MAX_OBSERVATIONS,
  trimAtSentenceBoundary,
};
