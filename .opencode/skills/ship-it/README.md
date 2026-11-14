# Ship It skill

See [`SKILL.md`](SKILL.md) for the workflow the phrase "ship it" authorizes:
finish and verify the current work, pass the repository's local verification
gates, deploy the committed candidate to the non-production environment, and
verify it there end to end — including the destructive, serial worker
integration phase against the positively verified non-production application
database, its complete schema/configuration reconstruction, and the deployed
smoke (billable provider calls under the owner's standing authorization) —
then push the feature branch and open a pull request, nothing more. It does not
authorize production database access or operations, production deployment,
merges, promotion, or unrelated changes.
