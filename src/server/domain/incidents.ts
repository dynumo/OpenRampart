import { and, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { IncidentDTO } from '../../shared/types.js';
import { config } from '../config.js';
import { db } from '../db/client.js';
import { incidentEvents, incidents } from '../db/schema.js';
import { ForbiddenError, NotFoundError, ValidationError } from '../lib/errors.js';
import { eventVisible, incidentVisible, restrictContext } from './access.js';
import { attachmentsForIncident, toAttachmentDTO } from './attachmentQueries.js';
import { auditCtx } from './audit.js';
import { isOwner, requireScopes, type AccessContext } from './context.js';
import { cleanIds, isUuid, iso, rows, uuidList } from './sqlutil.js';

/**
 * Incidents are optional groupings of Events. They hold no copy of Event
 * content: an Incident's timeline is a view over its Events.
 */

const dateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the format YYYY-MM-DD')
  .refine((v) => !Number.isNaN(Date.parse(v)), 'Enter a valid date');

const incidentInputSchema = z.object({
  title: z.string().trim().min(1, 'Enter a title').max(300),
  description: z.string().max(50_000).optional(),
  status: z.enum(['open', 'monitoring', 'resolved', 'closed']).optional(),
  openedOn: dateString.optional(),
  closedOn: dateString.nullish(),
  impactSummary: z.string().max(20_000).nullish(),
  outcomeNotes: z.string().max(20_000).nullish(),
  eventIds: z.array(z.string()).max(1000).optional(),
});
const incidentPatchSchema = incidentInputSchema.omit({ eventIds: true }).partial();

function parse<T extends z.ZodTypeAny>(schema: T, input: unknown): z.output<T> {
  const r = schema.safeParse(input);
  if (!r.success) {
    const fields: Record<string, string> = {};
    for (const i of r.error.issues) fields[i.path.join('.') || 'input'] = i.message;
    throw new ValidationError('Please check the details entered', fields);
  }
  return r.data;
}

interface IncidentRow {
  id: string;
  title: string;
  description: string;
  status: IncidentDTO['status'];
  opened_on: string;
  closed_on: string | null;
  impact_summary: string | null;
  outcome_notes: string | null;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
  event_count: number;
  first_event_at: Date | null;
  last_event_at: Date | null;
  highest_risk: IncidentDTO['highestRisk'] | null;
}

function select(ctx: AccessContext) {
  return sql`
    SELECT i.id, i.title, i.description, i.status, i.opened_on::text AS opened_on, i.closed_on::text AS closed_on,
           i.impact_summary, i.outcome_notes, i.created_at, i.updated_at, i.deleted_at,
           s.event_count, s.first_event_at, s.last_event_at, s.highest_risk
    FROM incidents i
    LEFT JOIN LATERAL (
      SELECT count(*)::int AS event_count, min(e.occurred_at) AS first_event_at, max(e.occurred_at) AS last_event_at,
             (ARRAY['none','low','medium','high'])[max(array_position(ARRAY['none','low','medium','high'], e.risk_level))] AS highest_risk
      FROM incident_events ie JOIN events e ON e.id = ie.event_id
      WHERE ie.incident_id = i.id AND ${eventVisible(ctx, 'e')}
    ) s ON TRUE`;
}

function toDTO(ctx: AccessContext, r: IncidentRow): IncidentDTO {
  return {
    id: r.id,
    title: r.title,
    description: r.description,
    status: r.status,
    openedOn: r.opened_on,
    closedOn: r.closed_on,
    impactSummary: r.impact_summary,
    outcomeNotes: r.outcome_notes,
    createdAt: iso(r.created_at)!,
    updatedAt: iso(r.updated_at)!,
    deletedAt: iso(r.deleted_at),
    eventCount: r.event_count ?? 0,
    firstEventAt: iso(r.first_event_at),
    lastEventAt: iso(r.last_event_at),
    highestRisk: r.highest_risk ?? 'none',
    canEdit: isOwner(ctx) && !r.deleted_at,
  };
}

export async function listIncidents(
  ctx: AccessContext,
  q: { status?: string[]; search?: string; limit?: number; offset?: number; deleted?: boolean } = {},
) {
  requireScopes(ctx, 'incidents:read');
  const where = [incidentVisible(ctx, 'i', { includeDeleted: q.deleted })];
  if (q.deleted) {
    if (!isOwner(ctx)) throw new ForbiddenError();
    where.push(sql`i.deleted_at IS NOT NULL`);
  }
  const statuses = (q.status ?? []).filter((s) => ['open', 'monitoring', 'resolved', 'closed'].includes(s));
  if (statuses.length) where.push(sql`i.status IN (${sql.join(statuses.map((s) => sql`${s}`), sql`, `)})`);
  if (q.search?.trim()) {
    const like = '%' + q.search.trim().replace(/[%_\\]/g, '\\$&') + '%';
    where.push(sql`(i.title ILIKE ${like} OR word_similarity(${q.search.trim()}, i.title) > 0.4)`);
  }
  const limit = Math.min(Math.max(q.limit ?? 100, 1), 500);
  const list = await rows<IncidentRow>(sql`${select(ctx)} WHERE ${sql.join(where, sql` AND `)}
    ORDER BY CASE i.status WHEN 'open' THEN 0 WHEN 'monitoring' THEN 1 WHEN 'resolved' THEN 2 ELSE 3 END,
             i.opened_on DESC, i.id
    LIMIT ${limit} OFFSET ${Math.max(q.offset ?? 0, 0)}`);
  const [count] = await rows<{ n: number }>(sql`SELECT count(*)::int AS n FROM incidents i WHERE ${sql.join(where, sql` AND `)}`);
  return { items: list.map((r) => toDTO(ctx, r)), total: count?.n ?? 0 };
}

export async function getIncident(ctx: AccessContext, id: string, opts: { includeDeleted?: boolean } = {}): Promise<IncidentDTO> {
  requireScopes(ctx, 'incidents:read');
  if (!isUuid(id)) throw new NotFoundError('Incident');
  const [row] = await rows<IncidentRow>(
    sql`${select(ctx)} WHERE i.id = ${id}::uuid AND ${incidentVisible(ctx, 'i', { includeDeleted: opts.includeDeleted && isOwner(ctx) })}`,
  );
  if (!row) throw new NotFoundError('Incident');
  const canSeeAttachments = !ctx.oauth || ctx.oauth.scopes.has('attachments:metadata');
  const attachmentRows = canSeeAttachments ? await attachmentsForIncident(ctx, id) : [];
  return { ...toDTO(ctx, row), attachments: attachmentRows.map(toAttachmentDTO) };
}

function requireIncidentWrite(ctx: AccessContext) {
  requireScopes(ctx, 'incidents:write');
  if (!isOwner(ctx)) throw new ForbiddenError('Only the owner of this record can organise Incidents');
}

async function visibleEventIds(ctx: AccessContext, ids: string[]): Promise<string[]> {
  const clean = cleanIds(ids);
  if (!clean.length) return [];
  const found = await rows<{ id: string }>(sql`SELECT e.id FROM events e WHERE e.id IN (${uuidList(clean)}) AND ${eventVisible(ctx, 'e')}`);
  if (found.length !== clean.length || clean.length !== ids.length) throw new NotFoundError('Event');
  return clean;
}

export async function createIncident(ctx: AccessContext, raw: unknown): Promise<IncidentDTO> {
  requireIncidentWrite(ctx);
  const input = parse(incidentInputSchema, raw);
  const eventIds = await visibleEventIds(ctx, input.eventIds ?? []);
  const status = input.status ?? 'open';
  if (input.closedOn && input.openedOn && input.closedOn < input.openedOn) {
    throw new ValidationError('The closed date must be on or after the opened date', { closedOn: 'Must be on or after the opened date.' });
  }
  const id = await db().transaction(async (tx) => {
    let openedOn = input.openedOn;
    if (!openedOn && eventIds.length) {
      const [earliest] = await rows<{ d: string }>(
        sql`SELECT min((occurred_at AT TIME ZONE ${ctx.ownerTimezone})::date)::text AS d FROM events WHERE id IN (${uuidList(eventIds)})`,
        tx,
      );
      openedOn = earliest?.d;
    }
    const [created] = await tx
      .insert(incidents)
      .values({
        ownerId: ctx.ownerId,
        title: input.title,
        description: input.description?.trim() ?? '',
        status,
        openedOn: openedOn ?? new Date().toISOString().slice(0, 10),
        closedOn: input.closedOn ?? (status === 'closed' || status === 'resolved' ? new Date().toISOString().slice(0, 10) : null),
        impactSummary: input.impactSummary?.trim() || null,
        outcomeNotes: input.outcomeNotes?.trim() || null,
        createdBy: ctx.userId,
      })
      .returning({ id: incidents.id });
    for (const eventId of eventIds) {
      await tx.insert(incidentEvents).values({ incidentId: created!.id, eventId, addedBy: ctx.userId });
    }
    await auditCtx(ctx, 'incident.created', { type: 'incident', id: created!.id, metadata: { events: eventIds.length } }, tx);
    return created!.id;
  });
  return getIncident(ctx, id);
}

async function loadOwnIncident(ctx: AccessContext, id: string, includeDeleted = false) {
  if (!isUuid(id)) throw new NotFoundError('Incident');
  const [row] = await db().select().from(incidents).where(and(eq(incidents.id, id), eq(incidents.ownerId, ctx.ownerId))).limit(1);
  if (!row || (row.deletedAt && !includeDeleted)) throw new NotFoundError('Incident');
  return row;
}

export async function updateIncident(ctx: AccessContext, id: string, raw: unknown): Promise<IncidentDTO> {
  requireIncidentWrite(ctx);
  const current = await loadOwnIncident(ctx, id);
  const patch = parse(incidentPatchSchema, raw);
  const set: Partial<typeof incidents.$inferInsert> = { updatedAt: new Date() };
  if (patch.title !== undefined) set.title = patch.title;
  if (patch.description !== undefined) set.description = patch.description.trim();
  if (patch.openedOn !== undefined) set.openedOn = patch.openedOn;
  if (patch.closedOn !== undefined) set.closedOn = patch.closedOn ?? null;
  if (patch.impactSummary !== undefined) set.impactSummary = patch.impactSummary?.trim() || null;
  if (patch.outcomeNotes !== undefined) set.outcomeNotes = patch.outcomeNotes?.trim() || null;
  if (patch.status !== undefined) {
    set.status = patch.status;
    if ((patch.status === 'closed' || patch.status === 'resolved') && patch.closedOn === undefined && !current.closedOn) {
      set.closedOn = new Date().toISOString().slice(0, 10);
    }
    if ((patch.status === 'open' || patch.status === 'monitoring') && patch.closedOn === undefined) set.closedOn = null;
  }
  const opened = set.openedOn ?? current.openedOn;
  const closed = set.closedOn !== undefined ? set.closedOn : current.closedOn;
  if (closed && closed < opened) {
    throw new ValidationError('The closed date must be on or after the opened date', { closedOn: 'Must be on or after the opened date.' });
  }
  await db().update(incidents).set(set).where(eq(incidents.id, id));
  await auditCtx(ctx, 'incident.updated', { type: 'incident', id, metadata: { fields: Object.keys(set).filter((k) => k !== 'updatedAt') } });
  return getIncident(ctx, id);
}

/**
 * Add Events to an Incident. Owners may add any of their Events; Helpers with
 * Add may add Events they can see to Incidents they can see (never remove).
 */
export async function addEventsToIncident(ctx: AccessContext, incidentId: string, eventIds: string[]): Promise<number> {
  requireScopes(ctx, 'incidents:write');
  if (!isUuid(incidentId)) throw new NotFoundError('Incident');
  const addCtx = isOwner(ctx) ? ctx : restrictContext(ctx, 'add');
  const [inc] = await rows<{ id: string }>(sql`SELECT i.id FROM incidents i WHERE i.id = ${incidentId}::uuid AND ${incidentVisible(addCtx, 'i')}`);
  if (!inc) throw new NotFoundError('Incident');
  if (!isOwner(ctx) && !ctx.grants.some((g) => g.canAdd)) throw new ForbiddenError();
  const ids = await visibleEventIds(addCtx, eventIds);
  let added = 0;
  await db().transaction(async (tx) => {
    for (const eventId of ids) {
      const r = await tx.insert(incidentEvents).values({ incidentId, eventId, addedBy: ctx.userId }).onConflictDoNothing().returning();
      if (r.length) {
        added++;
        await auditCtx(ctx, 'incident.event_added', { type: 'incident', id: incidentId, metadata: { eventId } }, tx);
      }
    }
    await tx.update(incidents).set({ updatedAt: new Date() }).where(eq(incidents.id, incidentId));
  });
  return added;
}

export async function removeEventFromIncident(ctx: AccessContext, incidentId: string, eventId: string): Promise<void> {
  requireIncidentWrite(ctx);
  await loadOwnIncident(ctx, incidentId);
  if (!isUuid(eventId)) throw new NotFoundError('Event');
  const removed = await db()
    .delete(incidentEvents)
    .where(and(eq(incidentEvents.incidentId, incidentId), eq(incidentEvents.eventId, eventId)))
    .returning();
  if (!removed.length) throw new NotFoundError('Event');
  await auditCtx(ctx, 'incident.event_removed', { type: 'incident', id: incidentId, metadata: { eventId } });
}

export async function deleteIncident(ctx: AccessContext, id: string): Promise<void> {
  requireIncidentWrite(ctx);
  await loadOwnIncident(ctx, id);
  const now = new Date();
  await db()
    .update(incidents)
    .set({ deletedAt: now, deletedBy: ctx.userId, purgeAfter: new Date(now.getTime() + config().DELETION_RETENTION_DAYS * 86400_000) })
    .where(eq(incidents.id, id));
  await auditCtx(ctx, 'incident.deleted', { type: 'incident', id });
}

export async function restoreIncident(ctx: AccessContext, id: string): Promise<IncidentDTO> {
  requireIncidentWrite(ctx);
  await loadOwnIncident(ctx, id, true);
  await db().update(incidents).set({ deletedAt: null, deletedBy: null, purgeAfter: null }).where(eq(incidents.id, id));
  await auditCtx(ctx, 'incident.restored', { type: 'incident', id });
  return getIncident(ctx, id);
}

export async function incidentIdsForGrant(ownerId: string, ids: string[]): Promise<string[]> {
  const clean = cleanIds(ids);
  if (!clean.length) return [];
  const found = await db()
    .select({ id: incidents.id })
    .from(incidents)
    .where(and(eq(incidents.ownerId, ownerId), inArray(incidents.id, clean)));
  return found.map((f) => f.id);
}
