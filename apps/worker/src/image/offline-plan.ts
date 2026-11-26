import { isFullyDressed } from "./photo-access.ts";
import type { ImageClothingSnapshot, ImageClothingItem } from "./types.ts";

export interface OfflineShot {
  readonly position: number;
  readonly rank: number;
  readonly kind: "outfit" | "sequence";
  readonly localDateTime: string;
  readonly schedule: {
    readonly location: "bedroom";
    readonly block: "morning";
  };
  readonly clothing: ImageClothingSnapshot;
  readonly hints: {
    readonly poseVariantId: string;
    readonly poseCategory: string;
    readonly expression: string;
    readonly handGesture: string;
    readonly cameraAngle: string;
    readonly includeSelfieFraming: boolean;
    readonly fullBody?: boolean;
    readonly framing?: "cowboy" | "feet_out";
    readonly removingBottoms?: boolean;
  };
  readonly seed: number;
}

/** The morning-change recipe fixes stage positions and randomizes only rank. */
export function offlineShotAccess(shot: OfflineShot): 1 | 2 | 3 {
  if (shot.kind === "outfit") return 1;
  if (shot.position === 1 || shot.position === 2) return 3;
  const items = shot.clothing.items;
  const coveredBelow = items.some((item) =>
    (item.slot === "bottom" || item.slot === "underwear") && item.state === "on"
  );
  const expectedTop = shot.position === 0 ? "undressing_top" :
    shot.position === 3 ? "dressing_top" : "on";
  return coveredBelow && items.some((item) => item.slot === "top" && item.state === expectedTop)
    ? 2 : 3;
}

export interface OfflinePhotoEvent {
  readonly id: string;
  readonly startedAt: string;
  readonly returnAt: string;
  readonly completedAt: string | null;
  readonly publishBy: string;
  readonly shots: readonly OfflineShot[];
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function isInstant(input: unknown): input is string {
  return (
    typeof input === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(input) &&
    Number.isFinite(Date.parse(input))
  );
}

function parseShot(raw: unknown): OfflineShot | null {
  if (
    !isRecord(raw) ||
    typeof raw.position !== "number" ||
    typeof raw.rank !== "number" ||
    !Number.isInteger(raw.position) ||
    !Number.isInteger(raw.rank) ||
    raw.position < 0 ||
    raw.position > 5 ||
    raw.rank < 0 ||
    raw.rank > 5 ||
    (raw.kind !== "outfit" && raw.kind !== "sequence") ||
    !isInstant(raw.localDateTime) ||
    typeof raw.seed !== "number" ||
    !Number.isSafeInteger(raw.seed) ||
    raw.seed < 0 ||
    !isRecord(raw.schedule) ||
    raw.schedule.location !== "bedroom" ||
    raw.schedule.block !== "morning" ||
    !isRecord(raw.clothing) ||
    typeof raw.clothing.occasion !== "string" ||
    !Array.isArray(raw.clothing.items) ||
    raw.clothing.items.length > 8 ||
    !isRecord(raw.hints)
  )
    return null;
  if (
    raw.kind === "outfit"
      ? raw.position !== 5 || raw.rank !== 0
      : raw.position === 5 || raw.rank === 0
  ) {
    return null;
  }
  const items: ImageClothingItem[] = [];
  for (const item of raw.clothing.items) {
    if (
      !isRecord(item) ||
      typeof item.itemId !== "string" ||
      typeof item.slot !== "string" ||
      typeof item.category !== "string" ||
      typeof item.tags !== "string" ||
      typeof item.state !== "string"
    ) {
      return null;
    }
    items.push({
      itemId: item.itemId,
      slot: item.slot,
      category: item.category,
      tags: item.tags,
      state: item.state,
    });
  }
  const clothing = { occasion: raw.clothing.occasion, items };
  const {
    poseVariantId,
    poseCategory,
    expression,
    handGesture,
    cameraAngle,
    includeSelfieFraming,
    fullBody,
    framing,
    removingBottoms,
  } = raw.hints;
  if (
    typeof poseVariantId !== "string" ||
    typeof poseCategory !== "string" ||
    typeof expression !== "string" ||
    typeof handGesture !== "string" ||
    typeof cameraAngle !== "string" ||
    typeof includeSelfieFraming !== "boolean" ||
    (fullBody !== true && framing !== "cowboy" && framing !== "feet_out")
  )
    return null;
  if (
    raw.kind === "outfit" &&
    (clothing.occasion !== "daytime" ||
      !isFullyDressed(clothing) ||
      poseCategory !== "standing" ||
      !["bed_standing_contrapposto", "bed_standing_crossed_ankles"].includes(
        poseVariantId,
      ) ||
      !["relaxed", "amused"].includes(expression) ||
      !["arm_behind_head", "hand_on_hip"].includes(handGesture) ||
      cameraAngle !== "straight_on" ||
      includeSelfieFraming ||
      removingBottoms === true)
  )
    return null;
  return {
    position: raw.position,
    rank: raw.rank,
    kind: raw.kind,
    localDateTime: raw.localDateTime,
    schedule: { location: "bedroom", block: "morning" },
    clothing,
    hints: {
      poseVariantId,
      poseCategory,
      expression,
      handGesture,
      cameraAngle,
      includeSelfieFraming,
      ...(fullBody === true ? { fullBody } : {}),
      ...(framing === "cowboy" || framing === "feet_out" ? { framing } : {}),
      ...(raw.kind === "sequence" && removingBottoms === true
        ? { removingBottoms }
        : {}),
    },
    seed: raw.seed,
  };
}

export function parseOfflinePhotoEvent(raw: unknown): OfflinePhotoEvent | null {
  if (
    !isRecord(raw) ||
    typeof raw.id !== "string" ||
    !/^morning-change:\d{4}-\d{2}-\d{2}$/.test(raw.id) ||
    !isInstant(raw.startedAt) ||
    !isInstant(raw.returnAt) ||
    !isInstant(raw.publishBy) ||
    (raw.completedAt !== null && !isInstant(raw.completedAt)) ||
    !Array.isArray(raw.shots)
  )
    return null;
  const start = Date.parse(raw.startedAt);
  const end = Date.parse(raw.returnAt);
  const expiry = Date.parse(raw.publishBy);
  if (start >= end || end >= expiry || expiry - end > 5 * 60_000) return null;
  const shots: OfflineShot[] = [];
  if (raw.completedAt === null) {
    if (raw.shots.length < 1 || raw.shots.length > 6) return null;
    for (const entry of raw.shots) {
      const shot = parseShot(entry);
      if (
        shot === null ||
        Date.parse(shot.localDateTime) < start ||
        Date.parse(shot.localDateTime) >= end
      )
        return null;
      shots.push(shot);
    }
    if (
      !shots.some((shot) => shot.kind === "outfit") ||
      new Set(shots.map((shot) => shot.position)).size !== shots.length ||
      new Set(shots.map((shot) => shot.rank)).size !== shots.length
    )
      return null;
  } else if (raw.shots.length !== 0 || Date.parse(raw.completedAt) < end) {
    return null;
  }
  return {
    id: raw.id,
    startedAt: raw.startedAt,
    returnAt: raw.returnAt,
    completedAt: raw.completedAt,
    publishBy: raw.publishBy,
    shots,
  };
}
