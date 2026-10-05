import { closeDb, getPool } from './db/client.js';
import { runMigrations } from './db/migrator.js';

/** `npm run migrate` — apply pending SQL migrations and exit. */
async function main() {
  const result = await runMigrations(getPool());
  for (const name of result.applied) console.log(`applied ${name}`);
  console.log(
    `migrations complete: ${result.applied.length} applied, ${result.alreadyApplied.length} already applied`,
  );
  await closeDb();
}

main().catch(async (err) => {
  console.error(err instanceof Error ? err.message : err);
  await closeDb().catch(() => undefined);
  process.exit(1);
});
