# Shared infrastructure libraries

This root holds reusable infrastructure boundaries, not a common home for unrelated domain models. Domain types, schemas, and queries remain owned by the domains that use them.

- [`openrouter`](openrouter/README.md) — shared transport plus separate typed Decisions and Chat capability contracts; no credentials, retries, fallback, or application behavior.
- [`postgres`](postgres/README.md) — relational PostgreSQL connection lifecycle, transaction mechanics, and a minimal SQL migration runner over `pg`; no endpoints, credentials, or domain schemas.

Both directories are private workspace packages (`@companion/openrouter`, `@companion/postgres`) with source, a package manifest (`type: module`, private), and a tsconfig; applications consume them through pnpm workspace linking and import the TypeScript sources directly (tests run them through Node's type stripping, and `pnpm typecheck` maps the package names to their sources). Application-specific choices and deployment-configured policy are outside the shared-library boundary.
