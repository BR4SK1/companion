/**
 * Memory-domain LLM adapter.
 *
 * Memory tasks are plain OpenRouter chat-completions calls with a JSON
 * response format. The adapter is transport-injected (the shared
 * `@companion/openrouter` transport), keeps application policy (model,
 * endpoint, credentials) at the composition edge, and returns metadata only:
 * no caller ever persists prompt or response text for memory operations.
 *
 * Two retry behaviors are applied in a fixed order, each once per request
 * body:
 * 1. a 400 response that names structured-output support falls back to a
 *    plain request (`structuredOutputFallback`), because some models reject
 *    `response_format`;
 * 2. a 400 response that names both reasoning and max_tokens falls back to
 *    `reasoning: { effort: "low" }` (`reasoningClampFallback`), because some
 *    models clamp requested reasoning budgets.
 *
 * Task presets carry the reasoning-effort and thinking knobs:
 * GLM 5.3 Flash reasoning tokens count against max_tokens on OpenRouter, so
 * every cap covers reasoning plus visible output or the model returns empty
 * content (finishReason "length").
 */

import { postJson, OpenRouterTransportError } from "@companion/openrouter/transport";

export type ReasoningEffort =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export interface TaskPreset {
  readonly maxTokens: number;
  /** Send `max_tokens` exactly as configured (all memory tasks do). When
   *  false, model families with hard smaller caps get 8192 instead. */
  readonly honorMaxTokens?: boolean;
  readonly temperature?: number;
  readonly reasoningEffort?: ReasoningEffort;
  readonly thinking?: {
    readonly enabled: boolean;
    readonly budgetTokens: number;
    readonly reasoningMaxTokens?: number;
  };
}

export interface MemoryLlmCallInput {
  readonly systemPrompt: string;
  readonly userMessage: string;
  readonly taskPreset: TaskPreset;
  readonly responseFormat?: Record<string, unknown>;
}

export interface MemoryLlmCallResult {
  readonly text: string;
  readonly model: string;
  readonly finishReason: string | null;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Provider-reported reasoning tokens when it distinguishes them. */
  readonly nativeReasoningTokens: number | null;
  readonly attemptCount: number;
  readonly structuredOutputFallback: boolean;
  /** True when the reasoning-clamp fallback rewrote the request. */
  readonly reasoningClampFallback: boolean;
}

interface ChatCompletionResponse {
  readonly model?: unknown;
  readonly choices?: ReadonlyArray<{
    readonly message?: { readonly content?: unknown };
    readonly finish_reason?: unknown;
  }>;
  readonly usage?: {
    readonly prompt_tokens?: unknown;
    readonly completion_tokens?: unknown;
    readonly native_tokens_reasoning?: unknown;
    readonly completion_tokens_details?: { readonly reasoning_tokens?: unknown };
  };
}

function isStructuredOutputError(bodyText: string): boolean {
  const lower = bodyText.toLowerCase();
  return (
    lower.includes("response_format") ||
    lower.includes("json_schema") ||
    lower.includes("structured output")
  );
}

function isReasoningClampError(bodyText: string): boolean {
  const lower = bodyText.toLowerCase();
  return lower.includes("reasoning") && lower.includes("max_tokens");
}

/** Models with a hard completion cap below the configured presets. */
function getModelMaxTokens(model: string, defaultMaxTokens: number): number {
  const id = model.toLowerCase();
  if (id.startsWith("deepseek/") || id.startsWith("moonshotai/") || id.startsWith("qwen/")) {
    return 8192;
  }
  return defaultMaxTokens;
}

/** Extended thinking is a Claude-family request shape. */
export function modelSupportsThinking(model: string): boolean {
  return model.toLowerCase().includes("claude");
}

/**
 * The request body for one memory LLM call, mirroring the source adapter:
 * `include_reasoning` follows the thinking flag, the reasoning-effort knob
 * is sent as `reasoning.effort`, and an enabled thinking flag becomes
 * `extended_thinking` on models that support it or a `reasoning.max_tokens`
 * clamp when a reasoningMaxTokens value is configured.
 */
export function buildMemoryLlmRequestBody(input: {
  readonly model: string;
  readonly taskPreset: TaskPreset;
  readonly responseFormat?: Record<string, unknown>;
}): Record<string, unknown> {
  const preset = input.taskPreset;
  const body: Record<string, unknown> = {
    model: input.model,
    messages: [],
    max_tokens:
      preset.honorMaxTokens === true
        ? preset.maxTokens
        : getModelMaxTokens(input.model, preset.maxTokens),
    ...(preset.temperature !== undefined ? { temperature: preset.temperature } : {}),
    include_reasoning: preset.thinking?.enabled ?? false,
    ...(input.responseFormat !== undefined ? { response_format: input.responseFormat } : {}),
  };
  if (preset.reasoningEffort !== undefined) {
    body["reasoning"] = { effort: preset.reasoningEffort };
  }
  if (preset.thinking?.enabled === true && modelSupportsThinking(input.model)) {
    body["extended_thinking"] = true;
  } else if (
    preset.thinking?.enabled === true &&
    preset.thinking.reasoningMaxTokens !== undefined &&
    preset.thinking.reasoningMaxTokens !== null
  ) {
    body["reasoning"] = { max_tokens: preset.thinking.reasoningMaxTokens };
  }
  return body;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asInteger(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : 0;
}

interface Attempt {
  readonly ok: boolean;
  readonly status: number | undefined;
  readonly message: string;
  /** Retained (truncated) error body when the transport kept one. */
  readonly body: string | null;
  readonly data: ChatCompletionResponse | undefined;
  /**
   * The original transport error when the failure was transport-level. It is
   * re-thrown unchanged on final failure so error classification
   * (`memoryErrorCategory`) sees the real transport kind and status instead
   * of a wrapped plain error; its message text is never recorded anywhere.
   */
  readonly transportError: OpenRouterTransportError | null;
}

export interface MemoryLlmDeps {
  /** Full chat-completions endpoint URL. */
  readonly url: string;
  readonly apiKey: string;
  readonly model: string;
  readonly timeoutMs: number;
}

/**
 * The injectable caller. Memory pipelines take this as `callLlm` so tests run
 * with fakes and no network. Errors carry messages (and an HTTP status when
 * the transport reported one); response bodies are not retained beyond the
 * transport's own truncated error body, and nothing here writes content to
 * storage — operation traces record metadata only.
 */
export function createMemoryLlmCaller(
  deps: MemoryLlmDeps,
): (input: MemoryLlmCallInput) => Promise<MemoryLlmCallResult> {
  return async (input) => {
    const messages = [
      { role: "system", content: input.systemPrompt },
      { role: "user", content: input.userMessage },
    ];
    const baseBody: Record<string, unknown> = {
      ...buildMemoryLlmRequestBody({
        model: deps.model,
        taskPreset: input.taskPreset,
        responseFormat: input.responseFormat,
      }),
      messages,
    };

    let attemptCount = 0;
    let structuredOutputFallback = false;
    let reasoningClampFallback = false;

    const attempt = async (body: Record<string, unknown>): Promise<Attempt> => {
      attemptCount += 1;
      try {
        const response = await postJson(deps.url, body, {
          apiKey: deps.apiKey,
          timeoutMs: deps.timeoutMs,
        });
        return {
          ok: true,
          status: 200,
          message: "",
          body: null,
          data: response as ChatCompletionResponse,
          transportError: null,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const status = (error as { status?: unknown }).status;
        const body_ = (error as { body?: unknown }).body;
        return {
          ok: false,
          status: typeof status === "number" ? status : undefined,
          message,
          body: typeof body_ === "string" ? body_ : null,
          data: undefined,
          transportError: error instanceof OpenRouterTransportError ? error : null,
        };
      }
    };

    let result = await attempt(baseBody);
    let activeBody = baseBody;
    if (
      !result.ok &&
      result.status === 400 &&
      activeBody.response_format !== undefined &&
      result.body !== null &&
      isStructuredOutputError(result.body)
    ) {
      const fallback = { ...activeBody };
      delete fallback.response_format;
      structuredOutputFallback = true;
      activeBody = fallback;
      result = await attempt(fallback);
    }
    if (
      !result.ok &&
      result.status === 400 &&
      activeBody.reasoning !== undefined &&
      result.body !== null &&
      isReasoningClampError(result.body)
    ) {
      const fallback = { ...activeBody, reasoning: { effort: "low" } };
      reasoningClampFallback = true;
      activeBody = fallback;
      result = await attempt(fallback);
    }
    if (!result.ok) {
      // Re-throw the original transport error when there was one: the
      // classifier maps its kind/status to a fixed category (e.g.
      // llm_http_status_404) and its text is never recorded.
      throw result.transportError ??
        new Error(`memory llm call failed: ${result.message}`);
    }
    if (!result.data) {
      throw new Error("memory llm call returned a non-JSON success response");
    }
    const choice = result.data.choices?.[0];
    const nativeReasoning =
      result.data.usage?.native_tokens_reasoning ??
      result.data.usage?.completion_tokens_details?.reasoning_tokens;
    return {
      text: asString(choice?.message?.content),
      model: asString(result.data.model) || deps.model,
      finishReason: typeof choice?.finish_reason === "string" ? choice.finish_reason : null,
      inputTokens: asInteger(result.data.usage?.prompt_tokens),
      outputTokens: asInteger(result.data.usage?.completion_tokens),
      nativeReasoningTokens:
        typeof nativeReasoning === "number" && Number.isFinite(nativeReasoning)
          ? Math.trunc(nativeReasoning)
          : null,
      attemptCount,
      structuredOutputFallback,
      reasoningClampFallback,
    };
  };
}

export type MemoryLlmCaller = ReturnType<typeof createMemoryLlmCaller>;

export const __internal = {
  isStructuredOutputError,
  isReasoningClampError,
  getModelMaxTokens,
};

export interface MemoryTaskPresets {
  readonly temporalSummaryLeaf: TaskPreset;
  readonly temporalSummaryAggregate: TaskPreset;
  readonly profileSummary: TaskPreset;
  readonly memoryFactExtraction: TaskPreset;
  readonly memoryObservationConsolidation: TaskPreset;
  readonly memoryProfileV2: TaskPreset;
}

/**
 * Task presets with the pipeline's fixed operating points. The two
 * output-token caps are configuration (see `MemoryConfig`); the rest are
 * fixed values (see the module comment: reasoning tokens count against
 * max_tokens on GLM 5.3 Flash, so every cap covers reasoning plus visible
 * output).
 */
export function taskPresets(config: {
  readonly observationMaxOutputTokens: number;
  readonly profileMaxOutputTokens: number;
}): MemoryTaskPresets {
  return {
    temporalSummaryLeaf: {
      maxTokens: 4000,
      honorMaxTokens: true,
      temperature: 0.3,
      reasoningEffort: "high",
      thinking: { enabled: false, budgetTokens: 0 },
    },
    temporalSummaryAggregate: {
      maxTokens: 12000,
      honorMaxTokens: true,
      temperature: 0.5,
      reasoningEffort: "high",
      thinking: { enabled: true, budgetTokens: 0 },
    },
    profileSummary: {
      maxTokens: 4000,
      honorMaxTokens: true,
      temperature: 0.3,
      reasoningEffort: "high",
      thinking: { enabled: false, budgetTokens: 0 },
    },
    memoryFactExtraction: {
      maxTokens: 8000,
      honorMaxTokens: true,
      temperature: 0.1,
      reasoningEffort: "high",
      thinking: { enabled: false, budgetTokens: 0 },
    },
    memoryObservationConsolidation: {
      maxTokens: config.observationMaxOutputTokens,
      honorMaxTokens: true,
      temperature: 0.1,
      reasoningEffort: "max",
      thinking: { enabled: false, budgetTokens: 0 },
    },
    memoryProfileV2: {
      maxTokens: config.profileMaxOutputTokens,
      honorMaxTokens: true,
      temperature: 0.4,
      reasoningEffort: "high",
      thinking: { enabled: false, budgetTokens: 0 },
    },
  };
}
