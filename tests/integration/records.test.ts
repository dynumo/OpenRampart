import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db } from '../../src/server/db/client.js';
import { deleteActor, getActor, mergeActors, previewMerge, setActorArchived } from '../../src/server/domain/actors.js';
import { createEvent, deleteEvent, getEvent, linkEvents, listEvents, restoreEvent, revisionsFor, unlinkEvents, updateEvent } from '../../src/server/domain/events.js';
import { addEventsToIncident, createIncident, getIncident, removeEventFromIncident, updateIncident } from '../../src/server/domain/incidents.js';
import { verifyRevisionHash } from '../../src/server/domain/revisions.js';
import { search } from '../../src/server/domain/search.js';
import { actor, event, makeUser, ownerCtx } from './helpers.js';

describe('Events, revisions and relationships', () => {
  it('saves incomplete Events and keeps occurred and recorded times separate', async () => {
    const ctx = await ownerCtx((await makeUser()).id);
    const e = await createEvent(ctx, { typeId: 'phone_call', occurredAt: '2026-09-15T10:30' });
    expect(e.title).toBe('');
    expect(e.displayTitle).toBe('Phone call');
    expect(e.occurredPrecision).toBe('datetime');
    expect(e.occurredAt).toBe('2026-09-15T09:30:00.000Z'); // 10:30 BST
    expect(new Date(e.recordedAt).getTime()).toBeGreaterThan(new Date(e.occurredAt).getTime());
    const d = await createEvent(ctx, { typeId: 'letter_in', occurredAt: '2026-01-12' });
    expect(d.occurredPrecision).toBe('date');
    expect(d.occurredAt).toBe('2026-01-12T00:00:00.000Z'); // GMT in winter
    await expect(createEvent(ctx, { typeId: 'note', occurredAt: '31/02/2026' })).rejects.toMatchObject({ status: 400 });
    await expect(createEvent(ctx, { typeId: 'nonsense', occurredAt: '2026-01-01' })).rejects.toMatchObject({ status: 400 });
  });

  it('records a hash-chained revision for every change, preserving earlier ones', async () => {
    const ctx = await ownerCtx((await makeUser()).id);
    const a = await actor(ctx, 'Council');
    const e = await event(ctx, { title: 'Letter', actors: [{ actorId: a.id }], amount: '£1,250.50' });
    expect(e.amount).toBe('1250.50');
    expect(e.currency).toBe('GBP');
    const u1 = await updateEvent(ctx, e.id, { title: 'Letter about council tax', riskLevel: 'medium', riskNote: 'Payment due soon' });
    expect(u1.revision).toBe(2);
    const same = await updateEvent(ctx, e.id, { title: 'Letter about council tax' });
    expect(same.revision).toBe(2); // no change, no new revision
    await deleteEvent(ctx, e.id);
    await expect(getEvent(ctx, e.id)).rejects.toMatchObject({ status: 404 });
    await restoreEvent(ctx, e.id);
    const revs = await revisionsFor(ctx, e.id);
    expect(revs.map((r) => r.changeKind)).toEqual(['restore', 'delete', 'update', 'create']);
    for (const r of revs) expect(verifyRevisionHash(r.canonical!, r.sha256)).toBe(true);
    for (let i = 0; i < revs.length - 1; i++) expect(revs[i]!.previousSha256).toBe(revs[i + 1]!.sha256);
    expect(revs[2]!.changedFields.sort()).toEqual(['risk', 'title']);
    const first = JSON.parse(revs[3]!.canonical!);
    expect(first.title).toBe('Letter');
    // Revisions are immutable in the database.
    await expect(db().execute(sql`UPDATE event_revisions SET canonical = 'x' WHERE event_id = ${e.id}::uuid`)).rejects.toThrow();
  });

  it('relates Events and groups them into Incidents without copying content', async () => {
    const ctx = await ownerCtx((await makeUser()).id);
    const a = await event(ctx, { title: 'Payment made', occurredAt: '2026-09-12', typeId: 'payment' });
    const b = await event(ctx, { title: 'Payment shown as missing', occurredAt: '2026-09-15', typeId: 'observation' });
    const c = await event(ctx, { title: 'Arrears letter', occurredAt: '2026-09-16', typeId: 'letter_in' });
    await linkEvents(ctx, a.id, b.id, 'Same payment');
    const withRel = await getEvent(ctx, a.id);
    expect(withRel.related).toHaveLength(1);
    expect(withRel.related[0]!.note).toBe('Same payment');
    await unlinkEvents(ctx, withRel.related[0]!.relationId);
    expect((await getEvent(ctx, a.id)).related).toHaveLength(0);

    const inc = await createIncident(ctx, { title: 'Incorrect credit card arrears', eventIds: [a.id, b.id] });
    expect(inc.openedOn).toBe('2026-09-12');
    expect(inc.eventCount).toBe(2);
    await addEventsToIncident(ctx, inc.id, [c.id]);
    const timeline = await listEvents(ctx, { incidentIds: [inc.id] }, { order: 'asc' });
    expect(timeline.items.map((e) => e.title)).toEqual(['Payment made', 'Payment shown as missing', 'Arrears letter']);
    await removeEventFromIncident(ctx, inc.id, c.id);
    expect((await getIncident(ctx, inc.id)).eventCount).toBe(2);
    const closed = await updateIncident(ctx, inc.id, { status: 'resolved', outcomeNotes: 'Refunded' });
    expect(closed.closedOn).not.toBeNull();
    // An Event can belong to several Incidents.
    const second = await createIncident(ctx, { title: 'Complaint', eventIds: [a.id] });
    expect((await getEvent(ctx, a.id)).incidents.map((i) => i.id).sort()).toEqual([inc.id, second.id].sort());
  });

  it('filters the timeline by date, type, risk and attachments', async () => {
    const ctx = await ownerCtx((await makeUser()).id);
    await event(ctx, { title: 'Jan', occurredAt: '2026-01-05', riskLevel: 'high' });
    await event(ctx, { title: 'Feb', occurredAt: '2026-02-05', typeId: 'email_in' });
    await event(ctx, { title: 'Mar', occurredAt: '2026-03-05' });
    expect((await listEvents(ctx, { from: '2026-02-01', to: '2026-02-28' })).items.map((e) => e.title)).toEqual(['Feb']);
    expect((await listEvents(ctx, { riskLevels: ['high'] })).items.map((e) => e.title)).toEqual(['Jan']);
    const types = (await db().execute(sql`SELECT id FROM event_types WHERE key = 'email_in'`)).rows as { id: string }[];
    expect((await listEvents(ctx, { typeIds: [types[0]!.id] })).items.map((e) => e.title)).toEqual(['Feb']);
    expect((await listEvents(ctx, { hasAttachments: true })).items).toEqual([]);
    const page1 = await listEvents(ctx, {}, { limit: 2 });
    expect(page1.items.map((e) => e.title)).toEqual(['Mar', 'Feb']);
    const page2 = await listEvents(ctx, {}, { limit: 2, cursor: page1.nextCursor });
    expect(page2.items.map((e) => e.title)).toEqual(['Jan']);
    expect(page2.nextCursor).toBeNull();
  });
});

describe('Actors: archiving, deletion and merging', () => {
  it('refuses to delete an Actor that Events refer to, but allows archiving', async () => {
    const ctx = await ownerCtx((await makeUser()).id);
    const a = await actor(ctx, 'Landlord');
    await event(ctx, { actors: [{ actorId: a.id }] });
    await expect(deleteActor(ctx, a.id)).rejects.toMatchObject({ status: 409 });
    const archived = await setActorArchived(ctx, a.id, true);
    expect(archived.archivedAt).not.toBeNull();
    const unused = await actor(ctx, 'Typo actor');
    await deleteActor(ctx, unused.id);
    await expect(getActor(ctx, unused.id)).rejects.toMatchObject({ status: 404 });
  });

  it('merges duplicates, keeping Events, aliases and audit history', async () => {
    const ctx = await ownerCtx((await makeUser()).id);
    const hmrc = await actor(ctx, 'HMRC');
    const dotted = await actor(ctx, 'H.M.R.C.');
    const long = await actor(ctx, 'HM Revenue & Customs');
    const e1 = await event(ctx, { title: 'Tax letter', actors: [{ actorId: dotted.id }] });
    const e2 = await event(ctx, { title: 'Tax call', actors: [{ actorId: long.id }, { actorId: hmrc.id }] });
    const preview = await previewMerge(ctx, hmrc.id, [dotted.id, long.id]);
    expect(preview.sources.map((s) => s.eventCount)).toEqual([1, 1]);
    const merged = await mergeActors(ctx, hmrc.id, [dotted.id, long.id]);
    expect(merged.aliases).toEqual(expect.arrayContaining(['H.M.R.C.', 'HM Revenue & Customs']));
    expect(merged.stats.eventCount).toBe(2);
    expect(merged.mergedFrom.map((m) => m.name).sort()).toEqual(['H.M.R.C.', 'HM Revenue & Customs']);
    const ev2 = await getEvent(ctx, e2.id);
    expect(ev2.actors).toHaveLength(1); // duplicates collapse
    expect((await getEvent(ctx, e1.id)).actors.map((a) => (a as { name: string }).name)).toEqual(['HMRC']);
    const old = await getActor(ctx, dotted.id);
    expect(old.mergedIntoId).toBe(hmrc.id);
    // Searching an old name finds the merged Actor through its aliases.
    expect((await search(ctx, 'Revenue Customs')).actors.map((a) => a.id)).toContain(hmrc.id);
    const audit = await db().execute(sql`SELECT metadata FROM audit_entries WHERE action = 'actor.merged' AND target_id = ${hmrc.id}`);
    expect(audit.rows).toHaveLength(1);
  });
});
