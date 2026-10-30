/**
 * Worker entrypoint: migrate, then run the engine loop until shutdown.
 *
 * Composition edge only — every behavior lives in an injectable module:
 * configuration (`config.ts`), PostgreSQL access (`@companion/postgres`,
 * domain store), OpenRouter transport and contracts (`@companion/openrouter`),
 * the per-turn processor (`work/processor.ts`), and the engine loop
 * (`work/engine.ts`).
 *
 * Requires a reachable PostgreSQL (WORKER_DATABASE_URL) and an OpenRouter
 * API key. Startup exits with a clear error when configuration is missing;
 * it never runs against production resources implicitly.
 */

import process from "node:process";

import {
  closePostgresPool,
  createPostgresPool,
  runMigrations,
} from "@companion/postgres";
import { postJson } from "@companion/openrouter/transport";

import { loadWorkerConfig } from "./config.ts";
import { conversationMigrations } from "./conversation/migrations.ts";
import { createConversationStore } from "./conversation/store.ts";
import { processTurnWork } from "./work/processor.ts";
import { runEngineLoop } from "./work/engine.ts";

async function main(): Promise<void> {
  const config = loadWorkerConfig(process.env);
  const pool = createPostgresPool({ connectionString: config.databaseUrl });

  const shutdown = new AbortController();
  const onSignal = (): void => {
    shutdown.abort();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  try {
    const migrations = await runMigrations(pool, conversationMigrations);
    if (migrations.applied.length > 0) {
      console.log(`applied migrations: ${migrations.applied.join(", ")}`);
    }
    if (migrations.unrecognized.length > 0) {
      console.warn(
        `unrecognized recorded migrations (left untouched): ${migrations.unrecognized.join(", ")}`,
      );
    }

    const store = createConversationStore(pool);
    await runEngineLoop(
      {
        store,
        processTurn: (work) =>
          processTurnWork(work, {
            decisionModel: config.openrouter.decisionModel,
            chatModel: config.openrouter.chatModel,
            callDecisions: (request) =>
              postJson(config.openrouter.decisionsUrl, request, {
                apiKey: config.openrouter.apiKey,
                timeoutMs: config.openrouter.decisionTimeoutMs,
              }),
            callChat: (request) =>
              postJson(config.openrouter.chatUrl, request, {
                apiKey: config.openrouter.apiKey,
                timeoutMs: config.openrouter.chatTimeoutMs,
              }),
            loadPatterns: () => store.getEnabledResponsePatterns(),
            loadContext: (turnId) =>
              store.getThreadContext({
                turnId,
                limit: config.contextMessageLimit,
              }),
          }),
        leaseSeconds: config.leaseSeconds,
        pollSeconds: config.pollSeconds,
        ownerLabel: "companion-worker",
        log: (message) => console.log(message),
      },
      { signal: shutdown.signal },
    );
    console.log("worker stopped");
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    await closePostgresPool(pool);
  }
}

main().catch((error: unknown) => {
  console.error(
    `worker startup failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
