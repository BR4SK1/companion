/**
 * Memory context rendering for the chat request.
 *
 * Builds the individual memory sections the turn processor sends as
 * separate synthetic system messages (one chunk each): the generated subject
 * profiles (stable, fingerprint-tagged), the recent temporal memories, and
 * the per-turn canonical recall results. Each section is synthetic — in the
 * chat trace it is recorded with a null message source and its chunk
 * classification, like the identity and guidance system messages. A section
 * that renders nothing contributes no chunk at all.
 */

import type { CanonicalRecallItem, ObservationProfile } from "./types.ts";

const MEMORY_MAX_CONTENT_LENGTH = 220;

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength - 3)}...`;
}

function sanitizeForXmlText(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function formatAgeShort(createdAt: Date, now: Date): string {
  const diffMs = Math.max(0, now.getTime() - createdAt.getTime());
  const minutes = Math.floor(diffMs / 60000);

  if (minutes < 60) {
    return `${String(Math.max(1, minutes))}m ago`;
  }

  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${String(hours)}h ago`;
  }

  const days = Math.floor(hours / 24);
  if (days < 30) {
    return `${String(days)}d ago`;
  }

  const months = Math.floor(days / 30);
  if (months < 12) {
    return `${String(months)}mo ago`;
  }

  const years = Math.floor(days / 365);
  return `${String(years)}y ago`;
}

function formatMemoryContent(content: string): string {
  const singleLine = content.replace(/\s+/g, " ").trim();
  return sanitizeForXmlText(truncate(singleLine, MEMORY_MAX_CONTENT_LENGTH));
}

export interface BuildCanonicalMemoryContextInput {
  readonly items: readonly CanonicalRecallItem[];
  readonly now?: Date;
}

/**
 * Render canonical recall results (production facts + active observations)
 * as context for the prompt.
 */
export function buildCanonicalMemoryContextForPrompt(
  input: BuildCanonicalMemoryContextInput,
): string | undefined {
  const now = input.now ?? new Date();
  const items = (input.items ?? []).filter(
    (item) => typeof item.claim === "string" && item.claim.trim().length > 0,
  );
  if (items.length === 0) {
    return undefined;
  }

  const renderedIds = new Set<string>();
  const factLines: string[] = [];
  for (const item of items) {
    if (renderedIds.has(item.id)) continue;
    renderedIds.add(item.id);
    const observedAt = new Date(item.observedAt);
    const age = Number.isNaN(observedAt.getTime())
      ? "unknown"
      : formatAgeShort(observedAt, now);
    const formatted = formatMemoryContent(item.claim);
    factLines.push(`- (${item.type}) [${age}] ${formatted}`);
  }

  return [
    "Use these memories as user-specific context. Reference them naturally when relevant — do not force them into conversation.",
    "Relevant facts:",
    ...factLines,
  ].join("\n");
}

export interface ProfileSectionInput {
  readonly profile: ObservationProfile;
}

/**
 * One subject's observation profile as a fingerprint-tagged XML block. The
 * tag name is the configured subject id; no subject name is code content.
 */
export function renderProfileSection(
  input: ProfileSectionInput | undefined | null,
): string | undefined {
  if (input === undefined || input === null) return undefined;
  if (input.profile.sourceCount === 0) return undefined;
  const content = sanitizeForXmlText(input.profile.content);
  return [
    `<${input.profile.subject} profile_fingerprint="${escapeXmlAttribute(input.profile.fingerprint)}">`,
    content,
    `</${input.profile.subject}>`,
  ].join("\n");
}

function escapeXmlAttribute(text: string): string {
  return text.replace(/"/g, "&quot;");
}

export const __internal = {
  formatAgeShort,
  formatMemoryContent,
  sanitizeForXmlText,
};
