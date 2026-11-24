/**
 * Prompt-context rendering for recently sent photos in the current session.
 *
 * Keeps image feedback in a dedicated synthetic `system` chunk immediately
 * before `conversation` so the chat history remains strictly alternating
 * user/assistant turns without synthetic assistant messages or `*sends a
 * picture*` markers that the model might imitate in prose.
 */

import type { ImagePlanSummary, RecentSentImage } from "./types.ts";

/**
 * Fallback description built from persisted `plan_*` columns when an older
 * image job or image-service deployment did not supply `sceneDescription`.
 */
export function fallbackSceneDescription(plan: ImagePlanSummary): string | null {
  const details: string[] = [];
  if (plan.poseCategory !== null && plan.poseCategory.length > 0) {
    details.push(plan.poseCategory);
  }
  if (plan.location !== null && plan.location.length > 0) {
    details.push(`in the ${plan.location}`);
  }
  if (plan.timePeriod !== null && plan.timePeriod.length > 0) {
    details.push(`during ${plan.timePeriod}`);
  }
  const sentences: string[] = [];
  if (details.length > 0) {
    sentences.push(`You were ${details.join(" ")}.`);
  }
  if (plan.clothingSummary !== null && plan.clothingSummary.length > 0) {
    if (plan.clothingSummary.trim().toLowerCase() === "completely naked") {
      sentences.push("You were completely naked.");
    } else {
      sentences.push(`Outfit: ${plan.clothingSummary}.`);
    }
  }
  if (plan.expression !== null && plan.expression.length > 0) {
    sentences.push(`Expression: ${plan.expression.replace(/_/g, " ")}.`);
  }
  return sentences.length > 0 ? sentences.join(" ") : null;
}

function formatRelativeAge(publishedAt: string, now: Date): string {
  const publishedMs = Date.parse(publishedAt);
  if (!Number.isFinite(publishedMs)) return "recently";
  const elapsedSeconds = Math.max(0, Math.floor((now.getTime() - publishedMs) / 1000));
  if (elapsedSeconds < 60) return "just now";
  const minutes = Math.floor(elapsedSeconds / 60);
  if (minutes === 1) return "1 minute ago";
  if (minutes < 60) return `${String(minutes)} minutes ago`;
  const hours = Math.floor(minutes / 60);
  if (hours === 1) return "1 hour ago";
  if (hours < 24) return `${String(hours)} hours ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "1 day ago" : `${String(days)} days ago`;
}

/**
 * Render the session-scoped `image` system chunk from recently delivered
 * photos (oldest first). Returns null when no photos were sent in the
 * current session so photo-free chats pay zero token overhead.
 */
export function renderRecentImagesContext(input: {
  readonly images: readonly RecentSentImage[];
  readonly now: Date;
  readonly lastAssistantTurnId: string | null;
}): string | null {
  if (input.images.length === 0) return null;
  const lastIndex = input.images.length - 1;
  const lines = input.images.map((image, index) => {
    const isNewest = index === lastIndex;
    const age = formatRelativeAge(image.publishedAt, input.now);
    const sentRightAfterLastReply =
      isNewest &&
      (image.afterLastHistory ||
        (input.lastAssistantTurnId !== null &&
          image.turnId === input.lastAssistantTurnId));
    const timing = sentRightAfterLastReply
      ? age === "just now"
        ? "sent right after your last reply, just now"
        : `sent right after your last reply, ${age}`
      : age === "just now"
        ? "sent just now"
        : `sent ${age}`;
    const label = isNewest ? "Most recent photo" : "Earlier photo";
    return `- ${label} (${timing}): ${image.sceneDescription}`;
  });
  return [
    "Authoritative record of photos already sent to the user in this conversation (photos are delivered separately by the system; never write photo-sending tags like *sends a picture* yourself):",
    ...lines,
  ].join("\n");
}
