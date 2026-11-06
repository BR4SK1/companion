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
 * Per-item attribution tag: whose the memory is and where it came from.
 * User-role conversation memories render untagged (the default case); every
 * other combination is marked explicitly so an assistant-attributed memory
 * — a recorded article reaction, or an interest consolidated from them — can
 * never be presented as user-specific context.
 */
function attributionTag(item: CanonicalRecallItem): string {
  const parts: string[] = [];
  if (item.subjectRole === "assistant") {
    parts.push("the assistant's own");
  } else if (item.subjectRole === "relationship") {
    parts.push("about the user-assistant relationship");
  }
  if (item.sourceType === "article") {
    parts.push("from an article");
  }
  return parts.length > 0 ? ` [${parts.join(", ")}]` : "";
}

/** Header for the all-user conversation-memory case (the legacy shape). */
const USER_CONTEXT_HEADER =
  "Use these memories as user-specific context. Reference them naturally when relevant — do not force them into conversation.";

/**
 * Header whenever any item carries non-default attribution: it names the
 * attribution tags and states what assistant-attributed and article-sourced
 * items are — and are not — so an assistant reaction or interest is never
 * presented as a user memory, user preference, verified claim, full-article
 * reading, or biography.
 */
const ATTRIBUTED_CONTEXT_HEADER =
  "Use these memories as background context. Each item is tagged with whose it is and where it came from: an item marked as the assistant's own is the assistant's recorded reaction or interest — never present it as the user's memory, preference, or biography, and an item marked as from an article reflects a noted reaction to that article, not a verified claim or the full article. Reference them naturally when relevant — do not force them into conversation.";

/**
 * Render canonical recall results (production facts + active observations)
 * as context for the prompt. Attribution is honest per item: the header
 * stays the plain user-specific-context form only when every rendered item
 * is a user-role, conversation-sourced memory; any assistant-attributed or
 * article-sourced item switches the header to the attributed form above.
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
  let needsAttribution = false;
  for (const item of items) {
    if (renderedIds.has(item.id)) continue;
    renderedIds.add(item.id);
    const tag = attributionTag(item);
    if (tag.length > 0) needsAttribution = true;
    const observedAt = new Date(item.observedAt);
    const age = Number.isNaN(observedAt.getTime())
      ? "unknown"
      : formatAgeShort(observedAt, now);
    const formatted = formatMemoryContent(item.claim);
    factLines.push(`- (${item.type})${tag} [${age}] ${formatted}`);
  }

  return [
    needsAttribution ? ATTRIBUTED_CONTEXT_HEADER : USER_CONTEXT_HEADER,
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
