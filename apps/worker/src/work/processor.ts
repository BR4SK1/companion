/**
 * Per-turn processing: response-pattern/article decisions, independent optional
 * module applicability/execution, then chat.
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
 * - Chat diagnostics — every completed main-chat call also emits one
 *   structured, privacy-safe `[CHAT_DIAGNOSTIC]` log line (see
 *   `chat-diagnostics.ts`), correlated by turn id + attempt: the request as
 *   sent (model, effective `max_tokens`, requested reasoning effort with
 *   unset kept distinct), the response shape without content (content
 *   shape, finish reason, validated usage), and the outcome/validation
 *   path. It is emitted before the outcome trace write on every outcome,
 *   so diagnostics stay visible for an invalid response even when the
 *   best-effort trace write fails. Diagnostics never include prompts,
 *   replies, reasoning text, provider message text, raw bodies, or error
 *   text, and a logging failure never fails the turn.
 *
 * Behavior on unusable results is deliberately strict for this slice: a
 * decision that does not name an offered pattern, or a chat response that
 * fails the contract, propagates as a thrown error so the engine records a
 * failed turn. Optional article decisions can be omitted. The owner may
 * request a new attempt for the latest failed turn.
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
  TraceTemporalContext,
  TurnWork,
} from "../conversation/types.ts";
import {
  buildPatternChoiceRequest,
  DECISION_QUESTION_ID,
  selectResponsePattern,
} from "./decision.ts";
import {
  runWithDecisionModelPool,
  type DecisionModelPool,
} from "./decision-pool.ts";
import { buildChatPrompt } from "./chat.ts";
import { stripImageActionMarkers } from "../image/types.ts";
import { buildDynamicInitiativePrompt } from "./initiative.ts";
import { buildRecallQuery } from "../memory/recall.ts";
import type { MemoryChatContext } from "../memory/types.ts";
import { buildTemporalContext, type TemporalSettings } from "../temporal/context.ts";
import {
  ARTICLE_SHARE_QUESTION_ID,
  buildArticleShareContextForPrompt,
  buildArticleShareQuestion,
  selectArticleShare,
} from "../articles/share.ts";
import type { ArticleMemoryCandidate } from "../articles/types.ts";
import type {
  SelectedInitiativeQuestion,
} from "../relationship/types.ts";
import { mainReplyProviderMaxTokensForBaseTierOrdinal } from "../relationship/runtime.ts";
import { OpenRouterTransportError } from "@companion/openrouter/transport";
import type {
  ChatReasoningEffort,
  ChatRequest,
  ChatResponse,
} from "@companion/openrouter/chat";
import { DateTime } from "luxon";
import type {
  DecisionsRequest,
  DecisionsResponse,
} from "@companion/openrouter";
import { parseChatResponse } from "@companion/openrouter/chat";
import {
  buildChatDiagnostics,
  formatChatDiagnostics,
  type ChatDiagnosticOutcome,
} from "./chat-diagnostics.ts";
import { runPromptModules } from "../prompt-modules/runtime.ts";
import type {
  PromptModuleContext,
  PromptModuleDefinition,
  PromptModuleDecisionTrace,
  PromptModuleExecutionTrace,
  PromptModulePromptOutput,
  PromptModuleRunResult,
  PromptModuleTraceBoundary,
} from "../prompt-modules/types.ts";
import { PromptModuleTraceWriteError } from "../prompt-modules/types.ts";
import type { EngagementState } from "../engagement/types.ts";
import { TraceWriteFencedError } from "../conversation/store.ts";
import {
  parseDecisionsExchange,
  parseDecisionsRequest,
} from "@companion/openrouter";

interface PromptModuleServices {
  readonly leaseOwner: string;
  /** Enabled prompt modules are loaded afresh for each attempt. */
  readonly loadPromptModules: () => Promise<readonly PromptModuleDefinition[]>;
  /** Explicit service credentials only; the full worker environment is not passed to module code. */
  readonly promptModuleCredentials?: Readonly<Record<string, string>>;
  readonly executePromptModule: (input: {
    readonly module: PromptModuleDefinition;
    readonly context: PromptModuleContext;
  }) => Promise<PromptModuleRunResult>;
  readonly recordPromptModuleDefinitions: (input: {
    readonly turnId: string;
    readonly leaseOwner: string;
    readonly decisionModel: string;
    readonly modules: readonly PromptModuleDefinition[];
  }) => Promise<void>;
  readonly recordPromptModuleDecision: (input: {
    readonly turnId: string;
    readonly leaseOwner: string;
    readonly result: PromptModuleDecisionTrace;
  }) => Promise<void>;
  readonly recordPromptModuleExecution: (input: {
    readonly turnId: string;
    readonly leaseOwner: string;
    readonly result: PromptModuleExecutionTrace;
  }) => Promise<void>;
}

export interface TurnProcessorDeps {
  readonly decisionModel: string;
  /**
   * Optional multi-model pool supplying round-robin selection and automatic
   * failover/backoff retry for Decisions API calls. When absent, decisions
   * run once against `decisionModel`.
   */
  readonly decisionModelPool?: DecisionModelPool;
  readonly chatModel: string;
  /**
   * Optional reasoning effort for main chat, from
   * `WORKER_CHAT_REASONING_EFFORT`. When set, chat sends
   * `reasoning: { effort, exclude: true }`; when unset (legacy behavior)
   * no reasoning options are sent.
   */
  readonly chatReasoningEffort?: ChatReasoningEffort;
  /** Injectable wall-clock source for deterministic attempt-context tests. */
  readonly now?: () => Date;
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
  /** Prior-turn context for ordinary chat, oldest first and bounded by configuration. */
  readonly loadContext: (turnId: string) => Promise<readonly ConversationMessage[]>;
  /** Most recent published assistant-turn reply before this turn's durable thread order. */
  readonly loadPreviousPublishedAssistantReply: (turnId: string) => Promise<string | null>;
  /** Startup-captured private settings; absent means explicitly unconfigured. */
  readonly temporalSettings?: TemporalSettings;
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
    readonly turnAttempt: number;
    readonly userText: string;
    readonly history?: readonly ConversationMessage[];
    readonly referenceTime: Date;
  }) => Promise<MemoryChatContext | null>;
  /**
   * Loads a small curated subset of relationship questions (3–4 max) ONLY when
   * a response pattern with `includeInitiativeContext` is selected. Omitted on
   * normal chat turns; failures degrade to no questions.
   */
  readonly loadInitiativeQuestions?: (input: {
    readonly turnId: string;
    readonly recentText: string;
    readonly referenceTime: Date;
  }) => Promise<readonly SelectedInitiativeQuestion[]>;
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
  /**
   * Optional database-configured relationship context; failures degrade
   * to no context. Returns the rendered chunk plus the configured base
   * familiarity tier ordinal (0-based) so the main reply output budget
   * can be derived from familiarity specifically. A plain string/null
   * return is also accepted (legacy injected callers): it carries no
   * ordinal, so no tier-derived budget applies. When this loader is
   * absent in production wiring, the composition edge supplies the
   * disabled-relationship budget (first tier) through the same loader.
   */
  readonly loadRelationshipContext?: (
    turnId: string,
    referenceTime: Date,
  ) => Promise<
    | string
    | null
    | {
        readonly context: string | null;
        readonly baseTierOrdinal: number;
      }
  >;
  /** Optional configured scheduled/applied routine state; failures degrade to no context. */
  readonly loadRoutineContext?: (turnId: string, referenceTime: Date) => Promise<string | null>;
  /** Optional current engagement band from the worker's engagement domain. */
  readonly loadEngagementState?: (referenceTime: Date) => Promise<EngagementState | null>;
  readonly loadPublishedRoutineMessageKey?: (turnId: string) => Promise<string | null>;
  /** Optional callback to persist/clear an availability hold returned by an HTTP prompt module. */
  readonly applyAvailabilityHold?: (input: {
    readonly moduleKey: string;
    readonly unavailableUntil: Date | null;
    readonly availabilityRevision?: number;
  }) => Promise<void>;
  readonly promptModules?: PromptModuleServices;
  readonly log?: (message: string) => void;

}

/** The terminal result of one attempt, published by the engine. */
export interface TurnOutcome {
  readonly reply: string;
  readonly selectedPatternId: string | null;

}

function sanitizeConversationMessages(
  messages: readonly ConversationMessage[],
): { role: ConversationMessage["role"]; content: string }[] {
  const sanitized: { role: ConversationMessage["role"]; content: string }[] = [];
  for (const message of messages) {
    const content =
      message.role === "assistant"
        ? stripImageActionMarkers(message.content)
        : message.content;
    if (message.role === "assistant" && content.length === 0) continue;
    sanitized.push({
      role: message.role,
      content,
    });
  }
  return sanitized;
}

/** Conversation state presented to the decision model: the visible thread so far. */
function decisionState(
  history: readonly ConversationMessage[],
  turnMessages: readonly ConversationMessage[],
): { conversation: { role: string; content: string }[] } {
  return {
    conversation: sanitizeConversationMessages([...history, ...turnMessages]),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function promptModuleLocalDateTime(instant: Date, timezone: string | null | undefined): string | null {
  if (timezone === null || timezone === undefined) return null;
  const local = DateTime.fromJSDate(instant, { zone: timezone });
  return local.isValid
    ? local.toFormat("yyyy-MM-dd'T'HH:mm:ss.SSSZZ")
    : null;
}

async function recordPromptModuleTrace<T>(
  boundary: PromptModuleTraceBoundary,
  write: () => Promise<T>,
): Promise<T> {
  try {
    return await write();
  } catch (error) {
    if (error instanceof TraceWriteFencedError) throw error;
    // Trace errors can carry SQL/provider text; retain only the fixed feature
    // boundary category and never echo raw detail into turn state or logs.
    throw new PromptModuleTraceWriteError(boundary);
  }
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

/**
 * Emit the one structured, privacy-safe chat diagnostics line for a
 * completed chat call. Emitted before every outcome trace write so it
 * stays visible even when the (best-effort) trace write for an invalid or
 * failed attempt fails. Best-effort itself: a logging failure never
 * fails or masks the turn outcome — the original error still propagates.
 */
function emitChatDiagnostics(
  deps: TurnProcessorDeps,
  work: TurnWork,
  identityRevision: number,
  chatRequest: ChatRequest,
  rawResponse: unknown,
  outcome: ChatDiagnosticOutcome,
  error?: unknown,
): void {
  try {
    const record = buildChatDiagnostics({
      turnId: work.turn.id,
      attempt: work.turn.attempt,
      identityRevision,
      request: chatRequest,
      rawResponse,
      outcome,
      ...(error !== undefined ? { error } : {}),
    });
    (deps.log ?? console.log)(formatChatDiagnostics(record));
  } catch {
    // Diagnostics are best-effort; never fail the turn for logging.
  }
}

export async function processTurnWork(
  work: TurnWork,
  deps: TurnProcessorDeps,
): Promise<TurnOutcome> {
  // One attempt-scoped instant keeps temporal prose, recall windows, and
  // behavior-day consumers on the same side of any local midnight boundary.
  const attemptReferenceTime = deps.now?.() ?? new Date();
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
  // The chosen article-memory candidate (when article_memory_share selected
  // one) and its standalone context chunk on non-initiative turns.
  let chosenArticle: ArticleMemoryCandidate | null = null;
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
  const currentUserText = work.messages
    .filter((message) => message.role === "user")
    .map((message) => message.content.trim())
    .filter(Boolean)
    .join("\n");
  if (deps.loadMemoryContext !== undefined) {
    if (currentUserText.length > 0) {
      try {
        const loaded = await deps.loadMemoryContext({
          turnId: work.turn.id,
          turnAttempt: work.turn.attempt,
          userText: currentUserText,
          history,
          referenceTime: attemptReferenceTime,
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

  decisions: if (patterns.length > 0 || articleShareAsked) {
    const state = decisionState(history, work.messages);
    const articleQuestion = articleShareAsked
      ? buildArticleShareQuestion(articleCandidates)
      : undefined;

    const decisionCall = await runWithDecisionModelPool({
      pool: deps.decisionModelPool,
      fallbackModel: deps.decisionModel,
      scope: `turn:${work.turn.id}`,
      log: deps.log,
      buildRequest: (model) => {
        const baseRequest = patterns.length > 0
          ? buildPatternChoiceRequest({
              model,
              patterns,
              state,
            })
          : {
              model,
              state,
              questions: {} as Record<string, never>,
            };
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
        return {
          baseRequest,
          validated: parseDecisionsRequest(request),
        };
      },
      // Decision request boundary: persisted before each provider call, one
      // row per asked question (the per-(attempt, question) trace). This write
      // is deliberate, not best-effort: a failure here fails the attempt
      // rather than calling the provider with an unrecorded request. On
      // failover the idempotent upsert updates `request_model` to the
      // currently attempted model.
      beforeCall: async ({ validated }) => {
        if (deps.recordDecisionRequest !== undefined) {
          for (const questionId of Object.keys(validated.questions)) {
            await deps.recordDecisionRequest({ trace: { questionId, request: validated } });
          }
        }
      },
      call: ({ validated }) => deps.callDecisions(validated),
    });

    const { baseRequest, validated } = decisionCall.request;
    if (!decisionCall.ok) {
      const error = decisionCall.error;
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
        } catch (traceError) {
          if (traceError instanceof TraceWriteFencedError) throw traceError;
        }
      }
      if (patterns.length === 0) {
        articleCandidates = [];
        await deps.recordDecisionSelection?.({
          questionId: ARTICLE_SHARE_QUESTION_ID,
          selection: { kind: "rejected", reason: "article decision unavailable" },
        });
        break decisions;
      }
      throw error;
    }
    const rawResponse: unknown = decisionCall.response;

    let response: DecisionsResponse;
    let invalidArticle = false;
    try {
      response = parseDecisionsExchange(validated, rawResponse);
    } catch (error) {
      // Independently validate the required pattern if the optional article
      // answer is unusable. Preserve the shared exchange contract and actual
      // usage, model and returned pattern in the trace.
      let required: DecisionsResponse | undefined;
      if (articleShareAsked && patterns.length && typeof rawResponse === "object" && rawResponse !== null &&
          "answers" in rawResponse && typeof rawResponse.answers === "object" && rawResponse.answers !== null) {
        const { [ARTICLE_SHARE_QUESTION_ID]: _article, ...answers } =
          rawResponse.answers as Record<string, unknown>;
        try {
          required = parseDecisionsExchange(baseRequest, { ...rawResponse, answers });
        } catch { /* The required exchange is also invalid. */ }
      }
      for (const questionId of Object.keys(validated.questions)) {
        if (required && questionId !== ARTICLE_SHARE_QUESTION_ID) continue;
        await deps.recordDecisionOutcome?.({
          trace: { questionId, request: validated },
          outcome: { kind: "invalid", message: errorMessage(error) },
        });
      }
      if (articleShareAsked) {
        invalidArticle = true;
        articleCandidates = [];
        await deps.recordDecisionSelection?.({
          questionId: ARTICLE_SHARE_QUESTION_ID,
          selection: { kind: "rejected", reason: errorMessage(error) },
        });
      }
      if (!required) {
        if (patterns.length) throw error;
        break decisions;
      }
      response = required;
    }

    // Decision outcome boundary: the full validated exchange, persisted
    // BEFORE the selection step — so a rejected selection or a later chat
    // failure still leaves the complete native response behind. This write
    // is deliberate, not best-effort: a failure here fails the attempt rather
    // than selecting from an unrecorded response.
    if (deps.recordDecisionOutcome !== undefined) {
      for (const questionId of Object.keys(response.answers)) {
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
    // includes nothing. An unusable article answer is traced and omitted.
    if (articleShareAsked && !invalidArticle) {
      let articleSelection;
      try {
        articleSelection = selectArticleShare(response, articleCandidates);
      } catch (error) {
        await deps.recordDecisionSelection?.({
          questionId: ARTICLE_SHARE_QUESTION_ID,
          selection: { kind: "rejected", reason: errorMessage(error) },
        });
        articleCandidates = [];
        break decisions;
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
        chosenArticle = articleSelection.candidate;
        articleChunk = buildArticleShareContextForPrompt(
          chosenArticle,
          attemptReferenceTime,
        );
        // The inclusion record is a prompt-inclusion event (never a share
        // claim); a failed write is logged and never fails the turn.
        if (deps.recordArticleShareInclusion !== undefined) {
          try {
            await deps.recordArticleShareInclusion({
              turnId: work.turn.id,
              reactionId: chosenArticle.reactionId,
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

  // Dynamic initiative prompt assembly: runs ONLY when the selected pattern
  // explicitly enables `includeInitiativeContext`. On normal chat turns,
  // curated questions are omitted completely and the pattern's guidance (if
  // non-empty) passes through verbatim.
  let guidanceChunk: string | null =
    selected !== undefined ? selected.responseGuidance : null;
  if (selected?.includeInitiativeContext === true) {
    let initiativeArticle = chosenArticle;
    if (initiativeArticle === null && articleCandidates.length > 0) {
      initiativeArticle = articleCandidates[0]!;
      if (deps.recordArticleShareInclusion !== undefined) {
        try {
          await deps.recordArticleShareInclusion({
            turnId: work.turn.id,
            reactionId: initiativeArticle.reactionId,
          });
        } catch (error) {
          console.warn(
            `[ARTICLE] share inclusion record failed for turn ${work.turn.id}: ${errorMessage(error)}; continuing`,
          );
        }
      }
    }
    let initiativeQuestions: readonly SelectedInitiativeQuestion[] = [];
    if (deps.loadInitiativeQuestions !== undefined) {
      try {
        const recentText = buildRecallQuery({
          currentUserText,
          history,
        });
        initiativeQuestions = await deps.loadInitiativeQuestions({
          turnId: work.turn.id,
          recentText,
          referenceTime: attemptReferenceTime,
        });
      } catch {
        console.warn(
          `[RELATIONSHIP] initiative questions load failed for turn ${work.turn.id}; continuing without curated questions`,
        );
      }
    }
    // Fold the chosen/fallback article into the dynamic initiative block so it
    // is never duplicated as a separate background chunk.
    if (initiativeArticle !== null) {
      articleChunk = null;
    }
    guidanceChunk = buildDynamicInitiativePrompt({
      guidance: selected.responseGuidance,
      article: initiativeArticle,
      questions: initiativeQuestions,
      now: attemptReferenceTime,
    });
  }

  // Relationship context is independently optional and degrading, like the
  // other domain-owned context loaders. It contains only runtime-configured
  // labels, thresholds, prompts, and answer-bank content. The loaded base
  // tier ordinal (when the loader supplies one) drives the main reply
  // output budget below; a legacy string/null return carries no ordinal.
  let relationshipChunk: string | null = null;
  let relationshipBaseTierOrdinal: number | undefined;
  if (deps.loadRelationshipContext !== undefined) {
    try {
      const loaded = await deps.loadRelationshipContext(work.turn.id, attemptReferenceTime);
      if (typeof loaded === "string" || loaded === null) {
        relationshipChunk = loaded;
      } else {
        relationshipChunk = loaded.context;
        relationshipBaseTierOrdinal = loaded.baseTierOrdinal;
      }
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
      routineChunk = await deps.loadRoutineContext(work.turn.id, attemptReferenceTime);
    } catch {
      console.warn(
        `[ROUTINE] context load failed for turn ${work.turn.id}; continuing without routine context`,
      );
    }
  }

  let promptModuleChunks: readonly PromptModulePromptOutput[] = [];
  const moduleServices = deps.promptModules;
  if (moduleServices !== undefined) {
    try {
      const modules = await moduleServices.loadPromptModules();
      if (modules.length > 0) {
        const rawPreviousAssistantResponse =
          await deps.loadPreviousPublishedAssistantReply(work.turn.id) ?? "";
        const previousAssistantResponse = stripImageActionMarkers(rawPreviousAssistantResponse);
        let engagementState: EngagementState | null = null;
        if (deps.loadEngagementState !== undefined) {
          try {
            engagementState = await deps.loadEngagementState(attemptReferenceTime);
          } catch {
            engagementState = null;
          }
        }
        const publishedRoutineMessageKey = modules.some(
          ({ httpConfig }) => httpConfig?.publishedRoutineMessageKeyField != null,
        )
          ? await deps.loadPublishedRoutineMessageKey?.(work.turn.id).catch(() => null) ?? null
          : null;
        promptModuleChunks = await runPromptModules({
          turnId: work.turn.id,
          leaseOwner: moduleServices.leaseOwner,
          decisionModel: deps.decisionModel,
          ...(deps.decisionModelPool !== undefined
            ? { decisionModelPool: deps.decisionModelPool }
            : {}),
          state: decisionState(history, work.messages),
          modules,
          context: {
            credentials: moduleServices.promptModuleCredentials ?? {},
            conversation: sanitizeConversationMessages([...history, ...work.messages]),
            priorConversation: sanitizeConversationMessages(history.slice(-40)),
            userMessages: work.messages
              .filter((message) => message.role === "user")
              .map((message) => message.content),
            previousAssistantResponse,
            localDateTime: promptModuleLocalDateTime(
              new Date(work.turn.createdAt),
              deps.temporalSettings?.timezone,
            ),
            engagementState,
            publishedRoutineMessageKey,
            patternId: selected?.id ?? null,
          },
          callDecisions: deps.callDecisions,
          execute: moduleServices.executePromptModule,
          recordDefinitions: (input) => recordPromptModuleTrace("definitions", () =>
            moduleServices.recordPromptModuleDefinitions(input),
          ),
          recordDecision: (input) => recordPromptModuleTrace("decision", () =>
            moduleServices.recordPromptModuleDecision(input),
          ),
          recordExecution: (input) => recordPromptModuleTrace("execution", () =>
            moduleServices.recordPromptModuleExecution(input),
          ),
          ...(deps.log !== undefined ? { log: deps.log } : {}),
        });
        if (deps.applyAvailabilityHold !== undefined) {
          for (const output of promptModuleChunks) {
            if (output.unavailableUntil !== undefined) {
              try {
                await deps.applyAvailabilityHold({
                  moduleKey: output.moduleKey ?? output.moduleId,
                  unavailableUntil: output.unavailableUntil,
                  ...(output.availabilityRevision !== undefined
                    ? { availabilityRevision: output.availabilityRevision }
                    : {}),
                });
              } catch {
                (deps.log ?? console.warn)(
                  "[PROMPT_MODULE] availability_hold_write_failed; continuing chat",
                );
              }
            }
          }
        }
      }
    } catch (error) {
      if (error instanceof TraceWriteFencedError) throw error;
      // Prompt modules are optional and additive. A non-fencing feature trace
      // failure drops their outputs, but does not displace the mandatory chat
      // request/outcome trace. Raw SQL and function errors may contain secrets.
      const operationalCategory = error instanceof PromptModuleTraceWriteError
        ? `trace_write_failed boundary=${error.boundary}`
        : "processing_failed boundary=module_runtime";
      (deps.log ?? console.warn)(
        `[PROMPT_MODULE] ${operationalCategory}; continuing without module thoughts`,
      );
      promptModuleChunks = [];
    }
  }

  const temporal = deps.temporalSettings === undefined
    ? undefined
    : buildTemporalContext(attemptReferenceTime, deps.temporalSettings);
  const temporalTrace: TraceTemporalContext | undefined = temporal === undefined
    ? undefined
    : {
        asOf: temporal.asOf.toISOString(),
        timezone: temporal.timezone,
        localDate: temporal.localDate,
        localTime: temporal.localTime,
        season: temporal.season,
        occasionKeys: temporal.occasionKeys,
        occasionContext: temporal.occasionContext,
      };
  const timeChunk = temporal?.promptText ?? null;

  // Main reply output budget: when the relationship loader supplied a
  // base tier ordinal, the visible-reply budget is 500 + 100 per
  // successive base tier (first tier / disabled relationship = 500),
  // plus effort-scaled reasoning headroom when a non-`none` chat
  // reasoning effort is configured (OpenRouter counts hidden reasoning
  // tokens against `max_tokens`). The ordinal tracks familiarity (base
  // tier), never the transient effective tier. An explicit static
  // `deps.maxTokens` override still applies verbatim when no ordinal was
  // supplied; when neither is present no `max_tokens` is sent (legacy
  // injected callers). The resolved value flows into the assembled
  // request below, so the chat trace records the exact `max_tokens` sent.
  const resolvedMaxTokens =
    relationshipBaseTierOrdinal !== undefined
      ? mainReplyProviderMaxTokensForBaseTierOrdinal(
          relationshipBaseTierOrdinal,
          deps.chatReasoningEffort,
        )
      : deps.maxTokens;

  // The assembled prompt is the single source of truth for the wire request
  // and its trace metadata: chunk classification and source linkage are
  // index-aligned by construction. When a chat reasoning effort is
  // configured, main chat sends it with reasoning content excluded
  // (`exclude: true`), so the visible reply carries no reasoning text;
  // without configuration, no reasoning options are sent. Reasoning
  // tokens count against `max_tokens` on OpenRouter, so a high reasoning
  // effort can consume part of the reply budget above.
  const assemblePrompt = (modules: readonly PromptModulePromptOutput[]) =>
    buildChatPrompt({
      model: deps.chatModel,
      ...(deps.chatReasoningEffort !== undefined
        ? {
            reasoning: {
              effort: deps.chatReasoningEffort,
              exclude: true,
            } as const,
          }
        : {}),
      history,
      turnMessages: work.messages,
      identity: identity.content,
      guidance: guidanceChunk,
      ...(profilesChunk !== null ? { profiles: profilesChunk } : {}),
      ...(temporalChunk !== null ? { temporal: temporalChunk } : {}),
      ...(timeChunk !== null ? { time: timeChunk } : {}),
      ...(recallChunk !== null ? { recall: recallChunk } : {}),
      ...(articleChunk !== null ? { article: articleChunk } : {}),
      ...(relationshipChunk !== null ? { relationship: relationshipChunk } : {}),
      ...(routineChunk !== null ? { routine: routineChunk } : {}),
      ...(modules.length > 0 ? { promptModules: modules } : {}),
      ...(deps.temperature !== undefined ? { temperature: deps.temperature } : {}),
      ...(resolvedMaxTokens !== undefined ? { maxTokens: resolvedMaxTokens } : {}),
    });
  let { request: chatRequest, messages: assembledMessages } = assemblePrompt(promptModuleChunks);
  // Chat request boundary: persisted before the provider call. If the optional
  // module-to-message association alone cannot be recorded, discard all module
  // outputs and retry the mandatory baseline chat trace without them.
  if (deps.recordChatRequest !== undefined) {
    const recordRequest = () => deps.recordChatRequest!({
      request: { ...chatRequest, messages: assembledMessages },
      identityRevision: identity.revision,
      temporalContext: temporalTrace,
    });
    try {
      await recordRequest();
    } catch (error) {
      if (
        !(error instanceof PromptModuleTraceWriteError) ||
        error.boundary !== "chat_attribution" ||
        promptModuleChunks.length === 0
      ) throw error;
      (deps.log ?? console.warn)(
        "[PROMPT_MODULE] trace_write_failed boundary=chat_attribution; continuing without module thoughts",
      );
      promptModuleChunks = [];
      ({ request: chatRequest, messages: assembledMessages } = assemblePrompt([]));
      await recordRequest();
    }
  }

  let rawChatResponse: unknown;
  try {
    rawChatResponse = await deps.callChat(chatRequest);
  } catch (error) {
    // Transport failure: the structured diagnostics line goes out first
    // (request as sent + fixed error kind, no response data), then the
    // actual error is recorded best-effort — a trace write failure must
    // never mask the original error — and rethrown so the engine records
    // a failed turn.
    emitChatDiagnostics(
      deps,
      work,
      identity.revision,
      chatRequest,
      undefined,
      "failed",
      error,
    );
    if (deps.recordChatOutcome !== undefined) {
      try {
        await deps.recordChatOutcome({
          request: { ...chatRequest, messages: assembledMessages },
          identityRevision: identity.revision,
          outcome: chatFailureTrace(error),
        });
      } catch (traceError) {
        // Preserve the original transport error for ordinary trace failures,
        // but a lease fence always stops this stale attempt.
        if (traceError instanceof TraceWriteFencedError) throw traceError;
      }
    }
    throw error;
  }

  let chatResponse: ChatResponse;
  try {
    chatResponse = parseChatResponse(rawChatResponse);
  } catch (error) {
    // Contract failure: a body arrived but did not validate. The
    // structured diagnostics line (requested model/budget/reasoning, the
    // invalid field's structural path, content shape, and any
    // individually-valid finish reason/usage) goes out before the
    // best-effort trace write, so it stays visible even when that write
    // fails. The turn still fails; nothing is published.
    emitChatDiagnostics(
      deps,
      work,
      identity.revision,
      chatRequest,
      rawChatResponse,
      "invalid",
      error,
    );
    if (deps.recordChatOutcome !== undefined) {
      try {
        await deps.recordChatOutcome({
          request: { ...chatRequest, messages: assembledMessages },
          identityRevision: identity.revision,
          outcome: chatInvalidTrace(error),
        });
      } catch (traceError) {
        // Preserve the original contract error for ordinary trace failures,
        // but a lease fence always stops this stale attempt.
        if (traceError instanceof TraceWriteFencedError) throw traceError;
      }
    }
    throw error;
  }
  const choice = chatResponse.choices[0]!; // The provider contract enforces at least one choice.
  const reply = stripImageActionMarkers(choice.message.content);
  const applicationRejection =
    reply.trim().length === 0 ? "chat response contains a blank reply" : null;

  // Structured diagnostics for the responded call, emitted before the
  // deliberate outcome trace write below so they stay visible even when
  // that write fails and the attempt fails with it.
  emitChatDiagnostics(
    deps,
    work,
    identity.revision,
    chatRequest,
    rawChatResponse,
    "responded",
  );

  // Chat outcome boundary: persisted before the application usability check,
  // in its own fenced transaction. The returned response is recorded as-is
  // (even when unusable, with the application rejection reason captured
  // separately), so the trace is unambiguous: the response arrived, and the
  // application rejected it or not. This write is deliberate, not
  // best-effort: a failure here fails the attempt rather than publishing an
  // unrecorded boundary.
  if (deps.recordChatOutcome !== undefined) {
    await deps.recordChatOutcome({
      request: { ...chatRequest, messages: assembledMessages },
      identityRevision: identity.revision,
      outcome: {
        kind: "responded",
        response: chatResponse,
        replyContent: reply,
        applicationRejection,
      },
    });
  }

  if (applicationRejection !== null) throw new Error(applicationRejection);

  return {
    reply,
    selectedPatternId: selected !== undefined ? selected.id : null,
  };
}
