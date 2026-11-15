import { createHash } from "node:crypto";

export const EMBEDDING_MODEL = "nomic-embed-text-v1.5";
export const EMBEDDING_MODEL_REVISION = "e9b6763023c676ca8431644204f50c2b100d9aab";
export const EMBEDDING_CODE_REVISION = "7710840340a098cfb869c4f65e87cf2b1b70caca";
export const EMBEDDING_DIMENSIONS = 768;
export const EMBEDDING_INPUT_VERSION = "claim-condition-consequence-v1";
export const EMBEDDING_MAX_INPUTS = 8;
export const EMBEDDING_MAX_CHARS = 4096;
const NORMALIZATION_TOLERANCE = 0.015;

export type EmbeddingInputType = "query" | "document";
export type EmbeddingErrorCategory =
  | "embedding_timeout"
  | "embedding_transport"
  | "embedding_http_503"
  | "embedding_http_status"
  | "embedding_invalid_response";

export class EmbeddingRequestError extends Error {
  readonly category: EmbeddingErrorCategory;

  constructor(category: EmbeddingErrorCategory) {
    super(category);
    this.name = "EmbeddingRequestError";
    this.category = category;
  }
}

export interface EmbeddingClient {
  embed(texts: readonly string[], inputType: EmbeddingInputType): Promise<readonly (readonly number[])[]>;
  readonly busy: boolean;
}

/** Render the only memory fields represented by the vector, with a versioned, bounded input. */
export function renderEmbeddingInput(input: {
  readonly claim: string;
  readonly condition?: string | null;
  readonly consequence?: string | null;
}): string {
  const text = [
    input.claim,
    input.condition ? `Condition: ${input.condition}` : "",
    input.consequence ? `Consequence: ${input.consequence}` : "",
  ].filter(Boolean).join("\n").trim();
  return text.slice(0, EMBEDDING_MAX_CHARS);
}

export function embeddingContentHash(text: string): string {
  return createHash("sha256")
    .update(EMBEDDING_INPUT_VERSION)
    .update("\0")
    .update(text)
    .digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateVector(value: unknown): readonly number[] | undefined {
  if (!Array.isArray(value) || value.length !== EMBEDDING_DIMENSIONS) return undefined;
  let normSquared = 0;
  const vector: number[] = [];
  for (const coordinate of value) {
    if (typeof coordinate !== "number" || !Number.isFinite(coordinate)) return undefined;
    normSquared += coordinate * coordinate;
    vector.push(coordinate);
  }
  const norm = Math.sqrt(normSquared);
  if (!Number.isFinite(norm) || Math.abs(norm - 1) > NORMALIZATION_TOLERANCE) return undefined;
  return vector;
}

/**
 * A single-flight client is deliberate: the inference service serializes GPU work.
 * The caller decides whether busy shadow work is skipped or retried on the next sweep.
 */
export function createEmbeddingClient(input: {
  readonly baseUrl: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}): EmbeddingClient {
  const timeoutMs = input.timeoutMs ?? 15_000;
  const fetchImpl = input.fetchImpl ?? fetch;
  let busy = false;
  return {
    get busy() { return busy; },
    async embed(texts, inputType) {
      if (busy) throw new EmbeddingRequestError("embedding_transport");
      if (texts.length < 1 || texts.length > EMBEDDING_MAX_INPUTS ||
          texts.some((text) => !text.trim() || text.length > EMBEDDING_MAX_CHARS)) {
        throw new EmbeddingRequestError("embedding_invalid_response");
      }
      busy = true;
      try {
        let response: Response;
        try {
          response = await fetchImpl(`${input.baseUrl.replace(/\/$/, "")}/v1/embeddings`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              model: EMBEDDING_MODEL,
              input: [...texts],
              input_type: inputType,
            }),
            signal: AbortSignal.timeout(timeoutMs),
          });
        } catch (error) {
          if (error instanceof Error && error.name === "TimeoutError") {
            throw new EmbeddingRequestError("embedding_timeout");
          }
          throw new EmbeddingRequestError("embedding_transport");
        }
        if (response.status === 503) throw new EmbeddingRequestError("embedding_http_503");
        if (!response.ok) throw new EmbeddingRequestError("embedding_http_status");

        let body: unknown;
        try {
          body = await response.json();
        } catch (error) {
          if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
            throw new EmbeddingRequestError("embedding_timeout");
          }
          throw new EmbeddingRequestError("embedding_invalid_response");
        }
        if (!isRecord(body) || body["model"] !== EMBEDDING_MODEL || !Array.isArray(body["data"]) ||
            body["data"].length !== texts.length) {
          throw new EmbeddingRequestError("embedding_invalid_response");
        }
        const vectors: (readonly number[])[] = [];
        for (let index = 0; index < texts.length; index += 1) {
          const row: unknown = body["data"][index];
          if (!isRecord(row) || row["index"] !== index) {
            throw new EmbeddingRequestError("embedding_invalid_response");
          }
          const vector = validateVector(row["embedding"]);
          if (vector === undefined) throw new EmbeddingRequestError("embedding_invalid_response");
          vectors.push(vector);
        }
        return vectors;
      } finally {
        busy = false;
      }
    },
  };
}

export function vectorLiteral(vector: readonly number[]): string {
  if (vector.length !== EMBEDDING_DIMENSIONS || vector.some((value) => !Number.isFinite(value))) {
    throw new EmbeddingRequestError("embedding_invalid_response");
  }
  return `[${vector.join(",")}]`;
}
