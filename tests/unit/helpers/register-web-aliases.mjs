// Registers the web app's module aliases for plain-node execution of the
// real route handler modules. See web-next-resolve-hook.mjs for the mapping.
import { registerHooks, register } from "node:module";

import { resolve } from "./web-next-resolve-hook.mjs";

// registerHooks is synchronous and in-thread (Node ≥ 22.15/23.5); register
// is the portable fallback for older runtimes.
if (typeof registerHooks === "function") {
  registerHooks({ resolve });
} else {
  const hookUrl = new URL("./web-next-resolve-hook.mjs", import.meta.url);
  register(hookUrl.href, import.meta.url);
}
