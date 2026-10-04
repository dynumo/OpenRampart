import { and, eq, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { parseOccurrence } from '../../shared/dates.js';
import type {
  EventActorDTO,
  EventDetailDTO,
  EventPermissions,
  EventSummaryDTO,
  IncidentRef,
  Page,
  RelatedEventDTO,
  RevisionDTO,
} from '../../shared/types.js';
import { config } from '../config.js';
import { db, type Executor } from '../db/client.js';
import { actors, eventActors, eventRelations, events, incidentEvents } from '../db/schema.js';
import { ForbiddenError, NotFoundError, ValidationError } from '../lib/errors.js';
import {
  actorFullAccess,
  actorLinkVisible,
  eventVisible,
  incidentVisible,
  restrictContext,
} from './access.js';
import { attachmentsForEvents, timestampFromRow, toAttachmentDTO } from './attachmentQueries.js';
import { auditCtx } from './audit.js';
import { isOwner, requireScopes, type AccessContext } from './context.js';
import { resolveEventType } from './eventTypes.js';
import { appendRevision } from './revisions.js';
import {
  cleanIds,
  decodeCursor,
  encodeCursor,
  isUuid,
  iso,
  rows,
  summarise,
  uuidList,
} from './sqlutil.js';

// ---------------------------------------------------------------------------
// Input validation (shared by web API and MCP)
// ---------------------------------------------------------------------------

const optionalText = (max: number) =>
  z
    .string()
    .max(max)
    .nullish()
    .transform((v) => (v === undefined ? undefined : v === null ? null : v.trim() || null));

const actorLinkInput = z.object({
  actorId: z.string(),
  role: z.string().max(60).nullish(),
});

const newActorInput = z.object({
  name: z.string().trim().min(1).max(200),
  kind: z.enum(['organisation', 'person', 'other']).default('organisation'),
  role: z.string().max(60).nullish(),
});

export const eventInputSchema = z.object({
  typeId: z.string().min(1),
  title: z.string().max(300).optional(),
  occurredAt: z.string().min(1).max(40),
  endedAt: z.string().max(40).nullish(),
  direction: z.enum(['inbound', 'outbound', 'internal']).nullish(),
  description: z.string().max(100_000).optional(),
  tags: z.array(z.string().trim().min(1).max(60)).max(50).optional(),
  riskLevel: z.enum(['none', 'low', 'medium', 'high']).optional(),
  riskNote: optionalText(2000),
  amount: z
    .union([z.string(), z.number()])
    .nullish()
    .transform((v) => (v === undefined ? undefined : v === null || v === '' ? null : String(v).trim())),
  currency: optionalText(3),
  reference: optionalText(200),
  dueOn: optionalText(10),
  actors: z.array(actorLinkInput).max(50).optional(),
  newActors: z.array(newActorInput).max(20).optional(),
  incidentIds: z.array(z.string()).max(50).optional(),
  relatedEventIds: z.array(z.string()).max(50).optional(),
});

export type EventInput = z.input<typeof eventInputSchema>;
export const eventPatchSchema = eventInputSchema
  .omit({ incidentIds: true, relatedEventIds: true })
  .partial();
export type EventPatch = z.input<typeof eventPatchSchema>;

function parseInput<T extends z.ZodTypeAny>(schema: T, input: unknown): z.output<T> {
  const result = schema.safeParse(input);
  if (!result.success) {
    const fields: Record<string, string> = {};
    for (const issue of result.error.issues) fields[issue.path.join('.') || 'input'] = issue.message;
    throw new ValidationError('Please check the details entered', fields);
  }
  return result.data;
}

function normaliseAmount(v: string | null | undefined): string | null | undefined {
  if (v === undefined || v === null) return v;
  const cleaned = v.replace(/[£$€,\s]/g, '');
  if (!/^-?\d{1,12}(\.\d{1,2})?$/.test(cleaned)) {
    throw new ValidationError('Invalid amount', { amount: 'Enter an amount such as 123.45' });
  }
  return cleaned;
}

function normaliseCurrency(v: string | null | undefined): string | null | undefined {
  if (v === undefined || v === null) return v;
  const c = v.toUpperCase();
  if (!/^[A-Z]{3}$/.test(c)) throw new ValidationError('Invalid currency', { currency: 'Use a 3-letter code such as GBP' });
  return c;
}

function normaliseDue(v: string | null | undefined): string | null | undefined {
  if (v === undefined || v === null) return v;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v))) {
    throw new ValidationError('Invalid date', { dueOn: 'Enter a date as YYYY-MM-DD' });
  }
  return v;
}

function normaliseTags(tags: string[] | undefined): string[] | undefined {
  if (!tags) return tags;
  return [...new Set(tags.map((t) => t.trim().toLowerCase()).filter(Boolean))];
}

// ---------------------------------------------------------------------------
// Read side
// ---------------------------------------------------------------------------

interface EventRow {
  id: string;
  owner_id: string;
  title: string;
  description: string;
  occurred_at: Date;
  occurred_precision: 'date' | 'datetime';
  ended_at: Date | null;
  recorded_at: Date;
  direction: EventSummaryDTO['direction'];
  tags: string[];
  risk_level: EventSummaryDTO['riskLevel'];
  risk_note: string | null;
  amount: string | null;
  currency: string | null;
  reference: string | null;
  due_on: string | null;
  revision: number;
  created_by: string | null;
  created_by_name: string | null;
  updated_by: string | null;
  updated_by_name: string | null;
  created_via: string;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
  type_id: string;
  type_key: string;
  type_label: string;
}

const EVENT_COLUMNS = sql`
  e.id, e.owner_id, e.title, e.description, e.occurred_at, e.occurred_precision, e.ended_at, e.recorded_at,
  e.direction, e.tags, e.risk_level, e.risk_note, e.amount::text AS amount, e.currency, e.reference,
  e.due_on::text AS due_on, e.revision, e.created_by, cu.display_name AS created_by_name, e.updated_by,
  uu.display_name AS updated_by_name, e.created_via, e.created_at, e.updated_at, e.deleted_at,
  t.id AS type_id, t.key AS type_key, t.label AS type_label`;

const EVENT_FROM = sql`
  FROM events e
  JOIN event_types t ON t.id = e.event_type_id
  LEFT JOIN users cu ON cu.id = e.created_by
  LEFT JOIN users uu ON uu.id = e.updated_by`;

interface LinkRow {
  event_id: string;
  actor_id: string;
  name: string;
  kind: 'organisation' | 'person' | 'other';
  role: string | null;
  position: number;
  link_visible: boolean;
  full_access: boolean;
}

/** Actor links for Events, with per-link visibility evaluated in SQL. */
async function actorLinks(ctx: AccessContext, eventIds: string[], executor?: Executor) {
  if (!eventIds.length) return new Map<string, EventActorDTO[]>();
  const links = await rows<LinkRow>(
    sql`SELECT ea.event_id, ea.actor_id, a.name, a.kind, ea.role, ea.position,
          ${actorLinkVisible(ctx, 'ea', 'e')} AS link_visible,
          ${actorFullAccess(ctx, 'a')} AS full_access
        FROM event_actors ea
        JOIN events e ON e.id = ea.event_id
        JOIN actors a ON a.id = ea.actor_id
        WHERE ea.event_id IN (${uuidList(eventIds)})
        ORDER BY ea.position, a.name`,
    executor,
  );
  const out = new Map<string, EventActorDTO[]>();
  const grouped = new Map<string, Map<string, LinkRow[]>>();
  for (const l of links) {
    const byActor = grouped.get(l.event_id) ?? new Map<string, LinkRow[]>();
    byActor.set(l.actor_id, [...(byActor.get(l.actor_id) ?? []), l]);
    grouped.set(l.event_id, byActor);
  }
  for (const [eventId, byActor] of grouped) {
    const list: EventActorDTO[] = [];
    for (const [actorId, ls] of byActor) {
      const visible = ls.some((l) => l.link_visible);
      if (visible) {
        const first = ls[0]!;
        list.push({
          redacted: false,
          id: actorId,
          name: first.name,
          kind: first.kind,
          role: ls.find((l) => l.role)?.role ?? null,
          fullAccess: ls.some((l) => l.full_access),
        });
      } else {
        list.push({ redacted: true, role: null });
      }
    }
    // Redacted entries go last so their position reveals nothing.
    list.sort((a, b) => Number(a.redacted) - Number(b.redacted));
    out.set(eventId, list);
  }
  return out;
}

async function incidentLinks(ctx: AccessContext, eventIds: string[]) {
  const out = new Map<string, IncidentRef[]>();
  if (!eventIds.length) return out;
  const list = await rows<{ event_id: string; id: string; title: string; status: IncidentRef['status'] }>(
    sql`SELECT ie.event_id, i.id, i.title, i.status
        FROM incident_events ie JOIN incidents i ON i.id = ie.incident_id
        WHERE ie.event_id IN (${uuidList(eventIds)}) AND ${incidentVisible(ctx, 'i')}
        ORDER BY i.opened_on DESC`,
  );
  for (const r of list) out.set(r.event_id, [...(out.get(r.event_id) ?? []), { id: r.id, title: r.title, status: r.status }]);
  return out;
}

async function attachmentCounts(ctx: AccessContext, eventIds: string[]) {
  const out = new Map<string, number>();
  if (!eventIds.length) return out;
  const list = await rows<{ event_id: string; n: number }>(
    sql`SELECT att.event_id, count(*)::int AS n FROM attachments att
        WHERE att.event_id IN (${uuidList(eventIds)}) AND att.deleted_at IS NULL AND att.owner_id = ${ctx.ownerId}
        GROUP BY att.event_id`,
  );
  for (const r of list) out.set(r.event_id, r.n);
  return out;
}

export function displayTitle(title: string, typeLabel: string, actorList: EventActorDTO[]): string {
  if (title.trim()) return title.trim();
  const named = actorList.find((a): a is Extract<EventActorDTO, { redacted: false }> => !a.redacted);
  return named ? `${typeLabel} — ${named.name}` : typeLabel;
}

function toSummary(
  r: EventRow,
  actorList: EventActorDTO[],
  incidents: IncidentRef[],
  attachmentCount: number,
): EventSummaryDTO {
  return {
    id: r.id,
    title: r.title,
    displayTitle: displayTitle(r.title, r.type_label, actorList),
    type: { id: r.type_id, key: r.type_key, label: r.type_label },
    occurredAt: iso(r.occurred_at)!,
    occurredPrecision: r.occurred_precision,
    endedAt: iso(r.ended_at),
    recordedAt: iso(r.recorded_at)!,
    direction: r.direction,
    summary: summarise(r.description),
    actors: actorList,
    incidents,
    attachmentCount,
    riskLevel: r.risk_level,
    riskNote: r.risk_note,
    tags: r.tags,
    amount: r.amount,
    currency: r.currency,
    reference: r.reference,
    dueOn: r.due_on,
    createdBy: r.created_by ? { id: r.created_by, displayName: r.created_by_name ?? 'Unknown' } : null,
    createdVia: r.created_via,
  };
}

/** Build summaries for Event rows already known to be visible. */
export async function summariesFor(ctx: AccessContext, eventRows: EventRow[]): Promise<EventSummaryDTO[]> {
  const ids = eventRows.map((r) => r.id);
  const [links, incidents, counts] = await Promise.all([
    actorLinks(ctx, ids),
    incidentLinks(ctx, ids),
    attachmentCounts(ctx, ids),
  ]);
  return eventRows.map((r) => toSummary(r, links.get(r.id) ?? [], incidents.get(r.id) ?? [], counts.get(r.id) ?? 0));
}

export async function eventSummariesByIds(ctx: AccessContext, ids: string[]): Promise<Map<string, EventSummaryDTO>> {
  if (!ids.length) return new Map();
  const list = await rows<EventRow>(
    sql`SELECT ${EVENT_COLUMNS} ${EVENT_FROM} WHERE e.id IN (${uuidList(ids)}) AND ${eventVisible(ctx, 'e')}`,
  );
  const summaries = await summariesFor(ctx, list);
  return new Map(summaries.map((s) => [s.id, s]));
}

export interface EventFilters {
  actorIds?: string[];
  typeIds?: string[];
  incidentIds?: string[];
  /** Inclusive local dates (YYYY-MM-DD) in the owner's time zone. */
  from?: string | null;
  to?: string | null;
  hasAttachments?: boolean;
  riskLevels?: string[];
  direction?: string | null;
  tags?: string[];
  /** Restrict to Event ids (used by search). */
  ids?: string[];
  deleted?: boolean;
}

/** Translate filters into SQL against alias `e`; every filter respects visibility. */
export function filterSql(ctx: AccessContext, f: EventFilters): SQL[] {
  const where: SQL[] = [eventVisible(ctx, 'e', { includeDeleted: Boolean(f.deleted) })];
  if (f.deleted) {
    if (!isOwner(ctx)) throw new ForbiddenError();
    where.push(sql`e.deleted_at IS NOT NULL`);
  }
  const actorIds = cleanIds(f.actorIds);
  if (f.actorIds?.length) {
    if (!actorIds.length) where.push(sql`FALSE`);
    else
      where.push(
        sql`EXISTS (SELECT 1 FROM event_actors ea WHERE ea.event_id = e.id AND ea.actor_id IN (${uuidList(actorIds)}) AND ${actorLinkVisible(ctx, 'ea', 'e')})`,
      );
  }
  const typeIds = cleanIds(f.typeIds);
  if (f.typeIds?.length) where.push(typeIds.length ? sql`e.event_type_id IN (${uuidList(typeIds)})` : sql`FALSE`);
  const incidentIds = cleanIds(f.incidentIds);
  if (f.incidentIds?.length) {
    if (!incidentIds.length) where.push(sql`FALSE`);
    else
      where.push(
        sql`EXISTS (SELECT 1 FROM incident_events ie JOIN incidents i ON i.id = ie.incident_id WHERE ie.event_id = e.id AND ie.incident_id IN (${uuidList(incidentIds)}) AND ${incidentVisible(ctx, 'i')})`,
      );
  }
  const localDate = sql`(e.occurred_at AT TIME ZONE ${ctx.ownerTimezone})::date`;
  if (f.from) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(f.from)) throw new ValidationError('Invalid from date');
    where.push(sql`${localDate} >= ${f.from}::date`);
  }
  if (f.to) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(f.to)) throw new ValidationError('Invalid to date');
    where.push(sql`${localDate} <= ${f.to}::date`);
  }
  if (f.hasAttachments) {
    where.push(sql`EXISTS (SELECT 1 FROM attachments att WHERE att.event_id = e.id AND att.deleted_at IS NULL)`);
  }
  const risks = (f.riskLevels ?? []).filter((r) => ['none', 'low', 'medium', 'high'].includes(r));
  if (f.riskLevels?.length) where.push(risks.length ? sql`e.risk_level IN (${sql.join(risks.map((r) => sql`${r}`), sql`, `)})` : sql`FALSE`);
  if (f.direction && ['inbound', 'outbound', 'internal'].includes(f.direction)) where.push(sql`e.direction = ${f.direction}`);
  if (f.tags?.length) {
    where.push(sql`e.tags @> ${sql`ARRAY[${sql.join(f.tags.map((t) => sql`${t.toLowerCase()}`), sql`, `)}]::text[]`}`);
  }
  if (f.ids) {
    const ids = cleanIds(f.ids);
    where.push(ids.length ? sql`e.id IN (${uuidList(ids)})` : sql`FALSE`);
  }
  return where;
}

export async function listEvents(
  ctx: AccessContext,
  filters: EventFilters,
  page: { cursor?: string | null; limit?: number; order?: 'asc' | 'desc'; withTotal?: boolean } = {},
): Promise<Page<EventSummaryDTO>> {
  requireScopes(ctx, 'events:read');
  const limit = Math.min(Math.max(page.limit ?? 50, 1), 200);
  const order = page.order === 'asc' ? 'asc' : 'desc';
  const where = filterSql(ctx, filters);
  const cursor = decodeCursor(page.cursor);
  const pageWhere = [...where];
  if (cursor) {
    pageWhere.push(
      order === 'desc'
        ? sql`(e.occurred_at, e.id) < (${cursor.o}::timestamptz, ${cursor.id}::uuid)`
        : sql`(e.occurred_at, e.id) > (${cursor.o}::timestamptz, ${cursor.id}::uuid)`,
    );
  }
  const orderSql = order === 'desc' ? sql`e.occurred_at DESC, e.id DESC` : sql`e.occurred_at ASC, e.id ASC`;
  const list = await rows<EventRow>(
    sql`SELECT ${EVENT_COLUMNS} ${EVENT_FROM} WHERE ${sql.join(pageWhere, sql` AND `)} ORDER BY ${orderSql} LIMIT ${limit + 1}`,
  );
  const items = await summariesFor(ctx, list.slice(0, limit));
  let total: number | undefined;
  if (page.withTotal) {
    const [t] = await rows<{ n: number }>(sql`SELECT count(*)::int AS n FROM events e WHERE ${sql.join(where, sql` AND `)}`);
    total = t?.n ?? 0;
  }
  const last = list[limit - 1];
  return {
    items,
    nextCursor: list.length > limit && last ? encodeCursor({ o: iso(last.occurred_at)!, id: last.id }) : null,
    total,
  };
}

async function loadVisibleEventRow(ctx: AccessContext, id: string, opts: { includeDeleted?: boolean } = {}) {
  if (!isUuid(id)) throw new NotFoundError('Event');
  const [row] = await rows<EventRow>(
    sql`SELECT ${EVENT_COLUMNS} ${EVENT_FROM} WHERE e.id = ${id}::uuid AND ${eventVisible(ctx, 'e', opts)}`,
  );
  if (!row) throw new NotFoundError('Event');
  return row;
}

/** True when the Event is visible through a grant that allows adding. */
async function visibleForAdd(ctx: AccessContext, eventId: string, executor?: Executor): Promise<boolean> {
  const addCtx = restrictContext(ctx, 'add');
  const [row] = await rows<{ ok: boolean }>(
    sql`SELECT EXISTS (SELECT 1 FROM events e WHERE e.id = ${eventId}::uuid AND ${eventVisible(addCtx, 'e')}) AS ok`,
    executor,
  );
  return Boolean(row?.ok);
}

export async function eventPermissions(ctx: AccessContext, row: { id: string; created_by: string | null; deleted_at: Date | null }): Promise<EventPermissions> {
  if (isOwner(ctx)) {
    const live = row.deleted_at === null;
    return { canEdit: live, canDelete: live, canAddAttachment: live, canOrganise: live };
  }
  const canAdd = await visibleForAdd(ctx, row.id);
  return {
    canEdit: canAdd && row.created_by === ctx.userId,
    canDelete: false,
    canAddAttachment: canAdd,
    canOrganise: false,
  };
}

async function relatedEvents(ctx: AccessContext, eventId: string): Promise<RelatedEventDTO[]> {
  const list = await rows<{
    relation_id: string;
    note: string | null;
    id: string;
    title: string;
    occurred_at: Date;
    occurred_precision: 'date' | 'datetime';
    type_label: string;
  }>(sql`
    SELECT r.id AS relation_id, r.note, e.id, e.title, e.occurred_at, e.occurred_precision, t.label AS type_label
    FROM event_relations r
    JOIN events e ON e.id = CASE WHEN r.event_a_id = ${eventId}::uuid THEN r.event_b_id ELSE r.event_a_id END
    JOIN event_types t ON t.id = e.event_type_id
    WHERE (r.event_a_id = ${eventId}::uuid OR r.event_b_id = ${eventId}::uuid) AND ${eventVisible(ctx, 'e')}
    ORDER BY e.occurred_at`);
  const links = await actorLinks(ctx, list.map((r) => r.id));
  return list.map((r) => ({
    relationId: r.relation_id,
    id: r.id,
    displayTitle: displayTitle(r.title, r.type_label, links.get(r.id) ?? []),
    occurredAt: iso(r.occurred_at)!,
    occurredPrecision: r.occurred_precision,
    typeLabel: r.type_label,
    note: r.note,
  }));
}

export async function currentRevision(ctx: AccessContext, eventId: string): Promise<RevisionDTO | null> {
  const list = await revisionsFor(ctx, eventId, { latestOnly: true });
  return list[0] ?? null;
}

export async function revisionsFor(
  ctx: AccessContext,
  eventId: string,
  opts: { latestOnly?: boolean } = {},
): Promise<RevisionDTO[]> {
  const list = await rows<{
    revision: number;
    change_kind: RevisionDTO['changeKind'];
    changed_fields: string[];
    sha256: string;
    previous_sha256: string | null;
    created_at: Date;
    created_by: string | null;
    created_by_name: string | null;
    created_via: string;
    canonical: string;
    ts_provider: string | null;
    ts_status: 'queued' | 'pending' | 'complete' | 'failed' | null;
    ts_submitted_at: Date | null;
    ts_attested_time: Date | null;
    ts_attested_height: number | null;
    ts_verified_at: Date | null;
    ts_calendars: string[] | null;
    ts_error: string | null;
  }>(sql`
    SELECT r.revision, r.change_kind, r.changed_fields, r.sha256, r.previous_sha256, r.created_at, r.created_by,
           u.display_name AS created_by_name, r.created_via, r.canonical,
           tp.provider AS ts_provider, tp.status AS ts_status, tp.submitted_at AS ts_submitted_at,
           tp.attested_time AS ts_attested_time, tp.attested_height AS ts_attested_height,
           tp.verified_at AS ts_verified_at, tp.calendars AS ts_calendars, tp.error AS ts_error
    FROM event_revisions r
    LEFT JOIN users u ON u.id = r.created_by
    LEFT JOIN timestamp_proofs tp ON tp.subject_type = 'event_revision' AND tp.subject_id = r.id
    WHERE r.event_id = ${eventId}::uuid AND r.owner_id = ${ctx.ownerId}
    ORDER BY r.revision DESC
    ${opts.latestOnly ? sql`LIMIT 1` : sql``}`);
  return list.map((r) => ({
    revision: r.revision,
    changeKind: r.change_kind,
    changedFields: r.changed_fields,
    sha256: r.sha256,
    previousSha256: r.previous_sha256,
    createdAt: iso(r.created_at)!,
    createdBy: r.created_by ? { id: r.created_by, displayName: r.created_by_name ?? 'Unknown' } : null,
    createdVia: r.created_via,
    timestamp: timestampFromRow(r),
    // Snapshots can contain Actor names a Helper may not see, so only owners get them.
    ...(isOwner(ctx) ? { canonical: r.canonical } : {}),
  }));
}

export async function getEvent(ctx: AccessContext, id: string, opts: { includeDeleted?: boolean } = {}): Promise<EventDetailDTO> {
  requireScopes(ctx, 'events:read');
  const row = await loadVisibleEventRow(ctx, id, { includeDeleted: opts.includeDeleted && isOwner(ctx) });
  const [summary] = await summariesFor(ctx, [row]);
  const canSeeAttachments = !ctx.oauth || ctx.oauth.scopes.has('attachments:metadata');
  const [attachmentRows, related, revision, permissions] = await Promise.all([
    canSeeAttachments ? attachmentsForEvents(ctx, [row.id]) : Promise.resolve([]),
    relatedEvents(ctx, row.id),
    currentRevision(ctx, row.id),
    eventPermissions(ctx, row),
  ]);
  return {
    ...summary!,
    description: row.description,
    revision: row.revision,
    createdAt: iso(row.created_at)!,
    updatedAt: iso(row.updated_at)!,
    updatedBy: row.updated_by ? { id: row.updated_by, displayName: row.updated_by_name ?? 'Unknown' } : null,
    deletedAt: iso(row.deleted_at),
    attachments: attachmentRows.map(toAttachmentDTO),
    related,
    currentRevision: revision,
    permissions,
  };
}

// ---------------------------------------------------------------------------
// Write side
// ---------------------------------------------------------------------------

/** Actors an input may link: must exist in the record and be fully accessible. */
async function resolveLinkableActors(ctx: AccessContext, tx: Executor, actorIds: string[]): Promise<Map<string, string>> {
  const ids = cleanIds(actorIds);
  if (ids.length !== new Set(actorIds.map((s) => s.toLowerCase())).size) {
    throw new ValidationError('Unknown Actor', { actors: 'One of the selected Actors could not be found.' });
  }
  if (!ids.length) return new Map();
  const found = await rows<{ id: string; merged_into_id: string | null }>(
    sql`SELECT a.id, a.merged_into_id FROM actors a WHERE a.id IN (${uuidList(ids)}) AND ${actorFullAccess(ctx, 'a')}`,
    tx,
  );
  if (found.length !== ids.length) {
    throw new ValidationError('Unknown Actor', { actors: 'One of the selected Actors could not be found.' });
  }
  // Linking to a merged Actor links to the Actor it was merged into.
  return new Map(found.map((a) => [a.id, a.merged_into_id ?? a.id]));
}

async function createInlineActors(
  ctx: AccessContext,
  tx: Executor,
  list: { name: string; kind: 'organisation' | 'person' | 'other' }[],
): Promise<string[]> {
  if (!list.length) return [];
  requireScopes(ctx, 'actors:write');
  const created = await tx
    .insert(actors)
    .values(list.map((a) => ({ ownerId: ctx.ownerId, name: a.name.trim(), kind: a.kind, createdBy: ctx.userId })))
    .returning({ id: actors.id });
  for (const a of created) await auditCtx(ctx, 'actor.created', { type: 'actor', id: a.id }, tx);
  return created.map((c) => c.id);
}

async function setEventActors(
  tx: Executor,
  eventId: string,
  desired: { actorId: string; role: string | null }[],
): Promise<boolean> {
  const existing = await tx.select().from(eventActors).where(eq(eventActors.eventId, eventId));
  const desiredIds = new Set(desired.map((d) => d.actorId));
  let changed = false;
  for (const row of existing) {
    if (!desiredIds.has(row.actorId)) {
      await tx.delete(eventActors).where(and(eq(eventActors.eventId, eventId), eq(eventActors.originActorId, row.originActorId)));
      changed = true;
    }
  }
  for (const [position, d] of desired.entries()) {
    const rowsForActor = existing.filter((r) => r.actorId === d.actorId);
    if (!rowsForActor.length) {
      await tx.insert(eventActors).values({ eventId, actorId: d.actorId, originActorId: d.actorId, role: d.role, position });
      changed = true;
    } else {
      for (const r of rowsForActor) {
        if (r.role !== d.role || r.position !== position) {
          await tx
            .update(eventActors)
            .set({ role: d.role, position })
            .where(and(eq(eventActors.eventId, eventId), eq(eventActors.originActorId, r.originActorId)));
          if (r.role !== d.role) changed = true;
        }
      }
    }
  }
  return changed;
}

async function assertIncidentsLinkable(ctx: AccessContext, tx: Executor, incidentIds: string[]): Promise<string[]> {
  const ids = cleanIds(incidentIds);
  if (ids.length !== incidentIds.length) throw new ValidationError('Unknown Incident');
  if (!ids.length) return [];
  const found = await rows<{ id: string }>(
    sql`SELECT i.id FROM incidents i WHERE i.id IN (${uuidList(ids)}) AND ${incidentVisible(restrictContext(ctx, 'add'), 'i')}`,
    tx,
  );
  if (found.length !== ids.length) throw new ValidationError('Unknown Incident', { incidentIds: 'One of the Incidents could not be found.' });
  return ids;
}

function requireCanAdd(ctx: AccessContext): void {
  requireScopes(ctx, 'events:write');
  if (!isOwner(ctx) && !ctx.grants.some((g) => g.canAdd)) {
    throw new ForbiddenError('Your access to this record does not include adding Events');
  }
}

export async function createEvent(ctx: AccessContext, rawInput: unknown): Promise<EventDetailDTO> {
  requireCanAdd(ctx);
  const input = parseInput(eventInputSchema, rawInput);
  const type = await resolveEventType(input.typeId);
  if (type.archivedAt) throw new ValidationError('That Event type is archived');
  const occurrence = parseOccurrence(input.occurredAt, ctx.ownerTimezone);
  if (!occurrence) throw new ValidationError('Invalid date', { occurredAt: 'Enter when this happened, e.g. 2026-09-12 or 2026-09-12T14:30' });
  let endedAt: Date | null = null;
  if (input.endedAt) {
    const end = parseOccurrence(input.endedAt, ctx.ownerTimezone);
    if (!end) throw new ValidationError('Invalid end date', { endedAt: 'Enter a valid end date and time' });
    if (end.instant < occurrence.instant) throw new ValidationError('End must be after start', { endedAt: 'The end must be after the start.' });
    endedAt = end.instant;
  }
  const amount = normaliseAmount(input.amount);
  const id = await db().transaction(async (tx) => {
    const actorMap = await resolveLinkableActors(ctx, tx, (input.actors ?? []).map((a) => a.actorId));
    const newActorIds = await createInlineActors(ctx, tx, input.newActors ?? []);
    const incidentIds = await assertIncidentsLinkable(ctx, tx, input.incidentIds ?? []);
    if (incidentIds.length) requireScopes(ctx, 'incidents:write');
    const [created] = await tx
      .insert(events)
      .values({
        ownerId: ctx.ownerId,
        eventTypeId: type.id,
        title: input.title?.trim() ?? '',
        occurredAt: occurrence.instant,
        occurredPrecision: occurrence.precision,
        endedAt,
        direction: input.direction ?? type.defaultDirection ?? null,
        description: input.description?.trim() ?? '',
        tags: normaliseTags(input.tags) ?? [],
        riskLevel: input.riskLevel ?? 'none',
        riskNote: input.riskNote ?? null,
        amount: amount ?? null,
        currency: normaliseCurrency(input.currency) ?? (amount ? 'GBP' : null),
        reference: input.reference ?? null,
        dueOn: normaliseDue(input.dueOn) ?? null,
        createdBy: ctx.userId,
        updatedBy: ctx.userId,
        createdVia: ctx.via === 'mcp' ? 'mcp' : 'web',
      })
      .returning({ id: events.id });
    const eventId = created!.id;
    const desired: { actorId: string; role: string | null }[] = [];
    for (const a of input.actors ?? []) {
      const target = actorMap.get(a.actorId.toLowerCase())!;
      if (!desired.some((d) => d.actorId === target)) desired.push({ actorId: target, role: a.role?.trim() || null });
    }
    (input.newActors ?? []).forEach((a, i) => desired.push({ actorId: newActorIds[i]!, role: a.role?.trim() || null }));
    await setEventActors(tx, eventId, desired);
    for (const incidentId of incidentIds) {
      await tx.insert(incidentEvents).values({ incidentId, eventId, addedBy: ctx.userId }).onConflictDoNothing();
    }
    for (const otherId of cleanIds(input.relatedEventIds ?? [])) {
      await linkEventsTx(ctx, tx, eventId, otherId, null);
    }
    await appendRevision(tx, {
      eventId,
      ownerId: ctx.ownerId,
      changeKind: 'create',
      changedFields: [],
      userId: ctx.userId,
      via: ctx.via,
    });
    // A Helper may only create Events that fall inside a grant allowing Add.
    if (!isOwner(ctx) && !(await visibleForAdd(ctx, eventId, tx))) {
      throw new ForbiddenError(
        'This Event would fall outside the access you have been given. Check the date, Actors or Incident.',
      );
    }
    await auditCtx(ctx, 'event.created', { type: 'event', id: eventId }, tx);
    return eventId;
  });
  return getEvent(ctx, id);
}

/** Load an Event for modification, enforcing edit permission. */
async function loadForEdit(ctx: AccessContext, id: string) {
  requireScopes(ctx, 'events:write');
  const row = await loadVisibleEventRow(ctx, id);
  if (isOwner(ctx)) return row;
  if (row.created_by !== ctx.userId || !(await visibleForAdd(ctx, id))) {
    throw new ForbiddenError('Helpers can only edit Events they added themselves');
  }
  return row;
}

export async function updateEvent(ctx: AccessContext, id: string, rawPatch: unknown): Promise<EventDetailDTO> {
  const row = await loadForEdit(ctx, id);
  const patch = parseInput(eventPatchSchema, rawPatch);
  const changes: Partial<typeof events.$inferInsert> = {};
  const changed: string[] = [];
  const set = <K extends keyof typeof events.$inferInsert>(key: K, value: (typeof events.$inferInsert)[K], current: unknown, label: string) => {
    const a = value instanceof Date ? value.getTime() : JSON.stringify(value ?? null);
    const b = current instanceof Date ? current.getTime() : JSON.stringify(current ?? null);
    if (a !== b) {
      changes[key] = value;
      changed.push(label);
    }
  };
  if (patch.typeId !== undefined) {
    const type = await resolveEventType(patch.typeId);
    set('eventTypeId', type.id, row.type_id, 'type');
  }
  if (patch.title !== undefined) set('title', patch.title.trim(), row.title, 'title');
  if (patch.occurredAt !== undefined) {
    const occ = parseOccurrence(patch.occurredAt, ctx.ownerTimezone);
    if (!occ) throw new ValidationError('Invalid date', { occurredAt: 'Enter when this happened' });
    set('occurredAt', occ.instant, row.occurred_at, 'occurredAt');
    set('occurredPrecision', occ.precision, row.occurred_precision, 'occurredAt');
  }
  if (patch.endedAt !== undefined) {
    let end: Date | null = null;
    if (patch.endedAt) {
      const parsed = parseOccurrence(patch.endedAt, ctx.ownerTimezone);
      if (!parsed) throw new ValidationError('Invalid end date', { endedAt: 'Enter a valid end date and time' });
      end = parsed.instant;
    }
    set('endedAt', end, row.ended_at, 'endedAt');
  }
  const effectiveStart = (changes.occurredAt as Date | undefined) ?? row.occurred_at;
  const effectiveEnd = changes.endedAt !== undefined ? (changes.endedAt as Date | null) : row.ended_at;
  if (effectiveEnd && effectiveEnd < effectiveStart) {
    throw new ValidationError('End must be after start', { endedAt: 'The end must be after the start.' });
  }
  if (patch.direction !== undefined) set('direction', patch.direction ?? null, row.direction, 'direction');
  if (patch.description !== undefined) set('description', patch.description.trim(), row.description, 'description');
  if (patch.tags !== undefined) set('tags', normaliseTags(patch.tags) ?? [], row.tags, 'tags');
  if (patch.riskLevel !== undefined) set('riskLevel', patch.riskLevel, row.risk_level, 'risk');
  if (patch.riskNote !== undefined) set('riskNote', patch.riskNote ?? null, row.risk_note, 'risk');
  if (patch.amount !== undefined) set('amount', normaliseAmount(patch.amount) ?? null, row.amount, 'amount');
  if (patch.currency !== undefined) set('currency', normaliseCurrency(patch.currency) ?? null, row.currency, 'amount');
  if (patch.reference !== undefined) set('reference', patch.reference ?? null, row.reference, 'reference');
  if (patch.dueOn !== undefined) set('dueOn', normaliseDue(patch.dueOn) ?? null, row.due_on, 'dueOn');

  await db().transaction(async (tx) => {
    let actorsChanged = false;
    if (patch.actors !== undefined || patch.newActors !== undefined) {
      const actorMap = await resolveLinkableActors(ctx, tx, (patch.actors ?? []).map((a) => a.actorId));
      const newIds = await createInlineActors(ctx, tx, patch.newActors ?? []);
      const desired: { actorId: string; role: string | null }[] = [];
      for (const a of patch.actors ?? []) {
        const target = actorMap.get(a.actorId.toLowerCase())!;
        if (!desired.some((d) => d.actorId === target)) desired.push({ actorId: target, role: a.role?.trim() || null });
      }
      (patch.newActors ?? []).forEach((a, i) => desired.push({ actorId: newIds[i]!, role: a.role?.trim() || null }));
      if (!isOwner(ctx)) {
        // Helpers must not silently remove Actors they cannot see.
        const hidden = await rows<{ actor_id: string }>(
          sql`SELECT ea.actor_id FROM event_actors ea JOIN events e ON e.id = ea.event_id
              WHERE ea.event_id = ${id}::uuid AND NOT ${actorLinkVisible(ctx, 'ea', 'e')}`,
          tx,
        );
        for (const h of hidden) if (!desired.some((d) => d.actorId === h.actor_id)) desired.push({ actorId: h.actor_id, role: null });
      }
      actorsChanged = await setEventActors(tx, id, desired);
      if (actorsChanged) changed.push('actors');
    }
    if (!changed.length) return;
    await tx
      .update(events)
      .set({ ...changes, updatedAt: new Date(), updatedBy: ctx.userId })
      .where(eq(events.id, id));
    await appendRevision(tx, {
      eventId: id,
      ownerId: ctx.ownerId,
      changeKind: 'update',
      changedFields: [...new Set(changed)],
      userId: ctx.userId,
      via: ctx.via,
    });
    if (!isOwner(ctx) && !(await visibleForAdd(ctx, id, tx))) {
      throw new ForbiddenError('This change would move the Event outside the access you have been given');
    }
    await auditCtx(ctx, 'event.updated', { type: 'event', id, metadata: { fields: [...new Set(changed)] } }, tx);
  });
  return getEvent(ctx, id);
}

export async function deleteEvent(ctx: AccessContext, id: string): Promise<void> {
  requireScopes(ctx, 'events:write');
  if (!isOwner(ctx)) throw new ForbiddenError('Only the owner of this record can delete Events');
  await loadVisibleEventRow(ctx, id);
  const retentionDays = config().DELETION_RETENTION_DAYS;
  await db().transaction(async (tx) => {
    const now = new Date();
    await tx
      .update(events)
      .set({ deletedAt: now, deletedBy: ctx.userId, purgeAfter: new Date(now.getTime() + retentionDays * 86400_000) })
      .where(eq(events.id, id));
    await appendRevision(tx, { eventId: id, ownerId: ctx.ownerId, changeKind: 'delete', changedFields: [], userId: ctx.userId, via: ctx.via });
    await auditCtx(ctx, 'event.deleted', { type: 'event', id, metadata: { retentionDays } }, tx);
  });
}

export async function restoreEvent(ctx: AccessContext, id: string): Promise<EventDetailDTO> {
  requireScopes(ctx, 'events:write');
  if (!isOwner(ctx)) throw new ForbiddenError();
  const row = await loadVisibleEventRow(ctx, id, { includeDeleted: true });
  if (!row.deleted_at) return getEvent(ctx, id);
  await db().transaction(async (tx) => {
    await tx.update(events).set({ deletedAt: null, deletedBy: null, purgeAfter: null }).where(eq(events.id, id));
    await appendRevision(tx, { eventId: id, ownerId: ctx.ownerId, changeKind: 'restore', changedFields: [], userId: ctx.userId, via: ctx.via });
    await auditCtx(ctx, 'event.restored', { type: 'event', id }, tx);
  });
  return getEvent(ctx, id);
}

// ---------------------------------------------------------------------------
// Event-to-Event relationships
// ---------------------------------------------------------------------------

async function linkEventsTx(ctx: AccessContext, tx: Executor, aId: string, bId: string, note: string | null) {
  if (aId === bId) throw new ValidationError('An Event cannot be related to itself');
  const ids = cleanIds([aId, bId]);
  if (ids.length !== 2) throw new NotFoundError('Event');
  const visible = await rows<{ id: string }>(
    sql`SELECT e.id FROM events e WHERE e.id IN (${uuidList(ids)}) AND ${eventVisible(isOwner(ctx) ? ctx : restrictContext(ctx, 'add'), 'e')}`,
    tx,
  );
  if (visible.length !== 2) throw new NotFoundError('Event');
  const [first, second] = [aId, bId].sort() as [string, string];
  const [rel] = await tx
    .insert(eventRelations)
    .values({ ownerId: ctx.ownerId, eventAId: first, eventBId: second, note, createdBy: ctx.userId })
    .onConflictDoNothing()
    .returning({ id: eventRelations.id });
  if (rel) await auditCtx(ctx, 'event.linked', { type: 'event_relation', id: rel.id, metadata: { events: [first, second] } }, tx);
  return rel?.id ?? null;
}

export async function linkEvents(ctx: AccessContext, aId: string, bId: string, note?: string | null): Promise<void> {
  requireScopes(ctx, 'events:write');
  if (!isOwner(ctx)) throw new ForbiddenError('Only the owner of this record can relate Events');
  await db().transaction((tx) => linkEventsTx(ctx, tx, aId, bId, note?.trim() || null));
}

export async function unlinkEvents(ctx: AccessContext, relationId: string): Promise<void> {
  requireScopes(ctx, 'events:write');
  if (!isOwner(ctx)) throw new ForbiddenError('Only the owner of this record can change related Events');
  if (!isUuid(relationId)) throw new NotFoundError('Relationship');
  const removed = await db()
    .delete(eventRelations)
    .where(and(eq(eventRelations.id, relationId), eq(eventRelations.ownerId, ctx.ownerId)))
    .returning({ id: eventRelations.id });
  if (!removed.length) throw new NotFoundError('Relationship');
  await auditCtx(ctx, 'event.unlinked', { type: 'event_relation', id: relationId });
}

export { loadVisibleEventRow, visibleForAdd };
export type { EventRow };
