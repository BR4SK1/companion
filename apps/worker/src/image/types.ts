/**
 * Image-generation domain types, owned by this domain (hosted by the worker
 * deployable). The domain calls two external module services over HTTP: the
 * implementation service (post-reply reconciliation snapshots) and the image
 * service (translation + ComfyUI rendering). No module-service vocabulary
 * leaks into other domains; the snapshot shapes below are this domain's
 * typed copy of the module contracts it consumes.
 */

export interface ImageScheduleSnapshot {
  readonly date: string;
  readonly block: string;
  readonly location: string;
  readonly surface: string;
  readonly activity: string;
  readonly balconyDay: boolean;
}

export interface ImageClothingItem {
  readonly itemId?: string;
  readonly slot: string;
  readonly category?: string;
  readonly tags: string;
  readonly state: string;
}

export interface ImageClothingSnapshot {
  readonly occasion?: string;
  readonly items: readonly ImageClothingItem[];
  readonly plannedOccasion?: string;
}

export interface ImageRoleplaySnapshot {
  readonly inScene: boolean;
  readonly chapter: string | null;
  readonly activity: string | null;
  readonly pacing?: string | null;
  readonly userClimaxThisTurn?: boolean;
  readonly companionClimaxThisTurn?: boolean;
  readonly climaxRecent?: boolean;
  readonly turnsInChapter?: number;
  readonly beatSummary?: string;
}

export interface ReconciledSnapshot {
  readonly schedule: ImageScheduleSnapshot;
  readonly clothing: ImageClothingSnapshot | null;
  readonly roleplay: ImageRoleplaySnapshot | null;
}

export interface PriorPose {
  readonly poseVariantId?: string;
  readonly poseCategory?: string;
  readonly handGesture?: string;
  readonly cameraAngle?: string;
  readonly expression?: string;
}

/** Plan fields persisted on the job for traceability and pose continuity. */
export interface ImagePlanSummary {
  readonly location: string | null;
  readonly timePeriod: string | null;
  readonly poseCategory: string | null;
  readonly poseVariantId: string | null;
  readonly expression: string | null;
  readonly handGesture: string | null;
  readonly cameraAngle: string | null;
  readonly intimacy: string | null;
  readonly clothingSummary: string | null;
}

export interface RenderedImage {
  readonly filename: string;
  readonly mimeType: string;
  readonly width: number;
  readonly height: number;
  readonly data: Buffer;
}

export type ImageJobStatus =
  | "pending"
  | "running"
  | "rendered"
  | "succeeded"
  | "skipped"
  | "failed";

export interface ImageJob {
  readonly id: string;
  readonly turnId: string;
  readonly status: ImageJobStatus;
  readonly attempts: number;
  readonly patternId: string | null;
  readonly userText: string;
  readonly companionResponse: string;
  readonly localDateTime: string;
  readonly promptId: string | null;
  readonly plan: ImagePlanSummary;
  readonly errorCategory: string | null;
  readonly messageId: string | null;
  readonly createdAt: string;
}

/** One stored image asset, as attached to a thread message for reads. */
export interface MessageImageRef {
  readonly id: string;
  readonly mimeType: string;
  readonly width: number;
  readonly height: number;
  readonly alt: string;
}

/** Content marker of the standalone assistant message carrying an image. */
export const IMAGE_MESSAGE_MARKER = "*sends a picture*";

const IMAGE_ACTION_MARKER_PATTERN =
  /\*\s*(?:sends|takes|snaps)\s+(?:a\s+)?(?:picture|photo|selfie)\s*\*/gi;

/**
 * Strip standalone or inline `*sends a picture*` / `*takes picture*` action
 * markers from assistant message text while preserving surrounding paragraph
 * structure and normal roleplay actions.
 */
export function stripImageActionMarkers(text: string): string {
  if (!text.includes("*")) return text;
  const cleanedLines = text
    .split("\n")
    .map((line) => {
      const hadMarker = IMAGE_ACTION_MARKER_PATTERN.test(line);
      IMAGE_ACTION_MARKER_PATTERN.lastIndex = 0;
      if (!hadMarker) return line;
      return line
        .replace(IMAGE_ACTION_MARKER_PATTERN, "")
        .replace(/[ \t]{2,}/g, " ")
        .trim();
    });
  return cleanedLines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
