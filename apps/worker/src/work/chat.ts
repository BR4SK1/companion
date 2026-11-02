/**
 * Modular, deterministic chat prompt assembly for a claimed turn.
 *
 * Every synthetic section is its own system message (one chunk each), in a
 * fixed order, followed by the conversation messages in exact chronological
 * order:
 *
 * 1. `identity`     — the owner-authored identity/persona from `chat_identity`
 *                     (required configuration; a missing identity is a
 *                     configuration error upstream, never an invented one).
 * 2. `profiles`     — optional generated subject profiles (v2 observation
 *                     profiles). Kept as a separate chunk from the other
 *                     memory sections because it is a separately generated,
 *                     fingerprint-gated document rather than per-turn recall
 *                     output; it sits after identity and before the per-turn
 *                     memory chunks, preserving the profile→temporal→recall
 *                     relative order the single-memory-message layout used.
 * 3. `temporal`     — optional recent temporal memory summaries.
 * 4. `recall`       — optional long-term canonical recall for this turn.
 * 5. `guidance`     — the selected response pattern's response guidance
 *                     (absent when no pattern was selected — with no
 *                     patterns enabled, or none selected, the request simply
 *                     carries no guidance chunk; fallback policy for missing
 *                     selections is unresolved).
 * 6. `conversation` — the prior-turn history (oldest first, bounded to the
 *                     most recent window by `getThreadContext`) followed by
 *                     the exact user messages grouped into the turn.
 *
 * Each optional section contributes a chunk only when it rendered non-empty
 * content — empty memory contributes no chunk. The history + turn-message
 * tail is the fixed snapshot: messages that arrive while the turn is in
 * flight are not part of it; they are grouped into the next turn by the
 * claimer. The assembly is a pure function of its inputs: same inputs, same
 * request, same chunk classification.
 */

import {
  parseChatRequest,
  type ChatRequest,
} from "@companion/openrouter/chat";
import type {
  ChatChunkName,
  ConversationMessage,
} from "../conversation/types.ts";

/** One assembled prompt message with its chunk classification and source. */
export interface AssembledChatMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
  readonly chunk: ChatChunkName;
  /**
   * The conversation_message id for `conversation` messages; null for every
   * synthetic system chunk (identity, profiles, temporal, recall, guidance).
   */
  readonly sourceMessageId: string | null;
}

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
  /**
   * Owner-authored identity text from `chat_identity`. Required: the
   * processor loads it fail-closed, so assembly never runs without it.
   */
  readonly identity: string;
  /** Selected pattern's response guidance; null when none. */
  readonly guidance: string | null;
  /** Optional generated subject profiles chunk. */
  readonly profiles?: string | null;
  /** Optional temporal-memory chunk. */
  readonly temporal?: string | null;
  /** Optional long-term-recall chunk. */
  readonly recall?: string | null;
  readonly temperature?: number;
  readonly maxTokens?: number;
}

/** An optional section contributes a chunk only when it is non-empty. */
function hasContent(section: string | null | undefined): boolean {
  return typeof section === "string" && section.trim().length > 0;
}

/**
 * Assembles the full prompt: the request as sent plus the per-message chunk
 * classification and source linkage, index-aligned by construction. This is
 * the single source of truth for both the wire request and its trace
 * metadata — the trace records exactly what assembly produced, with no
 * separately-maintained alignment logic to drift.
 */
export function buildChatPrompt(
  params: BuildChatRequestParams,
): {
  readonly request: ChatRequest;
  readonly messages: readonly AssembledChatMessage[];
} {
  const messages: AssembledChatMessage[] = [];
  messages.push({
    role: "system",
    content: params.identity,
    chunk: "identity",
    sourceMessageId: null,
  });
  for (const [chunk, section] of [
    ["profiles", params.profiles],
    ["temporal", params.temporal],
    ["recall", params.recall],
  ] as const) {
    if (hasContent(section)) {
      messages.push({
        role: "system",
        content: section as string,
        chunk,
        sourceMessageId: null,
      });
    }
  }
  if (params.guidance !== null) {
    messages.push({
      role: "system",
      content: params.guidance,
      chunk: "guidance",
      sourceMessageId: null,
    });
  }
  for (const message of [...params.history, ...params.turnMessages]) {
    messages.push({
      role: message.role,
      content: message.content,
      chunk: "conversation",
      sourceMessageId: message.id,
    });
  }
  const request = parseChatRequest({
    model: params.model,
    messages: messages.map((message) => ({
      role: message.role,
      content: message.content,
    })),
    ...(params.temperature !== undefined
      ? { temperature: params.temperature }
      : {}),
    ...(params.maxTokens !== undefined ? { max_tokens: params.maxTokens } : {}),
  });
  return { request, messages };
}

/** The chat request as sent (the prompt assembly's wire form). */
export function buildChatRequest(
  params: BuildChatRequestParams,
): ChatRequest {
  return buildChatPrompt(params).request;
}
