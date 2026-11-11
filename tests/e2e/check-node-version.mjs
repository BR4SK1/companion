#!/usr/bin/env node
import process from "node:process";

const expected = "22.23.4";
if (process.versions.node !== expected) {
  console.error(
    `Companion E2E tooling requires Node.js ${expected}; found ${process.versions.node}. ` +
      "Select the version pinned in tests/e2e/.nvmrc and rerun the command.",
  );
  process.exitCode = 1;
}
