# Contributing

This repository is a single-user, self-hosted project maintained by its owner. These notes describe how the repository is currently worked in. Architectural guardrails live in [`AGENTS.md`](AGENTS.md).

## Repository state

The repository is an architecture scaffold with early implementation: architecture documentation, the OpenRouter shared-library contract code (`libraries/openrouter`), and a first web-client slice in `apps/web` — a local-only, fixture-backed messenger preview (Next.js, React, MUI) with no backend, authentication, or live chat. Nothing is deployed. Contribution tooling (package manager, commit hooks) is installed at the repository root and applies to documentation and code alike.

## Tooling setup

The package manager is [pnpm](https://pnpm.io/). The exact version is pinned in the root `package.json` via the `packageManager` field and recorded in the committed `pnpm-lock.yaml`. Node.js `>= 22.12.0` is required, as declared in the root `package.json` `engines` field; this matches the strictest engine requirement among the dependencies (the commitlint packages declare `>=22.12.0`).

The pinned pnpm version is activated as follows: install any pnpm 10.x by your preferred method (standalone installer, `npm install -g pnpm`, or a system package). From pnpm 10 onward, `manage-package-manager-versions` defaults to `true`, so pnpm honors the `packageManager` pin and switches to exactly that version, fetching it once if it differs from the installed one. Corepack is not required and is not assumed to be available on this machine.

The repository is a pnpm workspace (`pnpm-workspace.yaml` covers `apps/*`). `pnpm install` at the root installs the root tooling package and every workspace package's dependencies in one shared lockfile. Workspace application packages (currently `apps/web`) are named `@companion/<app>` so `pnpm --filter` commands address them individually; see [`apps/web/README.md`](apps/web/README.md) for its commands.

Hook tooling is installed locally with the repository dependencies. The `commit-msg` hook runs commitlint from those locally installed dependencies (`pnpm exec` resolves the repository's `node_modules`); it installs nothing when it runs. Separately, invoking pnpm itself can fetch the pinned pnpm release once via pnpm's version manager if the invoked pnpm differs from the `packageManager` pin — a one-time setup occurrence, not hook-time behavior.

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

The command discovers test files matching `tests/unit/**/*.test.mjs`, so new test files added under [`tests/unit`](tests/unit/README.md) run without changing the command. It contains the deliberate placeholder harness suite, the OpenRouter Decisions contract tests, and the web preview's pure-logic tests (thread grouping, scroll anchoring, time labels, fixture sanity); the contract and preview tests make no network calls. Add real unit tests there as more application code lands; they are picked up by the same command.

## Type checking

Shared-library sources are TypeScript. Type-check the OpenRouter contract with:

```sh
pnpm typecheck
```

This runs `tsc` (`--noEmit`, strict) over `libraries/openrouter` via its `tsconfig.json`. It is a separate command, not part of `pnpm test:unit`; the unit tests run the TypeScript source directly through Node's type stripping (the command passes `--experimental-strip-types` explicitly, which is required on Node 22.12–22.17 and still accepted where stripping is on by default), so no build step is required.

## Commit messages

Commits must follow [Conventional Commits](https://www.conventionalcommits.org/). A `commit-msg` hook validates every commit message locally with commitlint using the standard Conventional Commits configuration.

Standard types: `build`, `chore`, `ci`, `docs`, `feat`, `fix`, `perf`, `refactor`, `revert`, `style`, `test`.

Scopes are optional and currently free-form:

```text
docs: clarify the worker deployment scope
feat(bff): add owner authorization at the BFF edge
```

### Bypassing the hook

The hook is a local convenience, not a server-side gate: no CI or branch protection exists yet. A commit can bypass validation with:

```sh
git commit --no-verify
```

Use bypass sparingly and fix the message before pushing where possible, since a pushed invalid message cannot be re-validated by the hook.

### Limitations

- Hooks run locally only. Clones that skip `pnpm install`, or any workflow that does not run Git hooks, do not validate messages.
- Squash merges are not validated. When squashing a pull request, the squash commit title is entered at merge time and bypasses the hook entirely; keep it Conventional Commits-conformant by hand.
- The hook validates the message only. It does not check content, run tests, or perform any publication-safety review.

## Pull requests

`.github/PULL_REQUEST_TEMPLATE.md` applies to pull requests. Keep public content safe to publish as described in [`AGENTS.md`](AGENTS.md), and leave unresolved architectural choices documented as unresolved.
