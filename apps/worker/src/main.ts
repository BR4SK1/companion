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
  type PostgresPoolClient,
} from "@companion/postgres";
import { postJson } from "@companion/openrouter/transport";

import { loadWorkerConfig } from "./config.ts";
import { createApiServer } from "./api/server.ts";
import {
  createConversationStore,
  TraceWriteFencedError,
} from "./conversation/store.ts";
import { applyWorkerMigrations } from "./migrations.ts";
import { loadEngagementBands } from "./engagement/bands.ts";
import { createEngagementStore } from "./engagement/store.ts";
import {
  createRelationshipStore,
  loadRelationshipConfiguration,
  RelationshipConfigurationError,
} from "./relationship/store.ts";
import { startRelationshipLearning } from "./relationship/learning.ts";
import { renderRelationshipContext } from "./relationship/runtime.ts";
import { createRoutineStore } from "./routine/store.ts";
import { renderRoutineContext } from "./routine/runtime.ts";
import { startRoutineRuntime } from "./routine/runtime-loop.ts";
import {
  EXTERNAL_ROUTINE_HOLD_KEY,
  runExternalRoutineTick,
} from "./routine/external.ts";
import { loadMemoryConfig } from "./memory/config.ts";
import { createMemoryLlmCaller, taskPresets } from "./memory/llm.ts";
import { startArticleRuntime } from "./articles/runner.ts";
import { loadArticleLlmOverrides } from "./articles/config.ts";
import {
  loadArticleShareContext,
  recordArticleShareInclusion,
} from "./articles/share.ts";
import { getRecentArticleMemories } from "./articles/retrieval.ts";
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
import { startMemoryRuntime, recordMemoryOperation, type SemanticShadowRequest } from "./memory/runtime.ts";
import {
  buildRecallQuery,
  DEFAULT_RECALL_MAX_ASSISTANT_SHARE,
  recallCanonicalDetailed,
} from "./memory/recall.ts";
import {
  buildCanonicalMemoryContextForPrompt,
  renderProfileSection,
} from "./memory/chat-context.ts";
import { getTemporalSummaryPromptContext } from "./memory/temporal/store.ts";
import { getProfileDocument } from "./memory/profiles-v2.ts";
import { memoryErrorCategory } from "./memory/errors.ts";
import { createEmbeddingClient } from "./memory/embeddings.ts";
import { loadTemporalSettings } from "./temporal/store.ts";
import { createPromptModuleStore } from "./prompt-modules/store.ts";
import { executePromptModule } from "./prompt-modules/executor.ts";
import { loadImageConfig } from "./image/config.ts";
import { renderRecentImagesContext } from "./image/context.ts";
import { createImageStore } from "./image/store.ts";
import { createOfflineImageStore } from "./image/offline-store.ts";
import { createOfflinePhotoRuntime } from "./image/offline-runtime.ts";
import { photoAccessForTier, type PhotoAccess } from "./image/photo-access.ts";
import { createImageServiceClients } from "./image/client.ts";
import { startImageRuntime } from "./image/runtime.ts";
import { IMAGE_MESSAGE_MARKER } from "./image/types.ts";
import { DateTime } from "luxon";
import { createDecisionModelPool } from "./work/decision-pool.ts";

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
  const pool = createPostgresPool({
    connectionString: config.databaseUrl,
    connectionTimeoutMillis: 5_000,
  });

  const shutdown = new AbortController();
  const onSignal = (): void => {
    shutdown.abort();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  let api: ReturnType<typeof createApiServer> | undefined;
  let memoryRuntime: ReturnType<typeof startMemoryRuntime> | undefined;
  let learning: Awaited<ReturnType<typeof startRelationshipLearning>> | undefined;
  let articleRuntime: ReturnType<typeof startArticleRuntime> | undefined;
  let routineRuntime: ReturnType<typeof startRoutineRuntime> | undefined;
  let imageRuntime: ReturnType<typeof startImageRuntime> | undefined;
  try {
    const migrations = await applyWorkerMigrations(pool);
    if (migrations.applied.length > 0) {
      console.log(`applied migrations: ${migrations.applied.join(", ")}`);
    }
    if (migrations.unrecognized.length > 0) {
      console.warn(
        `unrecognized recorded migrations (left untouched): ${migrations.unrecognized.join(", ")}`,
      );
    }

    const temporalSettings = await loadTemporalSettings(pool);
    if (temporalSettings.timezone === null) {
      console.warn(
        "[TIME] authoritative timezone is not configured; local chat context and timezone-dependent features remain unspecified or disabled until provisioned and the worker restarts",
      );
    }

    const memoryConfig = loadMemoryConfig(process.env);

    // Engagement domain. A worker-owned peer to memory: per-message
    // assessments written inside the ingest transaction, and an effective
    // state recomputed on read from the engagement anchor. The band
    // boundaries are locally provisioned runtime configuration
    // (`engagement_bands`), never code or repository content. An
    // unprovisioned deployment runs engagement as a safe no-op (provision
    // the row and restart to enable); no timers and no proactive behavior
    // exist anywhere in the domain.
    const engagementBands = await loadEngagementBands(pool);
    const engagementStore = engagementBands === null
      ? undefined
      : createEngagementStore({ pool, bands: engagementBands });
    if (engagementStore === undefined) {
      console.warn(
        "[ENGAGEMENT] band configuration not provisioned (engagement_bands is empty); engagement stays disabled as a no-op until the row is provisioned and the worker restarts",
      );
    }

    // Relationship/familiarity is a database-configured domain. Missing or
    // invalid configuration disables only this optional context/learning
    // feature; no type, tier, day boundary, or question content is invented.
    let relationshipStore: ReturnType<typeof createRelationshipStore> | undefined;
    let relationshipConfiguration: Awaited<ReturnType<typeof loadRelationshipConfiguration>> = null;
    try {
      relationshipConfiguration = await loadRelationshipConfiguration(
        pool,
        temporalSettings.timezone,
      );
      if (relationshipConfiguration === null) {
        console.warn(
          "[RELATIONSHIP] configuration not provisioned (relationship_settings singleton is missing); provision relationship_settings, relationship_tier, relationship_question_type, and enabled relationship_question rows, then restart to enable relationship context and answer learning",
        );
      } else {
        relationshipStore = createRelationshipStore({ pool, configuration: relationshipConfiguration });
      }
    } catch (error) {
      if (error instanceof RelationshipConfigurationError) {
        console.warn(
          `[RELATIONSHIP] invalid configuration (${error.message}); relationship context and answer learning stay disabled until configuration is corrected and the worker restarts`,
        );
      } else {
        throw error;
      }
    }
    const relationshipCallLlm = relationshipStore === undefined
      ? undefined
      : createMemoryLlmCaller({
          url: `${memoryConfig.openrouterBaseUrl}/chat/completions`,
          apiKey: config.openrouter.apiKey,
          model: memoryConfig.model,
          timeoutMs: memoryConfig.chatTimeoutMs,
        });
    const relationshipExtractionPreset = taskPresets(memoryConfig).memoryFactExtraction;

    // The routine is generic relational runtime configuration. Missing
    // configuration preserves ordinary chat and availability; malformed
    // provisioned configuration fails startup rather than accidentally
    // bypassing an intended unavailable interval. Schedule rows are reloaded
    // on reconciliation, turn admission, and context reads; the authoritative
    // timezone remains pinned to the worker startup snapshot.
    const routineStore = createRoutineStore({ pool, timezone: temporalSettings.timezone });
    await routineStore.reconcile();

    // Image generation (post-turn media domain). Disabled unless the
    // operator supplies the module endpoints and the module-scope user id;
    // a partial configuration fails startup naming the missing variables.
    const imageConfig = loadImageConfig(process.env);
    const imageStore = imageConfig.enabled ? createImageStore(pool) : undefined;
    if (imageStore === undefined) {
      console.log(
        "[IMAGE] image generation disabled (module endpoints not configured); ordinary chat is unchanged",
      );
    }

    const promptModuleStore = createPromptModuleStore(pool);
    const store = createConversationStore(pool, {
      clientTimeMaxAheadMs: config.clientTimeMaxAheadMs,
      ...(imageStore !== undefined
        ? {
            threadImageLoader: {
              getImagesForMessages: (messageIds) =>
                imageStore.getImagesForMessages(messageIds),
            },
          }
        : {}),
      ...(engagementStore !== undefined
        ? {
            onUserMessageInserted: (tx, inserted) =>
              engagementStore.onUserMessageInserted(tx, inserted),
            // Model-history session scoping: decision/chat/snapshot and
            // prompt-module context start at the latest recorded `gone`
            // return message. Only wired when engagement is provisioned;
            // unprovisioned keeps existing unscoped behavior.
            sessionAssessmentLoader: {
              getAssessmentStatesForMessages: (messageIds) =>
                engagementStore.getAssessmentStatesForMessages(messageIds),
            },
          }
        : {}),
      onPromptModuleChatMessagesRecorded: (client, association) =>
        promptModuleStore.recordChatAttribution(client, association),
      loadPromptModuleTrace: (client, attemptId) =>
        promptModuleStore.loadAttemptTrace(client, attemptId),
    });
    routineRuntime = startRoutineRuntime({
      store: routineStore,
      publishPendingAnnouncement: () =>
        store.publishScheduledAssistantMessage({
          prepare: async (client) => {
            const draft = await routineStore.prepareAnnouncement(client);
            if (draft === null) return null;
            return {
              content: draft.content,
              validUntil: draft.validUntil,
              cancel: (transaction, cancelledAt) =>
                routineStore.cancelAnnouncement(transaction, draft, cancelledAt),
              recordPublication: (transaction, messageId, publishedAt) =>
                routineStore.recordAnnouncementPublication(
                  transaction,
                  draft,
                  messageId,
                  publishedAt,
                ),
            };
          },
        }),
      tickExternal: async () => {
        const outcome = await runExternalRoutineTick({
          loadProvider: () => routineStore.loadExternalProvider(),
          credentials: config.promptModuleCredentials,
          timezone: temporalSettings.timezone,
          ...(engagementStore !== undefined
            ? {
                loadEngagementState: (now) =>
                  engagementStore.getSummary(now).then((summary) => summary.state),
              }
            : {}),
          hasQueuedUserMessages: () =>
            store.getThreadStatus().then((status) => status.queuedUserMessages > 0),
          applyAvailabilityHold: (unavailableUntil, revision) =>
            routineStore.setAvailabilityHold(EXTERNAL_ROUTINE_HOLD_KEY, unavailableUntil, revision),
          publishAssistantMessage: (message, revision) =>
            store.publishScheduledAssistantMessage({
              skipIfUserMessagesQueued: true,
              prepare: async (client) => {
                if (revision !== undefined && !(await routineStore.lockCurrentAvailabilityRevision(
                  client,
                  EXTERNAL_ROUTINE_HOLD_KEY,
                  revision,
                ))) return null;
                if (await routineStore.hasPublishedExternalMessage(client, message.clientKey)) {
                  return null;
                }
                return {
                  content: message.content,
                  validUntil: null,
                  cancel: async () => {},
                  recordPublication: (transaction, messageId, publishedAt) =>
                    routineStore.recordExternalMessagePublication(
                      transaction,
                      message.clientKey,
                      messageId,
                      publishedAt,
                    ),
                };
              },
            }),
          observeResponse: async (response, scope) => {
            if (scope === imageConfig.userId) await imageRuntime?.observeRoutineTick(response);
          },
          log: (message) => console.log(message),
        });
        if (outcome.status === "failed") {
          console.warn(`[ROUTINE] external tick failed reason=${outcome.reason}`);
        }
      },
      log: (message) => console.log(message),
    });

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
    const liveRecallEmbeddingClient = memoryConfig.enabled && memoryConfig.semanticRecallEnabled
      ? createEmbeddingClient({
          baseUrl: memoryConfig.embeddingBaseUrl,
          timeoutMs: memoryConfig.semanticRecallTimeoutMs,
        })
      : undefined;
    const RECENT_RECALL_WINDOW_TURNS = 3;
    const recentRecallHistory: Array<readonly string[]> = [];
    if (memoryConfig.enabled) {
      try {
        memoryConfiguration = await loadMemoryConfiguration(pool, {
          fact_extraction: FACT_EXTRACTION_PROMPT_VERSION,
          observation_consolidation: OBSERVATION_CONSOLIDATION_PROMPT_VERSION,
          temporal_summary: TEMPORAL_SUMMARY_PROMPT_VERSION,
          profile_summary: PROFILE_SUMMARY_PROMPT_VERSION,
          observation_profile: MEMORY_PROFILE_PROMPT_VERSION,
        }, temporalSettings.timezone);
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
      loadMemoryContext = async ({ turnId, turnAttempt, userText, history, referenceTime }) => {
        const now = referenceTime;
        const profileSubjects = configuration.subjects.filter(
          (subject) => subject.profileEnabled,
        );

        // Each section degrades independently (wrapped in its own try/catch):
        // a failure in one section logs a warning and drops only that section,
        // never the whole memory context.
        let memoryContext: string | undefined;
        // Fact keys the recall chunk surfaced this turn — the dedupe input
        // for the per-turn article-memory share candidates.
        let recallFactKeys: string[] = [];
        let semanticShadowRequest: SemanticShadowRequest | undefined;
        if (memoryConfig.recallEnabled) {
          try {
            const recallQuery = buildRecallQuery({
              currentUserText: userText,
              history,
            });
            if (recallQuery.length > 0) {
              const excludeTurnIds = [
                turnId,
                ...(history ?? [])
                  .map((message) => message.turnId)
                  .filter((id): id is string => id !== null),
              ];
              const recallStartedAt = new Date();
              const recentlyRecalledIds = new Set(recentRecallHistory.flat());
              const detailedRecall = await recallCanonicalDetailed(pool, memoryConfig, {
                query: recallQuery,
                referenceTime: now,
                limit: memoryConfig.recallLimit,
                maxChars: memoryConfig.recallMaxChars,
                timezone: configuration.behavior.timezone,
                excludeTurnIds,
                minAgeMs: memoryConfig.recallMinAgeMs,
                maxAssistantShare: DEFAULT_RECALL_MAX_ASSISTANT_SHARE,
                deduplicateClaims: true,
                ...(liveRecallEmbeddingClient !== undefined
                  ? { embeddingClient: liveRecallEmbeddingClient }
                  : {}),
                ...(recentlyRecalledIds.size > 0 ? { recentlyRecalledIds } : {}),
                log: (message) => console.log(message),
              });
              const recall = detailedRecall.response;
              if (recall.results.length > 0) {
                recentRecallHistory.push(recall.results.map((item) => item.id));
                while (recentRecallHistory.length > RECENT_RECALL_WINDOW_TURNS) {
                  recentRecallHistory.shift();
                }
              }
              memoryContext = buildCanonicalMemoryContextForPrompt({
                items: recall.results,
                now,
              });
              recallFactKeys = recall.results
                .filter((item) => item.type === "fact")
                .map((item) => item.id);
              const recallOperationId = await recordMemoryOperation(pool, {
                kind: "recall",
                turnId,
                outcome: "ok",
                detail:
                  `mode=${recall.query.mode}` +
                  (recall.query.timeRange !== undefined
                    ? ` window=${recall.query.timeRange.description}`
                    : "") +
                  ` queryChars=${String(recallQuery.length)} results=${String(recall.results.length)}` +
                  ` facts=${String(recall.diagnostics.factCandidates)}` +
                  ` observations=${String(recall.diagnostics.observationCandidates)}` +
                  ` semantic=${String(recall.diagnostics.semanticUsed ?? false)}` +
                  ` semCandidates=${String(recall.diagnostics.semanticCandidates ?? 0)}` +
                  ` truncated=${String(recall.diagnostics.truncatedForBudget)}` +
                  ` ms=${String(recall.diagnostics.totalMs)}`,
                startedAt: recallStartedAt,
                finishedAt: new Date(),
              }).catch(() => null);
              semanticShadowRequest = {
                source: "chat",
                turnId,
                turnAttempt,
                recallOperationId,
                query: detailedRecall.normalizedInput.query,
                referenceTime: detailedRecall.normalizedInput.referenceTime,
                limit: detailedRecall.normalizedInput.limit,
                maxChars: detailedRecall.normalizedInput.maxChars,
                candidates: detailedRecall.candidates,
                baselineOrigin: recall.query.emptyQueryFallback
                  ? "recency"
                  : recall.query.mode === "hybrid" ? "temporal_keyword" : "keyword",
                retrievalMode: recall.query.mode,
                emptyQueryFallback: recall.query.emptyQueryFallback,
                ...(recall.query.timeRange !== undefined
                  ? { timeRange: { start: recall.query.timeRange.start, end: recall.query.timeRange.end } }
                  : {}),
              };
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

        if (semanticShadowRequest !== undefined) {
          memoryRuntime?.enqueueSemanticShadow(semanticShadowRequest);
        }

        return {
          ...(memoryContext !== undefined ? { memoryContext } : {}),
          ...(temporalContext !== undefined ? { temporalContext } : {}),
          ...(profileSection !== undefined ? { profileSection } : {}),
          ...(recallFactKeys.length > 0 ? { recallFactKeys } : {}),
        };
      };
    }

    // Article ingestion domain. Started on every worker run, independent of
    // the memory feature flag: the article domain has its own provisioned
    // enable switch, and every article input (feeds, prompts, policy, model,
    // and the assistant subject reactions are attributed to) is loaded from
    // PostgreSQL at every attempt. An unprovisioned article domain is a
    // fail-closed no-op that logs exactly `ingestion not configured`, so
    // starting the scheduler unconditionally is safe and keeps the
    // documented contract honest: provisioning (or disabling) the article
    // tables takes effect on the next scheduled attempt without a restart. The
    // OpenRouter endpoint and credential are environment configuration,
    // available regardless of provisioning state.
    const articleLlmOverrides = loadArticleLlmOverrides(process.env);
    articleRuntime = startArticleRuntime({
      pool,
      timezone: temporalSettings.timezone,
      ...(articleLlmOverrides.model !== undefined
        ? { modelOverride: articleLlmOverrides.model }
        : {}),
      ...(articleLlmOverrides.reasoningEffort !== undefined
        ? { reasoningEffortOverride: articleLlmOverrides.reasoningEffort }
        : {}),
      callLlm: (model, input) =>
        createMemoryLlmCaller({
          url: `${memoryConfig.openrouterBaseUrl}/chat/completions`,
          apiKey: config.openrouter.apiKey,
          model,
          timeoutMs: memoryConfig.chatTimeoutMs,
        })(input),
      log: (message) => console.log(message),
    });

    if (imageStore !== undefined) {
      const images = imageStore;
      const related = relationshipStore;
      const tiers = relationshipConfiguration?.tiers ?? [];
      const loadPhotoAccess = async (client?: PostgresPoolClient): Promise<PhotoAccess> => {
        if (related === undefined || imageConfig.outfitTierKey === null) return 0;
        const baseTier = await related.getBaseTier(client).catch(() => null);
        return baseTier === null
          ? 0
          : photoAccessForTier(baseTier, tiers, imageConfig.outfitTierKey, imageConfig.sequenceTierKey);
      };

      const clients = createImageServiceClients({
        implementationUrl: imageConfig.implementationUrl,
        imageServiceUrl: imageConfig.imageServiceUrl,
        userId: imageConfig.userId,
        timeoutMs: imageConfig.timeoutMs,
      });
      const offlineImages = createOfflineImageStore(pool, images);
      const offline = createOfflinePhotoRuntime({
        store: offlineImages,
        images,
        clients,
        timeoutMs: imageConfig.timeoutMs,
        maxAttempts: imageConfig.maxAttempts,
        loadAccess: loadPhotoAccess,
        publishAlbum: (eventId) =>
          store.publishScheduledAssistantMessage({
            skipIfUserMessagesQueued: true,
            prepare: async (client) => {
              const album = await offlineImages.prepareAlbum(client, eventId, await loadPhotoAccess(client));
              if (album === null) return null;
              return {
                content: IMAGE_MESSAGE_MARKER,
                validUntil: album.publishBy,
                cancel: (transaction) => offlineImages.cancelAlbum(transaction, eventId),
                recordPublication: (transaction, messageId) =>
                  offlineImages.publishAlbum(transaction, album, messageId),
              };
            },
          }),
        log: (message) => console.log(message),
      });

      imageRuntime = startImageRuntime({
        store: images,
        clients,
        patternIds: imageConfig.patternIds,
        maxAttempts: imageConfig.maxAttempts,
        pollMs: imageConfig.pollMs,
        loadPhotoAccess,
        offline,
        publishImageMessage: (job) =>
          store.publishScheduledAssistantMessage({
            prepare: async (client) => {
              if (!(await images.isRendered(client, job.id))) return null;
              // Rendered jobs from before the gate were unrestricted.
              if (await loadPhotoAccess(client) < (job.photoAccess ?? 3)) {
                await images.discardRendered(client, job.id);
                return null;
              }
              return {
                content: IMAGE_MESSAGE_MARKER,
                validUntil: null,
                cancel: async () => {},
                recordPublication: (transaction, messageId) =>
                  images.linkMessage(transaction, job.id, messageId),
              };
            },
          }),
        log: (message) => console.log(message),
      });
      console.log(
        `[IMAGE] image generation enabled (implementation=${imageConfig.implementationUrl}, image=${imageConfig.imageServiceUrl}, patterns=${String(imageConfig.patternIds.length)})`,
      );
    }

    // Const alias so the recall closure can rely on the provisioned
    // configuration's narrowing (a captured `let` would not stay narrowed).
    const provisionedMemoryConfiguration = memoryConfiguration;
    const provisionedRelationshipStore = relationshipStore;
    if (provisionedRelationshipStore && relationshipCallLlm) {
      learning = await startRelationshipLearning(pool, provisionedRelationshipStore, relationshipCallLlm, relationshipExtractionPreset);
    }
    const provisionedRoutineStore = routineStore;
    api = createApiServer({
      store,
      token: config.apiToken,
      host: config.http.host,
      port: config.http.port,
      timezone: temporalSettings.timezone,
      log: (message) => console.log(message),
      // Engagement summary: recomputed on each read from the engagement
      // anchor's effective time and the provisioned bands. Wired only when
      // engagement is provisioned; the route reports 503 otherwise.
      ...(engagementStore !== undefined
        ? { engagement: () => engagementStore.getSummary(new Date()) }
        : {}),
      ...(provisionedMemoryConfiguration !== undefined
        ? {
            // General recall surface: canonical recall by arbitrary query,
            // independent of the per-turn chat assembly (whose query is the
            // turn's user text). Same domain validation and ranking as the
            // per-turn path; the behavioral timezone comes from the
            // provisioned configuration.
            recall: async (input: { query: string; limit?: number }) => {
              const startedAt = new Date();
              const detailedResult = await recallCanonicalDetailed(pool, memoryConfig, {
                query: input.query,
                referenceTime: startedAt,
                ...(input.limit !== undefined ? { limit: input.limit } : {}),
                maxChars: memoryConfig.recallMaxChars,
                timezone: provisionedMemoryConfiguration.behavior.timezone,
                ...(liveRecallEmbeddingClient !== undefined
                  ? { embeddingClient: liveRecallEmbeddingClient }
                  : {}),
                log: (message) => console.log(message),
              });
              const result = detailedResult.response;
              // Metadata-only trace, never a content copy; a tracing failure
              // must not fail an already-successful recall.
              const recallOperationId = await recordMemoryOperation(pool, {
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
              }).catch(() => null);
              memoryRuntime?.enqueueSemanticShadow({
                source: "api",
                recallOperationId,
                query: detailedResult.normalizedInput.query,
                referenceTime: detailedResult.normalizedInput.referenceTime,
                limit: detailedResult.normalizedInput.limit,
                maxChars: detailedResult.normalizedInput.maxChars,
                candidates: detailedResult.candidates,
                baselineOrigin: result.query.emptyQueryFallback
                  ? "recency"
                  : result.query.mode === "hybrid" ? "temporal_keyword" : "keyword",
                retrievalMode: result.query.mode,
                emptyQueryFallback: result.query.emptyQueryFallback,
                ...(result.query.timeRange !== undefined
                  ? { timeRange: { start: result.query.timeRange.start, end: result.query.timeRange.end } }
                  : {}),
              });
              return result;
            },
          }
        : {}),
      // Programmatic article-memory retrieval: deterministic newest-first
      // accepted memories, caller-configurable limit with safe defaults and
      // maxima. Wired unconditionally, matching the article runtime's
      // unconditional start: the article domain's enable switch is its
      // provisioned configuration (applied migrations + article tables), not
      // the memory feature flag, and this read-only surface reads
      // article-sourced facts that exist regardless of the memory flag. The
      // private API route reports 503 only when the surface is unwired
      // (embedding without the article domain), never because memory is off.
      articleMemories: (input: { limit?: number }) =>
        getRecentArticleMemories(pool, input),
      ...(imageStore !== undefined
        ? { image: (id: string) => imageStore.getImage(id) }
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

    const decisionModelPool = createDecisionModelPool(
      config.openrouter.decisionModels,
    );
    console.log(
      `[DECISION] configured model pool (${String(decisionModelPool.models.length)}): ${decisionModelPool.models.join(", ")}`,
    );

    await runEngineLoop(
      {
        store,
        canStartNewTurn: provisionedRoutineStore.canStartNewTurn,
        processTurn: (work, { leaseOwner }) =>
          processTurnWork(work, {
            decisionModel: config.openrouter.decisionModel,
            decisionModelPool,
            chatModel: config.openrouter.chatModel,
            ...(config.openrouter.chatReasoningEffort !== undefined
              ? {
                  chatReasoningEffort:
                    config.openrouter.chatReasoningEffort,
                }
              : {}),
            temporalSettings,
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
            promptModules: {
              leaseOwner,
              loadPromptModules: () => promptModuleStore.loadEnabled(),
              promptModuleCredentials: config.promptModuleCredentials,
              executePromptModule,
              recordPromptModuleDefinitions: (payload) =>
                recordTraced("prompt-module definitions", work.turn.id, () =>
                  promptModuleStore.recordDefinitions(payload),
                ),
              recordPromptModuleDecision: (payload) =>
                recordTraced("prompt-module decision", work.turn.id, () =>
                  promptModuleStore.recordDecision(payload),
                ),
              recordPromptModuleExecution: (payload) =>
                recordTraced("prompt-module execution", work.turn.id, () =>
                  promptModuleStore.recordExecution(payload),
                ),
            },
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
            loadPreviousPublishedAssistantReply: (turnId) =>
              store.getPreviousPublishedAssistantReply(turnId),
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
                  questionId: payload.questionId,
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
            // Always wired so the main reply output budget is always
            // resolved: enabled relationship derives it from the base
            // familiarity tier ordinal (500 at the first tier, +100 per
            // successive tier); a disabled relationship is the first
            // tier (500). Answer extraction stays conditional on the
            // store and its LLM caller being provisioned.
            loadRelationshipContext: async (_turnId, referenceTime) => {
              if (provisionedRelationshipStore === undefined) {
                return { context: null, baseTierOrdinal: 0 };
              }
              const summary =
                await provisionedRelationshipStore.getSummary(referenceTime);
              return {
                context: renderRelationshipContext(summary),
                baseTierOrdinal: summary.baseTierOrdinal,
              };
            },
            ...(provisionedRelationshipStore !== undefined
              ? {
                  loadInitiativeQuestions: ({ recentText, referenceTime }) =>
                    provisionedRelationshipStore.getInitiativeQuestions({
                      recentText,
                      now: referenceTime,
                    }),
                }
              : {}),
            loadRoutineContext: async (_turnId, referenceTime) => {
              const snapshot = await provisionedRoutineStore.getSnapshot(referenceTime);
              return snapshot === null ? null : renderRoutineContext(snapshot);
            },
            ...(imageStore !== undefined
              ? {
                  loadImageContext: async ({ turnId, history, referenceTime }) => {
                    const firstHistory = history[0];
                    const lastHistory = history[history.length - 1];
                    if (firstHistory === undefined || lastHistory === undefined) {
                      return null;
                    }
                    const recentImages = await imageStore.getRecentSentImagesForTurn({
                      turnId,
                      sinceMessageId: firstHistory.id,
                      lastHistoryMessageId: lastHistory.id,
                      limit: 3,
                    });
                    let lastAssistantTurnId: string | null = null;
                    for (let i = history.length - 1; i >= 0; i -= 1) {
                      const msg = history[i]!;
                      if (msg.role === "assistant" && msg.turnId !== null) {
                        lastAssistantTurnId = msg.turnId;
                        break;
                      }
                    }
                    return renderRecentImagesContext({
                      images: recentImages,
                      now: referenceTime,
                      lastAssistantTurnId,
                    });
                  },
                }
              : {}),
            ...(engagementStore !== undefined
              ? {
                  loadEngagementState: (referenceTime) =>
                    engagementStore
                      .getSummary(referenceTime)
                      .then((summary) => summary.state),
                }
              : {}),
            loadPublishedRoutineMessageKey: provisionedRoutineStore.loadPublishedMessageKeyBeforeTurn,
            applyAvailabilityHold: ({ unavailableUntil, availabilityRevision }) =>
              provisionedRoutineStore.setAvailabilityHold(
                EXTERNAL_ROUTINE_HOLD_KEY,
                unavailableUntil,
                availabilityRevision,
              ),
            ...(articleRuntime !== undefined
              ? {
                  loadArticleShareCandidates: (input: {
                    readonly recallFactKeys: readonly string[];
                  }) =>
                    loadArticleShareContext(pool, { recallFactKeys: input.recallFactKeys })
                      .then((context) => context?.candidates ?? null),
                  recordArticleShareInclusion: (input: {
                    readonly turnId: string;
                    readonly reactionId: string;
                  }) =>
                    recordArticleShareInclusion(pool, {
                      turnId: input.turnId,
                      reactionId: input.reactionId,
                    }),
                }
              : {}),
          }),
        leaseSeconds: config.leaseSeconds,
        pollSeconds: config.pollSeconds,
        ownerLabel: "companion-worker",
        log: (message) => console.log(message),
        onTurnPublished: (turnId) => {
          memoryRuntime?.onTurnPublished(turnId);
          if (imageStore !== undefined) {
            const provisionedImageStore = imageStore;
            void (async () => {
              const input = await store.getPublishedTurnImageInput(turnId);
              if (input === null) return;
              const local = DateTime.fromISO(input.replyCreatedAt, {
                zone: temporalSettings.timezone ?? "UTC",
              });
              const localDateTime = local.isValid
                ? local.toFormat("yyyy-MM-dd'T'HH:mm:ss.SSSZZ")
                : input.replyCreatedAt;
              await provisionedImageStore.enqueueTurn({
                turnId,
                patternId: input.selectedPatternId,
                userText: input.userText,
                companionResponse: input.reply,
                localDateTime,
              });
              imageRuntime?.notify();
            })().catch(() => {
              console.log(
                `[IMAGE] enqueue failed for turn ${turnId}; no image job was recorded`,
              );
            });
          }
        },
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
    if (articleRuntime !== undefined) {
      await articleRuntime.close().catch((error: unknown) => {
        console.error(
          `article runtime shutdown failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    }
    if (routineRuntime !== undefined) {
      await routineRuntime.close().catch((error: unknown) => {
        console.error(
          `routine runtime shutdown failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    }
    if (imageRuntime !== undefined) {
      await imageRuntime.close().catch((error: unknown) => {
        console.error(
          `image runtime shutdown failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    }
    await learning?.close();
    await closePostgresPool(pool);
  }
}

main().catch((error: unknown) => {
  console.error(
    `worker startup failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
