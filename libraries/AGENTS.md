# Shared library boundaries

- Keep this area focused on reusable infrastructure interfaces and integrations, not a common home for unrelated domain models.
- Domain semantics, types, schemas, and queries belong to their owning domains. Do not create a generic shared-types library or move domain-owned behavior here for convenience.
- Keep transport/integration concerns distinct from typed capability contracts where the architecture calls for that separation. Do not embed deployment-specific policy or rule content in shared libraries.
- Treat package tooling, ORM, and library implementation choices as unresolved unless separately approved and recorded.
- Follow the root `AGENTS.md` for repository-wide scope, public-content, and delegation rules. Documented future designs do not by themselves authorize implementation.
