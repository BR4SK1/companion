/**
 * Custom production server entry for the web app.
 *
 * Runs the Next.js production build (same `next build` output as
 * `next start`) on the main listener, plus — only when the test gate is
 * explicitly enabled in the environment — a second, dedicated listener
 * bound strictly to `127.0.0.1` for non-production end-to-end access (see
 * `server/test-listener.mjs` and apps/web/README.md).
 *
 * The main listener is unchanged in behavior: owner-only Keycloak
 * sessions, verified at the BFF edge. The test listener is reachable only
 * through `kubectl port-forward` and serves the same application under a
 * separate, gate-gated session identity; it never issues owner sessions.
 *
 * Fail-closed rules:
 * - Without `WEB_TEST_GATE_ENABLED=true` there is no test listener at all.
 * - With the gate enabled but misconfigured (missing/invalid loopback
 *   port, missing/too-short session secret), or without a valid
 *   deployment-purpose attestation (production, unknown, missing, or
 *   namespace-mismatched), the process exits with a named-variable error
 *   instead of starting anything, so a misconfigured candidate cannot
 *   come up partially open or silently without the intended entry.
 * - The attestation token is process-random, memory-only, and never
 *   logged.
 * - The test listener additionally enforces channel integrity on every
 *   request: the Host header must be exactly `127.0.0.1:<gate port>` and
 *   forwarding/proxy headers are refused (DNS-rebinding defense; reject
 *   only, never grant).
 */

import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

import next from "next";

import {
  parseTestGateEnv,
  TEST_CHANNEL_TOKEN_GLOBAL_KEY,
} from "./server/gate-env.mjs";
import { createTestEntryListener } from "./server/test-listener.mjs";

const port = Number(process.env.PORT ?? "3000");
// Mirrors `next start`: bind to HOSTNAME when set (the container sets
// 0.0.0.0), otherwise all interfaces.
const hostname =
  process.env.HOSTNAME !== undefined && process.env.HOSTNAME.length > 0
    ? process.env.HOSTNAME
    : "0.0.0.0";

// The gate's configuration (including its deployment-purpose attestation)
// is validated first: a misconfigured or wrongly-attested gate exits here,
// before any listener work, with a named-variable error.
let gate;
try {
  gate = parseTestGateEnv(process.env);
} catch (error) {
  console.error(
    `test gate configuration error: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`invalid main listener port: ${String(process.env.PORT)}`);
  process.exit(1);
}

const app = next({ dev: false });
await app.prepare();
const handler = app.getRequestHandler();

const mainServer = createServer((request, response) => {
  Promise.resolve(handler(request, response)).catch((error) => {
    // The Next handler manages its own error responses; this guard only
    // prevents an unhandled rejection from killing the process.
    console.error(`request failed: ${error instanceof Error ? error.message : String(error)}`);
    if (!response.headersSent) {
      response.statusCode = 500;
      response.end();
    } else {
      response.end();
    }
  });
});
mainServer.on("error", (error) => {
  // Fail fast with a clear message instead of an uncaught exception.
  console.error(`main listener error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
mainServer.listen(port, hostname, () => {
  console.log(`web listening on ${hostname}:${String(port)}`);
});

let testEntry = null;
if (gate.enabled) {
  const token = randomBytes(32).toString("base64url");
  // Publish the token to the request handlers running in this same
  // process; it never leaves process memory.
  globalThis[TEST_CHANNEL_TOKEN_GLOBAL_KEY] = token;
  testEntry = createTestEntryListener({
    port: gate.port,
    token,
    // Re-checked on every accepted request, not only at bind time.
    isEnabled: () => {
      try {
        return parseTestGateEnv(process.env).enabled;
      } catch {
        return false;
      }
    },
    handler,
    log: (message) => console.log(message),
  });
  await testEntry.start();
  console.log(
    `test entry listening on 127.0.0.1:${String(gate.port)} (loopback-only; non-production use via kubectl port-forward)`,
  );
}

async function shutdown() {
  // Stop accepting new connections; in-flight requests are given a moment
  // by the container runtime's grace period.
  const closing = [new Promise((resolve) => mainServer.close(() => resolve()))];
  if (testEntry !== null) {
    closing.push(testEntry.close());
  }
  await Promise.all(closing);
  process.exit(0);
}
process.on("SIGTERM", () => {
  void shutdown();
});
process.on("SIGINT", () => {
  void shutdown();
});
