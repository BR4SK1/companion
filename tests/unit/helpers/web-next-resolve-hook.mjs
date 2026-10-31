// The alias resolver itself (shared by both registration mechanisms; see
// register-web-aliases.mjs). Falls through for every specifier the web app
// routes do not use.
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../apps/web");

export function resolve(specifier, context, nextResolve) {
  if (specifier === "next/server" || specifier === "next/navigation") {
    return {
      url: pathToFileURL(
        path.join(webRoot, "node_modules", "next", `${specifier.slice("next/".length)}.js`),
      ).href,
      shortCircuit: true,
    };
  }
  if (specifier.startsWith("@/")) {
    const base = path.join(webRoot, "src", specifier.slice(2));
    for (const candidate of [`${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")]) {
      if (existsSync(candidate)) {
        return { url: pathToFileURL(candidate).href, shortCircuit: true };
      }
    }
  }
  return nextResolve(specifier, context);
}
