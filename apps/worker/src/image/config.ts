/**
 * Image-generation configuration, parsed from the environment like the
 * memory configuration. The feature is enabled only when the operator
 * supplies all three core settings; a partial configuration is a startup
 * error naming the missing variables, never a silent half-enabled state.
 * With none supplied, the worker runs with image generation disabled and
 * ordinary chat is unchanged.
 */

export class ImageConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageConfigError";
  }
}

/**
 * Default pattern ids treated as photo-worthy. These mirror the
 * implementation service's default clothing/roleplay inclusion lists so the
 * two services agree out of the box; `WORKER_IMAGE_PATTERN_IDS` replaces
 * the list wholesale (an explicitly empty value means no pattern is
 * photo-worthy on its own).
 */
export const DEFAULT_IMAGE_PATTERN_IDS: readonly string[] = [
  "cozy_roleplay",
  "intimate_roleplay",
  "afterglow_and_wind_down",
  "initiate_roleplay",
  "flirtation_and_tension",
  "affection_and_closeness",
  "playful_banter",
  "holding_a_boundary",
];

export interface ImageConfig {
  readonly enabled: boolean;
  /** Base URL of the implementation service (`POST /v1/reconcile`). */
  readonly implementationUrl: string;
  /** Base URL of the image service (`POST /v1/render`). */
  readonly imageServiceUrl: string;
  /**
   * Opaque module-scope user id sent to both module services. It must match
   * the scope value the prompt-module registration uses, so reconciliation
   * advances the same schedule/clothing/roleplay state the chat turn read.
   */
  readonly userId: string;
  readonly patternIds: readonly string[];
  readonly timeoutMs: number;
  readonly pollMs: number;
  readonly maxAttempts: number;
}

const DISABLED: ImageConfig = {
  enabled: false,
  implementationUrl: "",
  imageServiceUrl: "",
  userId: "",
  patternIds: DEFAULT_IMAGE_PATTERN_IDS,
  timeoutMs: 180_000,
  pollMs: 5_000,
  maxAttempts: 3,
};

function optionalUrl(
  env: Record<string, string | undefined>,
  name: string,
): string | undefined {
  const raw = env[name];
  if (raw === undefined || raw.trim().length === 0) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    throw new ImageConfigError(`${name} is not a valid URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ImageConfigError(`${name} must be an http(s) URL`);
  }
  return raw.trim().replace(/\/+$/, "");
}

function optionalPositiveInt(
  env: Record<string, string | undefined>,
  name: string,
  fallback: number,
): number {
  const raw = env[name];
  if (raw === undefined || raw.trim().length === 0) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ImageConfigError(`${name} must be a positive integer`);
  }
  return value;
}

export function loadImageConfig(
  env: Record<string, string | undefined>,
): ImageConfig {
  const implementationUrl = optionalUrl(env, "WORKER_IMPLEMENTATION_SERVICE_URL");
  const imageServiceUrl = optionalUrl(env, "WORKER_IMAGE_SERVICE_URL");
  const userIdRaw = env.WORKER_IMAGE_USER_ID;
  const userId =
    userIdRaw === undefined || userIdRaw.trim().length === 0
      ? undefined
      : userIdRaw.trim();

  const supplied = [
    ["WORKER_IMPLEMENTATION_SERVICE_URL", implementationUrl],
    ["WORKER_IMAGE_SERVICE_URL", imageServiceUrl],
    ["WORKER_IMAGE_USER_ID", userId],
  ] as const;
  const anySupplied = supplied.some(([, value]) => value !== undefined);
  if (!anySupplied) return DISABLED;
  const missing = supplied
    .filter(([, value]) => value === undefined)
    .map(([name]) => name);
  if (missing.length > 0) {
    throw new ImageConfigError(
      `image generation is partially configured; missing: ${missing.join(", ")}`,
    );
  }

  let patternIds: readonly string[] = DEFAULT_IMAGE_PATTERN_IDS;
  const rawPatterns = env.WORKER_IMAGE_PATTERN_IDS;
  if (rawPatterns !== undefined) {
    patternIds = rawPatterns
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  }

  return {
    enabled: true,
    implementationUrl: implementationUrl!,
    imageServiceUrl: imageServiceUrl!,
    userId: userId!,
    patternIds,
    timeoutMs: optionalPositiveInt(env, "WORKER_IMAGE_TIMEOUT_MS", 180_000),
    pollMs: optionalPositiveInt(env, "WORKER_IMAGE_POLL_MS", 5_000),
    maxAttempts: optionalPositiveInt(env, "WORKER_IMAGE_MAX_ATTEMPTS", 3),
  };
}
