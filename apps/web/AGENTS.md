# Web/BFF boundaries

- The web/BFF owns owner authentication and authorization at the request boundary. Keep credentials and session-handling secrets server-side; never expose them to browser or mobile clients.
- Treat domain identity separately from authentication identity. Do not propagate identity-provider subjects or speculative user/tenant IDs into domain records, jobs, or worker calls.
- Mobile and browser clients use the BFF boundary; preserve the single continuous visible conversation rather than exposing internal processing segments as separate threads.
- Keep domain-owned types, schemas, and persistence with their owning domain. Treat framework and library choices as unresolved unless separately approved and recorded.
- Follow the root `AGENTS.md` for repository-wide scope, public-content, and delegation rules. Documented future designs do not by themselves authorize implementation.
