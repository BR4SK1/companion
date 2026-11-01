# Ship It skill

See [`SKILL.md`](SKILL.md) for the workflow the phrase "ship it" authorizes:
finish and verify the current work, pass the repository's local verification
gates, deploy the committed candidate to the non-production environment, and
verify it there end to end — the deployed non-production smoke (billable
provider calls under the owner's standing authorization) included — then
push the feature branch and open a pull request, nothing more. It does not
authorize production deployment, merges, promotion, or unrelated changes.
