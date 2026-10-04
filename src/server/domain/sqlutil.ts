import { sql, type SQL } from 'drizzle-orm';
import { db, type Executor } from '../db/client.js';
import { ValidationError } from '../lib/errors.js';

const PG_TIMESTAMP = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?([+-]\d{2}(:?\d{2})?|Z)?$/;
const TIMESTAMP_KEY = /(_at|_after|_time)$/;

/**
 * Run a raw SQL query. Drizzle returns timestamp columns from raw queries as
 * PostgreSQL text; columns named *_at, *_after or *_time are converted back to
 * Date objects so raw and query-builder results behave the same.
 */
export async function rows<T>(query: SQL, executor: Executor = db()): Promise<T[]> {
  const result = await executor.execute(query);
  for (const row of result.rows as Record<string, unknown>[]) {
    for (const key of Object.keys(row)) {
      const v = row[key];
      if (typeof v === 'string' && TIMESTAMP_KEY.test(key) && PG_TIMESTAMP.test(v)) {
        const d = new Date(v.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00'));
        if (!Number.isNaN(d.getTime())) row[key] = d;
      }
    }
  }
  return result.rows as T[];
}

export function uuidList(ids: string[]): SQL {
  return sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(v: unknown): v is string {
  return typeof v === 'string' && UUID_RE.test(v);
}

/** Validate ids from untrusted input; malformed ids are treated as not found. */
export function cleanIds(ids: unknown, field = 'ids'): string[] {
  if (ids === undefined || ids === null) return [];
  const list = Array.isArray(ids) ? ids : [ids];
  if (list.length > 500) throw new ValidationError(`Too many ${field}`);
  return [...new Set(list.filter(isUuid).map((s) => s.toLowerCase()))];
}

export interface Cursor {
  o: string;
  id: string;
}

export function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c)).toString('base64url');
}

export function decodeCursor(s: string | undefined | null): Cursor | null {
  if (!s) return null;
  try {
    const c = JSON.parse(Buffer.from(s, 'base64url').toString('utf8')) as Cursor;
    if (typeof c.o === 'string' && isUuid(c.id) && !Number.isNaN(Date.parse(c.o))) return c;
  } catch {
    // fall through
  }
  throw new ValidationError('Invalid pagination cursor');
}

export function iso(d: Date | string | null | undefined): string | null {
  if (d === null || d === undefined) return null;
  return (typeof d === 'string' ? new Date(d) : d).toISOString();
}

export function summarise(text: string, max = 220): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
}
