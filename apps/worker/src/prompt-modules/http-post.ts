import { performance } from "node:perf_hooks";

import type {
  PromptModuleContext,
  PromptModuleDefinition,
  PromptModuleRunResult,
  PromptModuleHttpPostConfig,
} from "./types.ts";

const SETTING_NAME = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const JSON_FIELD_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const LOCAL_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?[+-]\d{2}:\d{2}$/;
const MAX_ENDPOINT_BYTES = 4096;
const MAX_OUTPUT_CHARACTERS = 16_000;

function durationMs(startedAt: number): number {
  return Math.max(0, Math.round(performance.now() - startedAt));
}

function result(
  startedAt: number,
  kind: PromptModuleRunResult["kind"],
  content?: string,
): PromptModuleRunResult {
  return kind === "succeeded"
    ? { kind, content: content!, durationMs: durationMs(startedAt) }
    : { kind, durationMs: durationMs(startedAt) };
}

function integerInRange(value: number, minimum: number, maximum: number): boolean {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function isSettingName(value: unknown): value is string {
  return typeof value === "string" && SETTING_NAME.test(value);
}

function isJsonFieldName(value: unknown): value is string {
  return typeof value === "string" && JSON_FIELD_NAME.test(value);
}

function validConfig(config: PromptModuleHttpPostConfig): boolean {
  if (!isSettingName(config.endpointSetting)) return false;
  if (
    (config.scopeSetting === null) !== (config.scopeField === null) ||
    (config.scopeSetting !== null &&
      (!isSettingName(config.scopeSetting) || config.scopeSetting === config.endpointSetting))
  ) return false;

  const optionalRequestFields = [
    config.scopeField,
    config.turnIdField,
    config.localDateTimeField,
    config.previousAssistantResponseField,
    config.userMessageField,
    config.priorConversationField,
  ];
  if (
    !optionalRequestFields.every((field) => field === null || isJsonFieldName(field)) ||
    !isJsonFieldName(config.responseTextField) ||
    !integerInRange(config.fieldMaxBytes, 1, 262_144) ||
    !integerInRange(config.priorMessageLimit, 0, 200) ||
    !integerInRange(config.requestMaxBytes, 128, 1_048_576) ||
    !integerInRange(config.responseMaxBytes, 1, 1_048_576)
  ) return false;
  const requestFields = optionalRequestFields.filter((field): field is string => field !== null);
  return new Set(requestFields).size === requestFields.length;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function jsonBytes(value: Readonly<Record<string, unknown>>): number | null {
  try {
    const encoded = JSON.stringify(value);
    return byteLength(encoded);
  } catch {
    return null;
  }
}

function endpointUrl(value: string): URL | null {
  if (
    byteLength(value) === 0 || byteLength(value) > MAX_ENDPOINT_BYTES ||
    !/^https?:\/\//i.test(value) ||
    value.trim() !== value || /[\u0000-\u0020\u007f]/.test(value)
  ) return null;
  try {
    const endpoint = new URL(value);
    if (
      (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") ||
      endpoint.hostname.length === 0 ||
      endpoint.username.length > 0 ||
      endpoint.password.length > 0 ||
      endpoint.hash.length > 0
    ) return null;
    return endpoint;
  } catch {
    return null;
  }
}

async function discardResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Cancellation is best-effort; preserve the already-known module outcome.
  }
}

function boundedPriorConversation(
  context: PromptModuleContext,
  config: PromptModuleHttpPostConfig,
  body: Record<string, unknown>,
): void {
  const field = config.priorConversationField;
  if (field === null) return;
  body[field] = [];
  const minimumBodyBytes = jsonBytes(body);
  if (minimumBodyBytes === null || minimumBodyBytes > config.requestMaxBytes) return;

  const limit = config.priorMessageLimit;
  const source = Array.isArray(context.priorConversation) ? context.priorConversation : [];
  const prior = limit === 0 ? [] : source.slice(-limit);
  const eligible = prior.filter((message) =>
    (message.role === "user" || message.role === "assistant") &&
    typeof message.content === "string" &&
    message.content.trim().length > 0 &&
    byteLength(message.content) <= config.fieldMaxBytes
  );

  let selectedNewestFirst: { role: "user" | "assistant"; content: string }[] = [];
  for (const message of [...eligible].reverse()) {
    const candidate = [{ role: message.role, content: message.content }, ...selectedNewestFirst];
    body[field] = candidate;
    const candidateBytes = jsonBytes(body);
    if (candidateBytes !== null && candidateBytes <= config.requestMaxBytes) {
      selectedNewestFirst = candidate;
    }
  }
  body[field] = selectedNewestFirst;
}

/** Execute a fixed HTTP POST JSON mapping without evaluating module-authored code. */
export async function executeHttpPromptModule(input: {
  readonly module: PromptModuleDefinition;
  readonly context: PromptModuleContext;
}): Promise<PromptModuleRunResult> {
  const startedAt = performance.now();
  const config = input.module.httpConfig;
  if (
    input.module.executionMode !== "http_post" ||
    input.module.functionDefinition !== null ||
    !integerInRange(input.module.timeoutMs, 1, 30_000) ||
    config === null ||
    !validConfig(config)
  ) return result(startedAt, "failed");

  const context = input.context;
  const credentials = context.credentials;
  if (typeof credentials !== "object" || credentials === null) {
    return result(startedAt, "failed");
  }
  const endpointText = credentials[config.endpointSetting];
  if (typeof endpointText !== "string") return result(startedAt, "failed");
  const endpoint = endpointUrl(endpointText);
  if (endpoint === null) return result(startedAt, "failed");

  const body: Record<string, unknown> = {};
  if (config.scopeField !== null && config.scopeSetting !== null) {
    const scopeValue = credentials[config.scopeSetting];
    if (
      typeof scopeValue !== "string" || scopeValue.trim().length === 0 ||
      byteLength(scopeValue) > config.fieldMaxBytes
    ) return result(startedAt, "failed");
    body[config.scopeField] = scopeValue;
  }
  if (config.turnIdField !== null) {
    if (typeof context.turnId !== "string" || context.turnId.length === 0) {
      return result(startedAt, "invalid_result");
    }
    if (byteLength(context.turnId) > config.fieldMaxBytes) {
      return result(startedAt, "invalid_result");
    }
    body[config.turnIdField] = context.turnId;
  }
  if (config.localDateTimeField !== null) {
    const localDateTime = context.localDateTime;
    if (
      typeof localDateTime !== "string" ||
      !LOCAL_DATE_TIME.test(localDateTime) ||
      !Number.isFinite(Date.parse(localDateTime)) ||
      byteLength(localDateTime) > config.fieldMaxBytes
    ) return result(startedAt, "invalid_result");
    body[config.localDateTimeField] = localDateTime;
  }
  if (config.previousAssistantResponseField !== null) {
    const previousAssistantResponse = context.previousAssistantResponse;
    if (
      typeof previousAssistantResponse !== "string" ||
      byteLength(previousAssistantResponse) > config.fieldMaxBytes
    ) return result(startedAt, "invalid_result");
    body[config.previousAssistantResponseField] = previousAssistantResponse;
  }
  if (config.userMessageField !== null) {
    if (!Array.isArray(context.userMessages) || context.userMessages.length === 0) {
      return result(startedAt, "invalid_result");
    }
    let currentUserMessageBytes = 0;
    for (const [index, message] of context.userMessages.entries()) {
      if (typeof message !== "string") return result(startedAt, "invalid_result");
      currentUserMessageBytes += byteLength(message) + (index === 0 ? 0 : 1);
      if (currentUserMessageBytes > config.fieldMaxBytes) {
        return result(startedAt, "invalid_result");
      }
    }
    const currentUserMessage = context.userMessages.join("\n");
    if (currentUserMessage.trim().length === 0) return result(startedAt, "invalid_result");
    body[config.userMessageField] = currentUserMessage;
  }
  if (config.priorConversationField !== null) {
    boundedPriorConversation(context, config, body);
  }
  const requestBody = JSON.stringify(body);
  if (byteLength(requestBody) > config.requestMaxBytes) {
    return result(startedAt, "invalid_result");
  }

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, input.module.timeoutMs);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      redirect: "error",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: requestBody,
    });
    if (!response.ok) {
      await discardResponseBody(response);
      return result(startedAt, "failed");
    }
    if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "")) {
      await discardResponseBody(response);
      return result(startedAt, "invalid_result");
    }
    if (response.body === null) return result(startedAt, "invalid_result");

    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let receivedBytes = 0;
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      receivedBytes += part.value.byteLength;
      if (receivedBytes > config.responseMaxBytes) {
        try {
          await reader.cancel();
        } catch {
          // The response is already unusable; cancellation failure is not surfaced.
        }
        return result(startedAt, "invalid_result");
      }
      chunks.push(Buffer.from(part.value));
    }

    let parsed: unknown;
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, receivedBytes));
      parsed = JSON.parse(text);
    } catch {
      return result(startedAt, "invalid_result");
    }
    if (
      typeof parsed !== "object" || parsed === null || Array.isArray(parsed) ||
      !Object.hasOwn(parsed, config.responseTextField)
    ) return result(startedAt, "invalid_result");

    const content = (parsed as Record<string, unknown>)[config.responseTextField];
    if (
      typeof content !== "string" ||
      content.trim().length === 0 ||
      content.length > MAX_OUTPUT_CHARACTERS ||
      byteLength(content) > config.responseMaxBytes
    ) return result(startedAt, "invalid_result");
    return result(startedAt, "succeeded", content);
  } catch {
    return result(startedAt, timedOut ? "timed_out" : "failed");
  } finally {
    clearTimeout(timer);
  }
}
