import pg from 'pg';
import { TEST_ENV } from './env.js';

/** Recreate the test database and apply migrations once per run. */
export default async function setup() {
  Object.assign(process.env, TEST_ENV);
  const url = new URL(TEST_ENV.DATABASE_URL!);
  const dbName = url.pathname.slice(1);
  // This database is dropped and recreated: never let a mistyped TEST_DATABASE_URL hit real data.
  if (!dbName.endsWith('_test'))
    throw new Error(`Refusing to reset a database not named *_test (${dbName})`);
  const admin = new pg.Client({
    connectionString: Object.assign(new URL(url), { pathname: '/postgres' }).toString(),
  });
  await admin.connect();
  await admin.query(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
    [dbName],
  );
  await admin.query(`DROP DATABASE IF EXISTS "${dbName}"`);
  await admin.query(`CREATE DATABASE "${dbName}"`);
  await admin.end();
  const { createPool } = await import('../../src/server/db/client.js');
  const { runMigrations } = await import('../../src/server/db/migrator.js');
  const pool = createPool(TEST_ENV.DATABASE_URL!, 'disable', 2);
  await runMigrations(pool);
  await pool.end();
  const { ensureBucket } = await import('../../src/server/storage/s3.js');
  await ensureBucket();
}
