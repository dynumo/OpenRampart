import { asc, eq } from 'drizzle-orm';
import type { Direction, EventTypeDTO } from '../../shared/types.js';
import { db } from '../db/client.js';
import { eventTypes } from '../db/schema.js';
import { ConflictError, NotFoundError, ValidationError, pgErrorCode } from '../lib/errors.js';
import { audit } from './audit.js';

/**
 * Event types are data, not schema: built-in types are seeded by migration and
 * administrators may add or archive types at runtime.
 */

type Row = typeof eventTypes.$inferSelect;

export function toEventTypeDTO(r: Row): EventTypeDTO {
  return {
    id: r.id,
    key: r.key,
    label: r.label,
    description: r.description,
    defaultDirection: r.defaultDirection,
    isBuiltin: r.isBuiltin,
    archived: r.archivedAt !== null,
    sortOrder: r.sortOrder,
  };
}

let cache: { at: number; rows: Row[] } | undefined;

export async function allEventTypes(): Promise<Row[]> {
  if (cache && Date.now() - cache.at < 30_000) return cache.rows;
  const rows = await db().select().from(eventTypes).orderBy(asc(eventTypes.sortOrder), asc(eventTypes.label));
  cache = { at: Date.now(), rows };
  return rows;
}

export function invalidateEventTypes(): void {
  cache = undefined;
}

export async function resolveEventType(idOrKey: string): Promise<Row> {
  const rows = await allEventTypes();
  const found = rows.find((r) => r.id === idOrKey || r.key === idOrKey);
  if (!found) throw new ValidationError('Unknown Event type', { typeId: 'Choose an Event type.' });
  return found;
}

export async function createEventType(
  input: { key: string; label: string; description?: string; defaultDirection?: Direction | null; sortOrder?: number },
  adminId: string,
): Promise<Row> {
  const key = input.key.trim().toLowerCase();
  if (!/^[a-z0-9_]{2,64}$/.test(key)) {
    throw new ValidationError('Invalid key', { key: 'Use 2–64 lower-case letters, numbers or underscores.' });
  }
  const label = input.label.trim();
  if (!label || label.length > 80) throw new ValidationError('Invalid label', { label: 'Enter a label of up to 80 characters.' });
  try {
    const [row] = await db()
      .insert(eventTypes)
      .values({
        key,
        label,
        description: input.description?.trim() ?? '',
        defaultDirection: input.defaultDirection ?? null,
        sortOrder: input.sortOrder ?? 500,
        createdBy: adminId,
      })
      .returning();
    invalidateEventTypes();
    await audit({ action: 'admin.action', actorUserId: adminId, targetType: 'event_type', targetId: row!.id, metadata: { operation: 'create_event_type', key } });
    return row!;
  } catch (err) {
    if (pgErrorCode(err) === '23505') throw new ConflictError('An Event type with that key already exists');
    throw err;
  }
}

export async function updateEventType(
  id: string,
  input: { label?: string; description?: string; defaultDirection?: Direction | null; sortOrder?: number; archived?: boolean },
  adminId: string,
): Promise<Row> {
  const patch: Partial<typeof eventTypes.$inferInsert> = {};
  if (input.label !== undefined) {
    const label = input.label.trim();
    if (!label || label.length > 80) throw new ValidationError('Invalid label', { label: 'Enter a label of up to 80 characters.' });
    patch.label = label;
  }
  if (input.description !== undefined) patch.description = input.description.trim();
  if (input.defaultDirection !== undefined) patch.defaultDirection = input.defaultDirection;
  if (input.sortOrder !== undefined) patch.sortOrder = input.sortOrder;
  if (input.archived !== undefined) patch.archivedAt = input.archived ? new Date() : null;
  const [row] = await db().update(eventTypes).set(patch).where(eq(eventTypes.id, id)).returning();
  if (!row) throw new NotFoundError('Event type');
  invalidateEventTypes();
  await audit({ action: 'admin.action', actorUserId: adminId, targetType: 'event_type', targetId: id, metadata: { operation: 'update_event_type' } });
  return row;
}
