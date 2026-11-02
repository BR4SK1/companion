/**
 * Stable hashing and identity helpers for the memory domain.
 *
 * All identities (fact keys, observation keys, canonical identities, promotion
 * and history ids, fingerprints) are content-derived hashes so retries and
 * replays are idempotent without mutable counters.
 */

import { createHash } from "node:crypto";

/** Deterministic stringify: object keys sorted, dates as ISO markers. */
function stableValue(value: unknown): unknown {
  if (value instanceof Date) return { $date: value.toISOString() };
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(object)
        .sort()
        .map((key) => [key, stableValue(object[key])]),
    );
  }
  return value;
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

/** NUL-delimited multi-part hash with a readable prefix. */
export function hashArtifact(prefix: string, ...parts: string[]): string {
  const hash = createHash("sha256");
  hash.update(prefix);
  for (const part of parts) {
    hash.update("\u0000");
    hash.update(part);
  }
  return `${prefix}-${hash.digest("hex").slice(0, 32)}`;
}

export function hashPayload(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function canonicalHash(prefix: string, value: unknown): string {
  return `${prefix}-${createHash("sha256").update(stableStringify(value)).digest("hex").slice(0, 32)}`;
}
