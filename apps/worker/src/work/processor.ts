/**
 * Per-turn processing: response-pattern decision first, then chat.
 *
 * The processor is transport-agnostic: the caller injects the two capability
 * calls (decision and chat) and the two context loaders. This keeps the
 * orchestration testable without network or database and keeps application
 * policy (which models, which endpoints) at the composition edge.
 *
 * Context semantics: both the decision state and the chat request are built
 * from one coherent snapshot of prior work — the messages of every turn
 * claimed before this one, in conversation order (per turn: its user
 * messages, then its reply; see `getThreadContext`) — followed by this
 * turn's own grouped messages. A reply published while a later user
 * message was already waiting (that message joins the next turn under
 * finish-then-group, so its `seq` is lower than the reply's) still
 * precedes that message in the snapshot. Messages that are still
 * unassigned belong to future turns and never appear. The snapshot is
 * keyed by turn association, so it is identical across lease reclaims of
 * the same turn.
 *
 * Behavior on unusable results is deliberately strict for this slice: a
 * decision that does not name an offered pattern, a chat response with no
 * usable choice, or any transport/contract error propagates as a thrown
 * error so the engine records a failed turn. No silent fallback, retry, or
 * normalization is applied; retry policy remains an open decision.
 */

import type {
  DecisionsRequest,
  DecisionsState,
} from "@companion/openrouter";
import {
  parseDecisionsExchange,
  parseDecisionsRequest,
} from "@companion/openrouter";
import {
  parseChatResponse,
  type ChatRequest,
} from "@companion/openrouter/chat";

import type { ConversationMessage, ResponsePattern, TurnWork } from "../conversation/types.ts";
import {
  buildPatternChoiceRequest,
  recordFromSelection,
  selectResponsePattern,
  type RecordedDecision,
} from "./decision.ts";
import { buildChatRequest } from "./chat.ts";

export interface TurnProcessorDeps {
  readonly decisionModel: string;
  readonly chatModel: string;
  /** Perform the Decisions call; resolves with the raw response body. */
  readonly callDecisions: (request: DecisionsRequest) => Promise<unknown>;
  /** Perform the chat call; resolves with the raw response body. */
  readonly callChat: (request: ChatRequest) => Promise<unknown>;
  /** Enabled response patterns at turn start (the turn's pattern snapshot). */
  readonly loadPatterns: () => Promise<readonly ResponsePattern[]>;
  /**
   * Prior-turn thread context for this turn, oldest first, in conversation
   * order: the messages of the turns claimed before this one (including
   * failed turns' user messages), excluding unassigned messages, this
   * turn's own grouped messages, and any later turns' messages. See
   * `getThreadContext`.
   */
  readonly loadContext: (
    turnId: string,
  ) => Promise<readonly ConversationMessage[]>;
  readonly temperature?: number;
  readonly maxTokens?: number;
}

export interface TurnOutcome {
  readonly reply: string;
  readonly selectedPatternId: string | null;
  readonly decision: RecordedDecision | null;
}

/** Conversation state presented to the decision model: the visible thread so far. */
function decisionState(
  history: readonly ConversationMessage[],
  turnMessages: readonly ConversationMessage[],
): DecisionsState {
  return {
    conversation: [...history, ...turnMessages].map((message) => ({
      role: message.role,
      content: message.content,
    })),
  };
}

export async function processTurnWork(
  work: TurnWork,
  deps: TurnProcessorDeps,
): Promise<TurnOutcome> {
  const history = await deps.loadContext(work.turn.id);
  const patterns = await deps.loadPatterns();

  let selected: ResponsePattern | undefined;
  let recorded: RecordedDecision | null = null;

  if (patterns.length > 0) {
    const request = buildPatternChoiceRequest({
      model: deps.decisionModel,
      patterns,
      state: decisionState(history, work.messages),
    });
    // Round-trip the built request through the contract parser so what is
    // sent is exactly what the contract validates.
    const validated = parseDecisionsRequest(request);
    const rawResponse = await deps.callDecisions(validated);
    const response = parseDecisionsExchange(validated, rawResponse);
    const selection = selectResponsePattern(response, patterns);
    selected = patterns.find((pattern) => pattern.id === selection.patternId);
    if (selected === undefined) {
      throw new Error("selected pattern disappeared between load and use");
    }
    recorded = recordFromSelection(response, selection);
  }

  const chatRequest = buildChatRequest({
    model: deps.chatModel,
    history,
    turnMessages: work.messages,
    guidance: selected !== undefined ? selected.responseGuidance : null,
    ...(deps.temperature !== undefined ? { temperature: deps.temperature } : {}),
    ...(deps.maxTokens !== undefined ? { maxTokens: deps.maxTokens } : {}),
  });
  const rawChatResponse = await deps.callChat(chatRequest);
  const chatResponse = parseChatResponse(rawChatResponse);
  const choice = chatResponse.choices[0];
  if (choice === undefined) {
    throw new Error("chat response has no choices");
  }
  const reply = choice.message.content;

  return {
    reply,
    selectedPatternId: selected !== undefined ? selected.id : null,
    decision: recorded,
  };
}
