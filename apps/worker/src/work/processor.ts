/**
 * Per-turn processing: response-pattern decision first, chat second.
 *
 * The processor is transport-agnostic: the caller injects the two capability
 * calls and the context loaders. This keeps the orchestration testable
 * without network or database and keeps application policy (which models,
 * which endpoints) at the composition edge.
 *
 * The chat identity is required configuration and is loaded fail-closed
 * before any snapshot, decision, or provider call: a missing or empty
 * identity is an `IdentityConfigurationError` that fails the attempt — the
 * prompt is never assembled with an invented persona.
 *
 * Memory context (when a loader is provided) is assembled before the chat
 * call and sent as separate synthetic system messages — generated subject
 * profiles, temporal memory, and long-term recall each contribute their own
 * chunk, in that order, after identity and before the selected pattern's
 * guidance. Empty sections contribute no chunk; memory work never fails a
 * chat turn: loader errors are logged and the turn proceeds without the
 * failed section.
 *
 * Tracing boundaries (all injected, all fenced at the store):
 * - `recordSnapshot` — the attempt's input snapshot, before the decision step.
 * - `recordDecisionRequest` — the validated decision request (as sent),
 *   persisted BEFORE the provider call so the exact request exists even when
 *   the provider gives no usable response.
 * - `recordDecisionOutcome` — the available decision outcome after the call
 *   (the native response, or the actual transport/contract error), persisted
 *   BEFORE the selection step so a rejected or failed selection still leaves
 *   every response detail behind.
 * - `recordDecisionSelection` — the selection outcome (`selected` or
 *   `rejected`), recorded separately from the boundary.
 * - `recordChatRequest` — the exact chat request as sent, before the provider
 *   call.
 * - `recordChatOutcome` — the available outcome after the call: the native
 *   response and reply content, or the actual transport/contract error when
 *   no usable response arrived. Never invented; absent raw data stays absent.
 *
 * Behavior on unusable results is deliberately strict for this slice: a
 * decision that does not name an offered pattern, or a chat response that
 * fails the contract, propagates as a thrown error so the engine records a
 * failed turn. No silent fallback, retry, or normalization is applied; retry
 * policy remains an open decision.
 */

import type {
  AttemptSnapshotPayload,
  ChatOutcomeTrace,
  ChatOutcomeTracePayload,
  ChatRequestTracePayload,
  ChatIdentity,
  ConversationMessage,
  DecisionOutcomeTrace,
  DecisionOutcomeTracePayload,
  DecisionRequestTracePayload,
  DecisionSelectionTrace,
  ResponsePattern,
  TurnWork,
} from "../conversation/types.ts";
import {
  buildPatternChoiceRequest,
  DECISION_QUESTION_ID,
  selectResponsePattern,
} from "./decision.ts";
import { buildChatPrompt } from "./chat.ts";
import type { MemoryChatContext } from "../memory/types.ts";
import {
  ARTICLE_SHARE_QUESTION_ID,
  buildArticleShareContextForPrompt,
  buildArticleShareQuestion,
  selectArticleShare,
} from "../articles/share.ts";
import type { ArticleMemoryCandidate } from "../articles/types.ts";
import type { RelationshipExtractionItem } from "../relationship/types.ts";
import { OpenRouterTransportError } from "@companion/openrouter/transport";
import type {
  ChatRequest,
  ChatResponse,
} from "@companion/openrouter/chat";
import type {
  DecisionsRequest,
  DecisionsResponse,
} from "@companion/openrouter";
import { parseChatResponse } from "@companion/openrouter/chat";
import {
  parseDecisionsExchange,
  parseDecisionsRequest,
} from "@companion/openrouter";

export interface TurnProcessorDeps {
  readonly decisionModel: string;
  readonly chatModel: string;
  /** Perform the Decisions call; resolves with the raw response body. */
  readonly callDecisions: (request: DecisionsRequest) => Promise<unknown>;
  /** Perform the chat call; resolves with the raw response body. */
  readonly callChat: (request: ChatRequest) => Promise<unknown>;
  /** Enabled response patterns, in their stable presentation order. */
  readonly loadPatterns: () => Promise<readonly ResponsePattern[]>;
  /**
   * The owner-authored chat identity, read fresh per turn (fail-closed:
   * missing identity configuration is an `IdentityConfigurationError` that
   * fails the attempt before any snapshot, decision, or provider call).
   */
  readonly loadIdentity: () => Promise<ChatIdentity>;
  /** Prior-turn context for this turn, oldest first. */
  readonly loadContext: (turnId: string) => Promise<readonly ConversationMessage[]>;
  readonly temperature?: number;
  readonly maxTokens?: number;
  /**
   * Records the attempt's input snapshot (mutable patterns and the exact
   * ordered context) before the decision step begins. Fenced and idempotent
   * at the store.
   */
  readonly recordSnapshot?: (payload: AttemptSnapshotPayload) => Promise<void>;
  /**
   * Records the validated decision request (native typed request as sent)
   * BEFORE the provider call, in its own fenced transaction.
   */
  readonly recordDecisionRequest?: (payload: {
    readonly trace: DecisionRequestTracePayload;
  }) => Promise<void>;
  /**
   * Records the available decision outcome after the call (responded with
   * the native response, failed with the actual transport error, or invalid
   * with the contract validation error) before the selection step.
   */
  readonly recordDecisionOutcome?: (payload: DecisionOutcomeTracePayload) => Promise<void>;
  /**
   * Records the selection outcome for the named decision question (one trace
   * row per (attempt, question)): `selected` with the chosen pattern,
   * `selected-article` with the chosen article-memory candidate,
   * `selected-none` for the article-share question's legitimate no-action
   * outcome, or `rejected` with the reason.
   */
  readonly recordDecisionSelection?: (payload: {
    readonly questionId: string;
    readonly selection: DecisionSelectionTrace;
  }) => Promise<void>;
  /**
   * Records the exact chat request (with per-message source linkage) before
   * the provider call.
   */
  readonly recordChatRequest?: (payload: ChatRequestTracePayload) => Promise<void>;
  /**
   * Records the available chat outcome after the call (responded, failed, or
   * invalid) before publication.
   */
  readonly recordChatOutcome?: (payload: ChatOutcomeTracePayload) => Promise<void>;
  /**
   * Assembles the memory context (profiles, temporal memories, canonical
   * recall) for this turn, from the turn's user text. Memory work must never
   * fail a chat turn: the processor catches loader errors, logs them, and
   * continues without memory. Absent when memory is disabled.
   */
  readonly loadMemoryContext?: (input: {
    readonly turnId: string;
    readonly userText: string;
  }) => Promise<MemoryChatContext | null>;
  /**
   * Loads the per-turn article-memory share candidates (cooldown-eligible
   * accepted reactions, newest-first, deduplicated against the turn's recall
   * fact keys). Runs after the memory context so the recall dedupe input is
   * available. Absent, failing, or returning null all mean "ask no article
   * question this turn" — the article share is optional context, and its
   * loading must never fail a chat turn.
   */
  readonly loadArticleShareCandidates?: (input: {
    readonly turnId: string;
    readonly recallFactKeys: readonly string[];
  }) => Promise<readonly ArticleMemoryCandidate[] | null>;
  /**
   * Records the prompt-inclusion event for the chosen article-memory
   * candidate (the `article_share` row plus its metadata-only trace). The
   * record is an inclusion record, never a share claim; a failed write is
   * logged and never fails the turn.
   */
  readonly recordArticleShareInclusion?: (input: {
    readonly turnId: string;
    readonly reactionId: string;
  }) => Promise<void>;
  /** Optional database-configured relationship context; failures degrade to no context. */
  readonly loadRelationshipContext?: (turnId: string) => Promise<string | null>;
  /** Optional configured scheduled/applied routine state; failures degrade to no context. */
  readonly loadRoutineContext?: (turnId: string) => Promise<string | null>;
  /** Learns only from the just-completed new turn; failures never fail chat. */
  readonly extractRelationshipAnswers?: (input: {
    readonly turnId: string;
    readonly userText: string;
    readonly assistantText: string;
  }) => Promise<readonly RelationshipExtractionItem[]>;
}

/** The terminal result of one attempt, published by the engine. */
export interface TurnOutcome {
  readonly reply: string;
  readonly selectedPatternId: string | null;
  /** Prepared interpretations committed atomically with this reply when present. */
  readonly relationshipAnswers?: readonly RelationshipExtractionItem[];
}

/** Conversation state presented to the decision model: the visible thread so far. */
function decisionState(
  history: readonly ConversationMessage[],
  turnMessages: readonly ConversationMessage[],
): { conversation: { role: string; content: string }[] } {
  return {
    conversation: [...history, ...turnMessages].map((message) => ({
      role: message.role,
      content: message.content,
    })),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Builds the honest failure trace from a chat call error: the actual
 * transport error kind and message when it is an OpenRouterTransportError,
 * the truncated response body when the transport retained one, and a plain
 * error otherwise. Absent body data stays absent — never fabricated.
 */
function chatFailureTrace(error: unknown): ChatOutcomeTrace {
  if (error instanceof OpenRouterTransportError) {
    return {
      kind: "failed",
      errorKind: error.kind,
      message: error.message,
      body: error.body ?? null,
    };
  }
  return {
    kind: "failed",
    errorKind: "error",
    message: errorMessage(error),
    body: null,
  };
}

/**
 * Builds the honest failure trace from a decision call error: the actual
 * transport error kind and message when it is an OpenRouterTransportError,
 * the truncated response body when the transport retained one, and a plain
 * error otherwise. Absent body data stays absent — never fabricated.
 */
function decisionFailureTrace(error: unknown): DecisionOutcomeTrace {
  if (error instanceof OpenRouterTransportError) {
    return {
      kind: "failed",
      errorKind: error.kind,
      message: error.message,
      body: error.body ?? null,
    };
  }
  return {
    kind: "failed",
    errorKind: "error",
    message: errorMessage(error),
    body: null,
  };
}

/** Contract-validation failure: the body arrived but did not validate. */
function chatInvalidTrace(error: unknown): ChatOutcomeTrace {
  return { kind: "invalid", message: errorMessage(error) };
}

export async function processTurnWork(
  work: TurnWork,
  deps: TurnProcessorDeps,
): Promise<TurnOutcome> {
  const history = await deps.loadContext(work.turn.id);
  const patterns = await deps.loadPatterns();
  // The identity is required configuration. It is loaded fail-closed before
  // the snapshot and every provider call: with identity configuration
  // missing, the attempt fails here — nothing is invented in its place, and
  // no decision or chat spend happens against a persona-less prompt.
  const identity = await deps.loadIdentity();
  const fullContext = [...history, ...work.messages];

  // Snapshot boundary: the exact mutable patterns and ordered context this
  // attempt saw, recorded before the decision step begins.
  if (deps.recordSnapshot !== undefined) {
    await deps.recordSnapshot({ context: fullContext, patterns });
  }

  let selected: ResponsePattern | undefined;
  // The chosen article-memory candidate's context chunk, rendered when the
  // article-share decision selects a candidate; null otherwise.
  let articleChunk: string | null = null;

  // Memory context assembly, before the decision step so the article-memory
  // share candidates can deduplicate against the turn's lexical recall (the
  // decision state remains conversation-only, so the reorder has no
  // behavioral effect on the decision itself). Memory must never fail a
  // turn: loader errors are logged and the turn continues without the failed
  // section. Each loaded section is sent as its own synthetic system message
  // (null message source in the chat trace); a section that rendered nothing
  // contributes no chunk at all.
  let profilesChunk: string | null = null;
  let temporalChunk: string | null = null;
  let recallChunk: string | null = null;
  let recallFactKeys: string[] = [];
  if (deps.loadMemoryContext !== undefined) {
    const userText = work.messages
      .filter((message) => message.role === "user")
      .map((message) => message.content.trim())
      .filter(Boolean)
      .join("\n");
    if (userText.length > 0) {
      try {
        const loaded = await deps.loadMemoryContext({
          turnId: work.turn.id,
          userText,
        });
        profilesChunk = loaded?.profileSection ?? null;
        temporalChunk = loaded?.temporalContext ?? null;
        recallChunk = loaded?.memoryContext ?? null;
        recallFactKeys = [...(loaded?.recallFactKeys ?? [])];
      } catch (error) {
        console.warn(
          `[MEMORY] context assembly failed for turn ${work.turn.id}: ${errorMessage(error)}; continuing without memory`,
        );
        profilesChunk = null;
        temporalChunk = null;
        recallChunk = null;
        recallFactKeys = [];
      }
    }
  }

  // Article-memory share candidates: cooldown-eligible accepted reactions,
  // newest-first, deduplicated against this turn's recall fact keys. Loading
  // is optional and degrading: any failure means "ask no article question
  // this turn", never a failed chat turn.
  let articleCandidates: readonly ArticleMemoryCandidate[] = [];
  if (deps.loadArticleShareCandidates !== undefined) {
    try {
      const loaded = await deps.loadArticleShareCandidates({
        turnId: work.turn.id,
        recallFactKeys,
      });
      if (loaded !== null) articleCandidates = loaded;
    } catch (error) {
      console.warn(
        `[ARTICLE] share candidates failed for turn ${work.turn.id}: ${errorMessage(error)}; continuing without article context`,
      );
      articleCandidates = [];
    }
  }
  const articleShareAsked = articleCandidates.length > 0;

  if (patterns.length > 0 || articleShareAsked) {
    const state = decisionState(history, work.messages);
    const baseRequest = patterns.length > 0
      ? buildPatternChoiceRequest({
          model: deps.decisionModel,
          patterns,
          state,
        })
      : {
          model: deps.decisionModel,
          state,
          questions: {} as Record<string, never>,
        };
    const articleQuestion = articleShareAsked
      ? buildArticleShareQuestion(articleCandidates)
      : undefined;
    const request: DecisionsRequest = articleQuestion === undefined
      ? baseRequest
      : {
          model: baseRequest.model,
          state: baseRequest.state,
          questions: {
            ...baseRequest.questions,
            [articleQuestion.questionId]: articleQuestion.question,
          },
        };
    // Round-trip the built request through the contract parser so what is
    // sent is exactly what the contract validates.
    const validated = parseDecisionsRequest(request);

    // Decision request boundary: persisted before the provider call, one row
    // per asked question (the per-(attempt, question) trace). This write is
    // deliberate, not best-effort: a failure here fails the attempt rather
    // than calling the provider with an unrecorded request.
    if (deps.recordDecisionRequest !== undefined) {
      for (const questionId of Object.keys(validated.questions)) {
        await deps.recordDecisionRequest({ trace: { questionId, request: validated } });
      }
    }

    let rawResponse: unknown;
    try {
      rawResponse = await deps.callDecisions(validated);
    } catch (error) {
      // Transport failure: record the actual error (best-effort — a trace
      // write failure must never mask the original error) and rethrow so the
      // engine records a failed turn.
      if (deps.recordDecisionOutcome !== undefined) {
        try {
          for (const questionId of Object.keys(validated.questions)) {
            await deps.recordDecisionOutcome({
              trace: { questionId, request: validated },
              outcome: decisionFailureTrace(error),
            });
          }
        } catch {
          // best-effort; the original error propagates
        }
      }
      throw error;
    }

    let response: DecisionsResponse;
    try {
      response = parseDecisionsExchange(validated, rawResponse);
    } catch (error) {
      // Contract failure: a body arrived but did not validate.
      if (deps.recordDecisionOutcome !== undefined) {
        try {
          for (const questionId of Object.keys(validated.questions)) {
            await deps.recordDecisionOutcome({
              trace: { questionId, request: validated },
              outcome: { kind: "invalid", message: errorMessage(error) },
            });
          }
        } catch {
          // best-effort; the original error propagates
        }
      }
      throw error;
    }

    // Decision outcome boundary: the full validated exchange, persisted
    // BEFORE the selection step — so a rejected selection or a later chat
    // failure still leaves the complete native response behind. This write
    // is deliberate, not best-effort: a failure here fails the attempt rather
    // than selecting from an unrecorded response.
    if (deps.recordDecisionOutcome !== undefined) {
      for (const questionId of Object.keys(validated.questions)) {
        await deps.recordDecisionOutcome({
          trace: { questionId, request: validated },
          outcome: {
            kind: "responded",
            trace: {
              questionId,
              request: validated,
              response,
            },
          },
        });
      }
    }

    // Selection step, separate from the boundary, per question. A rejection
    // is recorded (best-effort: never masks the original error) and then
    // rethrown, so the engine fails the attempt exactly as before.
    if (patterns.length > 0) {
      let selection;
      try {
        selection = selectResponsePattern(response, patterns);
      } catch (error) {
        if (deps.recordDecisionSelection !== undefined) {
          try {
            await deps.recordDecisionSelection({
              questionId: DECISION_QUESTION_ID,
              selection: { kind: "rejected", reason: errorMessage(error) },
            });
          } catch {
            // best-effort; the original error propagates
          }
        }
        throw error;
      }
      selected = patterns.find((pattern) => pattern.id === selection.patternId);
      if (selected === undefined) {
        throw new Error("selected pattern disappeared between load and use");
      }
      if (deps.recordDecisionSelection !== undefined) {
        await deps.recordDecisionSelection({
          questionId: DECISION_QUESTION_ID,
          selection: { kind: "selected", patternId: selected.id },
        });
      }
    }

    // The article-share selection resolves the optional context question: a
    // chosen candidate becomes this turn's article context chunk, `none`
    // includes nothing. An unusable answer is an error, consistent with the
    // pattern selection policy — no silent fallback.
    if (articleShareAsked) {
      let articleSelection;
      try {
        articleSelection = selectArticleShare(response, articleCandidates);
      } catch (error) {
        if (deps.recordDecisionSelection !== undefined) {
          try {
            await deps.recordDecisionSelection({
              questionId: ARTICLE_SHARE_QUESTION_ID,
              selection: { kind: "rejected", reason: errorMessage(error) },
            });
          } catch {
            // best-effort; the original error propagates
          }
        }
        throw error;
      }
      if (deps.recordDecisionSelection !== undefined) {
        await deps.recordDecisionSelection({
          questionId: ARTICLE_SHARE_QUESTION_ID,
          // A `none` answer is the question's legitimate no-action outcome,
          // not a rejection: the selection step succeeded and chose the
          // permanent none option (the question's trace row carries
          // choice `none` with selection `selected`). Only an unusable
          // answer is a rejection, handled above.
          selection: articleSelection.kind === "none"
            ? { kind: "selected-none" }
            : {
                kind: "selected-article",
                reactionId: articleSelection.candidate.reactionId,
              },
        });
      }
      if (articleSelection.kind === "selected") {
        const chosen = articleSelection.candidate;
        articleChunk = buildArticleShareContextForPrompt(chosen);
        // The inclusion record is a prompt-inclusion event (never a share
        // claim); a failed write is logged and never fails the turn.
        if (deps.recordArticleShareInclusion !== undefined) {
          try {
            await deps.recordArticleShareInclusion({
              turnId: work.turn.id,
              reactionId: chosen.reactionId,
            });
          } catch (error) {
            console.warn(
              `[ARTICLE] share inclusion record failed for turn ${work.turn.id}: ${errorMessage(error)}; continuing`,
            );
          }
        }
      }
    }
  }

  // Relationship context is independently optional and degrading, like the
  // other domain-owned context loaders. It contains only runtime-configured
  // labels, thresholds, prompts, and answer-bank content.
  let relationshipChunk: string | null = null;
  if (deps.loadRelationshipContext !== undefined) {
    try {
      relationshipChunk = await deps.loadRelationshipContext(work.turn.id);
    } catch {
      console.warn(
        `[RELATIONSHIP] context load failed for turn ${work.turn.id}; continuing without relationship context`,
      );
    }
  }

  // Routine context is also optional and reactive-only. It is read near chat
  // assembly so a newly scheduled unavailable state can inform this still-
  // running reply; a transition after this snapshot cannot retroactively alter
  // the assembled provider request.
  let routineChunk: string | null = null;
  if (deps.loadRoutineContext !== undefined) {
    try {
      routineChunk = await deps.loadRoutineContext(work.turn.id);
    } catch {
      console.warn(
        `[ROUTINE] context load failed for turn ${work.turn.id}; continuing without routine context`,
      );
    }
  }

  // The assembled prompt is the single source of truth for the wire request
  // and its trace metadata: chunk classification and source linkage are
  // index-aligned by construction.
  const { request: chatRequest, messages: assembledMessages } = buildChatPrompt({
    model: deps.chatModel,
    history,
    turnMessages: work.messages,
    identity: identity.content,
    guidance: selected !== undefined ? selected.responseGuidance : null,
    ...(profilesChunk !== null ? { profiles: profilesChunk } : {}),
    ...(temporalChunk !== null ? { temporal: temporalChunk } : {}),
    ...(recallChunk !== null ? { recall: recallChunk } : {}),
    ...(articleChunk !== null ? { article: articleChunk } : {}),
    ...(relationshipChunk !== null ? { relationship: relationshipChunk } : {}),
    ...(routineChunk !== null ? { routine: routineChunk } : {}),
    ...(deps.temperature !== undefined ? { temperature: deps.temperature } : {}),
    ...(deps.maxTokens !== undefined ? { maxTokens: deps.maxTokens } : {}),
  });
  const messageSources = assembledMessages.map(
    (message) => message.sourceMessageId,
  );
  const messageChunks = assembledMessages.map((message) => message.chunk);

  // Chat request boundary: persisted before the provider call.
  if (deps.recordChatRequest !== undefined) {
    await deps.recordChatRequest({
      request: chatRequest,
      messageSources,
      messageChunks,
      identityRevision: identity.revision,
    });
  }

  let rawChatResponse: unknown;
  try {
    rawChatResponse = await deps.callChat(chatRequest);
  } catch (error) {
    // Transport failure: record the actual error (best-effort — a trace
    // write failure must never mask the original error) and rethrow so the
    // engine records a failed turn.
    if (deps.recordChatOutcome !== undefined) {
      try {
        await deps.recordChatOutcome({
          request: chatRequest,
          messageSources,
          messageChunks,
          identityRevision: identity.revision,
          outcome: chatFailureTrace(error),
        });
      } catch {
        // best-effort; the original error propagates
      }
    }
    throw error;
  }

  let chatResponse: ChatResponse;
  try {
    chatResponse = parseChatResponse(rawChatResponse);
  } catch (error) {
    // Contract failure: a body arrived but did not validate.
    if (deps.recordChatOutcome !== undefined) {
      try {
        await deps.recordChatOutcome({
          request: chatRequest,
          messageSources,
          messageChunks,
          identityRevision: identity.revision,
          outcome: chatInvalidTrace(error),
        });
      } catch {
        // best-effort; the original error propagates
      }
    }
    throw error;
  }
  const choice = chatResponse.choices[0];
  const reply = choice?.message.content ?? null;
  const applicationRejection =
    choice === undefined ? "chat response has no choices" : null;

  // Chat outcome boundary: persisted before the application usability check,
  // in its own fenced transaction. The returned response is recorded as-is
  // (even when unusable, with the application rejection reason captured
  // separately), so the trace is unambiguous: the response arrived, and the
  // application rejected it or not. This write is deliberate, not
  // best-effort: a failure here fails the attempt rather than publishing an
  // unrecorded boundary.
  if (deps.recordChatOutcome !== undefined) {
    await deps.recordChatOutcome({
      request: chatRequest,
      messageSources,
      messageChunks,
      identityRevision: identity.revision,
      outcome: {
        kind: "responded",
        response: chatResponse,
        replyContent: reply,
        applicationRejection,
      },
    });
  }

  if (choice === undefined) {
    throw new Error("chat response has no choices");
  }

  // Relationship answer interpretation is a best-effort extraction over this
  // new turn only. The resulting typed updates are committed by the
  // conversation store in the same transaction as publication, so a fenced or
  // failed attempt never changes the current answers.
  let relationshipAnswers: readonly RelationshipExtractionItem[] | undefined;
  if (deps.extractRelationshipAnswers !== undefined) {
    const userText = work.messages
      .filter((message) => message.role === "user")
      .map((message) => message.content.trim())
      .filter(Boolean)
      .join("\n");
    if (userText.length > 0 && choice.message.content.trim().length > 0) {
      try {
        relationshipAnswers = await deps.extractRelationshipAnswers({
          turnId: work.turn.id,
          userText,
          assistantText: choice.message.content,
        });
      } catch {
        console.warn(
          `[RELATIONSHIP] answer interpretation failed for turn ${work.turn.id}; continuing without this turn's answer updates`,
        );
      }
    }
  }

  // `choice` is narrowed here by the throw above, so the reply is a string.
  return {
    reply: choice.message.content,
    selectedPatternId: selected !== undefined ? selected.id : null,
    ...(relationshipAnswers !== undefined && relationshipAnswers.length > 0
      ? { relationshipAnswers }
      : {}),
  };
}
