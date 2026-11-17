import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

import type {
  PromptModuleContext,
  PromptModuleDefinition,
  PromptModuleRunResult,
} from "./types.ts";
import { executeHttpPromptModule } from "./http-post.ts";

interface ChildResponse {
  readonly nonce: string;
  readonly kind: "succeeded" | "failed" | "invalid_result";
  readonly content?: string;
}

/**
 * Execute a trusted DB-authored function expression in a separately
 * terminable Node process. This is process separation for timeout/cancellation,
 * NOT a security sandbox: the function has the worker OS/network privileges.
 */
export async function executePromptModule(input: {
  readonly module: PromptModuleDefinition;
  readonly context: PromptModuleContext;
}): Promise<PromptModuleRunResult> {
  if (input.module.executionMode === "http_post") {
    return await executeHttpPromptModule(input);
  }
  if (
    input.module.executionMode !== "function" ||
    input.module.functionDefinition === null ||
    input.module.httpConfig !== null
  ) {
    return { kind: "failed", durationMs: 0 };
  }
  const startedAt = performance.now();
  const nonce = randomUUID();
  const childPath = fileURLToPath(new URL("./executor-child.ts", import.meta.url));
  const child: ChildProcess = fork(childPath, [], {
    execArgv: ["--experimental-strip-types"],
    cwd: process.cwd(),
    // Do not inherit worker credentials or unrelated runtime configuration.
    // Service credentials enter only in the explicit function context below.
    env: { PATH: process.env.PATH ?? "" },
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });

  return await new Promise<PromptModuleRunResult>((resolve) => {
    let settled = false;
    let timedOut = false;
    const durationMs = (): number => Math.max(0, Math.round(performance.now() - startedAt));
    const finish = (result: PromptModuleRunResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child.connected) child.disconnect();
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      resolve(result);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
      finish({ kind: "timed_out", durationMs: durationMs() });
    }, input.module.timeoutMs);

    child.on("message", (message: unknown) => {
      const response = message as Partial<ChildResponse> | null;
      if (response?.nonce !== nonce) return;
      if (response.kind === "succeeded" && typeof response.content === "string") {
        finish({ kind: "succeeded", content: response.content, durationMs: durationMs() });
      } else if (response.kind === "invalid_result") {
        finish({ kind: "invalid_result", durationMs: durationMs() });
      } else if (response.kind === "failed") {
        finish({ kind: "failed", durationMs: durationMs() });
      }
    });
    child.once("error", () => {
      if (!timedOut) finish({ kind: "failed", durationMs: durationMs() });
    });
    child.once("exit", () => {
      if (!settled && !timedOut) finish({ kind: "failed", durationMs: durationMs() });
    });

    child.send({
      nonce,
      functionDefinition: input.module.functionDefinition,
      context: input.context,
    }, (error) => {
      if (error !== null && !timedOut) {
        finish({ kind: "failed", durationMs: durationMs() });
      }
    });
  });
}
