// Route-level tests for the non-production-only test-entry gate: the REAL
// Next.js route handler modules (apps/web/src/app/api/...) are executed
// under node:test with the web app's module aliases registered (see
// helpers/register-web-aliases.mjs), against a fake worker private API on
// the loopback interface. Hermetic: loopback sockets only, no database, no
// external network, and — deliberately — no provider calls of any kind
// (the fake worker is a stand-in; nothing here may touch a real model
// backend).
//
// Coverage: session issuance on the attested test channel only, full
// read/send flows through the real routes on both channels, per-channel
// same-origin decisions with spoofed Host/forwarding headers, cross-channel
// session rejection (no owner impersonation through the gate), OIDC routes
// absent on the test channel, and fail-closed behavior with the gate off.

import "./helpers/register-web-aliases.mjs";

import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

const {
  NextRequest,
} = await import("next/server");

const messagesRoute = await import("../../apps/web/src/app/api/messages/route.ts");
const threadRoute = await import("../../apps/web/src/app/api/thread/route.ts");
const logoutRoute = await import("../../apps/web/src/app/api/auth/logout/route.ts");
const loginRoute = await import("../../apps/web/src/app/api/auth/login/route.ts");
const callbackRoute = await import("../../apps/web/src/app/api/auth/callback/route.ts");
const issuanceRoute = await import("../../apps/web/src/app/api/test-gate/session/route.ts");
const sessionModule = await import("../../apps/web/src/lib/server/session.ts");
const testGateModule = await import("../../apps/web/src/lib/server/test-gate.ts");
const { TEST_ATTESTATION_HEADER } = await import("../../apps/web/server/gate-env.mjs");

const MAIN_ORIGIN = "https://companion.example.com";
const TEST_PORT = 3100;
const TEST_ORIGIN = `http://127.0.0.1:${String(TEST_PORT)}`;
const MAIN_SECRET = "main-session-secret-0123456789abcdef";
const GATE_SECRET = "test-gate-secret-0123456789abcdef";
const OWNER_SUBJECT = "owner-subject-1";
const WORKER_TOKEN = "service-token";

const baseEnv = {
  WEB_PUBLIC_URL: MAIN_ORIGIN,
  WEB_OIDC_ISSUER_URL: "https://keycloak.example.com/realms/companion",
  WEB_OIDC_CLIENT_ID: "companion-web",
  WEB_OIDC_CLIENT_SECRET: "client-secret",
  WEB_SESSION_SECRET: MAIN_SECRET,
  WEB_OWNER_SUBJECTS: OWNER_SUBJECT,
  WEB_WORKER_URL: "", // set per-test to the fake worker
  WEB_WORKER_TOKEN: WORKER_TOKEN,
  PORT: "3000",
};

const gateEnv = {
  WEB_TEST_GATE_ENABLED: "true",
  WEB_TEST_GATE_PORT: String(TEST_PORT),
  WEB_TEST_GATE_SESSION_SECRET: GATE_SECRET,
  // Chart-attested non-production deployment (the pod-namespace value is
  // the downward-API injection; in-process both env values are compared).
  COMPANION_DEPLOYMENT_PURPOSE: "non-production",
  COMPANION_DEPLOYMENT_NAMESPACE: "companion-np",
  COMPANION_POD_NAMESPACE: "companion-np",
};

/** The fake worker's observed requests (for asserting the BFF's calls). */
const workerCalls = [];
let workerServer;
let workerUrl;

before(async () => {
  workerServer = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      workerCalls.push({ method: req.method, path: req.url, auth: req.headers.authorization ?? null });
      const json = (body, status = 200) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      const authOk = req.headers.authorization === `Bearer ${WORKER_TOKEN}`;
      if (!authOk) return json({ error: "unauthorized" }, 401);
      if (req.method === "POST" && req.url === "/v1/messages") {
        const parsed = JSON.parse(raw);
        return json({
          message: {
            id: `fake-${parsed.clientKey}`,
            seq: 1,
            role: "user",
            content: parsed.text,
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        });
      }
      if (req.method === "GET" && (req.url === "/v1/thread" || req.url.startsWith("/v1/thread?"))) {
        return json({
          timezone: "UTC",
          messages: [
            {
              id: "fake-1",
              seq: 1,
              role: "assistant",
              content: "fake thread content",
              createdAt: "2026-01-01T00:00:00.000Z",
            },
          ],
          status: { queued: 0, generating: false, highestAllocatedSeq: 1, hasRecentFailure: false },
          page: { oldestSeq: 1, hasMore: false },
        });
      }
      json({ error: "not_found" }, 404);
    });
  });
  await new Promise((resolve) => workerServer.listen(0, "127.0.0.1", resolve));
  workerUrl = `http://127.0.0.1:${String(workerServer.address().port)}`;
});

after(async () => {
  await new Promise((resolve) => workerServer.close(resolve));
});

beforeEach(() => {
  setEnv({ ...baseEnv, ...gateEnv, WEB_WORKER_URL: workerUrl });
  testGateModule.setChannelAttestationTokenForTesting(null);
});

afterEach(() => {
  // Remove every test-set variable so nothing leaks between tests: a stale
  // gate value would silently change the next test's channel resolution.
  for (const key of [...Object.keys(gateEnv), "NODE_ENV"]) {
    delete process.env[key];
  }
});

after(() => {
  clearTestGateEnv();
});

function setEnv(vars) {
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function clearTestGateEnv() {
  for (const key of Object.keys(gateEnv)) {
    delete process.env[key];
  }
}

/** Build a NextRequest against a channel with chosen headers/cookies. */
function makeRequest(url, { method = "GET", headers = {}, cookies = {}, body } = {}) {
  const cookieHeader = Object.entries(cookies)
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
  const allHeaders = new Headers(headers);
  if (cookieHeader.length > 0) {
    allHeaders.set("cookie", cookieHeader);
  }
  return new NextRequest(url, {
    method,
    headers: allHeaders,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

function ownerCookie(nowOffsetSeconds = 0) {
  const now = Math.floor(Date.now() / 1000) + nowOffsetSeconds;
  return sessionModule.signToken(
    sessionModule.createSessionPayload(OWNER_SUBJECT, now, 3600),
    MAIN_SECRET,
  );
}

function testCookie(nowOffsetSeconds = 0) {
  const now = Math.floor(Date.now() / 1000) + nowOffsetSeconds;
  return sessionModule.signToken(
    sessionModule.createTestSessionPayload(now, 3600),
    GATE_SECRET,
  );
}

const spoofedHeaders = {
  host: "evil.example.net",
  "x-forwarded-host": "evil.example.net",
  "x-forwarded-proto": "https",
  "x-forwarded-for": "6.6.6.6",
  forwarded: "for=6.6.6.6;host=evil.example.net",
};

describe("test-session issuance route (api/test-gate/session)", () => {
  it("does not exist on the main channel, even with a guessed attestation header", async () => {
    const request = makeRequest(`${MAIN_ORIGIN}/api/test-gate/session`, {
      headers: { [TEST_ATTESTATION_HEADER]: "guessed" },
    });
    const response = await issuanceRoute.GET(request);
    assert.equal(response.status, 404);
  });

  it("issues an identity-free test session on the attested test channel", async () => {
    testGateModule.setChannelAttestationTokenForTesting("route-test-token");
    const request = makeRequest(`${TEST_ORIGIN}/api/test-gate/session`, {
      headers: { [TEST_ATTESTATION_HEADER]: "route-test-token" },
    });
    const response = await issuanceRoute.GET(request);
    assert.equal(response.status, 303);
    assert.equal(response.headers.get("location"), `${TEST_ORIGIN}/`);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const setCookie = response.headers.get("set-cookie");
    assert.ok(setCookie !== null);
    assert.ok(setCookie.includes(`${sessionModule.TEST_SESSION_COOKIE_NAME}=`));
    assert.ok(setCookie.includes("HttpOnly"));
    assert.ok(setCookie.includes("SameSite=lax"));
    assert.ok(!/Secure/i.test(setCookie), "the http loopback entry must not set Secure");
    const value = setCookie.split(`${sessionModule.TEST_SESSION_COOKIE_NAME}=`)[1].split(";")[0];
    const payload = sessionModule.verifyTestSessionToken(value, GATE_SECRET, Math.floor(Date.now() / 1000));
    assert.notEqual(payload, null);
    assert.ok(!("sub" in payload), "the test session carries no identity");
  });

  it("refuses issuance when the gate is disabled even with a token present", async () => {
    testGateModule.setChannelAttestationTokenForTesting("route-test-token");
    clearTestGateEnv();
    const request = makeRequest(`${TEST_ORIGIN}/api/test-gate/session`, {
      headers: { [TEST_ATTESTATION_HEADER]: "route-test-token" },
    });
    const response = await issuanceRoute.GET(request);
    assert.equal(response.status, 404, "no gate, no issuance: the request falls back to the main channel");
  });

  it("refuses issuance when the attestation does not match the process token", async () => {
    testGateModule.setChannelAttestationTokenForTesting("route-test-token");
    const request = makeRequest(`${TEST_ORIGIN}/api/test-gate/session`, {
      headers: { [TEST_ATTESTATION_HEADER]: "wrong" },
    });
    const response = await issuanceRoute.GET(request);
    assert.equal(response.status, 404);
  });

  it("redirect target is always the fixed loopback origin, never request-derived (DNS-rebinding regression)", async () => {
    // The listener rejects a rebinding request long before this route; this
    // regression proves the defense in depth: even a request that somehow
    // reached the route carrying an attacker Host and forwarding headers
    // would still be redirected to the configured loopback origin, never
    // to an attacker-controlled one, and the cookie would be the gate's
    // session on the fixed path — not a channel the attacker chose.
    testGateModule.setChannelAttestationTokenForTesting("route-test-token");
    const request = makeRequest(`${TEST_ORIGIN}/api/test-gate/session`, {
      headers: {
        [TEST_ATTESTATION_HEADER]: "route-test-token",
        host: "attacker.example.net",
        "x-forwarded-host": "attacker.example.net",
        "x-forwarded-proto": "https",
        forwarded: "for=6.6.6.6;host=attacker.example.net;proto=https",
      },
    });
    const response = await issuanceRoute.GET(request);
    assert.equal(response.status, 303);
    assert.equal(response.headers.get("location"), `${TEST_ORIGIN}/`, "the redirect origin must be the configured loopback origin");
    const setCookie = response.headers.get("set-cookie");
    assert.ok(setCookie !== null);
    assert.ok(setCookie.startsWith(`${sessionModule.TEST_SESSION_COOKIE_NAME}=`), setCookie);
    assert.ok(!setCookie.includes("attacker.example.net"), setCookie);
  });
});

describe("message sending through the real route (fake worker only)", () => {
  const postBody = { text: "route test", clientKey: "routekey1" };

  function postRequest(channelOrigin, { headers = {}, cookies = {} } = {}) {
    return makeRequest(`${channelOrigin}/api/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      cookies,
      body: postBody,
    });
  }

  it("accepts and proxies a send on the attested test channel with a test session", async () => {
    testGateModule.setChannelAttestationTokenForTesting("route-test-token");
    const response = await messagesRoute.POST(
      postRequest(TEST_ORIGIN, {
        headers: { origin: TEST_ORIGIN, [TEST_ATTESTATION_HEADER]: "route-test-token" },
        cookies: { [sessionModule.TEST_SESSION_COOKIE_NAME]: testCookie() },
      }),
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.message.role, "user");
    assert.equal(body.message.text, "route test");
    // The worker call carried the shared service token and no identity.
    assert.equal(workerCalls.at(-1).auth, `Bearer ${WORKER_TOKEN}`);
  });

  it("rejects state changes without or with a foreign Origin on the test channel", async () => {
    testGateModule.setChannelAttestationTokenForTesting("route-test-token");
    const cookies = { [sessionModule.TEST_SESSION_COOKIE_NAME]: testCookie() };
    const attested = { [TEST_ATTESTATION_HEADER]: "route-test-token" };
    const noOrigin = await messagesRoute.POST(postRequest(TEST_ORIGIN, { headers: attested, cookies }));
    assert.equal(noOrigin.status, 403);
    const foreign = await messagesRoute.POST(
      postRequest(TEST_ORIGIN, { headers: { origin: "https://attacker.example.net", ...attested }, cookies }),
    );
    assert.equal(foreign.status, 403);
  });

  it("ignores spoofed Host and forwarding headers: Origin decides", async () => {
    testGateModule.setChannelAttestationTokenForTesting("route-test-token");
    const cookies = { [sessionModule.TEST_SESSION_COOKIE_NAME]: testCookie() };
    const attested = { [TEST_ATTESTATION_HEADER]: "route-test-token" };
    // Host and forwarding headers pointing at the test origin cannot make a
    // cross-site Origin acceptable.
    const spoofedWrongOrigin = await messagesRoute.POST(
      postRequest(TEST_ORIGIN, { headers: { origin: "https://attacker.example.net", ...spoofedHeaders, ...attested }, cookies }),
    );
    assert.equal(spoofedWrongOrigin.status, 403);
    // A correct Origin is accepted even with hostile Host/forwarding headers.
    const spoofedRightOrigin = await messagesRoute.POST(
      postRequest(TEST_ORIGIN, { headers: { origin: TEST_ORIGIN, ...spoofedHeaders, ...attested }, cookies }),
    );
    assert.equal(spoofedRightOrigin.status, 200);
  });

  it("rejects a test session on the main channel and an owner session on the test channel", async () => {
    testGateModule.setChannelAttestationTokenForTesting("route-test-token");
    const onMain = await messagesRoute.POST(
      postRequest(MAIN_ORIGIN, {
        headers: { origin: MAIN_ORIGIN },
        cookies: { [sessionModule.TEST_SESSION_COOKIE_NAME]: testCookie() },
      }),
    );
    assert.equal(onMain.status, 401);
    const onTest = await messagesRoute.POST(
      postRequest(TEST_ORIGIN, {
        headers: { origin: TEST_ORIGIN, [TEST_ATTESTATION_HEADER]: "route-test-token" },
        cookies: { [sessionModule.SESSION_COOKIE_NAME]: ownerCookie() },
      }),
    );
    assert.equal(onTest.status, 401);
  });

  it("keeps the main channel's requirements intact (origin then owner session)", async () => {
    const cookies = { [sessionModule.SESSION_COOKIE_NAME]: ownerCookie() };
    const noOrigin = await messagesRoute.POST(postRequest(MAIN_ORIGIN, { cookies }));
    assert.equal(noOrigin.status, 403);
    const foreignOrigin = await messagesRoute.POST(
      postRequest(MAIN_ORIGIN, { headers: { origin: "https://attacker.example.net", ...spoofedHeaders }, cookies }),
    );
    assert.equal(foreignOrigin.status, 403);
    const spoofedRightOrigin = await messagesRoute.POST(
      postRequest(MAIN_ORIGIN, { headers: { origin: MAIN_ORIGIN, ...spoofedHeaders }, cookies }),
    );
    assert.equal(spoofedRightOrigin.status, 200);
    const noSession = await messagesRoute.POST(
      postRequest(MAIN_ORIGIN, { headers: { origin: MAIN_ORIGIN } }),
    );
    assert.equal(noSession.status, 401);
  });
});

describe("thread reads through the real route", () => {
  it("serves the test channel with a test session", async () => {
    testGateModule.setChannelAttestationTokenForTesting("route-test-token");
    const response = await threadRoute.GET(
      makeRequest(`${TEST_ORIGIN}/api/thread`, {
        headers: { [TEST_ATTESTATION_HEADER]: "route-test-token" },
        cookies: { [sessionModule.TEST_SESSION_COOKIE_NAME]: testCookie() },
      }),
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.messages[0].text, "fake thread content");
    assert.equal(body.status.queued, 0);
  });

  it("serves the main channel with an owner session and rejects test sessions", async () => {
    const ok = await threadRoute.GET(
      makeRequest(`${MAIN_ORIGIN}/api/thread`, {
        cookies: { [sessionModule.SESSION_COOKIE_NAME]: ownerCookie() },
      }),
    );
    assert.equal(ok.status, 200);
    const rejected = await threadRoute.GET(
      makeRequest(`${MAIN_ORIGIN}/api/thread`, {
        cookies: { [sessionModule.TEST_SESSION_COOKIE_NAME]: testCookie() },
      }),
    );
    assert.equal(rejected.status, 401);
  });

  it("rejects unauthenticated reads on the test channel", async () => {
    testGateModule.setChannelAttestationTokenForTesting("route-test-token");
    const response = await threadRoute.GET(
      makeRequest(`${TEST_ORIGIN}/api/thread`, {
        headers: { [TEST_ATTESTATION_HEADER]: "route-test-token" },
      }),
    );
    assert.equal(response.status, 401);
  });
});

describe("OIDC routes on the test channel", () => {
  it("login redirects to the gate's issuance instead of starting OIDC", async () => {
    testGateModule.setChannelAttestationTokenForTesting("route-test-token");
    const response = await loginRoute.GET(
      makeRequest(`${TEST_ORIGIN}/api/auth/login`, {
        headers: { [TEST_ATTESTATION_HEADER]: "route-test-token" },
      }),
    );
    assert.equal(response.status, 303);
    assert.equal(response.headers.get("location"), `${TEST_ORIGIN}/api/test-gate/session`);
    // No flow cookie is set: the OIDC flow never started.
    assert.equal(response.headers.get("set-cookie"), null);
  });

  it("callback is absent on the test channel (no owner session can be minted there)", async () => {
    testGateModule.setChannelAttestationTokenForTesting("route-test-token");
    const response = await callbackRoute.GET(
      makeRequest(`${TEST_ORIGIN}/api/auth/callback?code=x&state=y`, {
        headers: { [TEST_ATTESTATION_HEADER]: "route-test-token" },
      }),
    );
    assert.equal(response.status, 404);
  });

  it("logout on the test channel clears the test cookie only", async () => {
    testGateModule.setChannelAttestationTokenForTesting("route-test-token");
    const response = await logoutRoute.POST(
      makeRequest(`${TEST_ORIGIN}/api/auth/logout`, {
        method: "POST",
        headers: { origin: TEST_ORIGIN, [TEST_ATTESTATION_HEADER]: "route-test-token" },
        cookies: {
          [sessionModule.TEST_SESSION_COOKIE_NAME]: testCookie(),
          [sessionModule.SESSION_COOKIE_NAME]: ownerCookie(),
        },
      }),
    );
    assert.equal(response.status, 204);
    const setCookie = response.headers.get("set-cookie");
    assert.ok(setCookie.includes(`${sessionModule.TEST_SESSION_COOKIE_NAME}=;`));
    assert.ok(!setCookie.includes(sessionModule.SESSION_COOKIE_NAME));
  });

  it("logout on the main channel still requires the owner session and clears it", async () => {
    const noSession = await logoutRoute.POST(
      makeRequest(`${MAIN_ORIGIN}/api/auth/logout`, { method: "POST", headers: { origin: MAIN_ORIGIN } }),
    );
    assert.equal(noSession.status, 401);
    const ok = await logoutRoute.POST(
      makeRequest(`${MAIN_ORIGIN}/api/auth/logout`, {
        method: "POST",
        headers: { origin: MAIN_ORIGIN, ...spoofedHeaders },
        cookies: { [sessionModule.SESSION_COOKIE_NAME]: ownerCookie() },
      }),
    );
    assert.equal(ok.status, 204);
    assert.ok(ok.headers.get("set-cookie").includes(`${sessionModule.SESSION_COOKIE_NAME}=;`));
  });
});

describe("fail-closed behavior with the gate disabled", () => {
  it("an attestation-shaped header on the main channel is just an unknown header", async () => {
    clearTestGateEnv();
    // No token in the process (server would not have started a listener):
    // a client-supplied header cannot create a test channel.
    const request = makeRequest(`${MAIN_ORIGIN}/api/test-gate/session`, {
      headers: { [TEST_ATTESTATION_HEADER]: "whatever" },
    });
    const response = await issuanceRoute.GET(request);
    assert.equal(response.status, 404);
  });

  it("a production deployment purpose keeps the gate closed everywhere", async () => {
    testGateModule.setChannelAttestationTokenForTesting("route-test-token");
    setEnv({ ...gateEnv, COMPANION_DEPLOYMENT_PURPOSE: "production" });
    const response = await threadRoute.GET(
      makeRequest(`${TEST_ORIGIN}/api/thread`, {
        headers: { [TEST_ATTESTATION_HEADER]: "route-test-token" },
        cookies: { [sessionModule.TEST_SESSION_COOKIE_NAME]: testCookie() },
      }),
    );
    assert.equal(response.status, 503, "a production purpose must fail the whole configuration");
    const mainResponse = await threadRoute.GET(
      makeRequest(`${MAIN_ORIGIN}/api/thread`, {
        cookies: { [sessionModule.SESSION_COOKIE_NAME]: ownerCookie() },
      }),
    );
    assert.equal(mainResponse.status, 503, "the owner channel fails closed too");
  });

  it("misconfigured gate values fail the whole configuration closed", async () => {
    testGateModule.setChannelAttestationTokenForTesting("route-test-token");
    setEnv({ ...gateEnv, WEB_TEST_GATE_SESSION_SECRET: "short" });
    const response = await threadRoute.GET(
      makeRequest(`${TEST_ORIGIN}/api/thread`, {
        headers: { [TEST_ATTESTATION_HEADER]: "route-test-token" },
        cookies: { [sessionModule.TEST_SESSION_COOKIE_NAME]: testCookie() },
      }),
    );
    assert.equal(response.status, 503);
    const send = await messagesRoute.POST(
      makeRequest(`${TEST_ORIGIN}/api/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: TEST_ORIGIN, [TEST_ATTESTATION_HEADER]: "route-test-token" },
        cookies: { [sessionModule.TEST_SESSION_COOKIE_NAME]: testCookie() },
        body: { text: "x", clientKey: "k" },
      }),
    );
    assert.equal(send.status, 503);
  });

  it("the test gate is invisible to the owner session machinery (NODE_ENV irrelevant)", async () => {
    process.env.NODE_ENV = "production";
    try {
      testGateModule.setChannelAttestationTokenForTesting("route-test-token");
      const response = await threadRoute.GET(
        makeRequest(`${TEST_ORIGIN}/api/thread`, {
          headers: { [TEST_ATTESTATION_HEADER]: "route-test-token" },
          cookies: { [sessionModule.TEST_SESSION_COOKIE_NAME]: testCookie() },
        }),
      );
      assert.equal(response.status, 200, "the gate works under Next production mode");
      const mainResponse = await threadRoute.GET(
        makeRequest(`${MAIN_ORIGIN}/api/thread`, {
          cookies: { [sessionModule.SESSION_COOKIE_NAME]: ownerCookie() },
        }),
      );
      assert.equal(mainResponse.status, 200, "the main channel is unchanged under Next production mode");
    } finally {
      delete process.env.NODE_ENV;
    }
  });
});
