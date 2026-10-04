import { and, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { ActorDTO, IncidentRef } from '../../shared/types.js';
import { config } from '../config.js';
import { db } from '../db/client.js';
import { accessGrants, actors, eventActors, grantActors, helperRelationships } from '../db/schema.js';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../lib/errors.js';
import { actorFullAccess, actorLinkVisible, actorVisible, eventVisible, incidentVisible } from './access.js';
import { auditCtx } from './audit.js';
import { appendRevision } from './revisions.js';
import { isOwner, requireScopes, type AccessContext } from './context.js';
import { cleanIds, isUuid, iso, rows, uuidList } from './sqlutil.js';

const actorInputSchema = z.object({
  name: z.string().trim().min(1, 'Enter a name').max(200),
  kind: z.enum(['organisation', 'person', 'other']).default('organisation'),
  aliases: z.array(z.string().trim().min(1).max(200)).max(50).optional(),
  description: z.string().max(20_000).optional(),
  accountReference: z.string().max(200).nullish(),
  website: z.string().max(500).nullish(),
  email: z.string().max(320).nullish(),
  phone: z.string().max(60).nullish(),
  address: z.string().max(1000).nullish(),
});
const actorPatchSchema = actorInputSchema.partial();

function parse<T extends z.ZodTypeAny>(schema: T, input: unknown): z.output<T> {
  const r = schema.safeParse(input);
  if (!r.success) {
    const fields: Record<string, string> = {};
    for (const i of r.error.issues) fields[i.path.join('.') || 'input'] = i.message;
    throw new ValidationError('Please check the details entered', fields);
  }
  return r.data;
}

const blankToNull = (v: string | null | undefined) => (v === undefined ? undefined : v?.trim() ? v.trim() : null);

interface ActorRow {
  id: string;
  name: string;
  kind: ActorDTO['kind'];
  aliases: string[];
  description: string;
  account_reference: string | null;
  website: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  archived_at: Date | null;
  merged_into_id: string | null;
  created_by: string | null;
  created_at: Date;
  full_access: boolean;
  event_count: number;
  first_event_at: Date | null;
  last_event_at: Date | null;
  open_incident_count: number;
}

/** Statistics are computed only over Events and Incidents visible in this context. */
function actorSelect(ctx: AccessContext) {
  return sql`
    SELECT a.id, a.name, a.kind, a.aliases, a.description, a.account_reference, a.website, a.email, a.phone,
           a.address, a.archived_at, a.merged_into_id, a.created_by, a.created_at,
           ${actorFullAccess(ctx, 'a')} AS full_access,
           stats.event_count, stats.first_event_at, stats.last_event_at,
           (SELECT count(DISTINCT i.id)::int FROM incidents i
              JOIN incident_events ie ON ie.incident_id = i.id
              JOIN events e ON e.id = ie.event_id
              JOIN event_actors ea ON ea.event_id = e.id AND ea.actor_id = a.id
             WHERE i.status IN ('open', 'monitoring') AND ${incidentVisible(ctx, 'i')}
               AND ${eventVisible(ctx, 'e')} AND ${actorLinkVisible(ctx, 'ea', 'e')}) AS open_incident_count
    FROM actors a
    LEFT JOIN LATERAL (
      SELECT count(DISTINCT e.id)::int AS event_count, min(e.occurred_at) AS first_event_at, max(e.occurred_at) AS last_event_at
      FROM event_actors ea JOIN events e ON e.id = ea.event_id
      WHERE ea.actor_id = a.id AND ${eventVisible(ctx, 'e')} AND ${actorLinkVisible(ctx, 'ea', 'e')}
    ) stats ON TRUE`;
}

function toDTO(r: ActorRow): ActorDTO {
  const full = r.full_access;
  return {
    id: r.id,
    name: r.name,
    kind: r.kind,
    fullAccess: full,
    aliases: full ? r.aliases : [],
    description: full ? r.description : '',
    accountReference: full ? r.account_reference : null,
    website: full ? r.website : null,
    email: full ? r.email : null,
    phone: full ? r.phone : null,
    address: full ? r.address : null,
    archivedAt: iso(r.archived_at),
    mergedIntoId: full ? r.merged_into_id : null,
    createdAt: iso(r.created_at)!,
    stats: {
      eventCount: r.event_count ?? 0,
      firstEventAt: iso(r.first_event_at),
      lastEventAt: iso(r.last_event_at),
      openIncidentCount: r.open_incident_count ?? 0,
    },
  };
}

export interface ActorListQuery {
  q?: string;
  includeArchived?: boolean;
  kind?: string;
  sort?: 'name' | 'recent';
  limit?: number;
  offset?: number;
}

export async function listActors(ctx: AccessContext, query: ActorListQuery = {}) {
  requireScopes(ctx, 'actors:read');
  const where = [actorVisible(ctx, 'a'), sql`a.merged_into_id IS NULL`];
  if (!query.includeArchived) where.push(sql`a.archived_at IS NULL`);
  if (query.kind && ['organisation', 'person', 'other'].includes(query.kind)) where.push(sql`a.kind = ${query.kind}`);
  const q = query.q?.trim();
  if (q) {
    where.push(
      sql`(a.name ILIKE ${'%' + q.replace(/[%_\\]/g, '\\$&') + '%'} OR word_similarity(${q}, a.name) > 0.4 OR (${actorFullAccess(ctx, 'a')} AND EXISTS (SELECT 1 FROM unnest(a.aliases) al WHERE al ILIKE ${'%' + q.replace(/[%_\\]/g, '\\$&') + '%'})))`,
    );
  }
  const limit = Math.min(Math.max(query.limit ?? 100, 1), 500);
  const offset = Math.max(query.offset ?? 0, 0);
  const order = query.sort === 'recent' ? sql`stats.last_event_at DESC NULLS LAST, a.name` : sql`lower(a.name), a.id`;
  const list = await rows<ActorRow>(
    sql`${actorSelect(ctx)} WHERE ${sql.join(where, sql` AND `)} ORDER BY ${order} LIMIT ${limit + 1} OFFSET ${offset}`,
  );
  const [count] = await rows<{ n: number }>(sql`SELECT count(*)::int AS n FROM actors a WHERE ${sql.join(where, sql` AND `)}`);
  return { items: list.slice(0, limit).map(toDTO), total: count?.n ?? 0, hasMore: list.length > limit };
}

export async function getActor(ctx: AccessContext, id: string): Promise<ActorDTO & { openIncidents: IncidentRef[]; mergedFrom: { id: string; name: string }[] }> {
  requireScopes(ctx, 'actors:read');
  if (!isUuid(id)) throw new NotFoundError('Actor');
  const [row] = await rows<ActorRow>(sql`${actorSelect(ctx)} WHERE a.id = ${id}::uuid AND ${actorVisible(ctx, 'a')}`);
  if (!row) throw new NotFoundError('Actor');
  const openIncidents = await rows<IncidentRef>(sql`
    SELECT DISTINCT i.id, i.title, i.status, i.opened_on FROM incidents i
      JOIN incident_events ie ON ie.incident_id = i.id
      JOIN events e ON e.id = ie.event_id
      JOIN event_actors ea ON ea.event_id = e.id AND ea.actor_id = ${id}::uuid
     WHERE i.status IN ('open', 'monitoring') AND ${incidentVisible(ctx, 'i')}
       AND ${eventVisible(ctx, 'e')} AND ${actorLinkVisible(ctx, 'ea', 'e')}
     ORDER BY i.opened_on DESC`);
  const mergedFrom = row.full_access
    ? await rows<{ id: string; name: string }>(
        sql`SELECT a.id, a.name FROM actors a WHERE a.merged_into_id = ${id}::uuid AND a.owner_id = ${ctx.ownerId} ORDER BY a.name`,
      )
    : [];
  return {
    ...toDTO(row),
    openIncidents: openIncidents.map((i) => ({ id: i.id, title: i.title, status: i.status })),
    mergedFrom,
  };
}

/** Actor name suggestions for pickers. Only Actors the caller may link (full access). */
export async function suggestActors(ctx: AccessContext, q: string, limit = 10) {
  requireScopes(ctx, 'actors:read');
  const term = q.trim();
  const where = [actorFullAccess(ctx, 'a'), sql`a.merged_into_id IS NULL`, sql`a.archived_at IS NULL`];
  if (term) {
    const like = '%' + term.replace(/[%_\\]/g, '\\$&') + '%';
    where.push(
      sql`(a.name ILIKE ${like} OR word_similarity(${term}, a.name) > 0.35 OR EXISTS (SELECT 1 FROM unnest(a.aliases) al WHERE al ILIKE ${like}))`,
    );
  }
  return rows<{ id: string; name: string; kind: string; matched_alias: string | null }>(sql`
    SELECT a.id, a.name, a.kind,
      ${term ? sql`(SELECT al FROM unnest(a.aliases) al WHERE al ILIKE ${'%' + term.replace(/[%_\\]/g, '\\$&') + '%'} LIMIT 1)` : sql`NULL`} AS matched_alias
    FROM actors a WHERE ${sql.join(where, sql` AND `)}
    ORDER BY ${term ? sql`(lower(a.name) = lower(${term})) DESC, word_similarity(${term}, a.name) DESC,` : sql``} lower(a.name)
    LIMIT ${Math.min(limit, 50)}`);
}

function requireActorWrite(ctx: AccessContext) {
  requireScopes(ctx, 'actors:write');
  if (!isOwner(ctx) && !ctx.grants.some((g) => g.canAdd)) {
    throw new ForbiddenError('Your access to this record does not include adding Actors');
  }
}

export async function createActor(ctx: AccessContext, raw: unknown): Promise<ActorDTO> {
  requireActorWrite(ctx);
  const input = parse(actorInputSchema, raw);
  const [created] = await db()
    .insert(actors)
    .values({
      ownerId: ctx.ownerId,
      name: input.name,
      kind: input.kind,
      aliases: [...new Set((input.aliases ?? []).map((a) => a.trim()).filter(Boolean))],
      description: input.description?.trim() ?? '',
      accountReference: blankToNull(input.accountReference) ?? null,
      website: blankToNull(input.website) ?? null,
      email: blankToNull(input.email) ?? null,
      phone: blankToNull(input.phone) ?? null,
      address: blankToNull(input.address) ?? null,
      createdBy: ctx.userId,
    })
    .returning({ id: actors.id });
  await auditCtx(ctx, 'actor.created', { type: 'actor', id: created!.id });
  return getActor(ctx, created!.id);
}

async function loadActorForWrite(ctx: AccessContext, id: string) {
  requireScopes(ctx, 'actors:write');
  if (!isUuid(id)) throw new NotFoundError('Actor');
  const [row] = await db().select().from(actors).where(and(eq(actors.id, id), eq(actors.ownerId, ctx.ownerId))).limit(1);
  if (!row || row.deletedAt) throw new NotFoundError('Actor');
  if (!isOwner(ctx)) {
    // Helpers may only edit Actors they created themselves.
    if (row.createdBy !== ctx.userId || !ctx.grants.some((g) => g.canAdd)) {
      const [visible] = await rows<{ ok: boolean }>(sql`SELECT ${actorVisible(ctx, 'a')} AS ok FROM actors a WHERE a.id = ${id}::uuid`);
      if (!visible?.ok) throw new NotFoundError('Actor');
      throw new ForbiddenError('Helpers can only edit Actors they added themselves');
    }
  }
  return row;
}

export async function updateActor(ctx: AccessContext, id: string, raw: unknown): Promise<ActorDTO> {
  const row = await loadActorForWrite(ctx, id);
  if (row.mergedIntoId) throw new ConflictError('This Actor has been merged into another Actor');
  const patch = parse(actorPatchSchema, raw);
  const set: Partial<typeof actors.$inferInsert> = { updatedAt: new Date() };
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.kind !== undefined) set.kind = patch.kind;
  if (patch.aliases !== undefined) set.aliases = [...new Set(patch.aliases.map((a) => a.trim()).filter(Boolean))];
  if (patch.description !== undefined) set.description = patch.description.trim();
  for (const key of ['accountReference', 'website', 'email', 'phone', 'address'] as const) {
    if (patch[key] !== undefined) set[key] = blankToNull(patch[key]) ?? null;
  }
  await db().update(actors).set(set).where(eq(actors.id, id));
  await auditCtx(ctx, 'actor.updated', { type: 'actor', id, metadata: { fields: Object.keys(set).filter((k) => k !== 'updatedAt') } });
  return getActor(ctx, id);
}

export async function setActorArchived(ctx: AccessContext, id: string, archived: boolean): Promise<ActorDTO> {
  if (!isOwner(ctx)) throw new ForbiddenError('Only the owner of this record can archive Actors');
  await loadActorForWrite(ctx, id);
  await db().update(actors).set({ archivedAt: archived ? new Date() : null, updatedAt: new Date() }).where(eq(actors.id, id));
  await auditCtx(ctx, 'actor.archived', { type: 'actor', id, metadata: { archived } });
  return getActor(ctx, id);
}

/**
 * Delete an Actor. Refused while any Event (including deleted Events awaiting
 * purge) still references it: archiving or merging preserves history instead.
 */
export async function deleteActor(ctx: AccessContext, id: string): Promise<void> {
  if (!isOwner(ctx)) throw new ForbiddenError('Only the owner of this record can delete Actors');
  await loadActorForWrite(ctx, id);
  const [ref] = await rows<{ n: number }>(
    sql`SELECT count(*)::int AS n FROM event_actors WHERE actor_id = ${id}::uuid OR origin_actor_id = ${id}::uuid`,
  );
  if ((ref?.n ?? 0) > 0) {
    throw new ConflictError(
      `This Actor is linked to ${ref!.n} Event${ref!.n === 1 ? '' : 's'}. Archive it, or merge it into another Actor, so the history is kept.`,
    );
  }
  const now = new Date();
  await db()
    .update(actors)
    .set({ deletedAt: now, deletedBy: ctx.userId, purgeAfter: new Date(now.getTime() + config().DELETION_RETENTION_DAYS * 86400_000) })
    .where(eq(actors.id, id));
  await auditCtx(ctx, 'actor.deleted', { type: 'actor', id });
}

export async function restoreActor(ctx: AccessContext, id: string): Promise<ActorDTO> {
  if (!isOwner(ctx)) throw new ForbiddenError();
  const [row] = await db().select().from(actors).where(and(eq(actors.id, id), eq(actors.ownerId, ctx.ownerId))).limit(1);
  if (!row) throw new NotFoundError('Actor');
  await db().update(actors).set({ deletedAt: null, deletedBy: null, purgeAfter: null }).where(eq(actors.id, id));
  await auditCtx(ctx, 'actor.restored', { type: 'actor', id });
  return getActor(ctx, id);
}

export interface MergePreview {
  target: { id: string; name: string };
  sources: { id: string; name: string; eventCount: number }[];
  affectedHelpers: { relationshipId: string; label: string; grantId: string; actorsInGrant: string[] }[];
}

async function loadMergeActors(ctx: AccessContext, targetId: string, sourceIds: string[]) {
  if (!isOwner(ctx)) throw new ForbiddenError('Only the owner of this record can merge Actors');
  requireScopes(ctx, 'actors:write');
  const sources = cleanIds(sourceIds).filter((s) => s !== targetId);
  if (!isUuid(targetId) || !sources.length) throw new ValidationError('Choose at least one Actor to merge into the target');
  const all = await db()
    .select()
    .from(actors)
    .where(and(eq(actors.ownerId, ctx.ownerId), inArray(actors.id, [targetId, ...sources])));
  const target = all.find((a) => a.id === targetId);
  const src = all.filter((a) => sources.includes(a.id));
  if (!target || target.deletedAt || target.mergedIntoId || src.length !== sources.length || src.some((s) => s.deletedAt || s.mergedIntoId)) {
    throw new NotFoundError('Actor');
  }
  return { target, sources: src };
}

export async function previewMerge(ctx: AccessContext, targetId: string, sourceIds: string[]): Promise<MergePreview> {
  const { target, sources } = await loadMergeActors(ctx, targetId, sourceIds);
  const counts = await rows<{ actor_id: string; n: number }>(
    sql`SELECT actor_id, count(DISTINCT event_id)::int AS n FROM event_actors WHERE actor_id IN (${uuidList(sources.map((s) => s.id))}) GROUP BY actor_id`,
  );
  const affected = await rows<{ relationship_id: string; label: string; grant_id: string; actor_id: string }>(sql`
    SELECT r.id AS relationship_id, r.label, g.id AS grant_id, ga.actor_id
    FROM grant_actors ga
    JOIN access_grants g ON g.id = ga.grant_id AND g.revoked_at IS NULL
    JOIN helper_relationships r ON r.id = g.relationship_id AND r.status <> 'ended'
    WHERE g.owner_id = ${ctx.ownerId} AND ga.actor_id IN (${uuidList([target.id, ...sources.map((s) => s.id)])})`);
  const byGrant = new Map<string, MergePreview['affectedHelpers'][number]>();
  for (const a of affected) {
    const entry = byGrant.get(a.grant_id) ?? { relationshipId: a.relationship_id, label: a.label, grantId: a.grant_id, actorsInGrant: [] };
    entry.actorsInGrant.push(a.actor_id);
    byGrant.set(a.grant_id, entry);
  }
  return {
    target: { id: target.id, name: target.name },
    sources: sources.map((s) => ({ id: s.id, name: s.name, eventCount: counts.find((c) => c.actor_id === s.id)?.n ?? 0 })),
    affectedHelpers: [...byGrant.values()],
  };
}

/**
 * Merge duplicate Actors into a target.
 *
 *  - Event links move to the target; each link keeps its origin_actor_id, so
 *    Helper grants that named a source keep seeing exactly the same Events, and
 *    grants that named the target do not suddenly gain the source's history.
 *  - Source names and aliases become aliases of the target.
 *  - Sources are kept (archived, with merged_into_id) so links, audit history
 *    and exports still resolve.
 *  - With `extendHelperAccess`, Helpers whose grants named any of the merged
 *    Actors are explicitly given all of them (recorded in the audit log).
 */
export async function mergeActors(
  ctx: AccessContext,
  targetId: string,
  sourceIds: string[],
  opts: { extendHelperAccess?: boolean } = {},
): ReturnType<typeof getActor> {
  const { target, sources } = await loadMergeActors(ctx, targetId, sourceIds);
  const sourceIdList = sources.map((s) => s.id);
  await db().transaction(async (tx) => {
    const moved = await tx
      .update(eventActors)
      .set({ actorId: target.id })
      .where(inArray(eventActors.actorId, sourceIdList))
      .returning({ eventId: eventActors.eventId });
    const aliases = new Set([...target.aliases]);
    for (const s of sources) {
      aliases.add(s.name);
      for (const al of s.aliases) aliases.add(al);
    }
    aliases.delete(target.name);
    const now = new Date();
    await tx
      .update(actors)
      .set({
        aliases: [...aliases],
        description: [target.description, ...sources.map((s) => s.description)].filter((d) => d.trim()).join('\n\n'),
        accountReference: target.accountReference ?? sources.find((s) => s.accountReference)?.accountReference ?? null,
        website: target.website ?? sources.find((s) => s.website)?.website ?? null,
        email: target.email ?? sources.find((s) => s.email)?.email ?? null,
        phone: target.phone ?? sources.find((s) => s.phone)?.phone ?? null,
        address: target.address ?? sources.find((s) => s.address)?.address ?? null,
        updatedAt: now,
      })
      .where(eq(actors.id, target.id));
    await tx
      .update(actors)
      .set({ mergedIntoId: target.id, mergedAt: now, archivedAt: now, updatedAt: now })
      .where(inArray(actors.id, sourceIdList));
    // Earlier merges into a source now point at the final target.
    await tx.update(actors).set({ mergedIntoId: target.id }).where(inArray(actors.mergedIntoId, sourceIdList));

    // Each affected Event's Actor list changed, so each gets a new revision.
    for (const eventId of [...new Set(moved.map((m) => m.eventId))]) {
      await appendRevision(tx, {
        eventId,
        ownerId: ctx.ownerId,
        changeKind: 'update',
        changedFields: ['actors'],
        userId: ctx.userId,
        via: ctx.via,
      });
    }

    const extended: string[] = [];
    if (opts.extendHelperAccess) {
      const allIds = [target.id, ...sourceIdList];
      const grants = await tx
        .selectDistinct({ grantId: grantActors.grantId })
        .from(grantActors)
        .innerJoin(accessGrants, eq(accessGrants.id, grantActors.grantId))
        .innerJoin(helperRelationships, eq(helperRelationships.id, accessGrants.relationshipId))
        .where(and(inArray(grantActors.actorId, allIds), eq(accessGrants.ownerId, ctx.ownerId)));
      for (const g of grants) {
        for (const actorId of allIds) {
          await tx.insert(grantActors).values({ grantId: g.grantId, actorId }).onConflictDoNothing();
        }
        extended.push(g.grantId);
        await auditCtx(ctx, 'grant.updated', { type: 'grant', id: g.grantId, metadata: { reason: 'actor_merge', addedActors: allIds } }, tx);
      }
    }
    await auditCtx(
      ctx,
      'actor.merged',
      {
        type: 'actor',
        id: target.id,
        metadata: {
          sources: sources.map((s) => ({ id: s.id, name: s.name })),
          linksMoved: moved.length,
          extendedGrants: extended,
        },
      },
      tx,
    );
  });
  return getActor(ctx, target.id);
}
