/**
 * Raw HTTP helpers for tests that must control low-level request details the
 * browser fetch stack does not allow: an explicit Host header (the test
 * gate's DNS-rebinding rejection) and forbidden forwarding headers.
 *
 * Also direct (non-browser) calls to the worker's private API on the loopback
 * interface, for the bearer-credential negative checks.
 */

import http from "node:http";

import { config } from "./config.mjs";

/**
 * Perform one HTTP request with fully controlled headers.
 * @returns {Promise<{status: number, headers: Record<string, string|string[]>, body: string}>}
 */
export function rawRequest({ port, method = "GET", path = "/", headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: "127.0.0.1",
        port,
        method,
        path,
        headers,
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    request.on("error", reject);
    if (body !== null) {
      request.end(body);
    } else {
      request.end();
    }
  });
}

/** Direct worker API call (bearer token chosen by the caller). */
export function workerRequest({ method = "GET", path = "/", token = null, json = null }) {
  const headers = {};
  if (token !== null) {
    headers.authorization = `Bearer ${token}`;
  }
  let body = null;
  if (json !== null) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(json);
  }
  return rawRequest({ port: config.workerPort, method, path, headers, body });
}
