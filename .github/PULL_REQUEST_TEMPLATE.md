# Pull request

## Summary

<!-- What does this change do, in one or two sentences? -->

## Motivation

<!-- Why is this change needed? Link related discussions or documents if any exist. -->

## Changes

<!-- Bullet list of the notable changes. -->

## Checklist

- [ ] Commits follow [Conventional Commits](https://www.conventionalcommits.org/) (validated locally by the `commit-msg` hook; squash-merge titles are set manually and are not hook-validated).
- [ ] Public documentation is standalone, generic, and safe to publish: no copied source, private infrastructure identifiers, sensitive usage details, personal details, credentials, or links to non-public documents.
- [ ] No secret values, local environment files, generated artifacts, or deployment credentials are added.
- [ ] Repository boundaries in [`AGENTS.md`](../AGENTS.md) are respected (for example: K3s targets, owner-only authorization, PostgreSQL as the relational data model, no premature service splits).
- [ ] Unresolved architectural choices are still documented as unresolved; this change does not imply approval of a proposal by its mere presence.

## Verification

<!-- How was this change verified (commands run, checks observed)? State limits if something could not be verified. -->
