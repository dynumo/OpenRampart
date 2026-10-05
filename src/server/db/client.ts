import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { config } from '../config.js';
import * as schema from './schema.js';
import { logger } from '../lib/logger.js';

export type Database = NodePgDatabase<typeof schema>;
/** Either the root database handle or a transaction handle. */
export type Executor = Database | Parameters<Parameters<Database['transaction']>[0]>[0];

let pool: pg.Pool | undefined;
let database: Database | undefined;

// Return DATE columns as plain 'YYYY-MM-DD' strings rather than JS Dates in
// the server's local timezone; Event dates are interpreted in the owner's zone.
pg.types.setTypeParser(1082, (v) => v);

export function createPool(connectionString: string, ssl: string, max: number): pg.Pool {
  return new pg.Pool({
    connectionString,
    max,
    ssl:
      ssl === 'disable'
        ? undefined
        : ssl === 'no-verify'
          ? { rejectUnauthorized: false }
          : { rejectUnauthorized: true },
    application_name: 'openrampart',
  });
}

export function getPool(): pg.Pool {
  if (!pool) {
    const c = config();
    pool = createPool(c.DATABASE_URL, c.DATABASE_SSL, c.DATABASE_POOL_MAX);
    pool.on('error', (err) => {
      // Idle client errors (e.g. database restart) must not crash the process.
      logger.error({ err: err.message }, 'PostgreSQL pool error');
    });
  }
  return pool;
}

export function db(): Database {
  if (!database) database = drizzle(getPool(), { schema });
  return database;
}

export async function closeDb(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
    database = undefined;
  }
}

export { schema };
