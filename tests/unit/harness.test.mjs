// Placeholder unit suite.
//
// Purpose: validate the unit-test harness only — that `pnpm test:unit`
// (`node --test` over tests/unit/**/*.test.mjs) discovers and runs test files
// with Node's built-in test runner. It intentionally makes no assertions about
// application code; there is none yet. Replace or supplement this file with
// real unit tests as application code lands, running them through the same
// command.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

describe("unit test harness", () => {
  it("executes and reports through the node:test runner", () => {
    assert.equal(true, true);
  });
});
