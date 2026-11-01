---
name: ship-it
description: Use when the user says "ship it" (or "ship this") — treat it as authorization to finish and publish only the current work as a pull request, including this repository's full delivery sequence up to that point: local verification gates, deploying the committed candidate to non-production, and integration/end-to-end testing — including the standing-authorized deployed non-production smoke — before the PR is created. Covers scope protection, check gates, branch/commit conventions, the manual non-production deployment, PR creation, and when to stop and ask instead of shipping. It does not authorize production deployment, merges, promotion, or unrelated changes.
---

# Ship It

"Ship it" means: finish the current work, verify it, deploy it to the
non-production environment, verify it there end to end, and publish it as a
pull request. The authorization covers the current work and its publication
path only — never merging, production deployment or promotion, or any
unrelated change. The owner's standing authorization (recorded 2026-11-01)
covers the deployed smoke's billable non-production provider calls within
this flow; production stays out of scope. This repository has no remote CI
and no deployment automation: every check and the non-production install
itself are performed locally (see `CONTRIBUTING.md` and `deploy/README.md`),
nothing runs automatically on push, and a merge does not deploy. If anything
required is missing, failing, unclear, inapplicable, or blocked, stop and ask
the user. Never fabricate success, bypass a gate, or assume an exception.

## Workflow

1. **Read the repo's own instructions first.** Follow the project's
   `AGENTS.md`, `CONTRIBUTING.md`, `README.md`, PR template, and any defined
   release or contribution process. Where this workflow and the repo's process
   disagree, the repo's process wins — including its ordering of steps. This
   repository defines its delivery sequence in `AGENTS.md` (code and unit
   tests → feature-branch commit → non-production deployment → integration
   and end-to-end tests → pre-publication safety checks → push/pull request →
   owner merge as production approval); the steps below follow it. In this
   repository, `AGENTS.md` process-adherence rules apply: follow the defined
   process exactly and stop for anything unclear.
2. **Determine and protect scope.** Identify exactly which changes belong to
   the current work. Leave unrelated modifications in the working tree
   untouched; never sweep them into the commit. Do not stash, discard, or
   otherwise modify unrelated work without the user's explicit permission. If
   the boundary is unclear, stop and ask before committing anything.
3. **Review the diff before committing.** Check the diff for secrets (keys,
   tokens, credentials), local-only planning or environment files, debug
   leftovers, generated artifacts that should not be committed, and anything
   the user has not seen. Surface anything questionable before committing.
4. **Run the pre-commit verification gates.** There is no remote CI to run
   them for you — no GitHub Actions workflows and no branch protection exist
   (`CONTRIBUTING.md`); every gate below is run locally, with the project's
   own commands. This is a hard gate: **required checks must pass before you
   commit**; the deployment (step 6) and the post-deployment gates (step 7)
   build on them, absent an explicit user-approved exception.
   - Prerequisite: `pnpm install` at the repository root (the pnpm workspace
     install; it also installs the Git hooks).
   - Always: `pnpm test:unit` (the hermetic unit suite — contracts, shared
     transport, worker logic, web logic; no database, no network; the
     `pre-commit` hook runs it again at commit time), `pnpm typecheck` (the
     OpenRouter and PostgreSQL libraries and the worker),
     `pnpm --filter @companion/web typecheck`, `pnpm --filter @companion/web
     lint`, and `pnpm --filter @companion/web build` (the production build
     the E2E suite serves). Accurately report the actual scope and results;
     do not improvise a substitute runner or gate.
   - When the Helm chart or deployment configuration changed, and always when
     preparing the deployment (step 6): `deploy/helm/render-checks.sh`
     (local-only, no cluster access; requires `helm` and `python3` with
     PyYAML).
   - The database-backed integration suites and the end-to-end suites are not
     pre-commit gates: this repository's sequence places them after the
     non-production deployment, and they are step 7 below.
   - If a check fails: fix within scope if the cause is your work; otherwise
     stop and report. Do not commit or deploy a red tree. If tooling is
     unavailable, or a check is inapplicable or unclear, do not improvise a
     substitute and do not assume an exception: stop and ask the user how to
     proceed. A skipped gate is the user's decision, not yours.
5. **Check the branch before shipping, then branch and commit per repo
   convention.** Always check which branch the working tree is currently on
   before committing or pushing. Decide from evidence (current branch, its
   upstream, its ancestry relative to the intended base, and any PR already
   open or previously filed for it) whether that branch is the right home for
   this work:
   - **Reuse the current branch** only when it is actually for this work: not
     the default or a protected branch, no merged or closed PR already
     attached to it, an intended base and clean ancestry for this change, and
     no unrelated work mixed into its history or working tree.
   - **Create (or switch to) a new feature branch** when the current branch is
     the default or otherwise protected, is for different work, already has a
     merged or closed PR, or has unsuitable upstream or ancestry for this
     change (e.g. it was branched off another feature branch rather than the
     intended base). Determine the intended base branch first and create the
     new branch from it, per repo naming convention.
   - Remember that a branch carries its full ancestry: pushing or opening a PR
     from the wrong base can expose unrelated history. Verify what would
     actually be outgoing (`git log`/`git diff` against the intended base)
     before pushing.
   - Never switch branches by overwriting, discarding, or stashing unrelated
     changes, and never move or rewrite others' work to make a branch fit. If
     committing here would mix unrelated changes, or the safe transition, base
     branch, or scope is uncertain, stop and ask the user before branching or
     committing.
   Creating a feature branch is a normal operation and does not by itself
   authorize rewriting, rebasing, or force-pushing history.
   Then use the repo's branch naming, Conventional Commits style, and hooks
   (the `commit-msg` hook validates the message; the `pre-commit` hook runs
   the unit suite). Let hooks run; never skip them (`--no-verify`) unless the
   user explicitly asks. Never push to a protected or default branch (e.g.
   `main`). Never force-push.
   The commit is the deployment candidate: the non-production images are
   built from it and tagged with its short SHA (see the deployment
   procedure), so complete the scoped commit before deploying. Everything
   that belongs to this work must be committed at that point; the candidate
   is the commit itself, not whatever else sits in the working tree. Any
   later change to this work means a new candidate commit and re-running the
   affected checks — never verify something that differs from what was
   deployed.
   **The built, deployed, and E2E-tested source must be exactly the committed
   candidate.** With a working tree clean at the candidate commit, building
   and testing from it satisfies this directly. If the tree carries unrelated
   modifications, leave those exactly as they are — never discard, stash, or
   modify them to obtain a clean tree — and build, deploy, and test from a
   separate source that is exactly the candidate commit instead (for example
   a temporary `git worktree` checked out at the candidate commit — with its
   own install and build — or building the images from an archive of that
   commit), verifying that what is built, deployed, and served to the E2E
   suite corresponds to that commit. Never build, deploy, or test a source
   that mixes this work with unrelated changes; if the candidate source
   cannot be separated safely, stop and ask the user.
6. **Deploy the committed candidate to non-production.** Follow the
   repository's local-only per-environment deployment procedure — kept
   outside version control (the gitignored `.private/` deploy notes; public
   context in `deploy/README.md` and
   `deploy/helm/environments/non-production/README.md`). Use that procedure's
   exact commands, environment-specific values files, and Secret delivery;
   never invent registry paths, hostnames, values, or secrets, and never
   touch production. The procedure's shape:
   - Build and push the images it requires from exactly the committed
     candidate (see the candidate-source rule in step 5), tagged with the
     candidate's short SHA (whether an unchanged deployable is rebuilt or
     stays pinned is the procedure's and owner's call — ask if unclear).
   - Render-check the chart with the environment's values before upgrading.
   - Install or upgrade the release into the non-production namespace.
   - Verify the rollout (deployment rollout status, pods) and the basic
     unauthenticated behavior (the web root renders, the BFF API refuses
     unauthenticated requests with 401, sign-in redirects to the identity
     provider). Record the evidence: candidate commit and tree hash, image
     tags, Helm revision.
   This step needs the cluster tooling and access (`docker`, `helm`,
   `kubectl`) and the local-only values and secrets. If any of those are
   missing, or the deploy or its verification fails, stop and report instead
   of working around it. Never claim a deployment happened unless you
   verified it. If the current work plainly cannot affect a deployment (for
   example a documentation-only change), confirm with the user that skipping
   this step is intended before continuing.
7. **Run integration and end-to-end verification against the candidate.** The
   repository's sequence places integration and E2E after the non-production
   deployment; they run against the identified candidate before publication
   (`deploy/helm/environments/non-production/README.md`).
   - **Worker integration suites** — when the worker, the shared libraries,
     or the database schema changed: the suites in `tests/integration`
     against a disposable, isolated non-production database provided via
     `WORKER_TEST_DATABASE_URL` — never a real application database (the
     suites truncate the domain tables) — each suite in its own `node --test`
     invocation, one at a time. They use their own disposable database, not
     the deployed release. If no disposable database is available, stop and
     report instead of skipping silently.
   - **Disposable-stack Playwright suite** — the implemented E2E coverage
     (`tests/e2e/README.md`). It exercises the committed candidate's
     production build (per the candidate-source rule in step 5) against a
     local fake provider and a run-owned throwaway PostgreSQL: no live model
     calls, no real application database, run-owned cleanup. Prerequisites:
     `pnpm install`, the pinned Playwright browser
     (`pnpm exec playwright install chromium` from `tests/e2e`),
     `pnpm --filter @companion/web build`, Docker, and free loopback ports
     (defaults 4620–4624). Run `pnpm --filter @companion/e2e test` (or
     `pnpm exec playwright test` from `tests/e2e`). When the E2E tooling
     itself changed, also run its own suites: `pnpm --filter @companion/e2e
     test:stack` and, for the deployed-smoke core, `pnpm --filter
     @companion/e2e test:smoke`. Note the documented limit: the suite
     exercises locally built source, not the deployed immutable artifacts.
   - **The deployed candidate through the loopback test-entry gate** — the
     documented E2E access to a non-production release (`apps/web/README.md`,
     `deploy/helm/environments/non-production/README.md`): `kubectl
     port-forward` to the pod-local gate port, address the app as
     `127.0.0.1`, keep the forward bound to the workstation loopback, and
     tear it down when testing ends. At minimum verify the gate's
     unauthenticated → issuance → app flow and read-only thread access
     against the deployed release. Sending through the gate is real
     conversation work and can incur provider charges; the owner's standing
     authorization (2026-11-01) covers this flow's billable non-production
     sends, and automated sends belong to the deployed smoke below, whose
     attribution and cleanup machinery ad-hoc sends should not improvise
     around. If the deployed release has the gate disabled, or the forward
     is blocked, stop and ask instead of improvising access.
   - **The deployed smoke — a normal pre-PR gate under standing owner
     authorization.** Run it whenever this flow deployed a candidate (it
     inherits step 6's applicability rule):
     `E2E_DEPLOYED_SMOKE_ALLOWED=1 E2E_DEPLOYED_SMOKE_EXCLUSIVE_DEV_ACCESS=1
     node tests/e2e/deployed-dev-smoke.mjs` (from the repository root). It
     drives the actual deployed candidate through its loopback test-entry
     gate (the script performs its own port-forward) and sends one synthetic
     message — real, billable provider calls and a non-production database
     write — then removes its own data with race-safe, targeted cleanup.
     The owner's standing authorization (recorded 2026-11-01) covers these
     billable non-production provider calls within this flow, and the owner
     has affirmed that the non-production environment and all accounts
     associated with this project belong to the owner and are not shared
     with anyone else; setting both variables here expresses that standing
     authorization. The script's own guards remain fully in force — it
     refuses to run without both variables, and exclusivity is still the
     owner's assertion, not a system guarantee: nothing prevents another
     process or person from reaching the dev stack concurrently, so never
     claim concurrent access is impossible. The script detects overlap
     conservatively and stays in control throughout: read-only preflight
     stops before anything is sent on any doubt (deployed image identity,
     gate attestation and enablement, a free forward port, cleanup linkage,
     thread quiescence, no leftover smoke rows); a pre-send state check
     aborts before any provider call if the thread changed since preflight;
     post-send accounting flags unexpected growth, retains everything, and
     reports it — including when the owner themselves is actively using the
     dev thread, where the quiescence checks legitimately refuse. If the
     script refuses, aborts, or reports overlap, anomalies, or retained
     data, stop and report its evidence; never route around a guard. If a
     run is interrupted, recover idempotently with the script's `--recover`
     path (`E2E_DEPLOYED_SMOKE_ALLOWED=1 node
     tests/e2e/deployed-dev-smoke.mjs --recover`). The one-call cost
     expectation derives from deployed configuration and is not hard-capped
     by the script.
8. **Run the pre-publication safety checks.** After verification and before
   pushing, re-review exactly what would be published: the outgoing diff
   against the intended base, and the checklist in
   `.github/PULL_REQUEST_TEMPLATE.md` — Conventional Commits; public-content
   safety (no copied source, private infrastructure identifiers, sensitive
   usage details, personal details, credentials, or links to non-public
   documents); no secret values, local environment files, generated artifacts,
   or deployment credentials added; repository boundaries respected;
   unresolved architectural choices still documented as unresolved. Surface
   anything questionable before pushing.
9. **Push the branch to its remote with a normal push** (e.g. `git push -u
   origin <branch>`), after all the gates above and before opening the pull
   request. If there is no remote, no permission to push, or the push fails,
   stop and report instead of working around it. Do not force-push or push
   anywhere other than the intended feature branch.
10. **Open the pull request.**
    - Check for an existing PR for this work first; do not create duplicates —
      update or comment on the existing one instead.
    - Follow the repo's PR template if present (this repository uses
      `.github/PULL_REQUEST_TEMPLATE.md`).
    - Write an accurate title and description: what changed, how it was
      verified (checks, the non-production deployment, integration/E2E —
      including anything not run and why), and any known limitations.
    - Do **not** merge, approve, or trigger promotion or production
      deployment. PR creation is the endpoint.
11. **Report.** Summarize: branch name, commit hash(es), push result, PR URL,
    the verification results gate by gate (unit, typechecks, lint, build,
    render checks, integration — command and pass/fail counts — or the reason
    none were run), the non-production deployment evidence (candidate commit
    and tree, image tags, Helm revision, rollout and post-deploy verification
    results), the E2E results (suite counts, deployed-candidate gate checks,
    and the deployed smoke's result — outcome, provider-call count, and
    cleanup/residual status — or why it did not run), any
    checks skipped or unavailable, and any limitations or follow-ups. Say
    plainly when something was not done and why.

## Boundaries

- Authorization is narrow: it covers completing, verifying, deploying to
  non-production, and publishing the current work as a PR. It does not cover
  production deployment or provisioning, merges, promotion, infrastructure
  changes, new features, or fixes to unrelated issues — file or mention those
  instead of doing them here. Production approval is the owner's merge, and a
  merge deploys nothing: there is no deployment trigger or controller.
- The deployed smoke runs under the owner's standing authorization recorded
  in this skill (2026-11-01): within this flow, its billable non-production
  provider calls and its non-production database write are authorized, and
  the owner has affirmed that the non-production environment and all
  accounts associated with this project belong to the owner and are not
  shared with anyone else. Exclusivity remains an operator assertion, not a
  system guarantee; do not assert that the system prevents concurrent access
  to the dev stack. This standing authorization does not extend to
  production: no production deployment, production provider calls, or
  production writes.
- No permission bypass: if a step requires access, approval, or a decision you
  do not have, stop and return the blocker to the user (or the coordinating
  primary agent, if delegated). Do not resolve it by assumption.
- Creating or loading this skill does not itself ship anything; it only defines
  how to respond when the user says "ship it".
