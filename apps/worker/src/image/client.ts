import type { OfflineShot } from "./offline-plan.ts";
/**
 * HTTP clients for the two module services the image domain consumes:
 * the implementation service's post-reply reconciliation and the image
 * service's render. Responses are validated strictly before use; every
 * failure collapses into a fixed error category (never upstream text),
 * matching the worker's sanitized-diagnostics policy.
 */

import { parseImageDimensions } from "./webp.ts";
import type {
  ImagePlanSummary,
  PriorPose,
  ReconciledSnapshot,
  RenderedImage,
} from "./types.ts";

export type ImageClientErrorCategory =
  | "reconcile_http_error"
  | "reconcile_unavailable"
  | "reconcile_invalid_response"
  | "render_http_error"
  | "render_unavailable"
  | "render_invalid_response";

export class ImageClientError extends Error {
  readonly category: ImageClientErrorCategory;
  constructor(category: ImageClientErrorCategory) {
    super(category);
    this.name = "ImageClientError";
    this.category = category;
  }
}

const MAX_RESPONSE_BYTES = 24 * 1024 * 1024;
const ALLOWED_MIME_TYPES = new Set(["image/webp", "image/png", "image/jpeg"]);
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ImageServiceClients {
  readonly reconcile: (input: {
    readonly turnId: string;
    readonly userText: string;
    readonly companionResponse: string;
    readonly localDateTime: string;
    readonly familiarityTier?: string | null;
  }) => Promise<ReconciledSnapshot>;
  readonly render: (input: {
    readonly turnId: string;
    readonly userText: string;
    readonly companionResponse: string;
    readonly localDateTime: string;
    readonly snapshot: ReconciledSnapshot;
    readonly priorPose: PriorPose | null;
  }) => Promise<ImageRenderResult>;
  readonly renderOfflineShot: (eventId: string, shot: OfflineShot) => Promise<ImageRenderResult>;
}

export interface ImageRenderResult {
  readonly promptId: string;
  readonly plan: ImagePlanSummary;
  readonly sceneDescription: string | null;
  readonly images: readonly RenderedImage[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

async function readBoundedJson(
  response: Response,
  invalid: ImageClientErrorCategory,
): Promise<unknown> {
  const reader = response.body?.getReader();
  if (reader === undefined) throw new ImageClientError(invalid);
  const chunks: Buffer[] = [];
  let received = 0;
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    received += part.value.byteLength;
    if (received > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new ImageClientError(invalid);
    }
    chunks.push(Buffer.from(part.value));
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ImageClientError(invalid);
  }
}

async function postJson(
  fetchImpl: FetchLike,
  url: string,
  body: unknown,
  timeoutMs: number,
  kinds: {
    readonly http: ImageClientErrorCategory;
    readonly unavailable: ImageClientErrorCategory;
    readonly invalid: ImageClientErrorCategory;
  },
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch {
    throw new ImageClientError(kinds.unavailable);
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new ImageClientError(kinds.http);
  }
  return readBoundedJson(response, kinds.invalid);
}

function parseSnapshot(value: unknown): ReconciledSnapshot | null {
  if (!isRecord(value) || !isRecord(value.snapshot)) return null;
  const snapshot = value.snapshot;
  if (!isRecord(snapshot.schedule)) return null;
  const schedule = snapshot.schedule;
  if (
    typeof schedule.date !== "string" ||
    typeof schedule.block !== "string" ||
    typeof schedule.location !== "string" ||
    typeof schedule.surface !== "string" ||
    typeof schedule.activity !== "string" ||
    typeof schedule.balconyDay !== "boolean"
  ) {
    return null;
  }

  let clothing: ReconciledSnapshot["clothing"] = null;
  if (snapshot.clothing !== null && snapshot.clothing !== undefined) {
    if (!isRecord(snapshot.clothing) || !Array.isArray(snapshot.clothing.items)) {
      return null;
    }
    const items = [];
    for (const entry of snapshot.clothing.items) {
      if (
        !isRecord(entry) ||
        typeof entry.slot !== "string" ||
        typeof entry.tags !== "string" ||
        typeof entry.state !== "string"
      ) {
        return null;
      }
      items.push({
        ...(typeof entry.itemId === "string" ? { itemId: entry.itemId } : {}),
        slot: entry.slot,
        ...(typeof entry.category === "string"
          ? { category: entry.category }
          : {}),
        tags: entry.tags,
        state: entry.state,
      });
    }
    clothing = {
      ...(typeof snapshot.clothing.occasion === "string"
        ? { occasion: snapshot.clothing.occasion }
        : {}),
      items,
      ...(typeof snapshot.clothing.plannedOccasion === "string"
        ? { plannedOccasion: snapshot.clothing.plannedOccasion }
        : {}),
    };
  }

  let roleplay: ReconciledSnapshot["roleplay"] = null;
  if (snapshot.roleplay !== null && snapshot.roleplay !== undefined) {
    if (!isRecord(snapshot.roleplay) || typeof snapshot.roleplay.inScene !== "boolean") {
      return null;
    }
    const raw = snapshot.roleplay;
    const inScene: boolean = raw.inScene === true;
    roleplay = {
      inScene,
      chapter: typeof raw.chapter === "string" ? raw.chapter : null,
      activity: typeof raw.activity === "string" ? raw.activity : null,
      ...(typeof raw.pacing === "string" ? { pacing: raw.pacing } : {}),
      ...(typeof raw.userClimaxThisTurn === "boolean"
        ? { userClimaxThisTurn: raw.userClimaxThisTurn }
        : {}),
      ...(typeof raw.companionClimaxThisTurn === "boolean"
        ? { companionClimaxThisTurn: raw.companionClimaxThisTurn }
        : {}),
      ...(typeof raw.climaxRecent === "boolean"
        ? { climaxRecent: raw.climaxRecent }
        : {}),
      ...(typeof raw.turnsInChapter === "number"
        ? { turnsInChapter: raw.turnsInChapter }
        : {}),
      ...(typeof raw.beatSummary === "string"
        ? { beatSummary: raw.beatSummary }
        : {}),
    };
  }

  return {
    schedule: {
      date: schedule.date,
      block: schedule.block,
      location: schedule.location,
      surface: schedule.surface,
      activity: schedule.activity,
      balconyDay: schedule.balconyDay,
    },
    clothing,
    roleplay,
  };
}

export function createImageServiceClients(deps: {
  readonly implementationUrl: string;
  readonly imageServiceUrl: string;
  readonly userId: string;
  readonly timeoutMs: number;
  readonly fetchImpl?: FetchLike;
}): ImageServiceClients {
  const fetchImpl: FetchLike = deps.fetchImpl ?? fetch;

  const renderRequest = async (request: object): Promise<ImageRenderResult> => {
    const raw = await postJson(
      fetchImpl,
      `${deps.imageServiceUrl}/v1/render`,
      { ...request, userId: deps.userId },
      deps.timeoutMs,
      {
        http: "render_http_error",
        unavailable: "render_unavailable",
        invalid: "render_invalid_response",
      },
    );
    if (!isRecord(raw) || raw.success !== true || !isRecord(raw.plan)) {
      throw new ImageClientError("render_invalid_response");
    }
    const promptId = stringOrNull(raw.promptId);
    if (promptId === null || !Array.isArray(raw.images) || raw.images.length === 0) {
      throw new ImageClientError("render_invalid_response");
    }
    const planRaw = raw.plan;
    const plan: ImagePlanSummary = {
      location: stringOrNull(planRaw.location),
      timePeriod: stringOrNull(planRaw.timePeriod),
      poseCategory: stringOrNull(planRaw.poseCategory),
      poseVariantId: stringOrNull(planRaw.poseVariantId),
      expression: stringOrNull(planRaw.expressionKey),
      handGesture: stringOrNull(planRaw.handGesture),
      cameraAngle: stringOrNull(planRaw.cameraAngle),
      intimacy: stringOrNull(planRaw.intimacy),
      clothingSummary: stringOrNull(planRaw.clothingSummary),
    };
    const rawSceneDescription =
      stringOrNull(raw.sceneDescription) ??
      stringOrNull(planRaw.sceneDescription);
    const sceneDescription =
      rawSceneDescription !== null && rawSceneDescription.trim().length > 0
        ? rawSceneDescription.trim()
        : null;

    const images: RenderedImage[] = [];
    for (const entry of raw.images) {
      if (
        !isRecord(entry) ||
        typeof entry.filename !== "string" ||
        typeof entry.mimeType !== "string" ||
        !ALLOWED_MIME_TYPES.has(entry.mimeType) ||
        typeof entry.dataBase64 !== "string"
      ) {
        throw new ImageClientError("render_invalid_response");
      }
      const data = Buffer.from(entry.dataBase64, "base64");
      if (data.byteLength === 0 || data.byteLength > MAX_IMAGE_BYTES) {
        throw new ImageClientError("render_invalid_response");
      }
      if (
        typeof entry.sizeBytes === "number" &&
        entry.sizeBytes !== data.byteLength
      ) {
        throw new ImageClientError("render_invalid_response");
      }
      const dimensions = parseImageDimensions(entry.mimeType, data);
      if (dimensions === null) {
        throw new ImageClientError("render_invalid_response");
      }
      images.push({
        filename: entry.filename,
        mimeType: entry.mimeType,
        width: dimensions.width,
        height: dimensions.height,
        data,
      });
    }
    return { promptId, plan, sceneDescription, images };
  };

  return {
    reconcile: async (input) => {
      const raw = await postJson(
        fetchImpl,
        `${deps.implementationUrl}/v1/reconcile`,
        {
          userId: deps.userId,
          turnId: input.turnId,
          localDateTime: input.localDateTime,
          userMessage: input.userText,
          companionResponse: input.companionResponse,
          conversation: [],
          ...(input.familiarityTier !== undefined
            ? { familiarityTier: input.familiarityTier }
            : {}),
        },
        deps.timeoutMs,
        {
          http: "reconcile_http_error",
          unavailable: "reconcile_unavailable",
          invalid: "reconcile_invalid_response",
        },
      );
      const snapshot = parseSnapshot(raw);
      if (snapshot === null) {
        throw new ImageClientError("reconcile_invalid_response");
      }
      return snapshot;
    },

    render: (input) => {
      const { schedule, clothing, roleplay } = input.snapshot;
      return renderRequest({
        turnId: input.turnId,
        localDateTime: input.localDateTime,
        userMessage: input.userText,
        companionResponse: input.companionResponse,
        schedule,
        clothing,
        roleplay,
        ...(input.priorPose !== null ? { priorPose: input.priorPose } : {}),
      });
    },
    renderOfflineShot: (eventId, shot) => renderRequest({
      turnId: `${eventId}:${String(shot.position)}`,
      localDateTime: shot.localDateTime,
      schedule: shot.schedule,
      clothing: shot.clothing,
      hints: shot.hints,
      seed: shot.seed,
    }),
  };
}
