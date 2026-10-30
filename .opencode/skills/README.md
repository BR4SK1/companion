# Reusable agent skills

These generic workflows read the actual repository rules and task context before acting; they provide guidance only and do not replace repository instructions or grant permissions.

- [`repository-architecture-review`](repository-architecture-review/README.md) — evidence-based, read-only review against Companion's current constraints, proposals, and architecture evidence.
- [`repository-publication-review`](repository-publication-review/README.md) — scope-aware review of public-branch history, content, and applicable artifacts against Companion's public-content policy; does not publish or clean up.
- [`ship-it`](ship-it/README.md) — workflow for the user's "ship it" request: verify the current work, then commit, push the feature branch, and open a pull request; does not merge, deploy, or touch unrelated work.
