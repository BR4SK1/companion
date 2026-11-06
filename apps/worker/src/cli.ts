/**
 * Read-only trace report CLI.
 *
 * Assembles a human-readable (or machine-readable JSON) report of a turn's
 * full recorded trace: every attempt, its snapshot of the mutable pattern
 * configuration and the exact ordered context it saw, the native decision
 * boundary values (choice, optional probabilities/confidence) for every
 * recorded decision question — the response-pattern decision and, when
 * asked, the per-turn article-memory share decision, whose action is
 * annotated as prompt inclusion only, never a share claim — and the chat
 * boundary (request messages, response choices, usage).
 *
 * The CLI only ever reads; it never writes. It requires no provider
 * credentials: the worker's database URL is the only configuration it needs.
 */

import { pathToFileURL } from "node:url";

import {
  closePostgresPool,
  createPostgresPool,
} from "@companion/postgres";

import { createConversationStore } from "./conversation/store.ts";
import { ARTICLE_SHARE_QUESTION_ID } from "./articles/share.ts";
import type {
  TraceChat,
  TraceDecision,
  TurnAttemptTrace,
  TurnTraceReport,
} from "./conversation/types.ts";

export function printUsage(): void {
  console.log("Usage: node src/cli.ts <turnId> [--json]");
  console.log("");
  console.log("Reads a turn's full trace report (all attempts, boundaries, snapshots).");
  console.log("Requires WORKER_DATABASE_URL in the environment.");
}

export function renderDecision(decision: TraceDecision): readonly string[] {
  const lines: string[] = [];
  lines.push(`  decision (${decision.questionType}, question ${decision.questionId}):`);
  lines.push(`    state: ${decision.state ?? "(not recorded)"}`);
  lines.push(`    request model: ${decision.requestModel}`);
  lines.push(`    instructions: ${decision.instructions}`);
  lines.push(`    choice: ${decision.choice ?? "(none returned)"}`);
  if (decision.confidence !== null) {
    lines.push(`    confidence: ${decision.confidence}`);
  } else {
    lines.push("    confidence: (not returned)");
  }
  if (decision.probabilities.length > 0) {
    lines.push("    probabilities:");
    for (const probability of decision.probabilities) {
      lines.push(`      ${probability.optionId}: ${probability.value}`);
    }
  } else if (decision.probabilitiesPresent) {
    lines.push("    probabilities: (empty distribution returned)");
  } else {
    lines.push("    probabilities: (none returned)");
  }
  if (decision.selection !== null) {
    lines.push(`    selection: ${decision.selection}`);
    if (decision.rejectionReason !== null) {
      lines.push(`    rejection reason: ${JSON.stringify(decision.rejectionReason)}`);
    }
  } else {
    lines.push("    selection: (not recorded)");
  }
  lines.push(`    response model: ${decision.responseModel ?? "(n/a)"}`);
  if (decision.responseProvider !== null) {
    lines.push(`    response provider: ${decision.responseProvider}`);
  }
  if (decision.responseId !== null) {
    lines.push(`    response id: ${decision.responseId}`);
  }
  if (decision.errorKind !== null) {
    lines.push(`    error kind: ${decision.errorKind}`);
    lines.push(`    error message: ${JSON.stringify(decision.errorMessage)}`);
    if (decision.errorBody !== null) {
      lines.push(`    error body: ${JSON.stringify(decision.errorBody)}`);
    }
  }
  lines.push(
    `    usage: input ${decision.usageInputTokens ?? "(n/a)"}, output ${decision.usageOutputTokens ?? "(n/a)"}, cost ${decision.usageCost ?? "(n/a)"}`,
  );
  lines.push(`    recorded at: ${decision.recordedAt}`);
  return lines;
}

export function renderChat(chat: TraceChat): readonly string[] {
  const lines: string[] = [];
  lines.push(`  chat:`);
  lines.push(`    state: ${chat.state ?? "(not recorded)"}`);
  lines.push(`    request model: ${chat.requestModel}`);
  if (chat.temperature !== null) {
    lines.push(`    temperature: ${chat.temperature}`);
  } else {
    lines.push("    temperature: (not set)");
  }
  if (chat.maxTokens !== null) {
    lines.push(`    max_tokens: ${chat.maxTokens}`);
  } else {
    lines.push("    max_tokens: (not set)");
  }
  if (chat.identityRevision !== null) {
    lines.push(`    identity revision: ${String(chat.identityRevision)}`);
  } else {
    lines.push("    identity revision: (not recorded)");
  }
  lines.push("    messages sent:");
  for (const message of chat.messages) {
    const source =
      message.sourceMessageId !== null
        ? ` [message ${message.sourceMessageId}]`
        : message.chunk !== null
          ? ` (synthetic ${message.chunk})`
          : " (synthetic, unclassified)";
    lines.push(
      `      ${String(message.position)}: ${message.role}: ${JSON.stringify(message.content)}${source}`,
    );
  }
  lines.push("    choices returned:");
  for (const choice of chat.choices) {
    lines.push(
      `      ${String(choice.position)}: finish_reason ${choice.finishReason ?? "(n/a)"}: ${JSON.stringify(choice.content)}`,
    );
  }
  if (chat.replyContent !== null) {
    lines.push(`    generated reply: ${JSON.stringify(chat.replyContent)}`);
  } else {
    lines.push("    generated reply: (none — response unusable or not returned)");
  }
  if (chat.applicationRejection !== null) {
    lines.push(
      `    application rejection: ${JSON.stringify(chat.applicationRejection)}`,
    );
  }
  lines.push(`    response id: ${chat.responseId ?? "(n/a)"}`);
  lines.push(`    response model: ${chat.responseModel ?? "(n/a)"}`);
  if (chat.errorKind !== null) {
    lines.push(`    error kind: ${chat.errorKind}`);
    lines.push(`    error message: ${JSON.stringify(chat.errorMessage)}`);
    if (chat.errorBody !== null) {
      lines.push(`    error body: ${JSON.stringify(chat.errorBody)}`);
    }
  }
  lines.push(
    `    usage: prompt ${chat.usagePromptTokens ?? "(n/a)"}, completion ${chat.usageCompletionTokens ?? "(n/a)"}, total ${chat.usageTotalTokens ?? "(n/a)"}`,
  );
  lines.push(`    recorded at: ${chat.recordedAt}`);
  return lines;
}

/**
 * Question-aware annotation appended after a decision's boundary block. Only
 * the article-memory share question carries one: that decision row records
 * the context-inclusion choice (which candidate, or the permanent none
 * option), so the annotation states what the row means and cross-references
 * the recorded chat request for the actual inclusion evidence. It records
 * prompt inclusion only — it never claims an included memory was shared.
 */
export function renderDecisionAnnotation(
  decision: TraceDecision,
  chat: TraceChat | null,
): readonly string[] {
  if (decision.questionId !== ARTICLE_SHARE_QUESTION_ID) {
    return [];
  }
  const lines: string[] = [];
  lines.push(
    "    article action: context-inclusion decision — prompt inclusion only, never a share claim",
  );
  if (chat === null) {
    lines.push(
      "    article context in the sent chat request: (chat not recorded)",
    );
  } else {
    const present = chat.messages.some((message) => message.chunk === "article");
    lines.push(
      `    article context in the sent chat request: ${present ? "present" : "absent"}`,
    );
  }
  return lines;
}

export function renderAttempt(attempt: TurnAttemptTrace): readonly string[] {
  const lines: string[] = [];
  const outcome = attempt.outcome ?? "in flight (never finalized)";
  const snapshot = attempt.snapshotRecordedAt ?? "(not recorded)";
  lines.push(`attempt ${attempt.attempt} [${attempt.id}]`);
  lines.push(`  lease owner: ${attempt.leaseOwner}`);
  lines.push(`  claimed: ${attempt.claimedAt}`);
  lines.push(`  finished: ${attempt.finishedAt ?? "(not finished)"}`);
  lines.push(`  outcome: ${outcome}`);
  lines.push(`  snapshot recorded: ${snapshot}`);
  lines.push(
    `  context snapshot (${attempt.context.length} message(s), in order):`,
  );
  if (attempt.context.length === 0) {
    lines.push("    (empty — no prior context, no grouped messages)");
  }
  for (const message of attempt.context) {
    const origin = message.fromTurn ? "turn" : "prior";
    lines.push(
      `      ${String(message.position)}: seq ${String(message.seq)} ${message.role} [${origin}]: ${JSON.stringify(message.content)}`,
    );
  }
  lines.push(`  pattern snapshot (${attempt.patterns.length} pattern(s)):`);
  if (attempt.patterns.length === 0) {
    lines.push("    (none offered)");
  }
  for (const pattern of attempt.patterns) {
    lines.push(`      ${String(pattern.position)}: ${pattern.patternId}`);
    lines.push(`        selection: ${JSON.stringify(pattern.selectionDescription)}`);
    lines.push(`        guidance: ${JSON.stringify(pattern.responseGuidance)}`);
  }
  // Every recorded decision question, in question-id order, each with its
  // own boundary and selection outcome. The store always populates
  // `decisions`; the legacy single-`decision` fallback keeps reports (and
  // hand-built fixtures) from before that field rendering exactly as before.
  const decisions = attempt.decisions ?? (attempt.decision !== null ? [attempt.decision] : []);
  if (decisions.length > 1) {
    lines.push(`  decisions (${String(decisions.length)} recorded questions):`);
  }
  if (decisions.length > 0) {
    for (const decision of decisions) {
      lines.push(...renderDecision(decision));
      lines.push(...renderDecisionAnnotation(decision, attempt.chat));
    }
  } else {
    lines.push("  decision: (not recorded)");
  }
  if (attempt.chat !== null) {
    lines.push(...renderChat(attempt.chat));
  } else {
    lines.push("  chat: (not recorded)");
  }
  return lines;
}

export function renderReport(report: TurnTraceReport): string {
  const lines: string[] = [];
  lines.push(`Turn ${report.turn.id}`);
  lines.push(`  status: ${report.turn.status}`);
  lines.push(`  current attempt: ${String(report.turn.attempt)}`);
  lines.push(`  selected pattern: ${report.turn.selectedPatternId ?? "(none)"}`);
  if (report.turn.status === "completed") {
    lines.push("  reply published: yes");
  } else {
    lines.push("  reply published: no");
  }
  if (report.turn.error !== null) {
    lines.push(`  error: ${JSON.stringify(report.turn.error)}`);
  }
  lines.push(`  created: ${report.turn.createdAt}`);
  if (report.turn.completedAt !== null) {
    lines.push(`  completed: ${report.turn.completedAt}`);
  }
  if (report.attempts.length === 0) {
    lines.push("  (no recorded attempts — legacy turn recorded before tracing)");
    if (report.turn.decision !== null && report.turn.decision !== undefined) {
      lines.push(
        `  legacy decision JSONB: ${JSON.stringify(report.turn.decision)}`,
      );
    }
  }
  for (const attempt of report.attempts) {
    lines.push("");
    lines.push(...renderAttempt(attempt));
  }
  return lines.join("\n");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const turnIdArg = args.find((arg) => !arg.startsWith("--"));
  const json = args.includes("--json");
  const turnId = turnIdArg;

  if (turnId === undefined) {
    printUsage();
    process.exit(2);
  }
  if (json === false && args.includes("--json") === false && args.length > 1) {
    printUsage();
    process.exit(2);
  }

  const databaseUrl = process.env.WORKER_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    console.error(
      "WORKER_DATABASE_URL is required (read-only; no secrets needed)",
    );
    process.exit(2);
  }

  const pool = createPostgresPool({ connectionString: databaseUrl });
  try {
    const store = createConversationStore(pool);
    const report = await store.getTurnTraceReport({ turnId });
    if (json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(renderReport(report));
    }
  } finally {
    await closePostgresPool(pool);
  }
}

// Run only when this module is the executed entry point: importing it (for
// example from unit tests) must never start the CLI.
if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
