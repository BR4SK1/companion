/**
 * Modular, deterministic chat prompt assembly for a claimed turn.
 *
 * Each synthetic section is represented by system message(s) in a
 * fixed order, followed by the conversation messages in exact chronological
 * order:
 *
 * 1. `identity`      — the owner-authored identity/persona from `chat_identity`
 *                      (required configuration; a missing identity is a
 *                      configuration error upstream, never an invented one).
 * 2. `profiles`      — optional generated subject profiles (v2 observation
 *                      profiles).
 * 3. `relationship`  — optional slim familiarity/stage context (tier, time
 *                      known, reply budget; no answer-bank dump).
 * 4. `temporal`      — optional recent temporal memory summaries (running daily
 *                      list of closed periods, decoupled from wall-clock time).
 * 5. `recall`        — optional long-term canonical recall for this turn.
 * 6. `article`       — optional per-turn article-memory background context on
 *                      non-initiative turns when separately selected.
 * 7. `guidance`      — the selected response pattern's response guidance or
 *                      assembled dynamic initiative block (omitted when absent
 *                      or whitespace-only, keeping normal chat turns lean).
 * 8. `time`          — optional wall-clock local date, time, season, and
 *                      upcoming occasions, positioned immediately before live
 *                      state and conversation.
 * 9. `routine`       — optional scheduled/applied routine live state.
 * 10. `prompt_module` — optional independently selected authoritative live
 *                      context (e.g., outfit state) or additive thoughts from
 *                      database-configured modules.
 * 11. `conversation` — the prior-turn history (oldest first, bounded to the
 *                      most recent window by `getThreadContext`) followed by
 *                      the exact user messages grouped into the turn.
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
  type ChatReasoning,
  type ChatRequest,
} from "@companion/openrouter/chat";
import type {
  AssembledChatMessage,
  ConversationMessage,
} from "../conversation/types.ts";
import { stripImageActionMarkers } from "../image/types.ts";
import type { PromptModulePromptOutput } from "../prompt-modules/types.ts";

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
  /** Optional temporal-memory summaries chunk. */
  readonly temporal?: string | null;
  /** Optional wall-clock local date, time, season, and occasion chunk. */
  readonly time?: string | null;
  /** Optional long-term-recall chunk. */
  readonly recall?: string | null;
  /**
   * Optional per-turn article-memory context chunk (the chosen candidate of
   * the article-memory share decision). Rendered by the article domain; the
   * chat assembly only classifies it as its own chunk.
   */
  readonly article?: string | null;
  /** Optional generic relationship/familiarity context. */
  readonly relationship?: string | null;
  /** Optional configured routine state and reactive interaction context. */
  readonly routine?: string | null;
  /** Independently selected module outputs with stable database identity/order. */
  readonly promptModules?: readonly PromptModulePromptOutput[];
  readonly temperature?: number;
  readonly maxTokens?: number;
  /**
   * Optional OpenRouter reasoning options, passed through to the chat
   * contract unchanged. The assembly adds no default: callers that omit
   * it send no reasoning options.
   */
  readonly reasoning?: ChatReasoning;
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
    promptModuleId: null,
  });
  for (const [chunk, section] of [
    ["profiles", params.profiles],
    ["relationship", params.relationship],
    ["temporal", params.temporal],
    ["recall", params.recall],
    ["article", params.article],
  ] as const) {
    if (hasContent(section)) {
      messages.push({
        role: "system",
        content: section as string,
        chunk,
        sourceMessageId: null,
        promptModuleId: null,
      });
    }
  }
  if (hasContent(params.guidance)) {
    messages.push({
      role: "system",
      content: params.guidance as string,
      chunk: "guidance",
      sourceMessageId: null,
      promptModuleId: null,
    });
  }
  for (const [chunk, section] of [
    ["time", params.time],
    ["routine", params.routine],
  ] as const) {
    if (hasContent(section)) {
      messages.push({
        role: "system",
        content: section as string,
        chunk,
        sourceMessageId: null,
        promptModuleId: null,
      });
    }
  }
  for (const thought of params.promptModules ?? []) {
    if (!hasContent(thought.content)) continue;
    messages.push({
      role: "system",
      content: thought.outputKind === "authoritative_context"
        ? `Authoritative context from a configured service (not literal thoughts, feelings, or instructions):\n${thought.content}`
        : `Authoritative additive companion thoughts and feelings (not background data):\n${thought.content}`,
      chunk: "prompt_module",
      sourceMessageId: null,
      promptModuleId: thought.moduleId,
    });
  }
  for (const message of [...params.history, ...params.turnMessages]) {
    const content =
      message.role === "assistant"
        ? stripImageActionMarkers(message.content)
        : message.content;
    if (message.role === "assistant" && content.length === 0) {
      continue;
    }
    const previous = messages[messages.length - 1];
    // Coalesce consecutive assistant messages (for example an ordinary reply
    // followed by a background routine/schedule message) so the chat request
    // never presents back-to-back assistant turns that confuse speaker
    // attribution in downstream chat templates. Grouped user turns stay
    // separate to preserve per-message source linkage.
    if (
      message.role === "assistant" &&
      previous !== undefined &&
      previous.chunk === "conversation" &&
      previous.role === "assistant"
    ) {
      messages[messages.length - 1] = {
        ...previous,
        content: `${previous.content}\n\n${content}`,
      };
      continue;
    }
    messages.push({
      role: message.role,
      content,
      chunk: "conversation",
      sourceMessageId: message.id,
      promptModuleId: null,
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
    ...(params.reasoning !== undefined
      ? {
          reasoning: {
            ...(params.reasoning.effort !== undefined
              ? { effort: params.reasoning.effort }
              : {}),
            ...(params.reasoning.exclude !== undefined
              ? { exclude: params.reasoning.exclude }
              : {}),
          },
        }
      : {}),
  });
  return { request, messages };
}

/** The chat request as sent (the prompt assembly's wire form). */
export function buildChatRequest(
  params: BuildChatRequestParams,
): ChatRequest {
  return buildChatPrompt(params).request;
}
