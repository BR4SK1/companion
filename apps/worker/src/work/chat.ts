/**
 * Chat request assembly for a claimed turn.
 *
 * The chat request is a fixed snapshot: prior turn-associated history
 * (bounded by the configured context limit, loaded at turn start, in
 * conversation order — see `getThreadContext`) followed by the exact user
 * messages grouped into the turn. Messages that arrive while the turn is
 * in flight are not part of this snapshot; they are grouped into the next
 * turn by the claimer.
 *
 * When a response pattern was selected, its response guidance is sent as the
 * leading system message. When a memory context was assembled for the turn,
 * it is sent as a second system message, immediately after the guidance —
 * synthetic content with no conversation-message source. With no patterns
 * enabled (or none selected), the request carries only the memory system
 * message; with neither, the request is sent without system content — a
 * deliberate MVP behavior, since fallback policy for missing selections is
 * unresolved.
 */

import {
  parseChatRequest,
  type ChatRequest,
  type ChatRequestMessage,
} from "@companion/openrouter/chat";
import type { ConversationMessage } from "../conversation/types.ts";

export interface BuildChatRequestParams {
  readonly model: string;
  /**
   * Prior-turn context, oldest first in conversation order: the messages
   * of the turns claimed before this one, excluding this turn's messages
   * and any later work (see `getThreadContext`).
   */
  readonly history: readonly ConversationMessage[];
  /** The user messages grouped into the current turn, in seq order. */
  readonly turnMessages: readonly ConversationMessage[];
  /** Response guidance from the selected pattern; null when none. */
  readonly guidance: string | null;
  /**
   * Assembled memory context (profiles, temporal memories, canonical
   * recall); null when none was assembled or memory is disabled.
   */
  readonly memoryContext?: string | null;
  readonly temperature?: number;
  readonly maxTokens?: number;
}

export function buildChatRequest(
  params: BuildChatRequestParams,
): ChatRequest {
  const messages: ChatRequestMessage[] = [];
  if (params.guidance !== null) {
    messages.push({ role: "system", content: params.guidance });
  }
  if (params.memoryContext !== undefined && params.memoryContext !== null) {
    messages.push({ role: "system", content: params.memoryContext });
  }
  for (const message of [...params.history, ...params.turnMessages]) {
    messages.push({ role: message.role, content: message.content });
  }
  return parseChatRequest({
    model: params.model,
    messages,
    ...(params.temperature !== undefined
      ? { temperature: params.temperature }
      : {}),
    ...(params.maxTokens !== undefined ? { max_tokens: params.maxTokens } : {}),
  });
}
