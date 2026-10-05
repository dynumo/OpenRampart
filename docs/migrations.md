# Database migrations

OpenRampart uses plain, hand-written SQL migrations in [`migrations/`](../migrations). They are
the source of truth for the schema. `src/server/db/schema.ts` (Drizzle) mirrors them for typed
queries.

## How they run

- On start-up, the server applies any pending migrations before it serves requests. To run
  them as a separate step instead, set `OPENRAMPART_SKIP_MIGRATIONS=true` and use
  `node dist/server/cli.js migrate` (or `npm run migrate`).
- Files are applied in filename order (`0001_initial.sql`, `0002_…`). Each runs in its own
  transaction, so a failing migration leaves the database as it was.
- A PostgreSQL advisory lock makes concurrent runners wait. That makes it safe to start
  several replicas at once.
- Each applied file is recorded in `schema_migrations` with a SHA-256 checksum. If an applied
  file has been edited, start-up **stops with an error** rather than silently diverging.

```sh
docker compose exec app node dist/server/cli.js migrate
# Applied 1 migration(s).
```

## Writing a migration

1. Add `migrations/NNNN_short_description.sql`, numbered after the last one.
2. Write forward-only SQL. There are no down-migrations; roll back by restoring a backup.
3. Keep it safe on a live database:
   - Add columns as nullable or with a default.
   - Create large indexes with care. `CREATE INDEX CONCURRENTLY` cannot run inside a
     transaction, so add large indexes in a separate release if needed.
   - Never rewrite `event_revisions`. It is append-only and protected by a trigger.
   - Backfill in batches if a table could be large.
4. Update `src/server/db/schema.ts` to match.
5. Run `npm run test:integration`. The test set-up recreates a database from all migrations.
6. Never edit a migration that has been released. Add a new one instead.

## Extensions

`0001_initial.sql` creates `pg_trgm` (typo-tolerant search) and `pgcrypto`. On managed
PostgreSQL, make sure both are allowed. The database user needs permission to create them on
the first run, or an administrator can create them in advance.

## Upgrading PostgreSQL

OpenRampart supports PostgreSQL 15 and newer. To move to a new major version, dump with the
new version's `pg_dump` and restore into the new server (see
[backup-restore.md](backup-restore.md)), or use `pg_upgrade`. No application changes are
needed.
