/**
 * Dynamic initiative prompt assembly.
 *
 * When the response-pattern decision selects a pattern marked with
 * `includeInitiativeContext`, this builds one concrete, compact prompt block
 * combining the pattern's configured guidance cue, an eligible article &
 * reaction (when available), and a small curated set of questions (3–4 max).
 */

import type { ArticleMemoryCandidate } from "../articles/types.ts";
import type { SelectedInitiativeQuestion } from "../relationship/types.ts";

const MAX_INITIATIVE_REACTION_CHARS = 600;

function formatAgeShort(generatedAt: Date, now: Date): string {
  const diffMs = Math.max(0, now.getTime() - generatedAt.getTime());
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return `${String(Math.max(1, minutes))}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${String(hours)}h ago`;
  const days = Math.floor(hours / 24);
  return `${String(days)}d ago`;
}

function truncateAtWordBoundary(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  const budget = Math.max(1, maxLength - 3);
  const slice = text.slice(0, budget);
  const lastSpace = slice.lastIndexOf(" ");
  const cut = lastSpace >= Math.floor(budget * 0.5) ? slice.slice(0, lastSpace) : slice;
  return `${cut.trimEnd()}...`;
}

function formatQuestionLine(question: SelectedInitiativeQuestion): string {
  if (question.reason === "clarification" && question.priorAnswer !== undefined) {
    return `- ${question.questionText} (unclear earlier: "${question.priorAnswer}" — clarify naturally if it fits)`;
  }
  if (question.reason === "revisit" && question.priorAnswer !== undefined) {
    const age = question.priorAnswerAgeDays !== undefined
      ? ` ${String(question.priorAnswerAgeDays)}d ago`
      : " earlier";
    return `- ${question.questionText} (answered${age} as "${question.priorAnswer}" — check if this is still true)`;
  }
  return `- ${question.questionText}`;
}

export function buildDynamicInitiativePrompt(input: {
  readonly guidance: string;
  readonly article: ArticleMemoryCandidate | null;
  readonly questions: readonly SelectedInitiativeQuestion[];
  readonly now?: Date;
}): string | null {
  const now = input.now ?? new Date();
  const blocks: string[] = [];
  const trimmedGuidance = input.guidance.trim();
  if (trimmedGuidance.length > 0) {
    blocks.push(trimmedGuidance);
  }

  if (input.article !== null) {
    const generatedAt = new Date(input.article.generatedAt);
    const age = Number.isNaN(generatedAt.getTime())
      ? "recently"
      : formatAgeShort(generatedAt, now);
    const reaction = truncateAtWordBoundary(
      input.article.reaction.replace(/\s+/g, " ").trim(),
      MAX_INITIATIVE_REACTION_CHARS,
    );
    blocks.push(
      [
        `You recently read an article about "${input.article.title}" (${input.article.url}) [read ${age}], and this is how you felt about it:`,
        reaction,
      ].join("\n"),
    );
  }

  if (input.questions.length > 0) {
    blocks.push(
      [
        "You have also been curious about the following topics:",
        ...input.questions.map(formatQuestionLine),
      ].join("\n"),
    );
  }

  if (input.article !== null && input.questions.length > 0) {
    blocks.push(
      `Ask one of these questions or bring up "${input.article.title}" naturally to keep the conversation going.`,
    );
  } else if (input.article !== null) {
    blocks.push(
      `Bring up "${input.article.title}" naturally if it fits to keep the conversation going.`,
    );
  } else if (input.questions.length > 0) {
    blocks.push("Ask one of these questions naturally to keep the conversation going.");
  }

  return blocks.length > 0 ? blocks.join("\n\n") : null;
}
