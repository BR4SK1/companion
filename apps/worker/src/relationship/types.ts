/** Domain-owned types for generic, database-configured relationship familiarity. */

import type { BehaviorTime } from "../memory/time.ts";

export type RelationshipParticipant = "user" | "assistant";

export interface RelationshipTier {
  readonly id: string;
  readonly key: string;
  readonly position: number;
  readonly minimumFamiliarity: number;
  readonly label: string;
  readonly prompt: string;
  readonly behavioralGuidance: string;
}

export interface RelationshipQuestion {
  readonly id: string;
  readonly key: string;
  readonly typeKey: string;
  readonly typeGuidance: string;
  readonly tierId: string;
  readonly tierPosition: number;
  readonly text: string;
  readonly position: number;
}

export interface RelationshipConfiguration {
  readonly relationshipType: string;
  readonly behaviorTime: BehaviorTime;
  readonly tierMovement: {
    readonly enabled: boolean;
    readonly upMinDays: number | null;
    readonly upMinActiveStreak: number | null;
    readonly downMissedStreak: number | null;
  };
  readonly answerExtractionPrompt: string;
  readonly clarificationGuidance: string;
  readonly tiers: readonly RelationshipTier[];
  readonly questions: readonly RelationshipQuestion[];
}

export interface RelationshipAnswer {
  readonly questionId: string;
  readonly questionKey: string;
  readonly questionText: string;
  readonly participant: RelationshipParticipant;
  readonly answer: string;
  readonly clarificationNeeded: boolean;
}

export interface RelationshipSummary {
  readonly relationshipType: string;
  readonly clarificationGuidance: string;
  readonly firstConversationDate: string | null;
  readonly timeKnownDays: number;
  readonly activeDayStreak: number;
  readonly missedDayStreak: number;
  readonly answeredSlots: number;
  readonly userAnsweredSlots: number;
  readonly assistantAnsweredSlots: number;
  readonly eligibleSlots: number;
  readonly eligibleSlotsPerParticipant: number;
  readonly familiarity: number;
  readonly baseTier: RelationshipTier;
  readonly effectiveTier: RelationshipTier;
  readonly tierMovement: "up" | "down" | "locked";
  readonly answers: readonly RelationshipAnswer[];
}

export interface RelationshipExtractionItem {
  readonly questionKey: string;
  readonly participant: RelationshipParticipant;
  readonly answer: string;
  readonly clarificationNeeded: boolean;
}
