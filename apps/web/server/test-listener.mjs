/**
 * The test-entry listener: a dedicated HTTP server bound strictly to
 * `127.0.0.1` inside the pod's network namespace, serving the full
 * application for non-production end-to-end testing without Keycloak
 * sign-in.
 *
 * Why this is a genuine network boundary (not a header convention):
 *
 * - The listener socket is bound to `127.0.0.1`, so it is addressable only
 *   from inside the pod's own network namespace. The ClusterIP Service
 *   targets the pod IP (endpoints cannot address a peer's loopback), the
 *   Ingress routes through that Service, and no other pod or node process
 *   can connect to it. The only intended path in is
 *   `kubectl port-forward`, which the kubelet performs by dialing
 *   `127.0.0.1:<port>` inside the pod's network namespace on the
 *   operator's behalf.
 * - Every request is additionally checked at the socket layer: the peer
 *   address must be loopback and the gate must still be enabled, or the
 *   request is refused before the application ever sees it.
 * - Channel integrity on every request: the Host header must be exactly
 *   `127.0.0.1:<port>` and no forwarding/proxy header may be present.
 *   This rejects DNS-rebinding requests (a page from an attacker domain
 *   that resolves to 127.0.0.1 arrives with the attacker's Host) and
 *   proxy-path requests before session issuance or any route can act on
 *   them. These checks only ever reject — never grant; authorization
 *   remains the socket check plus the attestation token.
 * - Accepted requests are marked with a process-random attestation token
 *   injected into the request headers by this listener. The token is
 *   generated at server start, kept in process memory only, and never
 *   logged, configured, or exposed; requests arriving on the main
 *   (owner-only) listener cannot carry it, so the application can trust
 *   the attestation as evidence that the connection came through this
 *   listener — without trusting any client-supplied marker, Host, or
 *   forwarding header.
 *
 * Plain JavaScript (imported by the custom server entry and by the unit
 * tests); no framework dependencies.
 */

import http from "node:http";

import {
  hasTestChannelForbiddenHeaders,
  isExpectedTestHost,
  isLoopbackRemoteAddress,
  TEST_ATTESTATION_HEADER,
} from "./gate-env.mjs";

/**
 * The per-request accept decision, factored out as a pure function so the
 * rules are directly unit-testable (real socket peers in tests are always
 * loopback, so the non-loopback rejections are exercised through this
 * function).
 *
 * @param {string | null | undefined} remoteAddress Actual socket peer address.
 * @param {boolean} gateEnabled Whether the gate is enabled at this instant.
 * @returns {boolean}
 */
export function shouldAcceptTestConnection(remoteAddress, gateEnabled) {
  return gateEnabled === true && isLoopbackRemoteAddress(remoteAddress);
}

/**
 * Create the loopback-only test-entry listener. Does not bind; call
 * `start()` on the returned handle.
 *
 * @param {{
 *   port: number,
 *   token: string,
 *   isEnabled: () => boolean,
 *   handler: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => unknown,
 *   log?: (message: string) => void,
 * }} options
 */
export function createTestEntryListener({ port, token, isEnabled, handler, log = () => {} }) {
  if (typeof token !== "string" || token.length === 0) {
    throw new Error("test entry listener requires a non-empty attestation token");
  }
  // The Host expectation follows the actually bound port: when started on
  // the ephemeral port (0, used by the unit tests), the bound port is the
  // one clients address. In the container the configured port is bound
  // unchanged, so both are the same there.
  let boundPort = port;
  const server = http.createServer((request, response) => {
    const refuse = (reason) => {
      // Refuse before the application sees anything: generic, no-store, no
      // detail about which check failed, and never a redirect (in
      // particular, never to the session-issuance endpoint). The Host
      // value is attacker-controlled in the hostile scenarios and is
      // deliberately not logged.
      const remoteAddress = request.socket.remoteAddress;
      log(`test entry refused a connection (${reason}) from ${String(remoteAddress === undefined || remoteAddress === null ? "unknown" : remoteAddress)}`);
      request.resume();
      response.writeHead(403, {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
        connection: "close",
      });
      response.end("forbidden");
    };
    if (!shouldAcceptTestConnection(request.socket.remoteAddress, isEnabled())) {
      refuse("socket");
      return;
    }
    // Channel-integrity checks: the exact loopback Host (DNS-rebinding
    // defense) and the absence of forwarding headers. Rejections only —
    // neither is an authorization factor.
    if (!isExpectedTestHost(request.headers.host, boundPort)) {
      refuse("host");
      return;
    }
    if (hasTestChannelForbiddenHeaders(request.headers)) {
      refuse("forwarding headers");
      return;
    }
    // Attest the channel: only this listener ever adds the process-random
    // token, and only after the socket-level checks above passed.
    request.headers[TEST_ATTESTATION_HEADER] = token;
    try {
      const result = handler(request, response);
      if (result instanceof Promise) {
        result.catch(() => {
          // The Next handler manages its own error responses; this guard
          // only prevents an unhandled rejection from killing the process.
          if (!response.headersSent) {
            response.destroy();
          }
        });
      }
    } catch {
      if (!response.headersSent) {
        response.destroy();
      }
    }
  });
  return {
    server,
    /** Bind to 127.0.0.1 — never configurable, never widened. */
    start: () =>
      new Promise((resolve, reject) => {
        const onListening = () => {
          server.off("error", onError);
          const address = server.address();
          const actualPort = typeof address === "object" && address !== null ? address.port : port;
          boundPort = actualPort;
          resolve(actualPort);
        };
        const onError = (error) => {
          server.off("listening", onListening);
          reject(error);
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(port, "127.0.0.1");
      }),
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
      }),
  };
}
