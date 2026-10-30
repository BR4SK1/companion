# PostgreSQL integration boundary

## Responsibilities

Future shared infrastructure may own connection lifecycle, transaction mechanics, and common access concerns for the existing PostgreSQL service. The database is relational and external to K3s; this project does not provision a database or add a document-compatibility layer.

## Boundaries and dependencies

Domain owners own their types, schemas, migrations, constraints, and queries. Shared database infrastructure must not become a generic domain repository or shared-types dumping ground. Non-production and production must use separate databases, credentials, and storage boundaries.

## Scope

No schema, migration, endpoint, credential, connection configuration, ORM, or database runtime is included. Drizzle with `pg` remains a proposal, not an approved choice.

## Open questions

Select the access/migration approach only after domain needs are known. Define migration compatibility, ordering, backup/recovery, restart behavior, and safe rollout/recovery policies. Do not imply database rollback is transactional or guaranteed without a designed mechanism.
