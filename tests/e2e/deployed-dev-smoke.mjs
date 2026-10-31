#!/usr/bin/env node
/**
 * Deployed non-production smoke test — one synthetic message through the
 * REAL deployed dev stack (real billable provider), with guaranteed targeted
 * cleanup of exactly its own data.
 *
 * This is deliberately NOT part of the Playwright suite and NOT part of the
 * local fake-provider stack: it drives the actual running non-production
 * deployment through its loopback test-entry gate (kubectl port-forward,
 * pod-local; the gate is never exposed through a Service), makes exactly one
 * synthetic user message's worth of provider calls against the REAL
 * (billable) OpenRouter, and then removes exactly the rows it created.
 *
 * Authorization (both required, both explicit — the script refuses without
 * them):
 * - `E2E_DEPLOYED_SMOKE_ALLOWED=1` authorizes the billable provider call and
 *   the non-production database write. Running this is never a byproduct of
 *   the ordinary suite.
 * - `E2E_DEPLOYED_SMOKE_EXCLUSIVE_DEV_ACCESS=1` is the OPERATOR'S explicit
 *   acknowledgement that this dev stack is in exclusively their use for the
 *   duration of the run. This is an assertion, NOT an enforcement: the
 *   system cannot prevent another user's message from being ingested before
 *   or during the run, and the worker's chat request includes the thread's
 *   visible history — so unrelated conversation can enter the provider
 *   context, and provider call costs and any replay behavior are not
 *   hard-capped by this script (the one-call expectation is derived from
 *   deployed configuration, not enforced). Overlap is detected
 *   conservatively: a pre-send state check aborts before anything is sent
 *   if the thread changed since preflight, and post-send composition checks
 *   make cleanup conservative when a turn was shared.
 *
 * Safety design (fail-closed, stop-before-send, preserve-when-uncertain):
 * - Read-only preflight of the deployment (images, gate attestation, gate
 *   enabled), the database schema's cleanup linkage, thread quiescence, and
 *   the absence of leftover synthetic rows. Any doubt stops the run BEFORE
 *   anything is sent; there is no broad database reset anywhere.
 * - Attribution is exact: the marker IS the synthetic message's content
 *   (the web BFF assigns its own opaque client_key); reply and turn derive
 *   only through that message's turn linkage, and the turn's composition is
 *   re-verified INSIDE the deletion transaction (turn row locked FOR UPDATE)
 *   so a concurrent mutation rolls back instead of over-deleting.
 * - The queued-message cleanup is a single atomic guarded delete
 *   (`… AND turn_id IS NULL`): against the worker's claim (`SELECT … FOR
 *   UPDATE` on pending rows, then `UPDATE … SET turn_id WHERE turn_id IS
 *   NULL`) it either deletes a still-unassigned row or deletes nothing and
 *   the run re-probes — it can never delete a row the worker has claimed or
 *   is claiming.
 * - Conservative cleanup: shared turn → only this run's own row (turn-
 *   scoped, id- and content-guarded); unreadable turn, timed-out wait,
 *   shutdown during a wait, transaction verification failure, or any
 *   uncertain state → RETAIN everything, persist an ownership record, and
 *   report; in-flight turns are waited out and never touched.
 * - SIGINT/SIGTERM are graceful: the journey aborts, the awaited cleanup
 *   still runs, and only then does the process exit non-zero. A second
 *   signal exits immediately. SIGKILL cannot be handled: the ownership
 *   marker persisted before the send (`.runs/deployed-smoke-last-marker.txt`)
 *   is the recovery trail — see `--recover`.
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
 * Recovery: `node deployed-dev-smoke.mjs --recover [marker-or-file]` runs
 * ONLY the idempotent, verified cleanup for a recorded marker (no browser,
 * no provider calls, no port-forward). It is safe to re-run: an already-
 * cleaned marker verifies as nothing-to-clean.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import { connect as tcpConnect } from "node:net";
import path from "node:path";
import process from "node:process";

import { chromium } from "@playwright/test";

import {
  buildMarker,
  buildPodActionScript,
  createShutdownController,
  fingerprint,
  planCleanupDecision,
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
const RUNS_DIR = process.env.E2E_RUNS_DIR ?? new URL("./.runs", import.meta.url).pathname;
const LAST_MARKER_FILE = path.join(RUNS_DIR, "deployed-smoke-last-marker.txt");

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
  cleanup: {},
  postState: {},
};
const failures = [];
/** Secrets of this run: never allowed into any log, error, or evidence. */
const secrets = [];
const shutdown = createShutdownController();

/** The marker of this run, set before the send (used by cleanup/recovery). */
let sentMarker = null;

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
  const script = buildPodActionScript(payload);
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
  const db = await workerPodAction({ action: "preflight", smokePrefix: SMOKE_PREFIX });
  evidence.preflight.database = {
    tablesOk: db.tablesOk,
    clientKeyIndexed: db.clientKeyIndexed,
    oneReplyPerTurn: db.oneReplyPerTurn,
    leftoverSmokeRows: db.leftoverSmokeRows,
    queuedUserMessages: db.queuedUserMessages,
    inFlightTurns: db.inFlightTurns,
    enabledPatterns: db.enabledPatterns,
    baselineMessages: db.baselineMessages,
    baselineTurns: db.baselineTurns,
    newestMessageAgeMinutes: db.newestMessageAgeMinutes,
    highestAllocatedSeq: db.highestAllocatedSeq,
  };
  if (!db.tablesOk || !db.clientKeyIndexed || !db.oneReplyPerTurn) {
    throw new Error("the deployed schema lacks the expected cleanup linkage (tables/client_key index/one reply per turn)");
  }
  if (db.leftoverSmokeRows !== 0) {
    throw new Error(
      `${String(db.leftoverSmokeRows)} pre-existing ${SMOKE_PREFIX}rows found — refusing to send (attribution would be ambiguous; use --recover)`,
    );
  }
  if (db.queuedUserMessages !== 0 || db.inFlightTurns !== 0) {
    throw new Error(
      `the dev thread is not quiescent (queued=${String(db.queuedUserMessages)}, inFlight=${String(db.inFlightTurns)}) — refusing to send`,
    );
  }
  evidence.provider.expectedCalls = db.enabledPatterns > 0 ? "decision + chat (2)" : "chat only (decision skipped: no enabled patterns)";
  log(
    `preflight OK: gate open (attestation ${evidence.preflight.gate.attestation}), ` +
    `db idle (newest message ${String(db.newestMessageAgeMinutes)} min old), ` +
    `baseline ${String(db.baselineMessages)} messages / ${String(db.baselineTurns)} turns, ` +
    `expected provider calls: ${evidence.provider.expectedCalls}`,
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
// The journey: one synthetic message, persisted reply, refresh
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
          `(user message ${userMessage === null ? "not yet" : "seen"}; the turn may have failed — cleanup still runs)`,
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

    // Post-send overlap accounting: exactly our message + its reply may have
    // appeared; anything else is an overlap anomaly (retained, reported).
    const afterThread = await step("post-reply thread read", async () =>
      await (await context.request.get(`${gateOrigin}/api/thread`)).json());
    evidence.journey.messageCountAfterReply = afterThread.messages.length;
    evidence.journey.threadStatus = afterThread.status;
    const ourCount = afterThread.messages.filter((message) => message.text === marker).length;
    if (ourCount !== 1 || afterThread.messages.length !== evidence.journey.baselineMessageCount + 2) {
      evidence.exclusivity.overlapDetected = true;
      failures.push("overlap anomaly: the thread gained unexpected messages during the run; cleanup stays conservative and nothing unrelated is deleted");
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
// Targeted cleanup (decision logic in deployed-smoke-lib.mjs; all SQL is
// parameterized pod-side; uncertainty always retains)
// ---------------------------------------------------------------------------

async function persistOwnershipRecord(mode, detail) {
  try {
    fs.mkdirSync(RUNS_DIR, { recursive: true });
    const marker = sentMarker;
    const record = {
      markerFingerprint: fingerprint(marker),
      mode,
      detail,
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
  } catch {
    // best effort; the evidence block still records the decision
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

async function cleanupPhase() {
  const marker = sentMarker;
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
    if (decision.mode === "own-message-only") {
      const result = await workerPodAction({
        action: "delete-own-message", messageId: probe.message.id, marker, turnId: probe.turn.id,
      });
      evidence.provider.turnComposition = probe.composition === null ? null : {
        messages: probe.composition.length,
        userMessages: probe.composition.filter((entry) => entry.role === "user").length,
        exclusiveToThisRun: false,
      };
      if (result.rowCount === 1) {
        evidence.cleanup = {
          mode: "own-message-only",
          deletedMessageCount: 1,
          preCleanupTotals: { messages: probe.totalMessages, turns: probe.totalTurns },
          reason: "the turn was shared with unrelated traffic; only this run's own message row was removed (residual retained and reported)",
          residualTurnId: probe.turn.id,
        };
        failures.push("conservative cleanup: the turn was not exclusive to this run; only this run's message row was removed (residual reported)");
        return;
      }
      continue; // rowCount 0: re-probe and re-decide.
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

async function verifyPostState() {
  const post = await workerPodAction({ action: "post-state", smokePrefix: SMOKE_PREFIX });
  evidence.postState = {
    smokeRows: post.smokeRows,
    messages: post.messages,
    turns: post.turns,
    queuedUserMessages: post.queuedUserMessages,
    inFlightTurns: post.inFlightTurns,
  };
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
    "refusing to run: this smoke makes a real billable provider call against the deployed non-production stack. " +
    "Set E2E_DEPLOYED_SMOKE_ALLOWED=1 to authorize it explicitly.",
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
      "refusing to run: exclusive dev access must be acknowledged by the operator " +
      "(E2E_DEPLOYED_SMOKE_EXCLUSIVE_DEV_ACCESS=1). This is an assertion the dev stack is exclusively yours for " +
      "this run — the system cannot enforce it, unrelated conversation can enter the provider context, and " +
      "provider call costs/replay are not hard-capped.",
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
      // best effort; the ownership trail also exists in the evidence block
    }
    const baseline = {
      messages: evidence.preflight.database.baselineMessages,
      turns: evidence.preflight.database.baselineTurns,
    };
    let journeyError = null;
    try {
      await startPortForward(podName);
      await journey(gateOrigin, marker);
    } catch (error) {
      if (error?.name === "StopRequested") {
        journeyError = `graceful stop (${shutdown.signal}): the journey was aborted and the awaited cleanup ran`;
        log(journeyError);
      } else {
        journeyError = error instanceof Error ? error.message : String(error);
        failures.push(`journey: ${journeyError}`);
      }
    }
    // From here on, cleanup runs no matter what the journey did: the send
    // may already have reached the worker and the provider. A stop request
    // that arrives during cleanup retains data instead of deleting mid-way.
    await cleanupPhase();
    await verifyPostState();
    if (journeyError !== null && !journeyError.startsWith("graceful stop")) {
      log(`journey failed (cleanup still ran and is verified above): ${journeyError}`);
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
  process.stderr.write(`[deployed-smoke] STOPPED (${shutdown.signal}) after awaited cleanup; re-run with --recover if anything was retained\n`);
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
log("SMOKE PASSED (send -> persisted reply -> UI/refresh verified; synthetic data cleaned and post-state verified)");
