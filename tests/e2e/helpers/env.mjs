import http from "node:http";

function requiredPort(name, fallback) {
  const raw = process.env[name] ?? fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`Invalid port for ${name}: ${String(raw)}`);
  }
  return value;
}

export const gatePort = requiredPort("E2E_GATE_PORT", "3100");
export const webPort = requiredPort("E2E_WEB_PORT", "3000");
export const workerPort = requiredPort("E2E_WORKER_PORT", "8080");

export const gateOrigin = () => `http://127.0.0.1:${String(gatePort)}`;
export const mainOrigin = () => `http://127.0.0.1:${String(webPort)}`;

/**
 * Raw HTTP request over 127.0.0.1 with explicit header control (for testing
 * Host and forwarding-header rejections that browsers disallow).
 */
export function rawRequest({ port, method = "GET", path = "/", headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        });
      });
    });
    req.on("error", reject);
    if (body !== null) {
      req.write(body);
    }
    req.end();
  });
}

/** Direct request to the forwarded worker private API. */
export function workerRequest({ method = "GET", path = "/healthz", token = null, json = null }) {
  const headers = {};
  if (token !== null) {
    headers.authorization = `Bearer ${token}`;
  }
  let body = null;
  if (json !== null) {
    body = JSON.stringify(json);
    headers["content-type"] = "application/json";
    headers["content-length"] = String(Buffer.byteLength(body));
  }
  return rawRequest({ port: workerPort, method, path, headers, body });
}
