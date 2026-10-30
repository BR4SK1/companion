// Unit tests for the BFF's signed cookie tokens
// (apps/web/src/lib/server/session.ts): HMAC sign/verify round-trips,
// tamper and malformed-token rejection, expiry handling, and payload
// validation. Pure modules — no Next.js runtime, no network.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  createAuthFlowPayload,
  createSessionPayload,
  signToken,
  verifyAuthFlowToken,
  verifySessionToken,
} from "../../apps/web/src/lib/server/session.ts";

const SECRET = "unit-test-secret-that-is-long-enough-32";

describe("BFF session tokens", () => {
  it("round-trips a session payload", () => {
    const payload = createSessionPayload("subject-1", 1000, 3600);
    const token = signToken(payload, SECRET);
    const verified = verifySessionToken(token, SECRET, 1000);
    assert.deepEqual(verified, { sub: "subject-1", iat: 1000, exp: 4600 });
  });

  it("rejects a session token signed with a different secret", () => {
    const token = signToken(createSessionPayload("subject-1", 1000, 3600), "another-secret-that-is-long-enough");
    assert.equal(verifySessionToken(token, SECRET, 1000), null);
  });

  it("rejects tampered payloads", () => {
    const token = signToken(createSessionPayload("subject-1", 1000, 3600), SECRET);
    const [payloadPart] = token.split(".");
    const forgedPayload = Buffer.from(
      JSON.stringify({ sub: "attacker", iat: 1000, exp: 4600 }),
    ).toString("base64url");
    // The forged payload keeps the original MAC.
    assert.equal(
      verifySessionToken(`${forgedPayload}.${token.split(".")[1]}`, SECRET, 1000),
      null,
      "a payload swapped under the original MAC must not verify",
    );
    assert.ok(forgedPayload !== payloadPart);
  });

  it("rejects expired session tokens", () => {
    const token = signToken(createSessionPayload("subject-1", 1000, 3600), SECRET);
    assert.equal(verifySessionToken(token, SECRET, 4600), null);
    assert.equal(verifySessionToken(token, SECRET, 4601), null);
    // Still valid just before expiry.
    assert.ok(verifySessionToken(token, SECRET, 4599) !== null);
  });

  it("rejects malformed tokens instead of throwing", () => {
    for (const token of [undefined, "", "garbage", "a.b", "....", `${"x".repeat(64)}.`, ".signed"]) {
      assert.equal(verifySessionToken(token, SECRET, 1000), null, `token: ${String(token)}`);
    }
  });

  it("rejects payloads missing required fields", () => {
    const token = signToken({ exp: 99999 }, SECRET);
    assert.equal(verifySessionToken(token, SECRET, 1000), null);
    const emptySub = signToken({ sub: "", iat: 1, exp: 99999 }, SECRET);
    assert.equal(verifySessionToken(emptySub, SECRET, 1000), null);
  });
});

describe("BFF login-flow tokens", () => {
  it("round-trips the flow binding (state, nonce, PKCE verifier)", () => {
    const flow = createAuthFlowPayload(
      { state: "state-1", nonce: "nonce-1", codeVerifier: "verifier-1" },
      1000,
      600,
    );
    const token = signToken(flow, SECRET);
    const verified = verifyAuthFlowToken(token, SECRET, 1000);
    assert.deepEqual(verified, {
      state: "state-1",
      nonce: "nonce-1",
      codeVerifier: "verifier-1",
      iat: 1000,
      exp: 1600,
    });
  });

  it("rejects expired or incomplete flow tokens", () => {
    const token = signToken(
      createAuthFlowPayload(
        { state: "s", nonce: "n", codeVerifier: "v" },
        1000,
        600,
      ),
      SECRET,
    );
    assert.equal(verifyAuthFlowToken(token, SECRET, 1600), null);

    const incomplete = signToken({ state: "s", exp: 99999 }, SECRET);
    assert.equal(verifyAuthFlowToken(incomplete, SECRET, 1000), null);
  });
});
