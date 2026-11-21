#!/usr/bin/env node
/**
 * Deployed Playwright E2E launcher against the live `companion-np` namespace.
 *
 * Opens temporary `kubectl port-forward` tunnels to the Ready `companion-web`
 * pod (loopback test gate on 127.0.0.1:3100 and main listener on an ephemeral
 * port) and `companion-worker` pod (ephemeral port), runs Playwright against
 * those forwarded endpoints, and tears the tunnels down on exit.
 */

import { spawn, spawnSync } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const NAMESPACE = process.env.E2E_NAMESPACE || "companion-np";
const RELEASE = process.env.E2E_RELEASE || "companion";
const GATE_PORT = Number(process.env.E2E_GATE_PORT || "3100");
const here = path.dirname(fileURLToPath(import.meta.url));

function findReadyPod(component) {
  const res = spawnSync(
    "kubectl",
    [
      "get",
      "pods",
      "-n",
      NAMESPACE,
      "-l",
      `app.kubernetes.io/instance=${RELEASE},app.kubernetes.io/name=${component}`,
      "-o",
      "json",
    ],
    { encoding: "utf8" },
  );
  if (res.status !== 0) {
    throw new Error(`kubectl get pods (${component}) failed: ${res.stderr.trim()}`);
  }
  const items = JSON.parse(res.stdout).items ?? [];
  const ready = items.find(
    (pod) =>
      !pod.metadata?.deletionTimestamp &&
      (pod.status?.conditions ?? []).some((c) => c.type === "Ready" && c.status === "True"),
  );
  if (!ready?.metadata?.name) {
    throw new Error(`No Ready ${component} pod found in namespace ${NAMESPACE}`);
  }
  return ready.metadata.name;
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function waitForPort(port, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = net.connect({ host: "127.0.0.1", port });
      socket.once("connect", () => {
        socket.end();
        resolve();
      });
      socket.once("error", () => {
        socket.destroy();
        if (Date.now() >= deadline) {
          reject(new Error(`Timed out waiting for port-forward on 127.0.0.1:${String(port)}`));
        } else {
          setTimeout(attempt, 200);
        }
      });
    };
    attempt();
  });
}

function startPortForward(podName, portMappings) {
  const child = spawn(
    "kubectl",
    ["port-forward", "--address", "127.0.0.1", "-n", NAMESPACE, `pod/${podName}`, ...portMappings],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });
  child.on("exit", (code) => {
    if (code && !child.killed) {
      console.error(`port-forward (${podName}) exited with ${String(code)}: ${stderr.trim()}`);
    }
  });
  return child;
}

const forwards = [];
function cleanup() {
  for (const child of forwards) {
    if (!child.killed) {
      child.kill("SIGTERM");
    }
  }
}

process.on("SIGINT", () => {
  cleanup();
  process.exit(130);
});
process.on("SIGTERM", () => {
  cleanup();
  process.exit(143);
});

try {
  const webPod = findReadyPod("web");
  const workerPod = findReadyPod("worker");
  const webPort = await getFreePort();
  const workerPort = await getFreePort();

  console.log(
    `e2e: targeting ${NAMESPACE}/${webPod} (gate=127.0.0.1:${String(GATE_PORT)}, main=127.0.0.1:${String(webPort)}) and ${NAMESPACE}/${workerPod} (worker=127.0.0.1:${String(workerPort)})`,
  );

  // Note: the web test-entry listener enforces Host: 127.0.0.1:<pod gate port>,
  // so local GATE_PORT must match the pod's configured testGate port (3100).
  forwards.push(startPortForward(webPod, [`${String(GATE_PORT)}:${String(GATE_PORT)}`, `${String(webPort)}:3000`]));
  forwards.push(startPortForward(workerPod, [`${String(workerPort)}:8080`]));

  await Promise.all([waitForPort(GATE_PORT), waitForPort(webPort), waitForPort(workerPort)]);

  const playwrightBin = path.join(here, "node_modules", ".bin", "playwright");
  const extraArgs = process.argv.slice(2);
  const result = spawnSync(playwrightBin, ["test", ...extraArgs], {
    cwd: here,
    stdio: "inherit",
    env: {
      ...process.env,
      E2E_GATE_PORT: String(GATE_PORT),
      E2E_WEB_PORT: String(webPort),
      E2E_WORKER_PORT: String(workerPort),
    },
  });

  process.exitCode = result.status ?? 1;
} finally {
  cleanup();
}
