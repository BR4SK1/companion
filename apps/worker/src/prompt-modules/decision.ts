import type {
  DecisionsChoiceAnswer,
  DecisionsRequest,
  DecisionsResponse,
  DecisionsState,
} from "@companion/openrouter";
import type { PromptModuleDefinition } from "./types.ts";

export const PROMPT_MODULE_INCLUDE = "include";
export const PROMPT_MODULE_SKIP = "skip";

export function promptModuleQuestionId(moduleId: string): string {
  return `prompt_module_${moduleId}`;
}

/** One batched, independent choice question per enabled module. */
export function buildPromptModuleDecisionRequest(input: {
  readonly model: string;
  readonly modules: readonly PromptModuleDefinition[];
  readonly state: DecisionsState;
}): DecisionsRequest {
  const questions: Record<string, {
    readonly type: "choice";
    readonly instructions: string;
    readonly criteria: Readonly<Record<string, string>>;
  }> = {};
  for (const module of input.modules) {
    Object.defineProperty(questions, promptModuleQuestionId(module.id), {
      value: {
        type: "choice",
        instructions:
          "Decide independently whether this optional prompt module applies to the current conversation. " +
          "Choose include only when its applicability criterion fits; otherwise choose skip.",
        criteria: {
          [PROMPT_MODULE_INCLUDE]: module.decisionDescription,
          [PROMPT_MODULE_SKIP]: "This module does not apply to the current conversation.",
        },
      },
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return { model: input.model, state: input.state, questions };
}

export function selectPromptModule(answer: DecisionsChoiceAnswer): boolean {
  if (answer.choice === PROMPT_MODULE_INCLUDE) return true;
  if (answer.choice === PROMPT_MODULE_SKIP) return false;
  throw new Error("prompt-module decision returned an unoffered choice");
}

export function promptModuleDecisionAnswer(
  response: DecisionsResponse,
  moduleId: string,
): DecisionsChoiceAnswer {
  const answer = response.answers[promptModuleQuestionId(moduleId)];
  if (answer === undefined || answer.type !== "choice") {
    throw new Error("prompt-module decision did not return a choice answer");
  }
  return answer;
}
