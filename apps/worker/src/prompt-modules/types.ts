/** Database-owned prompt-module definitions and their attempt-scoped trace values. */

export interface PromptModuleDefinition {
  readonly id: string;
  readonly key: string;
  readonly decisionDescription: string;
  /** A trusted TypeScript function expression, null for declarative HTTP modules. */
  readonly functionDefinition: string | null;
  readonly executionMode: PromptModuleExecutionMode;
  /** Fixed-field HTTP configuration; null for trusted function modules. */
  readonly httpConfig: PromptModuleHttpPostConfig | null;
  readonly definitionHash: string;
  readonly fallbackContent: string | null;
  readonly timeoutMs: number;
  readonly position: number;
  readonly activationMode: PromptModuleActivationMode;
  readonly outputKind: PromptModuleOutputKind;
}

export type PromptModuleActivationMode = "model_gated" | "every_turn";
export type PromptModuleOutputKind = "thoughts" | "authoritative_context";
export type PromptModuleExecutionMode = "function" | "http_post";

/** Narrow declarative HTTP mapping; field names are top-level JSON keys only. */
export interface PromptModuleHttpPostConfig {
  readonly endpointSetting: string;
  readonly scopeSetting: string | null;
  readonly scopeField: string | null;
  readonly turnIdField: string | null;
  readonly localDateTimeField: string | null;
  readonly previousAssistantResponseField: string | null;
  readonly userMessageField: string | null;
  readonly priorConversationField: string | null;
  readonly responseTextField: string;
  readonly fieldMaxBytes: number;
  readonly priorMessageLimit: number;
  readonly requestMaxBytes: number;
  readonly responseMaxBytes: number;
}

export interface PromptModuleConversationMessage {
  readonly role: "user" | "assistant";
  readonly content: string;
}

export interface PromptModulePromptOutput {
  readonly moduleId: string;
  readonly content: string;
  readonly outputKind: PromptModuleOutputKind;
}

export interface PromptModuleContext {
  readonly turnId: string;
  /** Full legacy conversation view, oldest first. */
  readonly conversation: readonly PromptModuleConversationMessage[];
  /** Prior context only, oldest first, bounded independently from current input. */
  readonly priorConversation: readonly PromptModuleConversationMessage[];
  /** The grouped user messages belonging to the current turn. */
  readonly userMessages: readonly string[];
  /** Most recent published assistant turn response, or empty when none exists. */
  readonly previousAssistantResponse: string;
  /** Authoritative worker-local ISO date-time with numeric offset; null if unconfigured. */
  readonly localDateTime: string | null;
  /** Only explicitly configured prompt-module credentials are passed here. */
  readonly credentials: Readonly<Record<string, string>>;
}

export type PromptModuleRunResult =
  | { readonly kind: "succeeded"; readonly content: string; readonly durationMs: number }
  | { readonly kind: "failed" | "timed_out" | "invalid_result"; readonly durationMs: number };

export type PromptModuleTraceBoundary = "definitions" | "decision" | "execution" | "chat_attribution";

export class PromptModuleTraceWriteError extends Error {
  readonly boundary: PromptModuleTraceBoundary;

  constructor(boundary: PromptModuleTraceBoundary) {
    super("prompt-module trace write failed");
    this.name = "PromptModuleTraceWriteError";
    this.boundary = boundary;
  }
}

export type PromptModuleDecisionState = "responded" | "failed" | "invalid" | "not_required";

export interface PromptModuleDecisionTrace {
  readonly state: PromptModuleDecisionState;
  readonly decisionModel: string | null;
  readonly responseModel: string | null;
  readonly responseProvider: string | null;
  readonly durationMs: number | null;
  readonly failureKind: "decision_transport" | "decision_invalid" | "decision_unusable" | null;
  readonly selections: readonly {
    readonly moduleId: string;
    readonly choice: string | null;
    readonly selected: boolean | null;
    readonly confidence: number | null;
    readonly probabilities: Readonly<Record<string, number>> | null;
  }[];
}

export interface PromptModuleExecutionTrace {
  readonly moduleId: string;
  /** Zero-based order among selected modules actually executed this attempt. */
  readonly executionOrdinal: number;
  readonly state: "succeeded" | "failed" | "timed_out" | "invalid_result";
  readonly durationMs: number;
  /** A validated function result or selected fallback is ready for chat assembly. */
  readonly outputReady: boolean;
  readonly fallbackSelected: boolean;
}

export interface PromptModuleTraceRecord {
  readonly moduleId: string;
  readonly moduleKey: string;
  readonly position: number;
  readonly decisionDescription: string;
  readonly definitionHash: string;
  readonly activationMode: PromptModuleActivationMode;
  readonly outputKind: PromptModuleOutputKind;
  readonly executionMode: PromptModuleExecutionMode;
  readonly fallbackAvailable: boolean;
  readonly decisionState: "not_requested" | "requested" | PromptModuleDecisionState;
  readonly decisionModel: string | null;
  readonly responseModel: string | null;
  readonly responseProvider: string | null;
  readonly decisionChoice: string | null;
  readonly selected: boolean | null;
  readonly confidence: number | null;
  readonly probabilities: readonly { readonly optionId: string; readonly value: number }[];
  readonly decisionMs: number | null;
  readonly executionState: "not_selected" | "pending" | "succeeded" | "failed" | "timed_out" | "invalid_result";
  readonly executionOrdinal: number | null;
  readonly executionMs: number | null;
  readonly failureKind: string | null;
  readonly outputReady: boolean;
  readonly fallbackSelected: boolean;
  readonly fallbackUsed: boolean;
  readonly included: boolean;
  /** Position in the exact traced chat request; null means not included. */
  readonly chatMessagePosition: number | null;
}
