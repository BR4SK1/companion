# Contributing

This repository is a single-user, self-hosted project maintained by its owner. These notes describe how the repository is currently worked in. Architectural guardrails live in [`AGENTS.md`](AGENTS.md).

## Repository state

The repository has early implementation beyond the scaffold: architecture documentation; shared-library code (`libraries/openrouter` — transport plus typed Decisions and Chat contracts; `libraries/postgres` — connection lifecycle, transactions, migration runner over `pg`); an implemented worker slice in `apps/worker` — durable grouped conversation work on PostgreSQL with OpenRouter response-pattern decisions preceding chat generation, plus a private bearer-token HTTP ingest/read API; and the authenticated web client with its BFF edge in `apps/web` — owner-only Keycloak OIDC sign-in and authenticated routes wired to the worker. Nothing is deployed with this wiring. Contribution tooling (package manager, commit hooks) is installed at the repository root and applies to documentation and code alike.

## Tooling setup

The package manager is [pnpm](https://pnpm.io/). The exact version is pinned in the root `package.json` via the `packageManager` field and recorded in the committed `pnpm-lock.yaml`. Node.js `>= 22.12.0` is required, as declared in the root `package.json` `engines` field; this matches the strictest engine requirement among the dependencies (the commitlint packages declare `>=22.12.0`).

The pinned pnpm version is activated as follows: install any pnpm 10.x by your preferred method (standalone installer, `npm install -g pnpm`, or a system package). From pnpm 10 onward, `manage-package-manager-versions` defaults to `true`, so pnpm honors the `packageManager` pin and switches to exactly that version, fetching it once if it differs from the installed one. Corepack is not required and is not assumed to be available on this machine.

The repository is a pnpm workspace (`pnpm-workspace.yaml` covers `apps/*`). `pnpm install` at the root installs the root tooling package and every workspace package's dependencies in one shared lockfile. Workspace application packages (currently `apps/web`) are named `@companion/<app>` so `pnpm --filter` commands address them individually; see [`apps/web/README.md`](apps/web/README.md) for its commands.

Hook tooling is installed locally with the repository dependencies, and the hooks run from those locally installed dependencies (`pnpm` and `pnpm exec` resolve the repository's `node_modules`); they install nothing when they run. Two hooks are active: `commit-msg` validates the commit message with commitlint, and `pre-commit` runs the full unit suite with `pnpm test:unit` — a failing run blocks the commit (see [Pre-commit unit tests](#pre-commit-unit-tests)). Separately, invoking pnpm itself can fetch the pinned pnpm release once via pnpm's version manager if the invoked pnpm differs from the `packageManager` pin — a one-time setup occurrence, not hook-time behavior.

```sh
pnpm install
```

`pnpm install` also installs the Git hooks (the `prepare` script runs Husky). Verify with:

```sh
git config core.hooksPath   # should print .husky/_
```

## Running unit tests

Unit tests run on Node's built-in test runner (`node:test`, `node:assert`); no test dependency is installed:

```sh
pnpm test:unit
```

The command discovers test files matching `tests/unit/**/*.test.mjs`, so new test files added under [`tests/unit`](tests/unit/README.md) run without changing the command. It contains the deliberate placeholder harness suite, the OpenRouter Decisions and Chat contract tests, the transport tests, the worker's pure turn-logic and HTTP API contract tests, and the web app's pure-logic tests (thread grouping, scroll anchoring, time labels, thread-state merging, BFF session/configuration/origin guards); they make no network calls and need no database. Database-backed worker coverage lives in [`tests/integration`](tests/integration/README.md), which is skipped unless a disposable isolated non-production database is explicitly provided via `WORKER_TEST_DATABASE_URL` (never a real application database — the suites truncate the domain tables).

## Pre-commit unit tests

Every `git commit` first runs the full unit suite (`pnpm test:unit`) through the `pre-commit` hook. If any unit test fails, the commit is not created; fix the code or the test and commit again. The suite makes no network calls and needs no database, so it is safe to run on every commit regardless of what changed, documentation-only commits included.

The hook runs the unit suite only. The database-backed integration suites in [`tests/integration`](tests/integration/README.md) are deliberately not part of it: they are skipped unless an explicitly provided disposable non-production database is set via `WORKER_TEST_DATABASE_URL`, and when one is provided they truncate the domain tables — side effects that never belong inside a commit hook.

The hook tests the working tree as it stands when the commit is made, not the exact staged snapshot; keep the working tree consistent with what you stage.

## Type checking

Shared-library sources are TypeScript. Type-check the OpenRouter library, the PostgreSQL library, and the worker with:

```sh
pnpm typecheck
```

This runs `tsc` (`--noEmit`, strict) over `libraries/openrouter`, `libraries/postgres`, and `apps/worker`. It is a separate command, not part of `pnpm test:unit`; the unit tests run the TypeScript source directly through Node's type stripping (the command passes `--experimental-strip-types` explicitly, which is required on Node 22.12–22.17 and still accepted where stripping is on by default), so no build step is required.

## Commit messages

Commits must follow [Conventional Commits](https://www.conventionalcommits.org/). A `commit-msg` hook validates every commit message locally with commitlint using the standard Conventional Commits configuration.

Standard types: `build`, `chore`, `ci`, `docs`, `feat`, `fix`, `perf`, `refactor`, `revert`, `style`, `test`.

Scopes are optional and currently free-form:

```text
docs: clarify the worker deployment scope
feat(bff): add owner authorization at the BFF edge
```

### Bypassing the hooks

The hooks are a local convenience, not a server-side gate: no CI or branch protection exists yet. `git commit --no-verify` skips both the `commit-msg` message validation and the `pre-commit` unit tests:

```sh
git commit --no-verify
```

Use bypass sparingly and fix the message before pushing where possible, since a pushed invalid message cannot be re-validated by the hook, and a skipped test run is not made up later.

### Limitations

- Hooks run locally only. Clones that skip `pnpm install`, or any workflow that does not run Git hooks, run neither hook.
- Squash merges are not validated. When squashing a pull request, the squash commit title is entered at merge time and bypasses the hook entirely; keep it Conventional Commits-conformant by hand.
- The `commit-msg` hook validates the message only. It does not check content or perform any publication-safety review; unit tests run separately in the `pre-commit` hook, and neither hook performs publication-safety review.

## Pull requests

`.github/PULL_REQUEST_TEMPLATE.md` applies to pull requests. Keep public content safe to publish as described in [`AGENTS.md`](AGENTS.md), and leave unresolved architectural choices documented as unresolved.
