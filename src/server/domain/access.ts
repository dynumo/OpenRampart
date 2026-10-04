import { and, eq, isNull, sql, type SQL } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  accessGrants,
  grantActors,
  grantIncidents,
  helperRelationships,
  users,
} from '../db/schema.js';
import { NotFoundError } from '../lib/errors.js';
import type { AccessContext, ResolvedGrant } from './context.js';

/**
 * Central authorisation rules.
 *
 * Every read path (web API, MCP, search, counts, autocomplete, exports) builds
 * its WHERE clauses from the predicates in this file, so there is exactly one
 * definition of "who can see what". The rules are documented in
 * docs/authorisation.md; the summary:
 *
 *  Owner     — everything in their own record that is not deleted.
 *  Helper    — the union of their active grants. A grant makes an Event visible when
 *              * scope "all":        always
 *              * scope "actors":     one of the Event's Actor links was made to a listed
 *                                    Actor (evaluated on origin_actor_id, so merges
 *                                    never change access)
 *              * scope "incidents":  the Event belongs to a listed, non-deleted Incident
 *              and, if the grant has dates, the Event's occurred date (in the owner's
 *              time zone) is within them.
 *
 *  Actors on a visible Event that are outside the Helper's scope are redacted,
 *  unless the grant that makes the Event visible is set to show co-Actor names.
 *  Seeing a co-Actor's name never grants access to that Actor's other Events or
 *  details.
 */

type Alias = 'e' | 'e2' | 'ev' | 'a' | 'i' | 'ea' | 'att' | 'x';
const ident = (alias: Alias) => sql.raw(alias);

function idList(ids: string[]): SQL {
  return sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
}

function dateClause(grant: ResolvedGrant, ctx: AccessContext, e: Alias): SQL {
  const parts: SQL[] = [];
  const localDate = sql`(${ident(e)}.occurred_at AT TIME ZONE ${ctx.ownerTimezone})::date`;
  if (grant.dateFrom) parts.push(sql`${localDate} >= ${grant.dateFrom}::date`);
  if (grant.dateTo) parts.push(sql`${localDate} <= ${grant.dateTo}::date`);
  return parts.length ? sql.join(parts, sql` AND `) : sql`TRUE`;
}

/** Event (alias `e`) is visible through one specific grant. */
export function eventVisibleViaGrant(grant: ResolvedGrant, ctx: AccessContext, e: Alias = 'e'): SQL {
  const dates = dateClause(grant, ctx, e);
  switch (grant.scopeType) {
    case 'all':
      return sql`(${dates})`;
    case 'actors':
      if (!grant.actorIds.length) return sql`FALSE`;
      return sql`(EXISTS (SELECT 1 FROM event_actors gx_ea WHERE gx_ea.event_id = ${ident(e)}.id AND gx_ea.origin_actor_id IN (${idList(grant.actorIds)})) AND ${dates})`;
    case 'incidents':
      if (!grant.incidentIds.length) return sql`FALSE`;
      return sql`(EXISTS (SELECT 1 FROM incident_events gx_ie JOIN incidents gx_i ON gx_i.id = gx_ie.incident_id WHERE gx_ie.event_id = ${ident(e)}.id AND gx_i.deleted_at IS NULL AND gx_ie.incident_id IN (${idList(grant.incidentIds)})) AND ${dates})`;
  }
}

/** Base ownership/non-deleted condition for Events. */
function eventBase(ctx: AccessContext, e: Alias, includeDeleted: boolean): SQL {
  return includeDeleted
    ? sql`${ident(e)}.owner_id = ${ctx.ownerId}`
    : sql`(${ident(e)}.owner_id = ${ctx.ownerId} AND ${ident(e)}.deleted_at IS NULL)`;
}

export interface VisibilityOptions {
  /** Owner-only: include soft-deleted rows (trash view). */
  includeDeleted?: boolean;
}

function applicableGrants(ctx: AccessContext, _opts: VisibilityOptions): ResolvedGrant[] {
  return ctx.grants;
}

/**
 * Narrow a helper's context to the grants carrying a capability. Used to ask
 * "could this helper ADD here?" or "what may this helper EXPORT?" with the very
 * same visibility predicates. Owners are unaffected.
 */
export function restrictContext(ctx: AccessContext, capability: 'add' | 'export'): AccessContext {
  if (ctx.role === 'owner') return ctx;
  return {
    ...ctx,
    grants: ctx.grants.filter((g) => (capability === 'add' ? g.canAdd : g.canExport)),
  };
}

/** SQL predicate: Event row aliased `e` is visible in this context. */
export function eventVisible(ctx: AccessContext, e: Alias = 'e', opts: VisibilityOptions = {}): SQL {
  if (ctx.role === 'owner') return eventBase(ctx, e, Boolean(opts.includeDeleted));
  const grants = applicableGrants(ctx, opts);
  if (!grants.length) return sql`FALSE`;
  return sql`(${eventBase(ctx, e, false)} AND (${sql.join(
    grants.map((g) => eventVisibleViaGrant(g, ctx, e)),
    sql` OR `,
  )}))`;
}

/** Set of Actor ids the helper has full access to by explicit grant. */
function grantedActorIds(ctx: AccessContext, grants: ResolvedGrant[]): string[] {
  return [...new Set(grants.filter((g) => g.scopeType === 'actors').flatMap((g) => g.actorIds))];
}

/**
 * SQL predicate: the link between Event `e` and Actor-link row `ea` may be
 * shown (Actor name and id). Assumes `e` is already known to be visible.
 */
export function actorLinkVisible(ctx: AccessContext, ea: Alias = 'ea', e: Alias = 'e'): SQL {
  if (ctx.role === 'owner') return sql`TRUE`;
  const clauses: SQL[] = [];
  const ids = grantedActorIds(ctx, ctx.grants);
  if (ids.length) clauses.push(sql`${ident(ea)}.actor_id IN (${idList(ids)})`);
  clauses.push(
    sql`EXISTS (SELECT 1 FROM actors lv_a WHERE lv_a.id = ${ident(ea)}.actor_id AND lv_a.created_by = ${ctx.userId})`,
  );
  for (const g of ctx.grants) {
    const via = eventVisibleViaGrant(g, ctx, e);
    if (g.scopeType === 'all') {
      clauses.push(via);
    } else if (g.coActorVisibility === 'name') {
      clauses.push(via);
    } else if (g.scopeType === 'actors' && g.actorIds.length) {
      clauses.push(sql`(${ident(ea)}.origin_actor_id IN (${idList(g.actorIds)}) AND ${via})`);
    }
  }
  return sql`(${sql.join(clauses, sql` OR `)})`;
}

/**
 * SQL predicate: Actor `a` can be seen at all (at least by name). True when
 * fully accessible or when it appears, unredacted, on a visible Event.
 */
export function actorVisible(ctx: AccessContext, a: Alias = 'a', opts: VisibilityOptions = {}): SQL {
  if (ctx.role === 'owner') return actorFullAccess(ctx, a, opts);
  return sql`(${actorFullAccess(ctx, a)} OR (${ident(a)}.owner_id = ${ctx.ownerId} AND ${ident(a)}.deleted_at IS NULL AND EXISTS (
    SELECT 1 FROM event_actors ea JOIN events e ON e.id = ea.event_id
    WHERE ea.actor_id = ${ident(a)}.id AND ${eventVisible(ctx, 'e')} AND ${actorLinkVisible(ctx, 'ea', 'e')}
  )))`;
}

/**
 * SQL predicate: the Actor aliased `a` is fully accessible (details, notes,
 * contact information and its own page) in this context.
 */
export function actorFullAccess(ctx: AccessContext, a: Alias = 'a', opts: VisibilityOptions = {}): SQL {
  const base = opts.includeDeleted
    ? sql`${ident(a)}.owner_id = ${ctx.ownerId}`
    : sql`(${ident(a)}.owner_id = ${ctx.ownerId} AND ${ident(a)}.deleted_at IS NULL)`;
  if (ctx.role === 'owner') return base;
  const grants = applicableGrants(ctx, opts);
  const clauses: SQL[] = [sql`${ident(a)}.created_by = ${ctx.userId}`];
  const ids = grantedActorIds(ctx, grants);
  if (ids.length) clauses.push(sql`${ident(a)}.id IN (${idList(ids)})`);
  for (const g of grants.filter((g) => g.scopeType === 'all')) {
    if (!g.dateFrom && !g.dateTo) {
      clauses.push(sql`TRUE`);
    } else {
      clauses.push(
        sql`EXISTS (SELECT 1 FROM event_actors ea JOIN events ev ON ev.id = ea.event_id WHERE ea.actor_id = ${ident(a)}.id AND ev.owner_id = ${ctx.ownerId} AND ev.deleted_at IS NULL AND ${dateClause(g, ctx, 'ev')})`,
      );
    }
  }
  return sql`(${base} AND (${sql.join(clauses, sql` OR `)}))`;
}

/** SQL predicate: Incident `i` is visible. */
export function incidentVisible(ctx: AccessContext, i: Alias = 'i', opts: VisibilityOptions = {}): SQL {
  const base = opts.includeDeleted && ctx.role === 'owner'
    ? sql`${ident(i)}.owner_id = ${ctx.ownerId}`
    : sql`(${ident(i)}.owner_id = ${ctx.ownerId} AND ${ident(i)}.deleted_at IS NULL)`;
  if (ctx.role === 'owner') return base;
  const grants = applicableGrants(ctx, opts);
  const clauses: SQL[] = [];
  const ids = [...new Set(grants.filter((g) => g.scopeType === 'incidents').flatMap((g) => g.incidentIds))];
  if (ids.length) clauses.push(sql`${ident(i)}.id IN (${idList(ids)})`);
  for (const g of grants.filter((g) => g.scopeType === 'all')) {
    if (!g.dateFrom && !g.dateTo) clauses.push(sql`TRUE`);
    else
      clauses.push(
        sql`EXISTS (SELECT 1 FROM incident_events ie JOIN events ev ON ev.id = ie.event_id WHERE ie.incident_id = ${ident(i)}.id AND ev.owner_id = ${ctx.ownerId} AND ev.deleted_at IS NULL AND ${dateClause(g, ctx, 'ev')})`,
      );
  }
  if (!clauses.length) return sql`FALSE`;
  return sql`(${base} AND (${sql.join(clauses, sql` OR `)}))`;
}

/** SQL predicate: Attachment `att` is visible (metadata level). */
export function attachmentVisible(ctx: AccessContext, att: Alias = 'att', opts: VisibilityOptions = {}): SQL {
  const deleted = opts.includeDeleted && ctx.role === 'owner' ? sql`TRUE` : sql`${ident(att)}.deleted_at IS NULL`;
  return sql`(${ident(att)}.owner_id = ${ctx.ownerId} AND ${deleted} AND (
    (${ident(att)}.event_id IS NOT NULL AND EXISTS (SELECT 1 FROM events e2 WHERE e2.id = ${ident(att)}.event_id AND ${eventVisible(ctx, 'e2', opts)}))
    OR
    (${ident(att)}.incident_id IS NOT NULL AND EXISTS (SELECT 1 FROM incidents i WHERE i.id = ${ident(att)}.incident_id AND ${incidentVisible(ctx, 'i', opts)}))
  ))`;
}

// ---------------------------------------------------------------------------
// Context resolution
// ---------------------------------------------------------------------------

/** Load the active grants a helper holds on an owner's record. */
export async function loadGrants(helperUserId: string, ownerId: string): Promise<ResolvedGrant[]> {
  const rows = await db()
    .select({ grant: accessGrants })
    .from(accessGrants)
    .innerJoin(helperRelationships, eq(helperRelationships.id, accessGrants.relationshipId))
    .where(
      and(
        eq(helperRelationships.helperUserId, helperUserId),
        eq(helperRelationships.ownerId, ownerId),
        eq(helperRelationships.status, 'active'),
        isNull(accessGrants.revokedAt),
      ),
    );
  if (!rows.length) return [];
  const ids = rows.map((r) => r.grant.id);
  const actorRows = await db()
    .select()
    .from(grantActors)
    .where(sql`${grantActors.grantId} IN (${idList(ids)})`);
  const incidentRows = await db()
    .select()
    .from(grantIncidents)
    .where(sql`${grantIncidents.grantId} IN (${idList(ids)})`);
  return rows.map(({ grant }) => ({
    id: grant.id,
    relationshipId: grant.relationshipId,
    scopeType: grant.scopeType,
    actorIds: actorRows.filter((r) => r.grantId === grant.id).map((r) => r.actorId),
    incidentIds: incidentRows.filter((r) => r.grantId === grant.id).map((r) => r.incidentId),
    dateFrom: grant.dateFrom,
    dateTo: grant.dateTo,
    canAdd: grant.canAdd,
    canExport: grant.canExport,
    coActorVisibility: grant.coActorVisibility,
  }));
}

export interface ContextRequest {
  userId: string;
  /** Record to open; defaults to the user's own. */
  ownerId?: string | null;
  via: AccessContext['via'];
  ip?: string | null;
  userAgent?: string | null;
}

/**
 * Build an AccessContext for a user opening a record. A helper with no active
 * grants on the requested record gets NotFound (not Forbidden) so the
 * existence of other accounts is not revealed.
 */
export async function resolveContext(req: ContextRequest): Promise<AccessContext> {
  const ownerId = req.ownerId ?? req.userId;
  const [owner] = await db()
    .select({ id: users.id, timezone: users.timezone, disabledAt: users.disabledAt })
    .from(users)
    .where(eq(users.id, ownerId))
    .limit(1);
  if (!owner || owner.disabledAt) throw new NotFoundError('Record');
  const common = { userId: req.userId, ownerId, ownerTimezone: owner.timezone, via: req.via, ip: req.ip, userAgent: req.userAgent };
  if (ownerId === req.userId) return { ...common, role: 'owner', grants: [] };
  const grants = await loadGrants(req.userId, ownerId);
  if (!grants.length) throw new NotFoundError('Record');
  return { ...common, role: 'helper', grants };
}

/** Records shared with a user (for the record switcher). */
export async function sharedRecords(userId: string) {
  return db()
    .select({
      ownerId: helperRelationships.ownerId,
      ownerName: users.displayName,
      relationshipId: helperRelationships.id,
      label: helperRelationships.label,
    })
    .from(helperRelationships)
    .innerJoin(users, eq(users.id, helperRelationships.ownerId))
    .where(
      and(
        eq(helperRelationships.helperUserId, userId),
        eq(helperRelationships.status, 'active'),
        isNull(users.disabledAt),
        sql`EXISTS (SELECT 1 FROM access_grants g WHERE g.relationship_id = ${helperRelationships.id} AND g.revoked_at IS NULL)`,
      ),
    );
}
