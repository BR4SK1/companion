import { performance } from "node:perf_hooks";
import { OpenRouterTransportError } from "@companion/openrouter/transport";
import {
  parseDecisionsExchange,
  parseDecisionsRequest,
  type DecisionsRequest,
  type DecisionsState,
} from "@companion/openrouter";

import { buildPromptModuleDecisionRequest, promptModuleDecisionAnswer, selectPromptModule } from "./decision.ts";
import type {
  PromptModuleContext,
  PromptModuleDefinition,
  PromptModuleDecisionTrace,
  PromptModuleExecutionTrace,
  PromptModuleRunResult,
} from "./types.ts";

export interface PromptModuleRuntimeDeps {
  readonly turnId: string;
  readonly leaseOwner: string;
  readonly decisionModel: string;
  readonly state: DecisionsState;
  readonly modules: readonly PromptModuleDefinition[];
  readonly context: Omit<PromptModuleContext, "turnId">;
  readonly callDecisions: (request: DecisionsRequest) => Promise<unknown>;
  readonly execute: (input: {
    readonly module: PromptModuleDefinition;
    readonly context: PromptModuleContext;
  }) => Promise<PromptModuleRunResult>;
  readonly recordDefinitions: (input: {
    readonly turnId: string;
    readonly leaseOwner: string;
    readonly decisionModel: string;
    readonly modules: readonly PromptModuleDefinition[];
  }) => Promise<void>;
  readonly recordDecision: (input: {
    readonly turnId: string;
    readonly leaseOwner: string;
    readonly result: PromptModuleDecisionTrace;
  }) => Promise<void>;
  readonly recordExecution: (input: {
    readonly turnId: string;
    readonly leaseOwner: string;
    readonly result: PromptModuleExecutionTrace;
  }) => Promise<void>;
  readonly log?: (message: string) => void;
}

function elapsed(startedAt: number): number {
  return Math.max(0, Math.round(performance.now() - startedAt));
}

function log(deps: PromptModuleRuntimeDeps, message: string): void {
  (deps.log ?? console.info)(`[PROMPT_MODULE] ${message}`);
}

function safeResult(result: PromptModuleRunResult): PromptModuleRunResult {
  if (result.kind !== "succeeded") return result;
  if (
    typeof result.content !== "string" ||
    result.content.trim().length === 0 ||
    result.content.length > 16_000
  ) {
    return { kind: "invalid_result", durationMs: result.durationMs };
  }
  return result;
}

/**
 * Runs the optional independent module decision batch and selected functions.
 * Any decision or function failure degrades to omitted module context; it never
 * rejects ordinary chat. A database trace fencing error remains fatal at the
 * composition edge to preserve lease correctness.
 */
export async function runPromptModules(
  deps: PromptModuleRuntimeDeps,
): Promise<readonly { readonly moduleId: string; readonly content: string }[]> {
  const modules = [...deps.modules].sort((a, b) =>
    a.position - b.position || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  if (modules.length === 0) return [];

  const request = parseDecisionsRequest(buildPromptModuleDecisionRequest({
    model: deps.decisionModel,
    modules,
    state: deps.state,
  }));
  // The trace snapshot of criteria and function hashes is written before the
  // optional model decision request. DB code itself is never copied to trace.
  await deps.recordDefinitions({
    turnId: deps.turnId,
    leaseOwner: deps.leaseOwner,
    decisionModel: deps.decisionModel,
    modules,
  });

  const decisionStartedAt = performance.now();
  let response: ReturnType<typeof parseDecisionsExchange> | undefined;
  let decisionFailure: PromptModuleDecisionTrace["failureKind"] = null;
  try {
    response = parseDecisionsExchange(request, await deps.callDecisions(request));
  } catch (error) {
    decisionFailure = error instanceof OpenRouterTransportError
      ? "decision_transport"
      : "decision_invalid";
  }

  if (response !== undefined) {
    const rawSelections = modules.map((module) => {
      const answer = promptModuleDecisionAnswer(response!, module.id);
      return { module, answer };
    });
    const selections: PromptModuleDecisionTrace["selections"][number][] = [];
    let unusable = false;
    for (const { module, answer } of rawSelections) {
      try {
        const selected = selectPromptModule(answer);
        selections.push({
          moduleId: module.id,
          choice: answer.choice,
          selected,
          confidence: answer.confidence ?? null,
          probabilities: answer.probabilities ?? null,
        });
      } catch {
        unusable = true;
        selections.push({
          moduleId: module.id,
          choice: answer.choice,
          selected: null,
          confidence: answer.confidence ?? null,
          probabilities: answer.probabilities ?? null,
        });
      }
    }
    if (unusable) {
      decisionFailure = "decision_unusable";
      await deps.recordDecision({
        turnId: deps.turnId,
        leaseOwner: deps.leaseOwner,
        result: {
          state: "invalid",
          decisionModel: request.model,
          responseModel: response.model,
          responseProvider: response.provider ?? null,
          durationMs: elapsed(decisionStartedAt),
          failureKind: decisionFailure,
          // A malformed choice invalidates this independent batch: retain raw
          // returned choices for explanation but never treat any as selected.
          selections: selections.map((selection) => ({ ...selection, selected: null })),
        },
      });
      log(deps, `decision=failed reason=${decisionFailure} modules=${modules.length}; all omitted`);
      return [];
    }

    await deps.recordDecision({
      turnId: deps.turnId,
      leaseOwner: deps.leaseOwner,
      result: {
        state: "responded",
        decisionModel: request.model,
        responseModel: response.model,
        responseProvider: response.provider ?? null,
        durationMs: elapsed(decisionStartedAt),
        failureKind: null,
        selections,
      },
    });
    const selected = new Set(selections.filter((entry) => entry.selected === true).map((entry) => entry.moduleId));
    const outputs: { moduleId: string; content: string }[] = [];
    let executionOrdinal = 0;
    for (const module of modules) {
      if (!selected.has(module.id)) {
        log(deps, `module=${module.key} decision=skipped execution=not_selected included=false`);
        continue;
      }
      const currentExecutionOrdinal = executionOrdinal++;
      const executionStartedAt = performance.now();
      let rawExecution: PromptModuleRunResult;
      try {
        rawExecution = await deps.execute({
          module,
          context: { ...deps.context, turnId: deps.turnId },
        });
      } catch {
        rawExecution = { kind: "failed", durationMs: elapsed(executionStartedAt) };
      }
      const execution = safeResult(rawExecution);
      const fallbackUsed = execution.kind !== "succeeded" && module.fallbackContent !== null;
      const content = execution.kind === "succeeded"
        ? execution.content
        : fallbackUsed
          ? module.fallbackContent!
          : null;
      const trace: PromptModuleExecutionTrace = {
        moduleId: module.id,
        executionOrdinal: currentExecutionOrdinal,
        state: execution.kind,
        durationMs: execution.durationMs,
        outputReady: content !== null,
        fallbackSelected: fallbackUsed,
      };
      await deps.recordExecution({ turnId: deps.turnId, leaseOwner: deps.leaseOwner, result: trace });
      if (content !== null) outputs.push({ moduleId: module.id, content });
      log(
        deps,
        `module=${module.key} decision=selected execution=${execution.kind} ms=${execution.durationMs} fallback_ready=${fallbackUsed} output_ready=${content !== null}`,
      );
    }
    return outputs;
  }

  await deps.recordDecision({
    turnId: deps.turnId,
    leaseOwner: deps.leaseOwner,
    result: {
      state: decisionFailure === "decision_transport" ? "failed" : "invalid",
      decisionModel: request.model,
      responseModel: null,
      responseProvider: null,
      durationMs: elapsed(decisionStartedAt),
      failureKind: decisionFailure,
      selections: modules.map((module) => ({
        moduleId: module.id,
        choice: null,
        selected: null,
        confidence: null,
        probabilities: null,
      })),
    },
  });
  log(deps, `decision=failed reason=${decisionFailure} modules=${modules.length}; all omitted`);
  return [];
}
