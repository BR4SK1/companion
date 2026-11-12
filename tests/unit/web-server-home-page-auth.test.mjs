// Unit tests for the owner's signed-out landing decision. This ensures the
// home page starts the existing login flow for ordinary signed-out visits,
// while auth failures remain on the retry view and valid sessions stay put.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { shouldAutoRedirectToLogin } from "../../apps/web/src/lib/server/home-page-auth.ts";

describe("signed-out home page login redirect", () => {
  it("starts login only for a signed-out visit without an auth notice", () => {
    assert.equal(shouldAutoRedirectToLogin(false, false), true);
    assert.equal(shouldAutoRedirectToLogin(false, true), false);
    assert.equal(shouldAutoRedirectToLogin(true, false), false);
    assert.equal(shouldAutoRedirectToLogin(true, true), false);
  });
});
