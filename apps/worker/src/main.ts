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
import {
  createConversationStore,
  TraceWriteFencedError,
} from "./conversation/store.ts";
import { memoryMigrations } from "./memory/migrations.ts";
import { loadMemoryConfig } from "./memory/config.ts";
import { createMemoryLlmCaller } from "./memory/llm.ts";
import { loadMemoryConfiguration, MemoryConfigurationError } from "./memory/subjects.ts";
import {
  PROMPT_KINDS,
  FACT_EXTRACTION_PROMPT_VERSION,
  OBSERVATION_CONSOLIDATION_PROMPT_VERSION,
  TEMPORAL_SUMMARY_PROMPT_VERSION,
  PROFILE_SUMMARY_PROMPT_VERSION,
  MEMORY_PROFILE_PROMPT_VERSION,
  promptContentHash,
} from "./memory/prompts.ts";
import { startMemoryRuntime, recordMemoryOperation } from "./memory/runtime.ts";
import { recallCanonical } from "./memory/recall.ts";
import {
  buildCanonicalMemoryContextForPrompt,
  renderProfileSection,
} from "./memory/chat-context.ts";
import { getTemporalSummaryPromptContext } from "./memory/temporal/store.ts";
import { getProfileDocument } from "./memory/profiles-v2.ts";
import { memoryErrorCategory } from "./memory/errors.ts";

/**
 * Runs one fenced trace write and refuses to continue on a lost lease. The
 * store reports fencing by returning `false`; a stale attempt must stop
 * processing — no further provider calls, and no selection or publication
 * decision based on an unrecorded boundary — so the wiring edge turns that
 * result into `TraceWriteFencedError`, which the engine handles through its
 * existing fenced failure path (`failTurn` is itself fenced, and a fenced
 * failure marks the attempt).
 */
async function recordTraced(
  boundary: string,
  turnId: string,
  write: () => Promise<boolean>,
): Promise<void> {
  const recorded = await write();
  if (!recorded) {
    throw new TraceWriteFencedError(
      `${boundary} trace write fenced: lease for turn ${turnId} no longer held`,
    );
  }
}
import { processTurnWork, type TurnProcessorDeps } from "./work/processor.ts";
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
  let memoryRuntime: ReturnType<typeof startMemoryRuntime> | undefined;
  try {
    const migrations = await runMigrations(pool, [
      ...conversationMigrations,
      ...memoryMigrations,
    ]);
    if (migrations.applied.length > 0) {
      console.log(`applied migrations: ${migrations.applied.join(", ")}`);
    }
    if (migrations.unrecognized.length > 0) {
      console.warn(
        `unrecognized recorded migrations (left untouched): ${migrations.unrecognized.join(", ")}`,
      );
    }

    const memoryConfig = loadMemoryConfig(process.env);

    const store = createConversationStore(pool);

    // Memory domain. Disabled memory changes nothing about the chat path:
    // no configuration load (fail-closed tables stay unprovisioned), no
    // runtime, and no per-turn memory context.
    //
    // Enabled memory is safe to start on an unprovisioned deployment: a
    // missing or incomplete personal configuration (subjects, prompts,
    // behavioral-day boundary) is a rollout state, not an error — memory
    // runs as a no-op and the worker starts normally. Provision the tables
    // and restart the worker to enable it. Any other configuration failure
    // (e.g. the database is unreachable) is still a startup failure.
    let loadMemoryContext: TurnProcessorDeps["loadMemoryContext"];
    let memoryConfiguration: Awaited<ReturnType<typeof loadMemoryConfiguration>> | undefined;
    if (memoryConfig.enabled) {
      try {
        memoryConfiguration = await loadMemoryConfiguration(pool, {
          fact_extraction: FACT_EXTRACTION_PROMPT_VERSION,
          observation_consolidation: OBSERVATION_CONSOLIDATION_PROMPT_VERSION,
          temporal_summary: TEMPORAL_SUMMARY_PROMPT_VERSION,
          profile_summary: PROFILE_SUMMARY_PROMPT_VERSION,
          observation_profile: MEMORY_PROFILE_PROMPT_VERSION,
        });
      } catch (error) {
        if (error instanceof MemoryConfigurationError) {
          console.warn(
            `[MEMORY] configuration not provisioned (${error.message}); memory stays disabled as a no-op until the tables are provisioned and the worker restarts`,
          );
        } else {
          throw error;
        }
      }
    }
    if (memoryConfiguration !== undefined) {
      const configuration = memoryConfiguration;
      const callMemoryLlm = createMemoryLlmCaller({
        url: `${memoryConfig.openrouterBaseUrl}/chat/completions`,
        apiKey: config.openrouter.apiKey,
        model: memoryConfig.model,
        timeoutMs: memoryConfig.chatTimeoutMs,
      });

      memoryRuntime = startMemoryRuntime({
        pool,
        config: memoryConfig,
        configuration,
        callLlm: callMemoryLlm,
        log: (message) => console.log(message),
      });

      // Per-turn memory context. Every section degrades independently: a
      // failed section logs a warning and the turn continues with the rest.
      loadMemoryContext = async ({ userText }) => {
        const now = new Date();
        const profileSubjects = configuration.subjects.filter(
          (subject) => subject.profileEnabled,
        );

        // Each section degrades independently (wrapped in its own try/catch):
        // a failure in one section logs a warning and drops only that section,
        // never the whole memory context.
        let memoryContext: string | undefined;
        if (memoryConfig.recallEnabled) {
          try {
            const recallQuery = userText.trim().split(/\s+/).slice(0, 16).join(" ").slice(0, 512);
            if (recallQuery.length > 0) {
              const recallStartedAt = new Date();
              const recall = await recallCanonical(pool, memoryConfig, {
                query: recallQuery,
                referenceTime: now,
                limit: memoryConfig.recallLimit,
                maxChars: memoryConfig.recallMaxChars,
                timezone: configuration.behavior.timezone,
              });
              memoryContext = buildCanonicalMemoryContextForPrompt({
                items: recall.results,
                now,
              });
              await recordMemoryOperation(pool, {
                kind: "recall",
                outcome: "ok",
                detail:
                  `mode=${recall.query.mode}` +
                  (recall.query.timeRange !== undefined
                    ? ` window=${recall.query.timeRange.description}`
                    : "") +
                  ` queryWords=16 results=${String(recall.results.length)}` +
                  ` facts=${String(recall.diagnostics.factCandidates)}` +
                  ` observations=${String(recall.diagnostics.observationCandidates)}` +
                  ` truncated=${String(recall.diagnostics.truncatedForBudget)}` +
                  ` ms=${String(recall.diagnostics.totalMs)}`,
                startedAt: recallStartedAt,
                finishedAt: new Date(),
              }).catch(() => undefined);
            }
          } catch (error) {
            console.warn(
              `[MEMORY] recall context failed (continuing without it): ${memoryErrorCategory(error)}`,
            );
          }
        }

        let temporalContext: string | undefined;
        if (memoryConfig.temporalContextEnabled) {
          try {
            temporalContext =
              (await getTemporalSummaryPromptContext(
                pool,
                configuration.subjects,
                now,
                configuration.behavior,
                // Serve gate: only summaries generated under the current
                // model and prompt content are served (a settings change or
                // same-version prompt edit excludes stored documents until
                // regeneration).
                {
                  model: memoryConfig.model,
                  promptContentHash: promptContentHash(
                    configuration.prompts["temporal_summary"]!.systemPrompt,
                  ),
                },
              )).recentText;
          } catch (error) {
            console.warn(
              `[MEMORY] temporal context failed (continuing without it): ${memoryErrorCategory(error)}`,
            );
          }
        }

        let profileSection: string | undefined;
        if (memoryConfig.profilesEnabled) {
          const sections: string[] = [];
          for (const subject of profileSubjects) {
            try {
              const profile = await getProfileDocument(pool, subject.id, {
                // Serve gate: only documents generated under the current
                // prompt version/content and model are served.
                promptVersion: MEMORY_PROFILE_PROMPT_VERSION,
                promptContentHash: promptContentHash(
                  configuration.prompts["observation_profile"]!.systemPrompt,
                ),
                model: memoryConfig.model,
              });
              const rendered = renderProfileSection(
                profile === null ? undefined : { profile },
              );
              if (rendered !== undefined) sections.push(rendered);
            } catch (error) {
              console.warn(
                `[MEMORY] profile context for ${subject.id} failed (continuing without it): ${memoryErrorCategory(error)}`,
              );
            }
          }
          profileSection = sections.length > 0 ? sections.join("\n\n") : undefined;
        }

        return {
          ...(memoryContext !== undefined ? { memoryContext } : {}),
          ...(temporalContext !== undefined ? { temporalContext } : {}),
          ...(profileSection !== undefined ? { profileSection } : {}),
        };
      };
    }

    // Const alias so the recall closure can rely on the provisioned
    // configuration's narrowing (a captured `let` would not stay narrowed).
    const provisionedMemoryConfiguration = memoryConfiguration;
    api = createApiServer({
      store,
      token: config.apiToken,
      host: config.http.host,
      port: config.http.port,
      log: (message) => console.log(message),
      ...(provisionedMemoryConfiguration !== undefined
        ? {
            // General recall surface: canonical recall by arbitrary query,
            // independent of the per-turn chat assembly (whose query is the
            // turn's user text). Same domain validation and ranking as the
            // per-turn path; the behavioral timezone comes from the
            // provisioned configuration.
            recall: async (input: { query: string; limit?: number }) => {
              const startedAt = new Date();
              const result = await recallCanonical(pool, memoryConfig, {
                query: input.query,
                referenceTime: startedAt,
                ...(input.limit !== undefined ? { limit: input.limit } : {}),
                maxChars: memoryConfig.recallMaxChars,
                timezone: provisionedMemoryConfiguration.behavior.timezone,
              });
              // Metadata-only trace, never a content copy; a tracing failure
              // must not fail an already-successful recall.
              await recordMemoryOperation(pool, {
                kind: "recall",
                outcome: "ok",
                detail:
                  `source=api mode=${result.query.mode}` +
                  (result.query.timeRange !== undefined
                    ? ` window=${result.query.timeRange.description}`
                    : "") +
                  ` results=${String(result.results.length)}` +
                  ` ms=${String(result.diagnostics.totalMs)}`,
                startedAt,
                finishedAt: new Date(),
              }).catch(() => undefined);
              return result;
            },
          }
        : {}),
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
        processTurn: (work, { leaseOwner }) =>
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
            // Required, fail-closed configuration: a missing or empty
            // identity row is an IdentityConfigurationError that fails the
            // attempt before any snapshot, decision, or provider call — the
            // prompt is never assembled with an invented persona. Read fresh
            // per turn, so owner edits apply on the next turn.
            loadIdentity: () => store.getChatIdentity(),
            loadContext: (turnId) =>
              store.getThreadContext({
                turnId,
                limit: config.contextMessageLimit,
              }),
            recordSnapshot: (snapshot) =>
              recordTraced("snapshot", work.turn.id, () =>
                store.recordAttemptSnapshot({
                  turnId: work.turn.id,
                  leaseOwner,
                  snapshot,
                }),
              ),
            recordDecisionRequest: (payload) =>
              recordTraced("decision request", work.turn.id, () =>
                store.recordDecisionRequest({
                  turnId: work.turn.id,
                  leaseOwner,
                  trace: payload.trace,
                }),
              ),
            recordDecisionOutcome: (payload) =>
              recordTraced("decision outcome", work.turn.id, () =>
                store.recordDecisionOutcome({
                  turnId: work.turn.id,
                  leaseOwner,
                  payload,
                }),
              ),
            recordDecisionSelection: (payload) =>
              recordTraced("decision selection", work.turn.id, () =>
                store.recordDecisionSelection({
                  turnId: work.turn.id,
                  leaseOwner,
                  selection: payload.selection,
                }),
              ),
            recordChatRequest: (payload) =>
              recordTraced("chat request", work.turn.id, () =>
                store.recordChatRequest({
                  turnId: work.turn.id,
                  leaseOwner,
                  payload,
                }),
              ),
            recordChatOutcome: (payload) =>
              recordTraced("chat outcome", work.turn.id, () =>
                store.recordChatOutcome({
                  turnId: work.turn.id,
                  leaseOwner,
                  payload,
                }),
              ),
            loadMemoryContext,
          }),
        leaseSeconds: config.leaseSeconds,
        pollSeconds: config.pollSeconds,
        ownerLabel: "companion-worker",
        log: (message) => console.log(message),
        onTurnPublished: (turnId) => memoryRuntime?.onTurnPublished(turnId),
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
    if (memoryRuntime !== undefined) {
      await memoryRuntime.close().catch((error: unknown) => {
        console.error(
          `memory runtime shutdown failed: ${error instanceof Error ? error.message : String(error)}`,
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
