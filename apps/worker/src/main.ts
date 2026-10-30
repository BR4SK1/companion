/**
 * Worker entrypoint: migrate, start the private HTTP API, then run the
 * engine loop until shutdown.
 *
 * Composition edge only — every behavior lives in an injectable module:
 * configuration (`config.ts`), PostgreSQL access (`@companion/postgres`,
 * domain store), OpenRouter transport and contracts (`@companion/openrouter`),
 * the per-turn processor (`work/processor.ts`), the engine loop
 * (`work/engine.ts`), and the private HTTP API (`api/server.ts`).
 *
 * Requires a reachable PostgreSQL (WORKER_DATABASE_URL), an OpenRouter API
 * key, and the private service-to-service API token (WORKER_API_TOKEN).
 * Startup exits with a clear error when configuration is missing; it never
 * runs against production resources implicitly and never serves the API
 * without its credential.
 *
 * Shutdown is graceful and ordered: the engine loop stops taking new claims
 * and finishes its in-flight cycle (including publication), then the HTTP
 * listener drains in-flight requests, and only then is the pool closed.
 */

import process from "node:process";

import {
  closePostgresPool,
  createPostgresPool,
  runMigrations,
} from "@companion/postgres";
import { postJson } from "@companion/openrouter/transport";

import { loadWorkerConfig } from "./config.ts";
import { createApiServer } from "./api/server.ts";
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

  let api: ReturnType<typeof createApiServer> | undefined;
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
    api = createApiServer({
      store,
      token: config.apiToken,
      host: config.http.host,
      port: config.http.port,
      log: (message) => console.log(message),
      ready: async () => {
        try {
          await pool.query("SELECT 1");
          return true;
        } catch {
          return false;
        }
      },
    });
    await api.start();
    console.log(`private api listening on ${config.http.host}:${String(config.http.port)}`);

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
    // Stop accepting and drain in-flight API requests before the pool they
    // use is closed.
    if (api !== undefined) {
      await api.close().catch((error: unknown) => {
        console.error(
          `api server shutdown failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    }
    await closePostgresPool(pool);
  }
}

main().catch((error: unknown) => {
  console.error(
    `worker startup failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
