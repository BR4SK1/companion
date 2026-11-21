import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const expected = fs.readFileSync(path.resolve(here, "../../.nvmrc"), "utf8").trim();

if (process.versions.node !== expected) {
  console.error(
    `Companion E2E tooling requires Node.js ${expected}; found ${process.versions.node}.\n` +
      `Select the version pinned in .nvmrc (for example: nvm use) and rerun.`,
  );
  process.exitCode = 1;
}
