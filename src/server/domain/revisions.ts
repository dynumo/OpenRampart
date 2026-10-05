import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import { config } from '../config.js';
import type { Executor } from '../db/client.js';
import {
  actors,
  attachments,
  eventActors,
  eventRevisions,
  events,
  eventTypes,
  timestampProofs,
} from '../db/schema.js';
import { canonicalHash } from '../integrity/canonical.js';

/**
 * Event revisions. Every create, edit, delete and restore of an Event appends
 * an immutable revision containing a canonical (RFC 8785) JSON snapshot and its
 * SHA-256. Each revision includes the previous revision's hash, forming a
 * per-Event hash chain. Revisions are never updated (enforced by a database
 * trigger); a correction always produces a new revision, so a revision that
 * has been externally timestamped is never altered.
 */

export const SNAPSHOT_SCHEMA = 'openrampart.event-revision.v1';

export interface EventSnapshot {
  schema: typeof SNAPSHOT_SCHEMA;
  eventId: string;
  ownerId: string;
  revision: number;
  previousSha256: string | null;
  deleted: boolean;
  type: string;
  title: string;
  occurredAt: string;
  occurredPrecision: string;
  endedAt: string | null;
  recordedAt: string;
  direction: string | null;
  description: string;
  tags: string[];
  riskLevel: string;
  riskNote: string | null;
  amount: string | null;
  currency: string | null;
  reference: string | null;
  dueOn: string | null;
  actors: { id: string; name: string; role: string | null }[];
  attachments: {
    id: string;
    filename: string;
    mimeType: string;
    sizeBytes: number;
    sha256: string;
  }[];
}

export async function buildSnapshot(
  tx: Executor,
  eventId: string,
  revision: number,
  previousSha256: string | null,
): Promise<EventSnapshot> {
  const [row] = await tx
    .select({ e: events, typeKey: eventTypes.key })
    .from(events)
    .innerJoin(eventTypes, eq(eventTypes.id, events.eventTypeId))
    .where(eq(events.id, eventId))
    .limit(1);
  if (!row) throw new Error(`Event ${eventId} not found while building snapshot`);
  const e = row.e;
  const links = await tx
    .select({ id: actors.id, name: actors.name, role: eventActors.role })
    .from(eventActors)
    .innerJoin(actors, eq(actors.id, eventActors.actorId))
    .where(eq(eventActors.eventId, eventId))
    .orderBy(asc(actors.id));
  const seen = new Set<string>();
  const actorList = links.filter((l) => (seen.has(l.id) ? false : (seen.add(l.id), true)));
  const files = await tx
    .select({
      id: attachments.id,
      filename: attachments.originalFilename,
      mimeType: attachments.mimeType,
      sizeBytes: attachments.sizeBytes,
      sha256: attachments.sha256,
    })
    .from(attachments)
    .where(and(eq(attachments.eventId, eventId), isNull(attachments.deletedAt)))
    .orderBy(asc(attachments.id));
  return {
    schema: SNAPSHOT_SCHEMA,
    eventId: e.id,
    ownerId: e.ownerId,
    revision,
    previousSha256,
    deleted: e.deletedAt !== null,
    type: row.typeKey,
    title: e.title,
    occurredAt: e.occurredAt.toISOString(),
    occurredPrecision: e.occurredPrecision,
    endedAt: e.endedAt?.toISOString() ?? null,
    recordedAt: e.recordedAt.toISOString(),
    direction: e.direction,
    description: e.description,
    tags: [...e.tags].sort(),
    riskLevel: e.riskLevel,
    riskNote: e.riskNote,
    amount: e.amount,
    currency: e.currency,
    reference: e.reference,
    dueOn: e.dueOn,
    actors: actorList.map((a) => ({ id: a.id, name: a.name, role: a.role ?? null })),
    attachments: files.map((f) => ({ ...f, sizeBytes: Number(f.sizeBytes) })),
  };
}

/**
 * Append a revision for the Event's current state. Must be called inside the
 * transaction that changed the Event, after the change.
 */
export async function appendRevision(
  tx: Executor,
  input: {
    eventId: string;
    ownerId: string;
    changeKind: 'create' | 'update' | 'delete' | 'restore';
    changedFields: string[];
    userId: string | null;
    via: string;
  },
) {
  // Lock the event row so concurrent edits produce a strictly ordered chain.
  await tx.execute(sql`SELECT id FROM events WHERE id = ${input.eventId} FOR UPDATE`);
  const [previous] = await tx
    .select({ revision: eventRevisions.revision, sha256: eventRevisions.sha256 })
    .from(eventRevisions)
    .where(eq(eventRevisions.eventId, input.eventId))
    .orderBy(desc(eventRevisions.revision))
    .limit(1);
  const revision = (previous?.revision ?? 0) + 1;
  const snapshot = await buildSnapshot(tx, input.eventId, revision, previous?.sha256 ?? null);
  const { canonical, sha256 } = canonicalHash(snapshot);
  const [row] = await tx
    .insert(eventRevisions)
    .values({
      eventId: input.eventId,
      ownerId: input.ownerId,
      revision,
      changeKind: input.changeKind,
      changedFields: input.changedFields,
      canonical,
      sha256,
      previousSha256: previous?.sha256 ?? null,
      createdBy: input.userId,
      createdVia: input.via,
    })
    .returning();
  await tx.update(events).set({ revision }).where(eq(events.id, input.eventId));
  await queueTimestamp(tx, input.ownerId, 'event_revision', row!.id, sha256);
  return row!;
}

/** Queue a digest for external timestamping when a provider is configured. */
export async function queueTimestamp(
  tx: Executor,
  ownerId: string,
  subjectType: 'attachment' | 'event_revision',
  subjectId: string,
  digest: string,
): Promise<void> {
  const provider = config().TIMESTAMP_PROVIDER;
  if (provider === 'none') return;
  await tx
    .insert(timestampProofs)
    .values({ ownerId, subjectType, subjectId, digest, provider, status: 'queued' })
    .onConflictDoNothing();
}

/**
 * Confirm a stored revision is intact: its text is in canonical form and its
 * SHA-256 matches the recorded hash.
 */
export function verifyRevisionHash(canonical: string, expectedSha256: string): boolean {
  try {
    const recomputed = canonicalHash(JSON.parse(canonical));
    return recomputed.canonical === canonical && recomputed.sha256 === expectedSha256;
  } catch {
    return false;
  }
}
