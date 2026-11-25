import type { RelationshipTier } from "../relationship/types.ts";
import type { ImageClothingSnapshot } from "./types.ts";

/** The allowed ordinary photo class and the maximum offline album size. */
export type PhotoAccess = 0 | 1 | 3;

export function photoAccessForTier(
  tier: RelationshipTier,
  tiers: readonly RelationshipTier[],
  outfitTierKey: string | null,
  sequenceTierKey: string | null,
): PhotoAccess {
  const outfit = tiers.find((entry) => entry.key === outfitTierKey);
  if (
    outfit === undefined ||
    outfit === tiers[0] ||
    tier.position < outfit.position
  )
    return 0;
  const sequence = tiers.find((entry) => entry.key === sequenceTierKey);
  return sequence !== undefined &&
    sequence.position > outfit.position &&
    tier.position >= sequence.position
    ? 3
    : 1;
}

export function isFullyDressed(
  clothing: ImageClothingSnapshot | null,
): boolean {
  return (
    clothing !== null &&
    (clothing.occasion === "daytime" || clothing.occasion === "pajamas") &&
    clothing.items.every((item) => item.state === "on") &&
    clothing.items.some((item) => item.slot === "top") &&
    clothing.items.some((item) => item.slot === "bottom")
  );
}
