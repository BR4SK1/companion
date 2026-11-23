/**
 * Application-owned decision model pool: round-robin load distribution and
 * automatic failover across configured OpenRouter Decisions models.
 *
 * OpenRouter's `/api/alpha/decisions` endpoint accepts a single `model`
 * string (not a fallback `models` array), and shared OpenRouter transport
 * (`libraries/openrouter/src/transport.ts`) deliberately performs no retries
 * or routing policy. This module owns that policy at the worker layer:
 *
 * - Each decision call gets a round-robin starting position across the
 *   configured model pool so traffic is distributed evenly.
 * - On retryable transport failures (HTTP 429, 408, 5xx, timeout, network,
 *   invalid_json), the call immediately fails over to the next configured
 *   model without sleeping.
 * - If every model in the pool fails with a retryable error on the initial
 *   pass, one short backoff pass retries the pool before surfacing the
 *   failure.
 * - Non-retryable transport errors (4xx other than 408/429) and non-transport
 *   errors (including lease-fencing or request-validation errors) fail fast
 *   without failing over or sleeping.
 * - Failover logs emit only sanitized categories (`http_429`, `timeout`,
 *   etc.), never raw response bodies or credentials.
 */

import { OpenRouterTransportError } from "@companion/openrouter/transport";

export const DEFAULT_DECISION_RETRY_PASSES = 1;
export const DEFAULT_DECISION_RETRY_BACKOFF_MS = 1_500;

export interface DecisionModelPool {
  readonly models: readonly [string, ...string[]];
  readonly retryPasses: number;
  readonly retryBackoffMs: number;
  readonly sleep: (ms: number) => Promise<void>;
  /** Return the round-robin model order for the next call and advance the cursor. */
  nextOrder(): readonly [string, ...string[]];
}

export interface CreateDecisionModelPoolOptions {
  /** Number of backoff passes after the initial pass through all models. Default: 1. */
  readonly retryPasses?: number;
  /** Delay before each backoff pass, in milliseconds. Default: 1500. */
  readonly retryBackoffMs?: number;
  /** Injectable delay for deterministic tests. */
  readonly sleep?: (ms: number) => Promise<void>;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function isRetryableDecisionTransportError(error: unknown): boolean {
  if (!(error instanceof OpenRouterTransportError)) {
    return false;
  }
  if (
    error.kind === "timeout" ||
    error.kind === "network" ||
    error.kind === "invalid_json"
  ) {
    return true;
  }
  if (error.kind === "http_status") {
    return (
      error.status === 429 ||
      error.status === 408 ||
      (error.status !== undefined && error.status >= 500 && error.status < 600)
    );
  }
  return false;
}

/** Sanitized error category for operational logs (never raw provider bodies). */
export function decisionErrorCategory(error: unknown): string {
  if (error instanceof OpenRouterTransportError) {
    if (error.kind === "http_status" && error.status !== undefined) {
      return `http_${String(error.status)}`;
    }
    return error.kind;
  }
  return "error";
}

export function createDecisionModelPool(
  models: readonly [string, ...string[]],
  options: CreateDecisionModelPoolOptions = {},
): DecisionModelPool {
  const frozenModels = Object.freeze([...models]) as readonly [string, ...string[]];
  const retryPasses = options.retryPasses ?? DEFAULT_DECISION_RETRY_PASSES;
  const retryBackoffMs = options.retryBackoffMs ?? DEFAULT_DECISION_RETRY_BACKOFF_MS;
  const sleep = options.sleep ?? defaultSleep;
  let nextIndex = 0;

  return {
    models: frozenModels,
    retryPasses,
    retryBackoffMs,
    sleep,
    nextOrder(): readonly [string, ...string[]] {
      const start = nextIndex;
      nextIndex = (nextIndex + 1) % frozenModels.length;
      if (start === 0) {
        return frozenModels;
      }
      return [
        ...frozenModels.slice(start),
        ...frozenModels.slice(0, start),
      ] as [string, ...string[]];
    },
  };
}

export type DecisionPoolRunResult<TRequest, TResponse> =
  | {
      readonly ok: true;
      readonly model: string;
      readonly request: TRequest;
      readonly response: TResponse;
    }
  | {
      readonly ok: false;
      readonly model: string;
      readonly request: TRequest;
      readonly error: unknown;
    };

export interface RunWithDecisionModelPoolParams<TRequest, TResponse> {
  readonly pool?: DecisionModelPool;
  readonly fallbackModel: string;
  readonly scope: string;
  readonly buildRequest: (model: string) => TRequest;
  readonly beforeCall?: (request: TRequest, model: string) => Promise<void>;
  readonly call: (request: TRequest, model: string) => Promise<TResponse>;
  readonly log?: (message: string) => void;
}

/**
 * Execute one decision call using the configured pool's round-robin order and
 * automatic failover policy. Errors thrown by `buildRequest` or `beforeCall`
 * (e.g., request validation or `TraceWriteFencedError`) propagate immediately.
 */
export async function runWithDecisionModelPool<TRequest, TResponse>(
  params: RunWithDecisionModelPoolParams<TRequest, TResponse>,
): Promise<DecisionPoolRunResult<TRequest, TResponse>> {
  const order: readonly [string, ...string[]] =
    params.pool !== undefined ? params.pool.nextOrder() : [params.fallbackModel];
  const maxPasses =
    params.pool !== undefined ? 1 + Math.max(0, params.pool.retryPasses) : 1;
  const backoffMs = params.pool?.retryBackoffMs ?? 0;
  const sleep = params.pool?.sleep ?? defaultSleep;
  const log = params.log ?? console.warn;

  let lastCategory = "error";
  for (let pass = 0; pass < maxPasses; pass += 1) {
    if (pass > 0) {
      log(
        `[DECISION] scope=${params.scope} all ${String(order.length)} model(s) failed (${lastCategory}); retrying pool after ${String(backoffMs)}ms (pass ${String(pass + 1)}/${String(maxPasses)})`,
      );
      if (backoffMs > 0) {
        await sleep(backoffMs);
      }
    }

    for (let index = 0; index < order.length; index += 1) {
      const model = order[index]!;
      const request = params.buildRequest(model);
      if (params.beforeCall !== undefined) {
        await params.beforeCall(request, model);
      }
      try {
        const response = await params.call(request, model);
        return { ok: true, model, request, response };
      } catch (error) {
        const retryable = isRetryableDecisionTransportError(error);
        const category = decisionErrorCategory(error);
        if (!retryable) {
          return { ok: false, model, request, error };
        }
        const nextModel = order[index + 1];
        if (nextModel !== undefined) {
          log(
            `[DECISION] scope=${params.scope} model=${model} failed (${category}); failing over to ${nextModel}`,
          );
          continue;
        }
        if (pass + 1 < maxPasses) {
          lastCategory = category;
          break;
        }
        return { ok: false, model, request, error };
      }
    }
  }

  // Unreachable because order is non-empty and maxPasses >= 1.
  throw new Error("decision model pool exited without attempting any model");
}
