/**
 * Temporal summary generation.
 *
 * Leaf periods (morning/afternoon/night) summarize the period's conversation
 * turns directly, with a coverage-biased selection (coverage-v4) that keeps a
 * bounded number of turn excerpts weighted toward the period's end. Aggregate
 * periods (day/week/month) summarize their children's completed summaries.
 * Empty periods stay absent: storing a completed placeholder would create
 * misleading memory data.
 *
 * Selection and budget constants are the pipeline's fixed operating points.
 * Rendering labels come from the configured subjects (`source_label`), never
 * code constants.
 */

import type { PostgresPool } from "@companion/postgres";

import type { MemoryConfig } from "../config.ts";
import {
  taskPresets,
  type MemoryLlmCaller,
  type TaskPreset,
} from "../llm.ts";
import {
  buildTemporalSummaryPrompt,
  buildTemporalSummaryResponseFormat,
  parseTemporalSummaryOutput,
  renderTemporalSummary,
  TEMPORAL_SUMMARY_PROMPT_VERSION,  promptContentHash,
} from "../prompts.ts";
import type { TemporalPeriod, TemporalSummary } from "../types.ts";
import { getChildPeriods } from "./periods.ts";
import type { BehaviorTime } from "../time.ts";
import { fingerprint, getTemporalSummary, saveTemporalSummary } from "./store.ts";

// Current near-term periods comfortably fit in one request. Keep a high
// safety threshold so normal periods do not fan out into costly map/reduce
// calls, while preserving a fallback for exceptionally large days.
const MAX_SOURCE_CHARS = 400_000;
const MAX_MESSAGE_CHARS = 12_000;
const MAX_SOURCE_PAIRS = 12;
const MAX_PAIRS_PER_SEGMENT = 3;
const COVERAGE_SELECTION_VERSION = "coverage-v4";
// Leaf budgets must cover the model's reasoning (counted against max_tokens
// on OpenRouter) plus the visible summary — tight ceilings made the model
// return empty output at finishReason "length".
const SUMMARY_MIN_TOKENS = 3000;
const SUMMARY_TOKENS_PER_MESSAGE = 6;
const SUMMARY_MAX_TOKENS = 4000;
const SUMMARY_CHARS_PER_TOKEN = 3;

const LEAF_KINDS: readonly TemporalPeriod["kind"][] = ["morning", "afternoon", "night"];

export interface TemporalGeneratorDeps {
  readonly pool: PostgresPool;
  readonly config: MemoryConfig;
  /** The behavioral-day boundary (provisioned configuration). */
  readonly behavior: BehaviorTime;
  readonly systemPrompt: string;
  readonly userLabel: string;
  readonly assistantLabel: string;
  readonly callLlm: MemoryLlmCaller;
}

export function getSummaryBudget(messageCount: number): {
  maxTokens: number;
  maxMemoryChars: number;
} {
  const normalizedCount = Math.max(1, Math.ceil(messageCount));
  const maxTokens = Math.min(
    SUMMARY_MAX_TOKENS,
    Math.max(SUMMARY_MIN_TOKENS, normalizedCount * SUMMARY_TOKENS_PER_MESSAGE),
  );
  return {
    maxTokens,
    maxMemoryChars: Math.max(
      800,
      Math.min(6000, Math.floor(maxTokens * SUMMARY_CHARS_PER_TOKEN)),
    ),
  };
}

function getTemporalSummaryTaskPreset(
  kind: TemporalPeriod["kind"],
  budget: ReturnType<typeof getSummaryBudget>,
  config: MemoryConfig,
): TaskPreset {
  const presets = taskPresets(config);
  if (kind === "day" || kind === "week" || kind === "month") {
    return {
      ...presets.temporalSummaryAggregate,
      maxTokens: Math.max(
        presets.temporalSummaryAggregate.maxTokens,
        budget.maxTokens,
      ),
    };
  }
  return {
    ...presets.temporalSummaryLeaf,
    maxTokens: budget.maxTokens,
  };
}

interface CoverageMessage {
  readonly id: string;
  readonly turnId: string | null;
  readonly role: string;
  readonly content: string;
  readonly createdAt: Date;
  readonly turnCompleted: boolean;
}

interface TurnPair {
  readonly id: string;
  readonly startAt: Date;
  readonly endAt: Date;
  readonly userText: string;
  readonly assistantText: string;
  readonly sourceIds: readonly string[];
  readonly combinedChars: number;
  readonly hasTurnLog: boolean;
  segment: number;
  score: number;
}

function hasUnfinishedThread(pair: TurnPair): boolean {
  return /[?…]|\b(?:later|tomorrow|next time|need to|should we|remember to|still)\b/i.test(
    `${pair.userText}\n${pair.assistantText}`,
  );
}

export function buildTurnPairs(
  messages: readonly CoverageMessage[],
): TurnPair[] {
  const groups = new Map<string, CoverageMessage[]>();
  for (const [index, message] of messages.entries()) {
    const key = message.turnId ?? `message-${String(index)}`;
    const group = groups.get(key) ?? [];
    group.push(message);
    groups.set(key, group);
  }

  const pairs = [...groups.entries()].map(([key, group]) => {
    const sorted = group.slice().sort(
      (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
    );
    const userText = sorted
      .filter((message) => message.role === "user")
      .map((message) => message.content.trim())
      .filter(Boolean)
      .join("\n");
    const assistantText = sorted
      .filter((message) => message.role === "assistant")
      .map((message) => message.content.trim())
      .filter(Boolean)
      .join("\n");
    const pair: TurnPair = {
      id: key,
      startAt: sorted[0]!.createdAt,
      endAt: sorted[sorted.length - 1]!.createdAt,
      userText,
      assistantText,
      sourceIds: sorted.map((message) => message.id),
      combinedChars: userText.length + assistantText.length,
      hasTurnLog: sorted.every((message) => message.turnCompleted),
      segment: 0,
      score: 0,
    };
    return pair;
  });

  pairs.sort(
    (a, b) =>
      a.startAt.getTime() - b.startAt.getTime() || a.id.localeCompare(b.id),
  );
  for (const [index, pair] of pairs.entries()) {
    pair.segment = Math.min(3, Math.floor((index * 4) / pairs.length));
    pair.score =
      (pair.segment === 3 ? 100 : 0) +
      (pair.userText && pair.assistantText ? 30 : 0) +
      (hasUnfinishedThread(pair) ? 20 : 0) +
      Math.min(10, pair.combinedChars / 60);
  }
  return pairs;
}

export function selectCoveragePairs(pairs: readonly TurnPair[]): TurnPair[] {
  const selected: TurnPair[] = [];
  const segmentCounts = [0, 0, 0, 0];
  const add = (pair: TurnPair): boolean => {
    if (selected.includes(pair) || selected.length >= MAX_SOURCE_PAIRS) return false;
    if (segmentCounts[pair.segment]! >= MAX_PAIRS_PER_SEGMENT) return false;
    selected.push(pair);
    segmentCounts[pair.segment] = segmentCounts[pair.segment]! + 1;
    return true;
  };
  const ranked = (items: readonly TurnPair[]) => items.slice().sort(
    (a, b) =>
      b.score - a.score ||
      b.endAt.getTime() - a.endAt.getTime() ||
      b.combinedChars - a.combinedChars ||
      a.id.localeCompare(b.id),
  );

  for (let segment = 0; segment < 4; segment += 1) {
    const candidate = ranked(pairs.filter((pair) => pair.segment === segment))[0];
    if (candidate !== undefined) add(candidate);
  }

  for (const candidate of ranked(pairs)) add(candidate);

  return selected.sort(
    (a, b) =>
      a.startAt.getTime() - b.startAt.getTime() || a.id.localeCompare(b.id),
  );
}

interface SourceUnit {
  readonly text: string;
  readonly sourceIds: readonly string[];
}

function renderPairSource(
  pair: TurnPair,
  excerptNumber: number,
  userLabel: string,
  assistantLabel: string,
): SourceUnit {
  const sides = [
    pair.userText && `${userLabel}: ${pair.userText.slice(0, MAX_MESSAGE_CHARS / 2)}`,
    pair.assistantText && `${assistantLabel}: ${pair.assistantText.slice(0, MAX_MESSAGE_CHARS / 2)}`,
  ].filter(Boolean);
  return {
    sourceIds: pair.sourceIds,
    text: [
      `CONVERSATION EXCERPT ${String(excerptNumber)}`,
      `timestamp=[${pair.startAt.toISOString()}, ${pair.endAt.toISOString()}]`,
      sides.join("\n"),
      `END CONVERSATION EXCERPT ${String(excerptNumber)}`,
    ].filter(Boolean).join("\n"),
  };
}

interface SummarySource {
  readonly units: readonly SourceUnit[];
  readonly messageIds: readonly string[];
  readonly childSummaryKeys: readonly string[];
  readonly messageCount: number;
  readonly fingerprintParts: readonly string[];
  readonly selectionVersion: string | null;
  readonly selectedPairIds: readonly string[];
  readonly segmentPairCounts: readonly number[];
  readonly withTurnLog: number | null;
}

async function loadMessageSource(
  deps: TemporalGeneratorDeps,
  period: TemporalPeriod,
): Promise<SummarySource> {
  const result = await deps.pool.query<{
    id: string;
    turn_id: string | null;
    role: string;
    content: string;
    created_at: Date;
    turn_completed: boolean | null;
  }>(
    `SELECT m.id, m.turn_id, m.role, m.content, m.created_at,
            (t.status = 'completed') AS turn_completed
     FROM conversation_message m
     LEFT JOIN conversation_turn t ON t.id = m.turn_id
     WHERE m.created_at >= $1 AND m.created_at < $2
       AND m.role IN ('user', 'assistant')
     ORDER BY m.created_at, m.id`,
    [period.startAt, period.endAt],
  );
  const messages: CoverageMessage[] = result.rows.map((row) => ({
    id: row.id,
    turnId: row.turn_id,
    role: row.role,
    content: row.content,
    createdAt: row.created_at,
    turnCompleted: row.turn_completed === true,
  }));

  if (messages.length === 0) {
    return {
      units: [],
      messageIds: [],
      childSummaryKeys: [],
      messageCount: 0,
      fingerprintParts: [],
      selectionVersion: null,
      selectedPairIds: [],
      segmentPairCounts: [],
      withTurnLog: null,
    };
  }

  const pairs = buildTurnPairs(messages);
  const selectedPairs = selectCoveragePairs(pairs);
  const units = selectedPairs.map((pair, index) =>
    renderPairSource(pair, index + 1, deps.userLabel, deps.assistantLabel),
  );
  const segmentPairCounts = [0, 0, 0, 0];
  for (const pair of pairs) {
    segmentPairCounts[pair.segment] = (segmentPairCounts[pair.segment] ?? 0) + 1;
  }
  const withTurnLog = pairs.filter((pair) => pair.hasTurnLog).length;

  return {
    units,
    messageIds: messages.map((message) => message.id),
    childSummaryKeys: [],
    messageCount: messages.length,
    selectionVersion: COVERAGE_SELECTION_VERSION,
    selectedPairIds: selectedPairs.map((pair) => pair.id),
    segmentPairCounts,
    withTurnLog,
    fingerprintParts: [
      COVERAGE_SELECTION_VERSION,
      ...messages.map((message) =>
        [
          message.id,
          message.createdAt.toISOString(),
          message.role,
          message.content,
        ].join("|"),
      ),
      ...selectedPairs.map((pair) =>
        [
          pair.id,
          String(pair.segment),
        ].join("|"),
      ),
    ],
  };
}

async function loadChildSource(
  deps: TemporalGeneratorDeps,
  period: TemporalPeriod,
  now: Date,
): Promise<SummarySource | null> {
  const children = getChildPeriods(period, deps.behavior);
  const childDocuments: GeneratedSummary[] = [];

  for (const child of children) {
    const document = await generateTemporalSummary(deps, child, now);
    if (document !== null && document.messageCount > 0) {
      childDocuments.push(document);
    }
  }

  if (childDocuments.length === 0) return null;

  const units = childDocuments.map((child, index) => ({
    sourceIds: child.messageIds,
    text: [
      `PRIOR MEMORY ${String(index + 1)}`,
      `period=[${child.period.startAt.toISOString()}, ${child.period.endAt.toISOString()})`,
      child.content,
      `END PRIOR MEMORY ${String(index + 1)}`,
    ].join("\n"),
  }));

  return {
    units,
    messageIds: childDocuments.flatMap((child) => child.messageIds),
    childSummaryKeys: childDocuments.map(
      (child) => `summary:${child.period.kind}:${child.period.periodKey}`,
    ),
    messageCount: childDocuments.reduce(
      (count, child) => count + child.messageCount,
      0,
    ),
    fingerprintParts: childDocuments.map(
      (child) =>
        `${child.period.kind}:${child.period.periodKey}:${child.fingerprint}`,
    ),
    selectionVersion: null,
    selectedPairIds: [],
    segmentPairCounts: [],
    withTurnLog: null,
  };
}

export function splitSource(units: readonly SourceUnit[]): SourceUnit[][] {
  if (units.length === 0) return [[]];

  const chunks: SourceUnit[][] = [];
  let current: SourceUnit[] = [];
  let currentChars = 0;

  for (const unit of units) {
    const nextChars = currentChars + unit.text.length + 1;
    if (current.length > 0 && nextChars > MAX_SOURCE_CHARS) {
      chunks.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(unit);
    currentChars += unit.text.length + 1;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

function sourceText(units: readonly SourceUnit[]): string {
  if (units.length === 0) {
    return "There were no eligible messages in this exact period. Do not invent activity.";
  }
  return units.map((unit) => unit.text).join("\n\n");
}

async function callSummaryModel(
  deps: TemporalGeneratorDeps,
  period: TemporalPeriod,
  units: readonly SourceUnit[],
  budget: ReturnType<typeof getSummaryBudget>,
): Promise<{
  content: string;
  inputTokens: number;
  outputTokens: number;
  callCount: number;
  attemptCount: number;
  structuredOutputFallback: boolean;
}> {
  const prompt = buildTemporalSummaryPrompt(
    deps.systemPrompt,
    period,
    sourceText(units),
    budget.maxMemoryChars,
  );
  const result = await deps.callLlm({
    systemPrompt: prompt.systemPrompt,
    userMessage: prompt.messages[0]!.content,
    taskPreset: getTemporalSummaryTaskPreset(period.kind, budget, deps.config),
    responseFormat: buildTemporalSummaryResponseFormat(budget.maxMemoryChars),
  });

  const output = parseTemporalSummaryOutput(result.text);

  return {
    content: renderTemporalSummary(
      period,
      output,
      budget.maxMemoryChars,
      deps.userLabel,
    ),
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    callCount: 1,
    attemptCount: result.attemptCount,
    structuredOutputFallback: result.structuredOutputFallback,
  };
}

interface SummarizeResult {
  readonly content: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly callCount: number;
  readonly attemptCount: number;
  readonly structuredOutputFallback: boolean;
}

async function summarizeSource(
  deps: TemporalGeneratorDeps,
  period: TemporalPeriod,
  source: SummarySource,
): Promise<SummarizeResult> {
  if (source.messageCount === 0) {
    return {
      content: "No conversation activity was recorded during this period.",
      inputTokens: 0,
      outputTokens: 0,
      callCount: 0,
      attemptCount: 0,
      structuredOutputFallback: false,
    };
  }

  const chunks = splitSource(source.units);
  const budget = getSummaryBudget(source.messageCount);
  if (chunks.length === 1) {
    return callSummaryModel(deps, period, chunks[0]!, budget);
  }

  const partials: SourceUnit[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let callCount = 0;
  let attemptCount = 0;
  let structuredOutputFallback = false;
  for (const [index, chunk] of chunks.entries()) {
    const result = await callSummaryModel(deps, period, chunk, budget);
    inputTokens += result.inputTokens;
    outputTokens += result.outputTokens;
    callCount += result.callCount;
    attemptCount += result.attemptCount;
    structuredOutputFallback ||= result.structuredOutputFallback;
    partials.push({
      sourceIds: [...new Set(chunk.flatMap((unit) => [...unit.sourceIds]))],
      text: [
        `PARTIAL MEMORY ${String(index + 1)}`,
        result.content,
        `END PARTIAL MEMORY ${String(index + 1)}`,
      ].join("\n"),
    });
  }

  const reduced = await callSummaryModel(deps, period, partials, budget);
  return {
    content: reduced.content,
    inputTokens: inputTokens + reduced.inputTokens,
    outputTokens: outputTokens + reduced.outputTokens,
    callCount: callCount + reduced.callCount,
    attemptCount: attemptCount + reduced.attemptCount,
    structuredOutputFallback:
      structuredOutputFallback || reduced.structuredOutputFallback,
  };
}

/** The result of one summary generation attempt, ready to persist. */
export interface GeneratedSummary {
  readonly period: TemporalPeriod;
  readonly content: string;
  readonly messageIds: readonly string[];
  readonly childSummaryKeys: readonly string[];
  readonly messageCount: number;
  readonly fingerprint: string;
  readonly selectionVersion: string | null;
  readonly selectedPairIds: readonly string[];
  readonly segmentPairCounts: readonly number[];
  readonly withTurnLog: number | null;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly callCount: number;
  readonly status: "complete";
}

/**
 * Generate (or reuse) the summary for one period. Returns null when the
 * period is still open or contained no eligible source material.
 */
export async function generateTemporalSummary(
  deps: TemporalGeneratorDeps,
  period: TemporalPeriod,
  now: Date = new Date(),
): Promise<GeneratedSummary | null> {
  if (!deps.config.temporalSummariesEnabled || period.endAt.getTime() > now.getTime()) {
    return null;
  }

  const source = LEAF_KINDS.includes(period.kind)
    ? await loadMessageSource(deps, period)
    : await loadChildSource(deps, period, now);
  if (source === null || source.messageCount === 0) return null;

  const promptHash = promptContentHash(deps.systemPrompt);
  // The generation fingerprint includes every generation-affecting input:
  // prompt version, the exact prompt content, the configured model, and the
  // source selection. A model change (WORKER_MEMORY_MODEL) or a same-version
  // prompt edit invalidates the cached summary and forces regeneration.
  const sourceFingerprint = fingerprint([
    TEMPORAL_SUMMARY_PROMPT_VERSION,
    promptHash,
    deps.config.model,
    period.kind,
    period.periodKey,
    ...source.fingerprintParts,
  ]);
  const existing = await getTemporalSummary(deps.pool, period);
  if (
    existing?.status === "complete" &&
    existing.fingerprint === sourceFingerprint
  ) {
    return storedToGenerated(existing, period);
  }

  const generated = await summarizeSource(deps, period, source);
  const timestamp = new Date();
  const summary: GeneratedSummary = {
    period,
    content: generated.content,
    messageIds: source.messageIds,
    childSummaryKeys: source.childSummaryKeys,
    messageCount: source.messageCount,
    fingerprint: sourceFingerprint,
    selectionVersion: source.selectionVersion,
    selectedPairIds: source.selectedPairIds,
    segmentPairCounts: source.segmentPairCounts,
    withTurnLog: source.withTurnLog,
    inputTokens: generated.inputTokens,
    outputTokens: generated.outputTokens,
    callCount: generated.callCount,
    status: "complete",
  };
  await saveTemporalSummary(deps.pool, {
    period,
    timezone: deps.behavior.timezone,
    content: summary.content,
    messageCount: summary.messageCount,
    fingerprint: summary.fingerprint,
    selectionVersion: summary.selectionVersion,
    selectedPairIds: summary.selectedPairIds,
    segmentPairCounts: summary.segmentPairCounts,
    withTurnLog: summary.withTurnLog,
    childSummaryKeys: summary.childSummaryKeys,
    model: deps.config.model,
    promptVersion: TEMPORAL_SUMMARY_PROMPT_VERSION,
    promptContentHash: promptHash,
    generatedAt: timestamp,
    inputTokens: summary.inputTokens,
    outputTokens: summary.outputTokens,
    callCount: summary.callCount,
    messageIds: summary.messageIds,
    status: "complete",
  });
  return summary;
}

function storedToGenerated(
  existing: TemporalSummary,
  period: TemporalPeriod,
): GeneratedSummary {
  return {
    period,
    content: existing.content,
    // Provenance is read back from storage (summary columns + links table),
    // so a cached summary keeps the source-message and selection evidence of
    // the generation it was produced by.
    messageIds: existing.messageIds ?? [],
    childSummaryKeys: existing.childSummaryKeys,
    messageCount: existing.messageCount,
    fingerprint: existing.fingerprint,
    selectionVersion: existing.selectionVersion,
    selectedPairIds: existing.selectedPairIds ?? [],
    segmentPairCounts: existing.segmentPairCounts ?? [],
    withTurnLog: null,
    inputTokens: existing.inputTokens,
    outputTokens: existing.outputTokens,
    callCount: existing.callCount,
    status: "complete",
  };
}

export const __internal = {
  MAX_SOURCE_CHARS,
  getSummaryBudget,
  getTemporalSummaryTaskPreset,
  buildTurnPairs,
  selectCoveragePairs,
  renderPairSource,
  splitSource,
};
