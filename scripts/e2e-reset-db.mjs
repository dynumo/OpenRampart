// Recreate the end-to-end test database before the server starts (used by playwright.config.ts).
import pg from 'pg';

const url = new URL(process.env.DATABASE_URL);
const name = url.pathname.slice(1);
if (!name.endsWith('_e2e'))
  throw new Error(`Refusing to reset a database not named *_e2e (${name})`);
const adminUrl = new URL(url);
adminUrl.pathname = '/postgres';
const admin = new pg.Client({ connectionString: adminUrl.toString() });
await admin.connect();
await admin.query(
  'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
  [name],
);
await admin.query(`DROP DATABASE IF EXISTS "${name}"`);
await admin.query(`CREATE DATABASE "${name}"`);
await admin.end();
