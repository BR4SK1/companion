# Ship It skill

See [`SKILL.md`](SKILL.md) for the workflow the phrase "ship it" authorizes:
finish and verify the current work, pass the repository's local verification
gates, deploy the committed candidate to the non-production environment, and
verify it there end to end with normal usage against unchanged provisioned
configuration — including focused disposable persistence checks where relevant,
the deployed gate, and the guarded smoke (which may incur external provider
charges and retains its synthetic non-production history) — then push the
feature branch and open a pull request, nothing more. Destructive database
suites are isolated tools, never
application database release gates. It does not authorize production access or
operations, merges, promotion, or unrelated changes.
