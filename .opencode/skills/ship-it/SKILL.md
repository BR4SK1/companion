---
name: ship-it
description: Use when the user says "ship it" (or "ship this") — treat it as authorization to finish and publish only the current work as a pull request. Covers scope protection, test gates, branch/commit/push conventions, PR creation, and when to stop and ask instead of shipping. It does not authorize deployments, merges, or unrelated changes.
---

# Ship It

"Ship it" means: finish the current work, verify it, and publish it as a pull
request. The authorization covers the current work and its pull request only —
not merging, deploying, promoting, or any unrelated change. If anything
required is missing, failing, unclear, inapplicable, or blocked, stop and ask
the user. Never fabricate success, bypass a gate, or assume an exception.

## Workflow

1. **Read the repo's own instructions first.** Follow the project's
   `AGENTS.md`, `CONTRIBUTING.md`, `README.md`, PR template, and any defined
   release or contribution process. Where this workflow and the repo's process
   disagree, the repo's process wins — including its ordering of steps. Do not
   impose the order below on a project that defines a different one. In this
   repository, `AGENTS.md` process-adherence rules apply: follow the defined
   process exactly and stop for anything unclear.
2. **Determine and protect scope.** Identify exactly which changes belong to
   the current work. Leave unrelated modifications in the working tree
   untouched; never sweep them into the commit. Do not stash, discard, or
   otherwise modify unrelated work without the user's explicit permission. If
   the boundary is unclear, stop and ask before committing anything.
3. **Review safety before publishing.** Check the diff for secrets (keys,
   tokens, credentials), local-only planning or environment files, debug
   leftovers, generated artifacts that should not be committed, and anything
   the user has not seen. Surface anything questionable before committing.
4. **Run the real test suite.** Find and run the project's actual applicable
   unit tests (and any required checks — lint, typecheck, build — that the
   repo's process requires), using the project's own commands. This is a hard
   gate: **required tests and checks must pass before you push**, absent an
   explicit user-approved exception.
   - If tests fail: fix within scope if the cause is your work; otherwise
     stop and report. Do not push a red tree.
   - If there is no test suite, no applicable tests, the tooling is
     unavailable, or a required step is inapplicable or unclear: do not
     improvise a substitute and do not assume an exception. Stop the
     publication steps and ask the user how to proceed. A skipped gate is the
     user's decision, not yours. (In this repository, unit tests run through
     the repository's own `test:unit` command, e.g. `pnpm test:unit`. Run it
     and accurately report the actual scope and results. If the suite
     currently contains only the placeholder harness test, say that it
     verifies the harness, not application behavior. Future unit tests belong
     in the same command — do not improvise a substitute runner or gate.)
5. **Branch and commit per repo convention.** Use the repo's branch naming,
   Conventional Commits style, and hooks. Let hooks run; never skip them
   (`--no-verify`) unless the user explicitly asks. Never push to a protected
   or default branch (e.g. `main`) — create or use a feature branch. Never
   force-push.
6. **Push the branch to its remote with a normal push** (e.g. `git push -u
   origin <branch>`), after the test gate and before opening the pull request.
   If there is no remote, no permission to push, or the push fails, stop and
   report instead of working around it. Do not force-push or push anywhere
   other than the intended feature branch.
7. **Open the pull request.**
   - Check for an existing PR for this work first; do not create duplicates —
     update or comment on the existing one instead.
   - Follow the repo's PR template if present (this repository uses
     `.github/PULL_REQUEST_TEMPLATE.md`).
   - Write an accurate title and description: what changed, how it was
     verified, and any known limitations.
   - Do **not** merge, approve, deploy, or trigger promotion. PR creation is
     the endpoint.
8. **Report.** Summarize: branch name, commit hash(es), push result, PR URL,
   test/check results (suite, command, pass/fail counts) or the reason none
   were run, any checks skipped or unavailable, and any limitations or
   follow-ups. Say plainly when something was not done and why.

## Boundaries

- Authorization is narrow: it covers completing, verifying, and publishing the
  current work as a PR. It does not cover deployments, merges, infrastructure
  changes, new features, or fixes to unrelated issues — file or mention those
  instead of doing them here.
- No permission bypass: if a step requires access, approval, or a decision you
  do not have, stop and return the blocker to the user (or the coordinating
  primary agent, if delegated). Do not resolve it by assumption.
- Creating or loading this skill does not itself ship anything; it only defines
  how to respond when the user says "ship it".
