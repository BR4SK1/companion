# Shared infrastructure libraries

This root holds reusable infrastructure boundaries, not a common home for unrelated domain models. Domain types, schemas, and queries remain owned by the domains that use them.

- [`openrouter`](openrouter/README.md) — shared transport and separate typed chat and decision capabilities. The typed Decisions contract is implemented; transport and chat adapters are not.
- [`postgres`](postgres/README.md) — relational PostgreSQL access boundary.

These directories contain documentation plus the first contract implementation (`openrouter`), which has source, a package manifest (`type: module`, private), and a tsconfig, but no transport, credentials, or application behavior. A shared TypeScript library is the intended organizational direction; workspace wiring, build tooling, and the consumption mechanism remain open. Application-specific choices and deployment-configured policy are outside the shared-library boundary.
