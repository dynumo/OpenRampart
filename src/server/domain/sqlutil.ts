import { sql, type SQL } from 'drizzle-orm';
import { db, type Executor } from '../db/client.js';
import { ValidationError } from '../lib/errors.js';

export async function rows<T>(query: SQL, executor: Executor = db()): Promise<T[]> {
  const result = await executor.execute(query);
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
