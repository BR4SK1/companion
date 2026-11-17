#!/usr/bin/env node
/**
 * Deployed non-production smoke test — a synthetic scenario through the
 * running application, retaining its conversation and normal learned effects
 * as intentional non-production history.
 *
 * This is deliberately NOT part of the local Playwright suite: it drives the
 * actual non-production deployment through its loopback test-entry gate
 * (kubectl port-forward; the gate is never exposed through a Service). The
 * scenario may invoke configured external providers that incur charges. The
 * conversation, traces, and learned state remain as non-production history.
 *
 * Required runtime safeguards (both required — the script refuses without
 * them):
 * - `E2E_DEPLOYED_SMOKE_ALLOWED=1` acknowledges external provider use and a
 *   non-production database write. It does not itself grant authorization.
 * - `E2E_DEPLOYED_SMOKE_EXCLUSIVE_DEV_ACCESS=1` records the operator's
 *   assertion of exclusive access for this run. This is an assertion, NOT an
 *   enforcement: the system cannot guarantee exclusivity. Provider usage and
 *   replay behavior depend on deployed configuration and are not hard-capped.
 *   Overlap checks fail closed before sending where possible and report later
 *   anomalies without deleting conversation or learned state.
 *
 * Safety design (fail-closed, stop-before-send, retain intentional history):
 * - Read-only preflight verifies the deployment (images, gate attestation,
 *   enablement), scenario linkage, thread quiescence, configuration
 *   fingerprint, and absence of unsettled prior smoke markers. It does not reject normal
 *   relationship questions, a fresh ingest cursor, or runnable consolidation.
 * - Attribution is exact: the marker IS the synthetic message's content
 *   (the web BFF assigns its own opaque client_key); the reply and turn are
 *   verified through that message's turn linkage and the conversation's
 *   persisted composition before the scenario is reported as retained.
 * - The thread is not transactionally exclusive: the operator acknowledges
 *   exclusive use and a pre-send state check detects observed overlap. Any
 *   unexpected overlap or scenario failure is reported accurately, and all
 *   existing conversation/learned state remains untouched.
 * - SIGINT/SIGTERM abort the journey and preserve any data that may have
 *   reached the worker before the process exits non-zero. A second signal
 *   exits immediately. SIGKILL cannot be handled: the ownership marker
 *   persisted before send (`$E2E_RUNS_DIR/deployed-smoke-last-marker.txt`)
 *   is the recovery trail for explicit historical recovery only.
 * - Output hygiene: the marker and any captured reply text are treated as
 *   secrets of this run. Evidence carries only ids, seqs, counts, statuses,
 *   attempt counts, timings, and a marker fingerprint — never message
 *   content, never the marker itself, never secrets (database credentials
 *   stay inside the worker pod's environment). All errors are rebuilt
 *   through a sanitizer that keeps only a step label and the error's first
 *   line (Playwright timeout errors would otherwise embed matched text and
 *   page snapshots) and redacts this run's secrets; the evidence block is
 *   redacted as a whole before printing.
 *
 * Explicit historical recovery: `node deployed-dev-smoke.mjs --recover
 * [marker]` may invoke legacy narrow deletion for an eligible
 * historical marker whose task-owned record is not tagged intentional
 * retention. The normal smoke path never invokes that cleanup machinery.
 * Recovery makes no provider calls and does not open the browser or forward.
 * It is safe to rerun for eligible historical cleanup records; normal
 * retained-run records are refused.
 */

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import { connect as tcpConnect } from "node:net";
import path from "node:path";
import process from "node:process";

import { chromium } from "@playwright/test";

import { resolveTaskRunsDir } from "./helpers/runs-dir.mjs";

import {
  buildMarker,
  buildPodActionScript,
  createShutdownController,
  evaluateExpectedHttpPromptModuleTrace,
  expectedHttpPromptModuleFromEnvironment,
  fingerprint,
  planCleanupDecision,
  planRetainedScenarioDecision,
  redactText,
  sanitizeError,
} from "./deployed-smoke-lib.mjs";

const NAMESPACE = process.env.E2E_DEPLOYED_NAMESPACE ?? "companion-np";
const GATE_PORT = Number(process.env.E2E_DEPLOYED_GATE_PORT ?? 3100);
const SMOKE_PREFIX = "e2e-deployed-smoke-";
const REPLY_TIMEOUT_MS = 180_000;
const SETTLE_TIMEOUT_MS = 90_000;
/** Overridable for tests; the operator run default is 30s. */
const GATE_WAIT_MS = Number(process.env.E2E_DEPLOYED_GATE_WAIT_MS ?? 30_000);
const RUNS_DIR = resolveTaskRunsDir();
const LAST_MARKER_FILE = path.join(RUNS_DIR, "deployed-smoke-last-marker.txt");
const BACKGROUND_CONVERGENCE_TIMEOUT_MS = 10 * 60_000;
let configurationFingerprintKey = randomBytes(32).toString("hex");

const evidence = {
  deployment: {},
  preflight: {},
  exclusivity: {
    acknowledgedByOperator: false,
    enforcedBySystem: false,
    providerContextMayIncludeUnrelatedConversation: true,
    providerCostsNotHardCapped: true,
    preSendOverlapCheck: "not-run",
    overlapDetected: false,
  },
  journey: {},
  provider: {},
  memory: {},
  retention: {},
  cleanup: {}, // populated only by explicit historical recovery
  postState: {},
};
const failures = [];
/** Secrets of this run: never allowed into any log, error, or evidence. */
const secrets = [];
const expectedHttpPromptModule = expectedHttpPromptModuleFromEnvironment(process.env);
if (expectedHttpPromptModule !== null) {
  secrets.push(expectedHttpPromptModule.id, expectedHttpPromptModule.definitionFingerprint);
}
const shutdown = createShutdownController();

/** The marker of this run, set before the send (used by cleanup/recovery). */
let sentMarker = null;
let scenarioStartedAt = null;
let baselineConfigurationFingerprint = null;

function log(message) {
  process.stdout.write(`[deployed-smoke] ${redactText(secrets, message)}\n`);
}

function fail(message) {
  process.stderr.write(`[deployed-smoke] ERROR: ${redactText(secrets, message)}\n`);
  process.exit(1);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Await a step's promise; on failure, rethrow a sanitized error. */
async function step(label, fn) {
  try {
    return await fn();
  } catch (error) {
    if (error?.name === "StopRequested") {
      throw error;
    }
    throw sanitizeError(secrets, error, label);
  }
}

function runCaptured(command, args, { input = undefined, timeoutMs = 120_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    if (input !== undefined) {
      child.stdin.on("error", () => {});
      child.stdin.write(input);
      child.stdin.end();
    }
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

async function kubectl(args, { input = undefined } = {}) {
  const result = await runCaptured("kubectl", args, { input, timeoutMs: 120_000 });
  if (result.code !== 0) {
    throw new Error(`kubectl ${args.join(" ")} failed: ${result.stderr.trim().slice(0, 400)}`);
  }
  return result.stdout;
}


/**
 * Run one structured action inside the running worker pod, where the
 * database credentials already live in the pod's environment. The pod-side
 * script is the fixed body above plus one injection-safe JSON constant; the
 * runner never assembles SQL. Secrets are never extracted or printed;
 * results are content-free.
 */
async function workerPodAction(payload) {
  const script = buildPodActionScript({ ...payload, configurationFingerprintKey });
  const result = await runCaptured(
    "kubectl",
    ["exec", "-i", "-n", NAMESPACE, "deploy/companion-worker", "--",
      "sh", "-c", "cd /app/libraries/postgres && node -"],
    { input: `${script}\n`, timeoutMs: 120_000 },
  );
  if (result.code !== 0) {
    throw sanitizeError(
      secrets,
      new Error(result.stderr.trim().slice(0, 400) || `exit ${String(result.code)}`),
      `worker pod action ${payload.action}`,
    );
  }
  const lines = result.stdout.split("\n").filter((line) => line.startsWith("SMOKE_JSON:"));
  if (lines.length === 0) {
    throw sanitizeError(secrets, new Error("no structured output"), `worker pod action ${payload.action}`);
  }
  const out = JSON.parse(lines.at(-1).slice("SMOKE_JSON:".length));
  if (out.ok !== true) {
    throw sanitizeError(secrets, new Error(out.error ?? "action failed"), `worker pod action ${payload.action}`);
  }
  return out;
}

function portBusy(port) {
  return new Promise((resolve) => {
    const socket = tcpConnect(port, "127.0.0.1");
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

async function waitForLocalGate(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(`http://127.0.0.1:${String(GATE_PORT)}/`, { redirect: "manual" });
      if (response.status > 0 && response.status < 500) {
        return;
      }
    } catch {
      // not ready yet
    }
    if (Date.now() > deadline) {
      throw new Error(`local gate forward on port ${String(GATE_PORT)} did not become ready`);
    }
    await sleep(300);
  }
}

// ---------------------------------------------------------------------------
// Preflight (read-only; any doubt stops before anything is sent)
// ---------------------------------------------------------------------------

async function preflight() {
  const namespaces = await kubectl(["get", "namespace", NAMESPACE, "-o", "name"]);
  if (!namespaces.includes(NAMESPACE)) {
    throw new Error(`namespace ${NAMESPACE} not found`);
  }

  const podsRaw = await kubectl([
    "get", "pods", "-n", NAMESPACE, "--field-selector", "status.phase=Running", "-o", "json",
  ]);
  const pods = JSON.parse(podsRaw).items;
  const webPods = pods.filter((pod) => pod.metadata.labels?.["app.kubernetes.io/name"] === "companion-web"
    || pod.metadata.name.startsWith("companion-web"));
  const workerPods = pods.filter((pod) => pod.metadata.labels?.["app.kubernetes.io/name"] === "companion-worker"
    || pod.metadata.name.startsWith("companion-worker"));
  if (webPods.length !== 1 || workerPods.length !== 1) {
    throw new Error(
      `expected exactly one running web and worker pod in ${NAMESPACE}, found ${String(webPods.length)}/${String(workerPods.length)}`,
    );
  }
  evidence.deployment = {
    namespace: NAMESPACE,
    webPod: webPods[0].metadata.name,
    webImage: webPods[0].spec.containers[0].image,
    webImageId: webPods[0].status.containerStatuses[0].imageID,
    workerPod: workerPods[0].metadata.name,
    workerImage: workerPods[0].spec.containers[0].image,
    workerImageId: workerPods[0].status.containerStatuses[0].imageID,
  };
  log(`web: ${evidence.deployment.webImage}`);
  log(`worker: ${evidence.deployment.workerImage}`);

  // Gate configuration: must be enabled, in the authorized non-production
  // attestation shape, and never exposed beyond the pod.
  const webDeployRaw = await kubectl([
    "get", "deploy", "companion-web", "-n", NAMESPACE, "-o", "json",
  ]);
  const webContainer = JSON.parse(webDeployRaw).spec.template.spec.containers[0];
  const env = Object.fromEntries((webContainer.env ?? []).map((entry) => [entry.name, entry.value]));
  if (env.WEB_TEST_GATE_ENABLED !== "true") {
    throw new Error("the deployed test-entry gate is not enabled — refusing (no routing around access)");
  }
  if (env.WEB_TEST_GATE_PORT !== String(GATE_PORT)) {
    throw new Error(`gate port mismatch: deployment says ${env.WEB_TEST_GATE_PORT}, configured ${String(GATE_PORT)}`);
  }
  if (env.COMPANION_DEPLOYMENT_PURPOSE !== "non-production" || env.COMPANION_DEPLOYMENT_NAMESPACE !== NAMESPACE) {
    throw new Error("the deployment-purpose attestation is not the authorized non-production shape");
  }
  evidence.preflight.gate = {
    enabled: true,
    port: GATE_PORT,
    attestation: `${env.COMPANION_DEPLOYMENT_PURPOSE}@${env.COMPANION_DEPLOYMENT_NAMESPACE}`,
  };
  const services = JSON.parse(await kubectl(["get", "svc", "-n", NAMESPACE, "-o", "json"])).items;
  const gateExposed = services.some((svc) =>
    (svc.spec.ports ?? []).some((port) => port.port === GATE_PORT || port.targetPort === GATE_PORT));
  evidence.preflight.gateExposedViaService = gateExposed;
  if (gateExposed) {
    log("WARNING: a Service exposes the gate port — reporting, but the pod-local forward is still used");
  }

  if (await portBusy(GATE_PORT)) {
    throw new Error(`local port ${String(GATE_PORT)} is already in use — refusing (no hijacking)`);
  }

  // Database linkage preflight (read-only, parameterized pod-side).
  const db = await workerPodAction({
    action: "preflight",
    smokePrefix: SMOKE_PREFIX,
    ...(expectedHttpPromptModule === null ? {} : { expectedHttpModule: expectedHttpPromptModule }),
  });
  if (expectedHttpPromptModule !== null) {
    evidence.preflight.expectedHttpPromptModule = { required: true };
    if (db.expectedHttpModuleConfigured !== true) {
      throw new Error("the expected HTTP prompt module is not enabled with every-turn activation; refusing before send");
    }
  }
  evidence.preflight.database = {
    tablesOk: db.tablesOk,
    clientKeyIndexed: db.clientKeyIndexed,
    oneReplyPerTurn: db.oneReplyPerTurn,
    historicalSmokeRows: db.leftoverSmokeRows,
    unsettledSmokeRows: db.unsettledSmokeRows,
    queuedUserMessages: db.queuedUserMessages,
    inFlightTurns: db.inFlightTurns,
    enabledPatterns: db.enabledPatterns,
    enabledPromptModules: db.enabledPromptModules,
    identityProvisioned: db.identityProvisioned,
    baselineMessages: db.baselineMessages,
    baselineTurns: db.baselineTurns,
    newestMessageAgeMinutes: db.newestMessageAgeMinutes,
    highestAllocatedSeq: db.highestAllocatedSeq,
    relationshipEnabledQuestions: db.relationshipEnabledQuestions,
    memorySchemaPresent: db.memorySchemaPresent,
    memoryEnabled: db.memoryEnabled,
    memoryIngestEnabled: db.memoryIngestEnabled,
    memoryRecallEnabled: db.memoryRecallEnabled,
    memoryAutopromoteEnabled: db.memoryAutopromoteEnabled,
    memoryEmbeddingConfigured: db.memoryEmbeddingConfigured,
    memoryIngestCursorInitialized: db.memoryIngestCursorInitialized,
    memoryIngestCursorCaughtUp: db.memoryIngestCursorCaughtUp,
    memoryNewFactsSinceConsolidation: db.memoryNewFactsSinceConsolidation,
    memoryConsolidationMayRun: db.memoryConsolidationMayRun,
    memoryActiveConsolidationRuns: db.memoryActiveConsolidationRuns,
    memoryUnrecordedPromotionRuns: db.memoryUnrecordedPromotionRuns,
    memoryPendingPromotions: db.memoryPendingPromotions,
    relationshipAnswerRows: db.relationshipAnswerRows,
    enabledPromptModules: db.enabledPromptModules,
    nextTemporalBoundaryMs: db.nextTemporalBoundaryMs,
  };
  baselineConfigurationFingerprint = db.configurationFingerprint;
  evidence.preflight.configurationFingerprint = db.configurationFingerprint;
  if (typeof db.configurationFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(db.configurationFingerprint)) {
    throw new Error("configuration fingerprint is unavailable; refusing to send");
  }
  if (!db.tablesOk || !db.clientKeyIndexed || !db.oneReplyPerTurn) {
    throw new Error("the deployed schema lacks expected conversation scenario linkage (tables/client_key index/one reply per turn)");
  }
  if (db.unsettledSmokeRows !== 0) {
    throw new Error(
      `${String(db.unsettledSmokeRows)} prior smoke row(s) are still unassigned, unreadable, or in flight — refusing to send`,
    );
  }
  if (db.queuedUserMessages !== 0 || db.inFlightTurns !== 0) {
    throw new Error(
      `the dev thread is not quiescent (queued=${String(db.queuedUserMessages)}, inFlight=${String(db.inFlightTurns)}) — refusing to send`,
    );
  }
  if (db.identityProvisioned !== 1) {
    throw new Error(
      "chat_identity is not provisioned in the deployed environment — a full turn cannot publish without the owner-authored identity; provision it and rerun",
    );
  }
  if (
    db.memorySchemaPresent !== true ||
    db.memoryEnabled !== true ||
    db.memoryIngestEnabled !== true ||
    db.memoryRecallEnabled !== true ||
    db.memoryEmbeddingConfigured !== true ||
    db.memoryIngestSettleMs + db.memoryChatTimeoutMs + 30_000 >= BACKGROUND_CONVERGENCE_TIMEOUT_MS
  ) {
    throw new Error(
      "normal-use preflight requires enabled memory ingest/recall and a configured embedding endpoint with bounded convergence; refusing before send",
    );
  }
  evidence.memory.expectedLearnedEffects = "retain the synthetic turn, trace, memory extraction/cache, semantic-shadow comparison, cursor/counters, and any ordinary relationship or shared derived-state updates";
  evidence.relationship = {
    enabledQuestions: db.relationshipEnabledQuestions,
    answerRowsBefore: db.relationshipAnswerRows,
    answersHaveTurnProvenance: false,
    note: "relationship answers are ordinary learned state and are retained; the schema does not attribute answer rows to a turn",
  };
  evidence.provider.expectedCalls = {
    chat: 1,
    decisions: db.enabledPatterns > 0 ? 1 : 0,
    promptModuleDecisions: db.enabledPromptModules > 0 ? 1 : 0,
    ...(expectedHttpPromptModule === null ? {} : { expectedHttpPromptModule: "required on the published attempt" }),
    relationshipExtraction: db.relationshipEnabledQuestions > 0 ? 1 : 0,
    memoryExtraction: "recorded after completion",
    note: "actual request-boundary counts are reported after the turn; retries may increase calls",
  };
  log(
    `preflight OK: gate open (attestation ${evidence.preflight.gate.attestation}), ` +
    `db idle (newest message ${String(db.newestMessageAgeMinutes)} min old), ` +
    `baseline ${String(db.baselineMessages)} messages / ${String(db.baselineTurns)} turns, ` +
    `relationship questions=${String(db.relationshipEnabledQuestions)}, ` +
    `memory cursor initialized=${String(db.memoryIngestCursorInitialized)}, ` +
    `consolidation may run=${String(db.memoryConsolidationMayRun)}; ` +
    "normal learned-state changes will be retained",
  );
}

// ---------------------------------------------------------------------------
// Port-forward lifecycle (owned by this process)
// ---------------------------------------------------------------------------

let forward = null;

async function startPortForward(podName) {
  const child = spawn(
    "kubectl",
    ["port-forward", "-n", NAMESPACE, `pod/${podName}`, `${String(GATE_PORT)}:${String(GATE_PORT)}`],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  forward = { child, stderr: () => stderr };
  await waitForLocalGate(GATE_WAIT_MS);
  log(`port-forward ready on 127.0.0.1:${String(GATE_PORT)} -> ${podName}`);
}

async function stopPortForward() {
  if (forward !== null && forward.child.exitCode === null) {
    forward.child.kill("SIGTERM");
    const deadline = Date.now() + 5000;
    while (forward.child.exitCode === null && Date.now() < deadline) {
      await sleep(100);
    }
    if (forward.child.exitCode === null) {
      forward.child.kill("SIGKILL");
    }
    log("port-forward stopped");
  }
  forward = null;
}

// ---------------------------------------------------------------------------
// The journey: a synthetic scenario, persisted reply, and refresh
//
// Content hygiene: the DOM is verified with STRUCTURAL locators only
// (`[data-last-bubble]` marks exactly the newest message's bubble); message
// text is compared Node-side and never placed into a locator, never logged,
// and never included in an error. Every step's errors are sanitized.
// ---------------------------------------------------------------------------

/** Poll `check` until true or the deadline; stop requests abort immediately. */
async function stepWait(label, timeoutMs, check) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(`${label}: not satisfied within ${String(timeoutMs / 1000)}s`);
    }
    await shutdown.waitOrStop(300);
  }
}

async function journey(gateOrigin, marker) {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await step("open gate", () => page.goto(`${gateOrigin}/`));
    const logConsole = page.getByRole("log", { name: "Conversation" });
    await step("wait for conversation log", () => logConsole.waitFor({ state: "visible", timeout: 30_000 }));
    evidence.journey.sessionIssued = true;

    // Right before sending: overlap + quiescence check against the
    // preflight baseline. The system cannot EXCLUDE other users (only the
    // operator's acknowledgement asserts exclusive access); if the thread
    // changed since preflight, stop before anything is sent.
    const preThread = await step("pre-send thread read", async () =>
      await (await context.request.get(`${gateOrigin}/api/thread`)).json());
    if (preThread.status.queued !== 0 || preThread.status.generating !== false) {
      evidence.exclusivity.preSendOverlapCheck = "failed-quiescence";
      throw new Error("the thread stopped being quiescent right before the send — aborting before any provider call");
    }
    if (preThread.messages.length !== evidence.preflight.database.baselineMessages) {
      evidence.exclusivity.preSendOverlapCheck = "failed-overlap";
      evidence.exclusivity.overlapDetected = true;
      throw new Error("the thread changed between preflight and the send — aborting before any provider call (exclusive dev access was not held)");
    }
    evidence.exclusivity.preSendOverlapCheck = "passed";
    evidence.journey.baselineMessageCount = preThread.messages.length;
    const preSendFingerprint = await step("pre-send configuration fingerprint", () =>
      workerPodAction({ action: "configuration-fingerprint" }));
    evidence.preflight.preSendConfigurationFingerprint = preSendFingerprint.configurationFingerprint;
    if (preSendFingerprint.configurationFingerprint !== baselineConfigurationFingerprint) {
      evidence.exclusivity.overlapDetected = true;
      throw new Error("provisioned configuration changed between preflight and send; aborting before any provider call");
    }
    const markerCheck = await step("pre-send unique marker check", () =>
      workerPodAction({ action: "marker-check", marker }));
    if (markerCheck.markerRows !== 0) {
      evidence.exclusivity.overlapDetected = true;
      throw new Error("the generated scenario marker already exists; aborting before any provider call");
    }

    const lastBubble = logConsole.locator("[data-last-bubble]");

    await step("compose message", () => page.getByPlaceholder("Message").fill(marker));
    await step("send message", () => page.getByRole("button", { name: "Send message" }).click());
    await step("composer ready again", () => page.getByPlaceholder("Message").waitFor({ state: "visible", timeout: 10_000 }));
    const sentAt = Date.now();

    // Our message becomes the newest bubble: verified structurally, text
    // compared Node-side (never logged).
    await stepWait("our message visible as the newest bubble", 20_000, async () => {
      const count = await lastBubble.count();
      if (count !== 1) {
        return false;
      }
      return (await lastBubble.innerText()) === marker;
    });
    evidence.journey.userMessageAcceptedInUi = true;

    // The reply arrives through the real worker + real provider (bounded).
    const replyDeadline = Date.now() + REPLY_TIMEOUT_MS;
    let userMessage = null;
    let reply = null;
    for (;;) {
      const thread = await step("reply-poll thread read", async () =>
        await (await context.request.get(`${gateOrigin}/api/thread`)).json());
      userMessage = thread.messages.find((message) => message.text === marker) ?? null;
      if (userMessage !== null) {
        reply = thread.messages.find(
          (message) => message.role === "assistant" && Number(message.seq) > Number(userMessage.seq),
        ) ?? null;
      }
      if (reply !== null) {
        break;
      }
      if (Date.now() > replyDeadline) {
        throw new Error(
          `no reply arrived within ${String(REPLY_TIMEOUT_MS / 1000)}s ` +
          `(user message ${userMessage === null ? "not yet" : "seen"}; the scenario remains for post-run verification)`,
        );
      }
      await shutdown.waitOrStop(1500);
    }
    // Treat the reply text as a run secret from here on.
    secrets.push(reply.text);
    evidence.journey.userMessageId = userMessage.id;
    evidence.journey.userMessageSeq = Number(userMessage.seq);
    evidence.journey.replyMessageId = reply.id;
    evidence.journey.replyMessageSeq = Number(reply.seq);
    evidence.journey.replyLatencyMs = Date.now() - sentAt;

    // The reply is rendered as the newest bubble (structural check; the
    // exact content is compared Node-side and never logged).
    await stepWait("reply visible as the newest bubble", 30_000, async () => {
      const count = await lastBubble.count();
      if (count !== 1) {
        return false;
      }
      return (await lastBubble.innerText()) === reply.text;
    });
    evidence.journey.replyVisibleInUi = true;

    const duringFingerprint = await step("post-reply configuration fingerprint", () =>
      workerPodAction({ action: "configuration-fingerprint" }));
    evidence.preflight.postReplyConfigurationFingerprint = duringFingerprint.configurationFingerprint;
    if (duringFingerprint.configurationFingerprint !== baselineConfigurationFingerprint) {
      failures.push("configuration-invariance check failed during the journey: provisioned configuration changed; all scenario history remains retained");
    }

    // Post-send overlap accounting: exactly our message + its reply may have
    // appeared; anything else is an overlap anomaly (retained, reported).
    const afterThread = await step("post-reply thread read", async () =>
      await (await context.request.get(`${gateOrigin}/api/thread`)).json());
    evidence.journey.messageCountAfterReply = afterThread.messages.length;
    evidence.journey.threadStatus = afterThread.status;
    const ourCount = afterThread.messages.filter((message) => message.text === marker).length;
    if (ourCount !== 1 || afterThread.messages.length !== evidence.journey.baselineMessageCount + 2) {
      evidence.exclusivity.overlapDetected = true;
      failures.push("overlap anomaly: the thread gained unexpected messages during the run; all observed conversation and learned state remains retained");
    }

    // Persistence across a refresh.
    await step("reload", () => page.reload());
    await step("conversation log after reload", () => logConsole.waitFor({ state: "visible", timeout: 30_000 }));
    await stepWait("our reply persisted across refresh", 30_000, async () => {
      const count = await lastBubble.count();
      return count === 1 && (await lastBubble.innerText()) === reply.text;
    });
    evidence.journey.persistedAcrossRefresh = true;

    return { userMessageId: userMessage.id, userSeq: Number(userMessage.seq) };
  } finally {
    await browser.close();
  }
}

// ---------------------------------------------------------------------------
// Legacy explicit recovery cleanup (normal smoke never calls this path)
// ---------------------------------------------------------------------------

async function persistOwnershipRecord(mode, detail) {
  try {
    fs.mkdirSync(RUNS_DIR, { recursive: true });
    const marker = sentMarker;
    const record = {
      markerFingerprint: fingerprint(marker),
      mode,
      detail,
      configurationFingerprint: baselineConfigurationFingerprint,
      configurationFingerprintKey,
      at: new Date().toISOString(),
      recoverWith: `E2E_DEPLOYED_SMOKE_ALLOWED=1 node ${path.basename(import.meta.url)} --recover`,
    };
    // The marker itself is required for recovery; this file lives in the
    // gitignored local run directory and contains only synthetic data.
    fs.writeFileSync(
      path.join(RUNS_DIR, `deployed-smoke-ownership-${fingerprint(marker)}.json`),
      `${JSON.stringify({ ...record, marker }, null, 2)}\n`,
    );
    log(`ownership record persisted for recovery: ${record.markerFingerprint} (${mode})`);
    return true;
  } catch {
    // The caller must not send unless this recovery record can be persisted.
    return false;
  }
}

/**
 * Bounded wait for the in-flight turn to settle; honors stop requests.
 * Resolves true when the turn has settled, false on timeout or stop.
 */
async function waitForTurnSettle() {
  const deadline = Date.now() + SETTLE_TIMEOUT_MS;
  for (;;) {
    const probe = await workerPodAction({ action: "probe", marker: sentMarker });
    if (probe.turn === null || probe.turn.status !== "in_flight") {
      return true;
    }
    if (Date.now() > deadline) {
      return false;
    }
    try {
      await shutdown.waitOrStop(2000);
    } catch {
      return false; // stop requested mid-wait: retain
    }
  }
}

async function waitForMemoryBackgroundQuiescence(turnId) {
  const deadline = Date.now() + BACKGROUND_CONVERGENCE_TIMEOUT_MS;
  for (;;) {
    const status = await workerPodAction({ action: "background-status", turnId });
    evidence.memory.background = {
      turnStatus: status.turn?.status ?? null,
      traceAttempts: status.traceAttempts,
      semanticShadowAttempts: status.semanticShadowAttempts,
      semanticShadowFailures: status.semanticShadowFailures,
      recallOperations: status.recallOperations,
      factExtractionOperations: status.factExtractionOperations,
      extractionCacheRows: status.extractionCacheRows,
      memoryProviderCalls: status.memoryProviderCalls,
      ingestCursorPassed: status.ingestCursorPassed,
      runTurns: status.runTurns,
      mixedRuns: status.mixedRuns,
      sharedOperationRows: status.sharedOperationRows,
      activeRuns: status.activeRuns,
      unrecordedRunPromotions: status.unrecordedRunPromotions,
      pendingPromotions: status.pendingPromotions,
      appliedPromotionItems: status.appliedPromotionItems,
      pendingFactEmbeddings: status.pendingFactEmbeddings,
      temporalReferences: status.temporalReferences,
    };
    const turnSettled = status.turn?.status === "completed" || status.turn?.status === "failed";
    const shadowSettled = status.semanticShadowAttempts >= status.recallOperations &&
      status.recallOperations >= status.traceAttempts;
    const ingestionSettled = status.turn?.status !== "completed" || (
      status.ingestCursorPassed === true &&
      (status.factExtractionOperations > 0 || status.extractionCacheRows > 0)
    );
    const derivedSettled = status.pendingFactEmbeddings === 0 &&
      status.activeRuns === 0 && status.unrecordedRunPromotions === 0 &&
      status.pendingPromotions === 0;
    if (turnSettled && shadowSettled && ingestionSettled && derivedSettled) {
      if (status.semanticShadowFailures > 0) {
        failures.push("semantic shadow comparison failed for the synthetic turn; all resulting evidence remains retained");
      }
      if (
        status.mixedRuns > 0 ||
        status.sharedOperationRows > 0 ||
        status.appliedPromotionItems > 0
      ) {
        return { settled: true, unsafeDerivedState: true };
      }
      return { settled: true, unsafeDerivedState: false };
    }
    if (Date.now() >= deadline || shutdown.requested) {
      return { settled: false, unsafeDerivedState: false };
    }
    await shutdown.waitOrStop(2_000).catch(() => undefined);
  }
}

async function cleanupPhase() {
  const marker = sentMarker;
  let backgroundWaitedTurnId = null;
  if (marker === null) {
    evidence.cleanup = { mode: "nothing-to-clean", reason: "no marker was ever generated (failure before the send)" };
    return;
  }
  for (let iteration = 0; iteration < 4; iteration += 1) {
    const probe = await workerPodAction({ action: "probe", marker });
    const decision = planCleanupDecision({
      message: probe.message,
      turn: probe.turn ?? null,
      composition: probe.composition ?? null,
      ourUserMessageInTurn: probe.ourUserMessageInTurn === true,
    });
    if (
      decision.mode === "full-turn" &&
      probe.turn !== undefined &&
      probe.turn !== null &&
      (probe.turn.status === "completed" || probe.turn.status === "failed") &&
      backgroundWaitedTurnId !== probe.turn.id
    ) {
      const background = await waitForMemoryBackgroundQuiescence(probe.turn.id);
      if (!background.settled || background.unsafeDerivedState) {
        const reason = !background.settled
          ? "bounded memory/semantic background convergence did not settle; scenario and shared state were retained"
          : "scenario processing mixed with other turns or applied shared promotion artifacts; nothing was deleted";
        evidence.cleanup = { mode: "retain", reason, turnId: probe.turn.id };
        failures.push(`cleanup retained data: ${reason}`);
        await persistOwnershipRecord("retain", reason);
        return;
      }
      backgroundWaitedTurnId = probe.turn.id;
      continue;
    }
    if (decision.mode === "nothing-to-clean") {
      evidence.cleanup = { mode: "nothing-to-clean", reason: decision.reason ?? "the synthetic message never persisted" };
      log("nothing to clean: the synthetic message never reached the database");
      return;
    }
    if (decision.mode === "queued-atomic-delete") {
      const result = await workerPodAction({ action: "delete-queued", messageId: probe.message.id, marker });
      if (result.rowCount === 1) {
        evidence.cleanup = {
          mode: "queued-message-deleted",
          messageDeleted: probe.message.id,
          deletedMessageCount: 1,
          preCleanupTotals: { messages: probe.totalMessages, turns: probe.totalTurns },
          atomicGuard: "turn_id IS NULL (race-safe against the worker claim)",
        };
        return;
      }
      // Deleted nothing: the row was claimed (or changed) between probe and
      // delete. Loop once more; the re-probe decides the new state.
      continue;
    }
    if (decision.mode === "turn-path") {
      const settled = await waitForTurnSettle();
      if (!settled) {
        const reason = shutdown.requested
          ? "shutdown requested while the turn was in flight; nothing was deleted"
          : "the turn is still in flight after the bounded wait; nothing was deleted";
        evidence.cleanup = { mode: "retain", reason, turnId: probe.turn.id };
        failures.push(`cleanup retained data: ${reason}`);
        await persistOwnershipRecord("retain", reason);
        return;
      }
      continue;
    }
    if (decision.mode === "full-turn") {
      const result = await workerPodAction({
        action: "delete-full-turn", turnId: probe.turn.id, messageId: probe.message.id, marker,
      });
      if (result.deleted === true) {
        evidence.provider.turn = result.turn;
        evidence.provider.turnComposition = result.composition;
        evidence.cleanup = {
          mode: "full-turn",
          deletedTurnId: probe.turn.id,
          deletedMessageIds: result.deletedMessageIds,
          deletedMessageCount: result.deletedMessageCount,
          deletedTurnCount: 1,
          preCleanupTotals: { messages: probe.totalMessages, turns: probe.totalTurns },
          transactionallyReverified: true,
        };
        return;
      }
      // Verification inside the transaction failed: nothing was deleted.
      evidence.provider.turn = result.turn ?? null;
      evidence.provider.turnComposition = result.composition ?? null;
      const reason = `full-turn transaction verification failed (${String(result.reason)}); nothing was deleted`;
      evidence.cleanup = { mode: "retain", reason, turnId: probe.turn.id };
      failures.push(`cleanup retained data: ${reason}`);
      await persistOwnershipRecord("retain", reason);
      return;
    }
    // retain
    evidence.cleanup = { mode: "retain", reason: decision.reason, turnId: probe.turn?.id ?? null };
    failures.push(`cleanup retained data: ${decision.reason}`);
    await persistOwnershipRecord("retain", decision.reason);
    return;
  }
  const reason = "cleanup did not converge within its bounded re-probe loop; nothing further was attempted";
  evidence.cleanup = { mode: "retain", reason };
  failures.push(`cleanup retained data: ${reason}`);
  await persistOwnershipRecord("retain", reason);
}

function recordExpectedHttpPromptModuleResult(trace) {
  if (expectedHttpPromptModule === null) return;
  const result = evaluateExpectedHttpPromptModuleTrace(trace);
  evidence.provider.expectedHttpPromptModule = {
    required: true,
    passed: result.passed,
    result: result.reason,
  };
  if (!result.passed) {
    failures.push(`required HTTP prompt-module trace verification failed (${result.reason}); all scenario history remains retained`);
  }
}

async function verifyRetainedScenario() {
  if (sentMarker === null) {
    evidence.retention = { mode: "no-scenario-to-retain", reason: "no marker was generated before setup failed" };
    return;
  }

  let probe = await workerPodAction({ action: "probe", marker: sentMarker });
  if (probe.message === null || probe.message.turnId === null || probe.turn === null || probe.turn === undefined) {
    const reason = probe.message === null
      ? "the synthetic message did not persist"
      : "the synthetic message is not yet associated with a readable turn";
    const finalFingerprint = await workerPodAction({ action: "configuration-fingerprint" });
    evidence.postState.configurationFingerprint = finalFingerprint.configurationFingerprint;
    evidence.retention = {
      mode: probe.message === null ? "no-scenario-persisted" : "retained-unverified",
      retainedIntentionally: true,
      reason,
      rowsDeleted: 0,
    };
    if (evidence.journey.userMessageAcceptedInUi === true || probe.message !== null) {
      failures.push(`retained-scenario verification failed: ${reason}; nothing was deleted`);
    }
    if (finalFingerprint.configurationFingerprint !== baselineConfigurationFingerprint) {
      failures.push("configuration-invariance check failed after the journey: provisioned configuration changed or was unavailable");
    }
    await persistOwnershipRecord(probe.message === null ? "no-scenario-persisted" : "retained-unverified", reason);
    recordExpectedHttpPromptModuleResult(null);
    return;
  }

  if (probe.turn.status === "in_flight") {
    const settled = await waitForTurnSettle();
    if (settled) {
      probe = await workerPodAction({ action: "probe", marker: sentMarker });
    }
  }

  let background = { settled: false, unsafeDerivedState: false };
  if (probe.turn !== null && probe.turn !== undefined) {
    background = await waitForMemoryBackgroundQuiescence(probe.turn.id);
  }
  const state = probe.message === null || probe.turn === null || probe.turn === undefined
    ? null
    : await workerPodAction({
      action: "retained-state",
      marker: sentMarker,
      messageId: probe.message.id,
      turnId: probe.turn.id,
      startedAt: scenarioStartedAt ?? new Date().toISOString(),
      ...(expectedHttpPromptModule === null ? {} : { expectedHttpModule: expectedHttpPromptModule }),
    });
  recordExpectedHttpPromptModuleResult(state?.expectedHttpModuleTrace ?? null);

  if (state !== null) {
    evidence.journey.persistedAssociation = {
      userMessageId: state.message?.id ?? null,
      userMessageSeq: state.message?.seq ?? null,
      turnId: state.turn?.id ?? null,
      turnStatus: state.turn?.status ?? null,
      composition: state.composition?.map((entry) => ({ id: entry.id, role: entry.role })) ?? [],
      markerAssociationVerified: state.ourUserMessageInTurn === true,
      retainedTurnMessageCount: state.scenarioTurnMessages,
      retainedMarkerRows: state.scenarioMarkerRows,
    };
    evidence.provider = {
      ...evidence.provider,
      requestBoundaries: {
        totalObservedOrPathDerived: state.providerRequestsObserved,
        responsePatternDecisions: { requests: state.decisionRequests, responses: state.decisionResponses },
        chat: { requests: state.chatRequests, responses: state.chatResponses },
        promptModuleDecisions: state.promptModuleDecisionRequests,
        memoryFactExtraction: state.memoryProviderCalls,
        relationshipExtraction: {
          callsDerivedFromEnabledQuestionsAndCompletedChat: state.relationshipExtractionProviderCalls,
          enabledQuestions: state.relationshipEnabledQuestions,
          independentlyTraced: false,
        },
        semanticShadowEmbeddingCalls: "served by the configured embedding service",
      },
      turn: { id: state.turn?.id ?? null, status: state.turn?.status ?? null },
    };
    evidence.memory.scenario = {
      factRows: state.memoryFacts,
      semanticShadowAttempts: state.semanticShadowAttempts,
      semanticShadowOutcomes: state.semanticShadowOutcomes,
      semanticOnlyCandidates: state.semanticOnlyCandidates,
      candidateCountsByArm: state.shadowCandidateCountsByArm,
      chatContextChunks: state.chatContextChunks,
      semanticShadowContextMessages: state.semanticShadowContextMessages,
      sharedDerivedStateObserved: background.unsafeDerivedState,
      note: "semantic-shadow comparisons are retained; source query text and candidate content are not emitted",
    };
    evidence.relationship.answerRowsAfter = state.relationshipAnswerCount;
    evidence.relationship.answersUpdatedSinceScenarioStart = state.relationshipAnswersUpdatedSinceStart;
    evidence.postState = {
      messages: state.messages,
      turns: state.turns,
      configurationFingerprint: state.configurationFingerprint,
      scenarioMarkerRows: state.scenarioMarkerRows,
      scenarioTurnMessages: state.scenarioTurnMessages,
    };
  }

  const configurationInvariant = state !== null &&
    state.configurationFingerprint === baselineConfigurationFingerprint &&
    evidence.preflight.preSendConfigurationFingerprint === baselineConfigurationFingerprint &&
    evidence.preflight.postReplyConfigurationFingerprint === baselineConfigurationFingerprint;
  const decision = planRetainedScenarioDecision({
    message: state?.message ?? probe.message,
    turn: state?.turn ?? probe.turn,
    composition: state?.composition ?? probe.composition,
    ourUserMessageInTurn: state?.ourUserMessageInTurn ?? probe.ourUserMessageInTurn,
    backgroundSettled: background.settled,
    configurationInvariant,
  });
  evidence.retention = {
    mode: decision.mode,
    retainedIntentionally: true,
    reason: decision.reason,
    turnId: state?.turn?.id ?? probe.turn?.id ?? null,
    messageId: state?.message?.id ?? probe.message?.id ?? null,
    sharedDerivedStateObserved: background.unsafeDerivedState,
    rowsDeleted: 0,
  };
  if (decision.mode !== "retained-intentionally") {
    failures.push(`retained-scenario verification failed: ${decision.reason}; all scenario and learned state remains retained`);
  }
  if (state !== null && state.scenarioMarkerRows !== 1) {
    failures.push(`retained-scenario evidence mismatch: expected one uniquely marked user message, found ${String(state.scenarioMarkerRows)}`);
  }
  if (state !== null && (state.chatRequests < 1 || state.chatResponses < 1)) {
    failures.push("retained-scenario trace is missing the real chat request/response boundary");
  }
  if (state !== null && state.semanticShadowContextMessages !== 0) {
    failures.push("semantic-shadow-labeled content appeared in chat context; scenario remains retained for review");
  }
  if (state !== null && !evidence.exclusivity.overlapDetected) {
    if (state.messages !== evidence.preflight.database.baselineMessages + 2) {
      failures.push(`post-state message count mismatch: expected baseline plus the retained user/reply pair, found ${String(state.messages)}`);
    }
    if (state.turns !== evidence.preflight.database.baselineTurns + 1) {
      failures.push(`post-state turn count mismatch: expected baseline plus the retained turn, found ${String(state.turns)}`);
    }
  }
  if (!(await persistOwnershipRecord("intentional-retention", "verified normal-use conversation and learned effects intentionally remain in non-production history"))) {
    failures.push("could not update the local ownership record after the scenario; deployed scenario history remains retained");
  }
}

async function verifyPostState() {
  const post = await workerPodAction({ action: "post-state", smokePrefix: SMOKE_PREFIX });
  evidence.postState = {
    smokeRows: post.smokeRows,
    messages: post.messages,
    turns: post.turns,
    queuedUserMessages: post.queuedUserMessages,
    inFlightTurns: post.inFlightTurns,
    configurationFingerprint: post.configurationFingerprint,
  };
  if (
    baselineConfigurationFingerprint === null ||
    post.configurationFingerprint !== baselineConfigurationFingerprint
  ) {
    failures.push("configuration-invariance check failed: provisioned configuration fingerprint changed or was unavailable");
    await persistOwnershipRecord("configuration-drift", "configuration fingerprint mismatch or unavailable");
  }
  if (post.smokeRows !== 0) {
    failures.push(`post-state check failed: ${String(post.smokeRows)} synthetic row(s) remain`);
    await persistOwnershipRecord("post-state-residue", `${String(post.smokeRows)} synthetic row(s) remain`);
  }
  // Count invariant, independent of run vs recovery mode: the post-state
  // totals must equal the pre-cleanup totals minus exactly the rows this
  // run recorded deleting. (Retained runs are not count-asserted: the
  // retention failure is already recorded and the remaining rows are
  // exactly what was deliberately kept.)
  const totals = evidence.cleanup.preCleanupTotals;
  const deletedMessages = evidence.cleanup.deletedMessageCount ?? 0;
  const deletedTurns = evidence.cleanup.deletedTurnCount ?? 0;
  if (evidence.cleanup.mode !== "retain" && totals !== undefined) {
    if (post.messages !== totals.messages - deletedMessages) {
      const detail = `messages ${String(post.messages)} != expected ${String(totals.messages - deletedMessages)}`;
      failures.push(`post-state count mismatch: ${detail}`);
      await persistOwnershipRecord("post-state-count-mismatch", detail);
    }
    if (post.turns !== totals.turns - deletedTurns) {
      const detail = `turns ${String(post.turns)} != expected ${String(totals.turns - deletedTurns)}`;
      failures.push(`post-state count mismatch: ${detail}`);
      await persistOwnershipRecord("post-state-count-mismatch", detail);
    }
  }
}

// ---------------------------------------------------------------------------
// Idempotent verified recovery (no browser, no provider calls, no forward)
// ---------------------------------------------------------------------------

async function recover(marker) {
  if (!marker.startsWith(SMOKE_PREFIX)) {
    fail("refusing to recover: the marker does not have the e2e-deployed-smoke- prefix");
  }
  const recordPath = path.join(RUNS_DIR, `deployed-smoke-ownership-${fingerprint(marker)}.json`);
  let record;
  try {
    record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
  } catch {
    throw new Error("refusing recovery without a verified task-owned configuration fingerprint record");
  }
  if (record.mode === "intentional-retention") {
    throw new Error("refusing recovery: this smoke recorded the scenario as intentional non-production history");
  }
  if (
    record.marker !== marker ||
    !/^[a-f0-9]{64}$/.test(record.configurationFingerprint ?? "") ||
    !/^[a-f0-9]{64}$/.test(record.configurationFingerprintKey ?? "")
  ) {
    throw new Error("refusing recovery without a verified task-owned configuration fingerprint record");
  }
  baselineConfigurationFingerprint = record.configurationFingerprint;
  configurationFingerprintKey = record.configurationFingerprintKey;
  sentMarker = marker;
  secrets.push(marker);
  evidence.recovery = { markerFingerprint: fingerprint(marker) };
  log(`recovery: verifying and cleaning marker ${fingerprint(marker)} (idempotent; no provider calls)`);
  const baseline = await workerPodAction({ action: "preflight", smokePrefix: SMOKE_PREFIX });
  evidence.preflight.database = {
    leftoverSmokeRows: baseline.leftoverSmokeRows,
    baselineMessages: baseline.baselineMessages,
    baselineTurns: baseline.baselineTurns,
  };
  await cleanupPhase();
  await verifyPostState();
}

// ---------------------------------------------------------------------------

function parseArgs(argv) {
  if (argv.includes("--recover")) {
    const index = argv.indexOf("--recover");
    const value = argv[index + 1];
    return { mode: "recover", markerArg: value !== undefined && !value.startsWith("--") ? value : null };
  }
  return { mode: "run" };
}

function readPersistedMarker() {
  try {
    const raw = fs.readFileSync(LAST_MARKER_FILE, "utf8").trim();
    return raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

if (process.env.E2E_DEPLOYED_SMOKE_ALLOWED !== "1") {
  fail(
    "refusing to run: external provider use and a retained non-production write require the guarded smoke. " +
    "Set E2E_DEPLOYED_SMOKE_ALLOWED=1 to acknowledge these effects; authorization is still required.",
  );
}
const args = parseArgs(process.argv.slice(2));

if (args.mode === "recover") {
  const marker = args.markerArg ?? readPersistedMarker();
  if (marker === null) {
    fail(`no marker given and none persisted at ${LAST_MARKER_FILE}`);
  }
  try {
    await recover(marker);
  } catch (error) {
    failures.push(`recovery: ${error instanceof Error ? error.message : String(error)}`);
  }
} else {
  if (process.env.E2E_DEPLOYED_SMOKE_EXCLUSIVE_DEV_ACCESS !== "1") {
    fail(
      "refusing to run: exclusive access must be asserted by the operator " +
      "(E2E_DEPLOYED_SMOKE_EXCLUSIVE_DEV_ACCESS=1). This records an assertion only; " +
      "the system cannot enforce exclusivity, and provider usage/replay are not hard-capped.",
    );
  }
  evidence.exclusivity.acknowledgedByOperator = true;
  try {
    await preflight();
    const podName = evidence.deployment.webPod;
    const gateOrigin = `http://127.0.0.1:${String(GATE_PORT)}`;
    const marker = buildMarker();
    sentMarker = marker;
    secrets.push(marker);
    evidence.journey.markerFingerprint = fingerprint(marker);
    try {
      fs.mkdirSync(RUNS_DIR, { recursive: true });
      fs.writeFileSync(LAST_MARKER_FILE, `${marker}\n`);
    } catch {
      throw new Error("could not persist the task-owned recovery marker; refusing to send");
    }
    if (!(await persistOwnershipRecord("prepared", "recovery marker persisted before synthetic send"))) {
      throw new Error("could not persist the task-owned recovery record; refusing to send");
    }
    const baseline = {
      messages: evidence.preflight.database.baselineMessages,
      turns: evidence.preflight.database.baselineTurns,
    };
    let journeyError = null;
    scenarioStartedAt = new Date().toISOString();
    try {
      await startPortForward(podName);
      await journey(gateOrigin, marker);
    } catch (error) {
      if (error?.name === "StopRequested") {
        journeyError = `graceful stop (${shutdown.signal}): the journey was aborted and retained-state verification ran`;
        log(journeyError);
      } else {
        journeyError = error instanceof Error ? error.message : String(error);
        failures.push(`journey: ${journeyError}`);
      }
    }
    // From here on, verification runs no matter what the journey did: the
    // send may already have reached the worker and provider. Normal operation
    // never invokes the historical deletion path; scenario and learned state
    // are deliberately retained even when verification reports a failure.
    await verifyRetainedScenario();
    if (journeyError !== null && !journeyError.startsWith("graceful stop")) {
      log(`journey failed (scenario retained; post-state verification ran): ${journeyError}`);
    }
  } catch (error) {
    failures.push(`preflight/setup: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await stopPortForward();
  }
}

// The evidence block is redacted as a whole before printing: no marker, no
// reply text, no content can survive into the output even if a future edit
// puts one into the evidence structure by mistake.
process.stdout.write(`\n[deployed-smoke] EVIDENCE ${redactText(secrets, JSON.stringify(evidence, null, 2))}\n`);

if (shutdown.requested) {
  process.stderr.write(`[deployed-smoke] STOPPED (${shutdown.signal}) after retained-state verification; scenario data was not deleted\n`);
}
if (failures.length > 0) {
  process.stderr.write(
    `[deployed-smoke] FAILED (${String(failures.length)}):\n${failures.map((f) => `  - ${redactText(secrets, f)}`).join("\n")}\n`,
  );
  process.exit(1);
}
if (shutdown.requested) {
  process.exit(1);
}
log("SMOKE PASSED (send -> persisted reply -> UI/refresh verified; synthetic conversation and learned effects intentionally retained)");
