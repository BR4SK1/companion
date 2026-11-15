/** Database-owned prompt-module definitions and their attempt-scoped trace values. */

export interface PromptModuleDefinition {
  readonly id: string;
  readonly key: string;
  readonly decisionDescription: string;
  /** A TypeScript function expression, e.g. `(ctx: PromptModuleContext) => string`. */
  readonly functionDefinition: string;
  readonly definitionHash: string;
  readonly fallbackContent: string | null;
  readonly timeoutMs: number;
  readonly position: number;
}

export interface PromptModuleConversationMessage {
  readonly role: "user" | "assistant";
  readonly content: string;
}

export interface PromptModulePromptOutput {
  readonly moduleId: string;
  readonly content: string;
}

export interface PromptModuleContext {
  readonly turnId: string;
  readonly conversation: readonly PromptModuleConversationMessage[];
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

export type PromptModuleDecisionState = "responded" | "failed" | "invalid";

export interface PromptModuleDecisionTrace {
  readonly state: PromptModuleDecisionState;
  readonly decisionModel: string;
  readonly responseModel: string | null;
  readonly responseProvider: string | null;
  readonly durationMs: number;
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
