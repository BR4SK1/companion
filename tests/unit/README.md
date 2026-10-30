# Unit tests

Unit tests live in this directory as `*.test.mjs` files and run on Node's built-in test runner (`node:test` with `node:assert`); no test dependency is installed. Run them from the repository root with:

```sh
pnpm test:unit
```

The command runs `node --test "tests/unit/**/*.test.mjs"`, so any future test file matching that pattern under this directory is discovered automatically — add files here and they run without changing the command. Whether future unit tests should instead be colocated next to the code they exercise is unresolved; if colocated tests are adopted later, extend this command's pattern rather than introducing a second unit runner.

## Current contents

`openrouter-decisions.test.mjs` covers the OpenRouter Decisions contract in [`../../libraries/openrouter/src/decisions.ts`](../../libraries/openrouter/src/decisions.ts): every typed request and answer variant (`choice`, `noul`, `score`), malformed requests and responses, answer/question ID and type correspondence, official-schema constraints (score `minItems: 1`, `session_id`/`user` `maxLength: 256`, nullable `provider` preferences, explicit rejection of the out-of-scope `assets` field), own-key preservation for maps with keys named `__proto__`/`constructor`/`toString`, and the absence of coercion or normalization (a noul probability stays numeric, optional fields stay optional, probabilities are not renormalized). The tests are deterministic, use inline fake payloads, and make no network calls; they import the TypeScript contract source directly, so no build step is required — `pnpm test:unit` passes `--experimental-strip-types` explicitly so the same tests run on Node versions where type stripping is still behind that flag (22.12–22.17) and on versions where it is on by default. They exercise the contract only — no live provider capability, calibration, or fallback is validated by them.

`harness.test.mjs` is a deliberate placeholder: it asserts only that the harness discovers and runs test files. It validates no application behavior beyond the harness itself. It remains so the publication test gate has a real, runnable suite even if the contract tests move.

`web-thread-*.test.mjs` cover the pure presentation logic of the web preview slice in [`../../apps/web`](../../apps/web/README.md): `grouping.ts` (cluster construction and UTC day-change dividers for the visible thread), `scroll.ts` (the "never pull the reader away from older messages" anchoring rule), `time.ts` (deterministic UTC labels and day keys so prerendered HTML and hydrated clients agree), `local-ids.ts` (unique in-session ids for locally composed preview messages), and `fixtures.ts` (fixture sanity: chronological, unique ids, no identity-like fields, local-only image assets that exist). They import the TypeScript sources directly like the contract tests, make no network calls, and need no browser; component behavior is verified separately when running the app.

Integration and end-to-end coverage remain documentation-only; see [`../README.md`](../README.md).
