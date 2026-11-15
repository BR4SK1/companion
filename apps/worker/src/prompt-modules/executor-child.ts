import ts from "typescript";
import type { PromptModuleContext } from "./types.ts";

interface ChildRequest {
  readonly nonce: string;
  readonly functionDefinition: string;
  readonly context: PromptModuleContext;
}

interface ChildResponse {
  readonly nonce: string;
  readonly kind: "succeeded" | "failed" | "invalid_result";
  readonly content?: string;
}

function respond(response: ChildResponse): void {
  // A trusted function may have created timers/handles; they must not keep a
  // completed execution process alive. Wait for IPC delivery before exiting.
  if (process.send === undefined) {
    process.exit(1);
    return;
  }
  process.send(response, () => process.exit(0));
}

process.once("message", async (raw: unknown) => {
  const request = raw as ChildRequest;
  if (
    typeof request?.nonce !== "string" ||
    typeof request.functionDefinition !== "string" ||
    request.functionDefinition.length > 131_072
  ) {
    respond({ nonce: typeof request?.nonce === "string" ? request.nonce : "", kind: "failed" });
    return;
  }

  try {
    const compiled = ts.transpileModule(
      `const promptModuleFunction = (${request.functionDefinition});\nexport default promptModuleFunction;`,
      {
        compilerOptions: {
          module: ts.ModuleKind.ESNext,
          target: ts.ScriptTarget.ES2022,
          strict: true,
        },
        reportDiagnostics: true,
      },
    );
    if (
      compiled.diagnostics?.some(
        (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
      )
    ) {
      respond({ nonce: request.nonce, kind: "failed" });
      return;
    }

    const encoded = Buffer.from(compiled.outputText, "utf8").toString("base64");
    const loaded = await import(`data:text/javascript;base64,${encoded}`) as {
      readonly default?: unknown;
    };
    if (typeof loaded.default !== "function") {
      respond({ nonce: request.nonce, kind: "failed" });
      return;
    }
    const result: unknown = await loaded.default(request.context);
    if (
      typeof result !== "string" ||
      result.trim().length === 0 ||
      result.length > 16_000
    ) {
      respond({ nonce: request.nonce, kind: "invalid_result" });
      return;
    }
    respond({ nonce: request.nonce, kind: "succeeded", content: result });
  } catch {
    // Exception text is arbitrary and may contain response bodies, credentials,
    // or private content. Only the fixed outcome category crosses IPC.
    respond({ nonce: request.nonce, kind: "failed" });
  }
});
