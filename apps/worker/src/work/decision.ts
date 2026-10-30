/**
 * Response-pattern selection via OpenRouter's native typed Decisions API.
 *
 * One narrow `choice` question is asked per turn: the offered options are
 * the enabled response-pattern records, each described by its
 * selection-description text (which is deliberately separate from the
 * response guidance used later to shape the chat request). The parsed
 * exchange is validated by the shared Decisions contract
 * (`parseDecisionsExchange`), which guarantees one answer per asked question
 * with the matching type.
 *
 * Selection policy for this slice: the returned `choice` value is the top
 * choice and is used as-is. Thresholds, top-N ranking, calibration, and
 * fallback for unusable or low-confidence results are NOT implemented — an
 * answer that does not name an offered pattern is an error, not a silent
 * fallback. Probabilities and confidence, when the provider returned them,
 * are recorded as diagnostics without normalization.
 */

import type {
  DecisionsChoiceAnswer,
  DecisionsRequest,
  DecisionsResponse,
  DecisionsState,
} from "@companion/openrouter";
import type { ResponsePattern } from "../conversation/types.ts";

/** Fixed question id for the per-turn response-pattern choice. */
export const DECISION_QUESTION_ID = "response_pattern";

/**
 * Generic, mechanism-level instructions for the selection question. This is
 * application behavior glue, not policy content: it says how to choose, not
 * what any specific pattern is or when it applies.
 */
const DECISION_INSTRUCTIONS =
  "Select the one response pattern that best fits the conversation state. " +
  "Each option below is described by its selection description.";

export class UnusableDecisionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnusableDecisionError";
  }
}

export interface PatternChoiceParams {
  readonly model: string;
  readonly patterns: readonly ResponsePattern[];
  /** Conversation state presented to the decision model. */
  readonly state: DecisionsState;
}

/**
 * Build the typed choice request. Option keys are pattern ids; option
 * descriptions are the patterns' selection descriptions, passed through
 * unchanged.
 */
export function buildPatternChoiceRequest(
  params: PatternChoiceParams,
): DecisionsRequest {
  if (params.patterns.length === 0) {
    throw new UnusableDecisionError(
      "cannot build a pattern choice request with no enabled patterns",
    );
  }
  // Own-key-safe map construction: pattern ids are external data (a pattern
  // row may legitimately be named `__proto__`), so build the criteria with
  // `Object.defineProperty` instead of ordinary assignment — assignment would
  // silently drop such an id by touching the prototype instead of creating
  // an own key (the same hazard the shared Decisions contract guards against
  // when parsing).
  const criteria: Record<string, string> = {};
  for (const pattern of params.patterns) {
    Object.defineProperty(criteria, pattern.id, {
      value: pattern.selectionDescription,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return {
    model: params.model,
    state: params.state,
    questions: {
      [DECISION_QUESTION_ID]: {
        type: "choice",
        instructions: DECISION_INSTRUCTIONS,
        criteria,
      },
    },
  };
}

export interface PatternSelection {
  readonly patternId: string;
  readonly answer: DecisionsChoiceAnswer;
}

/**
 * Extract the top choice from a validated exchange. Throws
 * `UnusableDecisionError` when the answer does not name one of the offered
 * patterns — there is no silent fallback.
 */
export function selectResponsePattern(
  response: DecisionsResponse,
  patterns: readonly ResponsePattern[],
): PatternSelection {
  const offered = new Set(patterns.map((pattern) => pattern.id));
  const answer = response.answers[DECISION_QUESTION_ID];
  if (answer === undefined || !Object.hasOwn(response.answers, DECISION_QUESTION_ID)) {
    throw new UnusableDecisionError(
      "decision response has no answer for the response-pattern question",
    );
  }
  if (answer.type !== "choice") {
    throw new UnusableDecisionError(
      `expected a choice answer, got ${answer.type}`,
    );
  }
  if (!offered.has(answer.choice)) {
    throw new UnusableDecisionError(
      `decision chose ${JSON.stringify(answer.choice)}, which is not an offered pattern`,
    );
  }
  return { patternId: answer.choice, answer };
}

/** Decision diagnostics recorded on the turn, as returned (no normalization). */
export interface RecordedDecision {
  readonly model: string;
  readonly choice: string;
  readonly probabilities?: Readonly<Record<string, number>>;
  readonly confidence?: number;
}

export function recordFromSelection(
  response: DecisionsResponse,
  selection: PatternSelection,
): RecordedDecision {
  const recorded: RecordedDecision = {
    model: response.model,
    choice: selection.answer.choice,
    ...(selection.answer.probabilities !== undefined
      ? { probabilities: selection.answer.probabilities }
      : {}),
    ...(selection.answer.confidence !== undefined
      ? { confidence: selection.answer.confidence }
      : {}),
  };
  return recorded;
}
