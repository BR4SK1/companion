# Shared infrastructure libraries

This root holds reusable infrastructure boundaries, not a common home for unrelated domain models. Domain types, schemas, and queries remain owned by the domains that use them.

- [`openrouter`](openrouter/README.md) — shared transport and separate typed chat and decision capabilities.
- [`postgres`](postgres/README.md) — relational PostgreSQL access boundary.

These directories contain documentation only, with no code or package manifests. A shared TypeScript library is the intended organizational direction, but its packaging and consumption mechanism remain open. Application-specific choices and deployment-configured policy are outside the shared-library boundary.
