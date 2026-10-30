# Unit tests

Unit tests live in this directory as `*.test.mjs` files and run on Node's built-in test runner (`node:test` with `node:assert`); no test dependency is installed. Run them from the repository root with:

```sh
pnpm test:unit
```

The command runs `node --test "tests/unit/**/*.test.mjs"`, so any future test file matching that pattern under this directory is discovered automatically — add files here and they run without changing the command. Whether future unit tests should instead be colocated next to the code they exercise is unresolved; if colocated tests are adopted later, extend this command's pattern rather than introducing a second unit runner.

## Current contents

`harness.test.mjs` is a deliberate placeholder: it asserts only that the harness discovers and runs test files. It validates no application behavior and provides no application coverage. It exists so the publication test gate has a real, runnable suite to execute.

Integration and end-to-end coverage remain documentation-only; see [`../README.md`](../README.md).
