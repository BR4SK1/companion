import { DateTime } from "luxon";
import type { EngagementState } from "../engagement/types.ts";
import type {
  RoutineExternalAssistantMessage,
  RoutineExternalProviderConfig,
  RoutineExternalTickResponse,
} from "./types.ts";

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const MAX_ENDPOINT_BYTES = 4096;
const MAX_RESPONSE_BYTES = 65_536;
const MAX_MESSAGE_CHARS = 16_000;
const MAX_CLIENT_KEY_CHARS = 128;

export const EXTERNAL_ROUTINE_HOLD_KEY = "external_routine";

function endpointUrl(value: string): URL | null {
  if (
    Buffer.byteLength(value, "utf8") === 0 ||
    Buffer.byteLength(value, "utf8") > MAX_ENDPOINT_BYTES ||
    !/^https?:\/\//i.test(value) ||
    value.trim() !== value ||
    /[\u0000-\u0020\u007f]/.test(value)
  ) return null;
  try {
    const parsed = new URL(value);
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      parsed.hostname.length === 0 ||
      parsed.username.length > 0 ||
      parsed.password.length > 0 ||
      parsed.hash.length > 0
    ) return null;
    return parsed;
  } catch {
    return null;
  }
}

function localDateTimeString(now: Date, timezone: string | null | undefined): string | null {
  if (timezone === null || timezone === undefined) return null;
  const local = DateTime.fromJSDate(now, { zone: timezone });
  return local.isValid ? local.toFormat("yyyy-MM-dd'T'HH:mm:ss.SSSZZ") : null;
}

function parseTickResponse(raw: unknown): RoutineExternalTickResponse | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  let unavailableUntil: Date | null | undefined;
  if (Object.hasOwn(record, "unavailableUntil")) {
    const hold = record.unavailableUntil;
    if (hold === null) {
      unavailableUntil = null;
    } else if (
      typeof hold === "string" &&
      ISO_TIMESTAMP.test(hold) &&
      Number.isFinite(Date.parse(hold))
    ) {
      unavailableUntil = new Date(hold);
    } else {
      return null;
    }
  }

  const availabilityRevision = record.availabilityRevision;
  if (
    availabilityRevision !== undefined &&
    (unavailableUntil === undefined ||
      typeof availabilityRevision !== "number" ||
      !Number.isSafeInteger(availabilityRevision) ||
      availabilityRevision <= 0)
  ) return null;

  let assistantMessage: RoutineExternalAssistantMessage | null | undefined;
  if (Object.hasOwn(record, "assistantMessage")) {
    const msg = record.assistantMessage;
    if (msg === null) {
      assistantMessage = null;
    } else if (typeof msg === "object" && msg !== null && !Array.isArray(msg)) {
      const m = msg as Record<string, unknown>;
      if (
        typeof m.clientKey !== "string" ||
        m.clientKey.trim().length === 0 ||
        m.clientKey.length > MAX_CLIENT_KEY_CHARS ||
        typeof m.content !== "string" ||
        m.content.trim().length === 0 ||
        m.content.length > MAX_MESSAGE_CHARS
      ) {
        return null;
      }
      assistantMessage = {
        clientKey: m.clientKey.trim(),
        content: m.content,
      };
    } else {
      return null;
    }
  }

  return {
    ...(unavailableUntil !== undefined ? { unavailableUntil } : {}),
    ...(availabilityRevision !== undefined ? { availabilityRevision } : {}),
    ...(assistantMessage !== undefined ? { assistantMessage } : {}),
  };
}

export interface ExternalRoutineTickDeps {
  readonly loadProvider: () => Promise<RoutineExternalProviderConfig | null>;
  readonly credentials: Readonly<Record<string, string>>;
  readonly timezone: string | null;
  readonly now?: () => Date;
  readonly loadEngagementState?: (now: Date) => Promise<EngagementState | null>;
  readonly hasQueuedUserMessages?: () => Promise<boolean>;
  readonly applyAvailabilityHold: (unavailableUntil: Date | null, revision?: number) => Promise<void>;
  readonly publishAssistantMessage: (
    message: RoutineExternalAssistantMessage,
    revision?: number,
  ) => Promise<boolean>;
  readonly observeResponse?: (response: unknown, scope: string | null) => Promise<void>;
  readonly fetchImpl?: typeof fetch;
  readonly log?: (message: string) => void;
}

export type ExternalRoutineTickOutcome =
  | { readonly status: "disabled" }
  | { readonly status: "skipped"; readonly reason: string }
  | { readonly status: "ok"; readonly publishedMessage: boolean }
  | { readonly status: "failed"; readonly reason: string };

/**
 * Execute one background tick against a DB-configured external HTTP routine
 * provider. Keeps availability holds and idempotent assistant messages synced
 * without duplicating engagement logic in external services.
 */
export async function runExternalRoutineTick(
  deps: ExternalRoutineTickDeps,
): Promise<ExternalRoutineTickOutcome> {
  const provider = await deps.loadProvider();
  if (provider === null || !provider.enabled) {
    return { status: "disabled" };
  }
  const now = deps.now?.() ?? new Date();
  const localDateTime = localDateTimeString(now, deps.timezone);
  if (localDateTime === null) {
    return { status: "skipped", reason: "timezone_unconfigured" };
  }

  const endpointRaw = deps.credentials[provider.endpointSetting];
  if (typeof endpointRaw !== "string") {
    return { status: "failed", reason: "missing_endpoint_setting" };
  }
  const endpoint = endpointUrl(endpointRaw);
  if (endpoint === null) {
    return { status: "failed", reason: "invalid_endpoint_url" };
  }

  let scope: string | null = null;
  if (provider.scopeSetting !== null) {
    const scopeRaw = deps.credentials[provider.scopeSetting];
    if (typeof scopeRaw !== "string" || scopeRaw.trim().length === 0) {
      return { status: "failed", reason: "missing_scope_setting" };
    }
    scope = scopeRaw;
  }

  const engagementState = deps.loadEngagementState !== undefined
    ? await deps.loadEngagementState(now).catch(() => null)
    : null;
  const hasQueuedUserMessages = deps.hasQueuedUserMessages !== undefined
    ? await deps.hasQueuedUserMessages().catch(() => false)
    : false;

  const requestPayload: Record<string, unknown> = {
    ...(scope !== null ? { userId: scope } : {}),
    localDateTime,
    engagementState,
    hasQueuedUserMessages,
  };

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, provider.timeoutMs);

  let parsedResponse: RoutineExternalTickResponse | null = null;
  let responseBody: unknown;
  try {
    const response = await (deps.fetchImpl ?? fetch)(endpoint, {
      method: "POST",
      redirect: "error",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(requestPayload),
    });
    if (!response.ok) {
      try {
        await response.body?.cancel();
      } catch {
        // best-effort cancel
      }
      return { status: "failed", reason: `http_${String(response.status)}` };
    }
    if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "")) {
      try {
        await response.body?.cancel();
      } catch {
        // best-effort cancel
      }
      return { status: "failed", reason: "invalid_content_type" };
    }
    if (response.body === null) {
      return { status: "failed", reason: "empty_body" };
    }
    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let receivedBytes = 0;
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      receivedBytes += part.value.byteLength;
      if (receivedBytes > MAX_RESPONSE_BYTES) {
        try {
          await reader.cancel();
        } catch {
          // best-effort cancel
        }
        return { status: "failed", reason: "response_too_large" };
      }
      chunks.push(Buffer.from(part.value));
    }
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(
        Buffer.concat(chunks, receivedBytes),
      );
      responseBody = JSON.parse(text);
    } catch {
      return { status: "failed", reason: "invalid_json" };
    }
    parsedResponse = parseTickResponse(responseBody);
    if (parsedResponse === null) {
      return { status: "failed", reason: "invalid_response_shape" };
    }
  } catch {
    return { status: "failed", reason: timedOut ? "timeout" : "transport_error" };
  } finally {
    clearTimeout(timer);
  }

  if (parsedResponse.unavailableUntil !== undefined) {
    await deps.applyAvailabilityHold(parsedResponse.unavailableUntil, parsedResponse.availabilityRevision);
  }
  let publishedMessage = false;
  if (parsedResponse.assistantMessage !== undefined && parsedResponse.assistantMessage !== null) {
    publishedMessage = await deps.publishAssistantMessage(
      parsedResponse.assistantMessage,
      parsedResponse.availabilityRevision,
    );
  }
  await deps.observeResponse?.(responseBody, scope).catch(() =>
    deps.log?.("[ROUTINE] external tick extension could not be processed"),
  );
  return { status: "ok", publishedMessage };
}
