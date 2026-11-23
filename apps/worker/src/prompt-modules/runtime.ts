import { performance } from "node:perf_hooks";
import { OpenRouterTransportError } from "@companion/openrouter/transport";
import {
  parseDecisionsExchange,
  parseDecisionsRequest,
  type DecisionsRequest,
  type DecisionsState,
} from "@companion/openrouter";

import { buildPromptModuleDecisionRequest, promptModuleDecisionAnswer, selectPromptModule } from "./decision.ts";
import {
  runWithDecisionModelPool,
  type DecisionModelPool,
} from "../work/decision-pool.ts";
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
  readonly decisionModelPool?: DecisionModelPool;
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

function emptySelection(moduleId: string, selected: boolean | null) {
  return {
    moduleId,
    choice: null,
    selected,
    confidence: null,
    probabilities: null,
  } as const;
}

/**
 * Records real model-gated outcomes independently from every-turn activation.
 * A failed or unusable model batch only suppresses model-gated modules; it
 * cannot suppress a module whose configured activation does not require a
 * provider decision. Selected modules still execute in their configured order.
 */
export async function runPromptModules(
  deps: PromptModuleRuntimeDeps,
): Promise<readonly {
  readonly moduleId: string;
  readonly moduleKey?: string;
  readonly content: string;
  readonly outputKind: PromptModuleDefinition["outputKind"];
  readonly unavailableUntil?: Date | null;
}[]> {
  const modules = [...deps.modules].sort((a, b) =>
    a.position - b.position || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  if (modules.length === 0) return [];

  const gatedModules = modules.filter((module) => module.activationMode === "model_gated");
  const everyTurnModules = modules.filter((module) => module.activationMode === "every_turn");
  await deps.recordDefinitions({
    turnId: deps.turnId,
    leaseOwner: deps.leaseOwner,
    decisionModel: deps.decisionModel,
    modules,
  });

  const selected = new Set<string>();
  if (gatedModules.length > 0) {
    const decisionStartedAt = performance.now();
    let request: DecisionsRequest | undefined;
    let response: ReturnType<typeof parseDecisionsExchange> | undefined;
    let failure: PromptModuleDecisionTrace["failureKind"] = null;
    try {
      const decisionCall = await runWithDecisionModelPool({
        pool: deps.decisionModelPool,
        fallbackModel: deps.decisionModel,
        scope: `prompt_modules:${deps.turnId}`,
        log: deps.log,
        buildRequest: (model) =>
          parseDecisionsRequest(buildPromptModuleDecisionRequest({
            model,
            modules: gatedModules,
            state: deps.state,
          })),
        call: (candidateRequest) => deps.callDecisions(candidateRequest),
      });
      request = decisionCall.request;
      if (!decisionCall.ok) {
        throw decisionCall.error;
      }
      response = parseDecisionsExchange(request, decisionCall.response);
    } catch (error) {
      failure = error instanceof OpenRouterTransportError
        ? "decision_transport"
        : "decision_invalid";
    }

    if (response !== undefined && request !== undefined) {
      const selections: PromptModuleDecisionTrace["selections"][number][] = [];
      let unusable = false;
      for (const module of gatedModules) {
        let answer: ReturnType<typeof promptModuleDecisionAnswer>;
        try {
          answer = promptModuleDecisionAnswer(response, module.id);
        } catch {
          unusable = true;
          selections.push(emptySelection(module.id, null));
          continue;
        }
        try {
          const include = selectPromptModule(answer);
          if (include) selected.add(module.id);
          selections.push({
            moduleId: module.id,
            choice: answer.choice,
            selected: include,
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
        failure = "decision_unusable";
        selected.clear();
        await deps.recordDecision({
          turnId: deps.turnId,
          leaseOwner: deps.leaseOwner,
          result: {
            state: "invalid",
            decisionModel: request.model,
            responseModel: response.model,
            responseProvider: response.provider ?? null,
            durationMs: elapsed(decisionStartedAt),
            failureKind: failure,
            selections: selections.map((entry) => ({ ...entry, selected: null })),
          },
        });
        log(deps, `decision=failed reason=${failure} modules=${gatedModules.length}; gated modules omitted`);
      } else {
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
      }
    } else {
      await deps.recordDecision({
        turnId: deps.turnId,
        leaseOwner: deps.leaseOwner,
        result: {
          state: failure === "decision_transport" ? "failed" : "invalid",
          decisionModel: request?.model ?? null,
          responseModel: null,
          responseProvider: null,
          durationMs: elapsed(decisionStartedAt),
          failureKind: failure ?? "decision_invalid",
          selections: gatedModules.map((module) => emptySelection(module.id, null)),
        },
      });
      log(deps, `decision=failed reason=${failure ?? "decision_invalid"} modules=${gatedModules.length}; gated modules omitted`);
    }
  }

  if (everyTurnModules.length > 0) {
    await deps.recordDecision({
      turnId: deps.turnId,
      leaseOwner: deps.leaseOwner,
      result: {
        state: "not_required",
        decisionModel: null,
        responseModel: null,
        responseProvider: null,
        durationMs: null,
        failureKind: null,
        selections: everyTurnModules.map((module) => emptySelection(module.id, true)),
      },
    });
    for (const module of everyTurnModules) selected.add(module.id);
  }

  const outputs: {
    moduleId: string;
    moduleKey?: string;
    content: string;
    outputKind: PromptModuleDefinition["outputKind"];
    unavailableUntil?: Date | null;
    availabilityRevision?: number;
  }[] = [];
  const { publishedRoutineMessageKey, ...context } = deps.context;
  let executionOrdinal = 0;
  for (const module of modules) {
    if (!selected.has(module.id)) {
      log(deps, `module=${module.key} activation=${module.activationMode} execution=not_selected included=false`);
      continue;
    }
    const currentExecutionOrdinal = executionOrdinal++;
    const executionStartedAt = performance.now();
    let rawExecution: PromptModuleRunResult;
    try {
      rawExecution = await deps.execute({
        module,
        context: {
          ...context,
          turnId: deps.turnId,
          ...(module.httpConfig?.publishedRoutineMessageKeyField != null
            ? { publishedRoutineMessageKey: publishedRoutineMessageKey ?? null }
            : {}),
        },
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
    if (content !== null) {
      const hold = execution.kind === "succeeded" ? execution.unavailableUntil : undefined;
      const revision = execution.kind === "succeeded" ? execution.availabilityRevision : undefined;
      outputs.push({
        moduleId: module.id,
        content,
        outputKind: module.outputKind,
        ...(hold !== undefined ? { moduleKey: module.key, unavailableUntil: hold } : {}),
        ...(hold !== undefined && revision !== undefined ? { availabilityRevision: revision } : {}),
      });
    }
    log(
      deps,
      `module=${module.key} activation=${module.activationMode} execution=${execution.kind} ms=${execution.durationMs} fallback_ready=${fallbackUsed} output_ready=${content !== null}`,
    );
  }
  return outputs;
}
