/**
 * Conventional Commits validation for the Companion repository.
 *
 * The standard Conventional Commits types from @commitlint/config-conventional
 * are enforced (build, chore, ci, docs, feat, fix, perf, refactor, revert,
 * style, test). Scopes are optional and free-form; there is no fixed scope
 * list yet because the repository is still a documentation-only scaffold and
 * area names may evolve.
 *
 * @type {import('@commitlint/types').UserConfig}
 */
export default {
  extends: ['@commitlint/config-conventional'],
};
