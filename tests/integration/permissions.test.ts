import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { getActor, listActors, mergeActors, suggestActors } from '../../src/server/domain/actors.js';
import { getAttachment, getAttachmentText, storeAttachment } from '../../src/server/domain/attachments.js';
import type { AccessContext } from '../../src/server/domain/context.js';
import { createEvent, getEvent, linkEvents, listEvents, updateEvent, deleteEvent } from '../../src/server/domain/events.js';
import { collectExport } from '../../src/server/domain/export.js';
import { endHelper, revokeGrant } from '../../src/server/domain/helpers.js';
import { addEventsToIncident, getIncident, listIncidents } from '../../src/server/domain/incidents.js';
import { search, searchDocuments, suggest } from '../../src/server/domain/search.js';
import { resolveContext } from '../../src/server/domain/access.js';
import { db } from '../../src/server/db/client.js';
import { attachments } from '../../src/server/db/schema.js';
import { eq } from 'drizzle-orm';
import { actor, event, grantHelper, helperCtx, incident, makeUser, oauthCtx, ownerCtx } from './helpers.js';

async function textAttachment(ctx: AccessContext, eventId: string, filename: string, text: string) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'or-test-'));
  const file = path.join(dir, 'f');
  await writeFile(file, text);
  const a = await storeAttachment(ctx, { eventId }, {
    tmpPath: file,
    originalFilename: filename,
    sizeBytes: Buffer.byteLength(text),
    sha256: createHash('sha256').update(text).digest('hex'),
  });
  // Simulate OCR having completed (the OCR pipeline has its own tests).
  await db().update(attachments).set({ ocrText: text, ocrStatus: 'done' }).where(eq(attachments.id, a.id));
  return a;
}

describe('Helper permissions and leakage prevention', () => {
  let owner: AccessContext;
  let B: string; // Barclays
  let D: string; // DebtCo
  let H: string; // HMRC
  let e1: string, e2: string, e3: string, e4: string;
  let I1: string, I2: string;
  let attOnE3: string;

  beforeAll(async () => {
    const o = await makeUser();
    owner = await ownerCtx(o.id);
    B = (await actor(owner, 'Barclays')).id;
    D = (await createActorWithDetails(owner)).id;
    H = (await actor(owner, 'HMRC')).id;
    e1 = (await event(owner, { title: 'Old Barclays statement', occurredAt: '2025-06-01', actors: [{ actorId: B }] })).id;
    e2 = (await event(owner, { title: 'Collector letter about Barclays debt', occurredAt: '2026-02-10', description: 'Mentions zebrafinch reference', actors: [{ actorId: B }, { actorId: D, role: 'sender' }] })).id;
    e3 = (await event(owner, { title: 'Phone call', occurredAt: '2026-03-05', actors: [{ actorId: D }] })).id;
    e4 = (await event(owner, { title: 'Tax letter', occurredAt: '2026-04-01', actors: [{ actorId: H }] })).id;
    I1 = (await incident(owner, 'Arrears problem', [e2, e3])).id;
    I2 = (await incident(owner, 'Tax matter', [e4])).id;
    await linkEvents(owner, e2, e3);
    await linkEvents(owner, e2, e1);
    attOnE3 = (await textAttachment(owner, e3, 'debtco-ledger.txt', 'The DebtCo ledger shows quokkaword balance')).id;
  });

  async function createActorWithDetails(ctx: AccessContext) {
    const { createActor } = await import('../../src/server/domain/actors.js');
    return createActor(ctx, { name: 'DebtCo Collections', description: 'Private note about DebtCo', accountReference: 'DC-999', aliases: ['DCC'] });
  }

  describe('Actor scope with a start date, view only, co-Actors redacted (default)', () => {
    let ctx: AccessContext;
    beforeAll(async () => {
      ctx = (await grantHelper(owner, { scopeType: 'actors', actorIds: [B], dateFrom: '2026-01-01' })).ctx;
    });

    it('lists only in-scope Events', async () => {
      const page = await listEvents(ctx, {}, { withTotal: true });
      expect(page.items.map((e) => e.id)).toEqual([e2]);
      expect(page.total).toBe(1);
    });

    it('refuses direct access to out-of-scope Events as not found', async () => {
      for (const id of [e1, e3, e4]) await expect(getEvent(ctx, id)).rejects.toMatchObject({ status: 404 });
    });

    it('redacts co-Actors on a shared Event without revealing their identity', async () => {
      const e = await getEvent(ctx, e2);
      const visible = e.actors.filter((a) => !a.redacted);
      expect(visible.map((a) => (a as { name: string }).name)).toEqual(['Barclays']);
      const hidden = e.actors.filter((a) => a.redacted);
      expect(hidden).toHaveLength(1);
      expect(JSON.stringify(hidden)).not.toContain(D);
      expect(JSON.stringify(e)).not.toContain('DebtCo');
    });

    it('does not open the redacted Actor by direct id', async () => {
      await expect(getActor(ctx, D)).rejects.toMatchObject({ status: 404 });
    });

    it('computes Actor statistics only over visible Events', async () => {
      const b = await getActor(ctx, B);
      expect(b.stats.eventCount).toBe(1);
      expect(b.stats.openIncidentCount).toBe(0);
    });

    it('lists and suggests only visible Actors', async () => {
      const list = await listActors(ctx);
      expect(list.items.map((a) => a.name)).toEqual(['Barclays']);
      expect(list.total).toBe(1);
      expect(await suggestActors(ctx, 'Deb')).toEqual([]);
    });

    it('cannot filter by a hidden Actor or Incident to probe for Events', async () => {
      expect((await listEvents(ctx, { actorIds: [D] }, { withTotal: true })).total).toBe(0);
      expect((await listEvents(ctx, { incidentIds: [I1] }, { withTotal: true })).total).toBe(0);
    });

    it('hides Incidents and related Events outside scope', async () => {
      const e = await getEvent(ctx, e2);
      expect(e.incidents).toEqual([]);
      expect(e.related).toEqual([]);
      expect((await listIncidents(ctx)).total).toBe(0);
      await expect(getIncident(ctx, I1)).rejects.toMatchObject({ status: 404 });
    });

    it('search, counts and autocomplete do not leak hidden names or content', async () => {
      const r = await search(ctx, 'DebtCo', { correct: false });
      expect(r.totals).toEqual({ events: 0, actors: 0, incidents: 0, documents: 0 });
      // Spelling correction may only draw on visible words, never the hidden name.
      const corrected = await search(ctx, 'DebtCo');
      expect(corrected.correctedQuery ?? '').not.toMatch(/debtco/i);
      expect(corrected.events.every((e) => e.id === e2)).toBe(true);
      expect(JSON.stringify({ ...corrected, query: '' })).not.toContain('DebtCo');
      const alias = await search(ctx, 'DCC', { correct: false });
      expect(alias.totals.actors + alias.totals.events).toBe(0);
      const doc = await search(ctx, 'quokkaword', { correct: false });
      expect(doc.totals.documents + doc.totals.events).toBe(0);
      const s = await suggest(ctx, 'Debt');
      expect(s.actors).toEqual([]);
      expect(s.incidents).toEqual([]);
      const own = await search(ctx, 'zebrafinch');
      expect(own.events.map((e) => e.id)).toEqual([e2]);
      expect(JSON.stringify(own)).not.toContain('DebtCo');
    });

    it('does not expose attachments of hidden Events', async () => {
      await expect(getAttachment(ctx, attOnE3)).rejects.toMatchObject({ status: 404 });
      await expect(getAttachmentText(ctx, attOnE3)).rejects.toMatchObject({ status: 404 });
      expect((await searchDocuments(ctx, 'debtco')).total).toBe(0);
    });

    it('cannot add, edit, delete or export', async () => {
      await expect(createEvent(ctx, { typeId: 'note', occurredAt: '2026-05-01', actors: [{ actorId: B }] })).rejects.toMatchObject({ status: 403 });
      await expect(updateEvent(ctx, e2, { title: 'changed' })).rejects.toMatchObject({ status: 403 });
      await expect(deleteEvent(ctx, e2)).rejects.toMatchObject({ status: 403 });
      await expect(collectExport(ctx)).rejects.toMatchObject({ status: 403 });
    });
  });

  describe('Actor scope with co-Actor names shown, Add and Export', () => {
    let ctx: AccessContext;
    let helperId: string;
    beforeAll(async () => {
      const g = await grantHelper(owner, { scopeType: 'actors', actorIds: [B], dateFrom: '2026-01-01', canAdd: true, canExport: true, coActorVisibility: 'name' });
      ctx = g.ctx;
      helperId = g.helper.id;
    });

    it('shows the co-Actor name but not its details or wider history', async () => {
      const e = await getEvent(ctx, e2);
      const d = e.actors.find((a) => !a.redacted && a.id === D) as { fullAccess: boolean } | undefined;
      expect(d).toBeTruthy();
      expect(d!.fullAccess).toBe(false);
      const dActor = await getActor(ctx, D);
      expect(dActor.description).toBe('');
      expect(dActor.aliases).toEqual([]);
      expect(dActor.accountReference).toBeNull();
      expect(dActor.stats.eventCount).toBe(1); // e2 only, never e3
      expect((await listEvents(ctx, { actorIds: [D] }, { withTotal: true })).items.map((x) => x.id)).toEqual([e2]);
      // Alias of a name-only Actor must not be searchable.
      expect((await search(ctx, 'DCC', { correct: false })).totals.actors).toBe(0);
    });

    it('can add Events inside its scope, attributed to the Helper', async () => {
      const created = await createEvent(ctx, { typeId: 'phone_call', title: 'Helper call', occurredAt: '2026-05-01', actors: [{ actorId: B }] });
      expect(created.createdBy?.id).toBe(helperId);
      expect(created.permissions.canEdit).toBe(true);
      const updated = await updateEvent(ctx, created.id, { title: 'Helper call (corrected)' });
      expect(updated.revision).toBe(2);
    });

    it('cannot add Events outside its dates or Actors', async () => {
      await expect(createEvent(ctx, { typeId: 'note', occurredAt: '2025-01-01', actors: [{ actorId: B }] })).rejects.toMatchObject({ status: 403 });
      await expect(createEvent(ctx, { typeId: 'note', occurredAt: '2026-05-01', newActors: [{ name: 'Someone new' }] })).rejects.toMatchObject({ status: 403 });
      // A name-only Actor cannot be linked.
      await expect(createEvent(ctx, { typeId: 'note', occurredAt: '2026-05-01', actors: [{ actorId: B }, { actorId: D }] })).rejects.toMatchObject({ status: 400 });
      await expect(createEvent(ctx, { typeId: 'note', occurredAt: '2026-05-01', actors: [{ actorId: H }] })).rejects.toMatchObject({ status: 400 });
    });

    it("cannot edit or delete the owner's Events", async () => {
      await expect(updateEvent(ctx, e2, { description: 'tampered' })).rejects.toMatchObject({ status: 403 });
      await expect(deleteEvent(ctx, e2)).rejects.toMatchObject({ status: 403 });
    });

    it('exports only what the export-capable grant covers', async () => {
      const data = await collectExport(ctx);
      const ids = (data.events as { id: string }[]).map((e) => e.id);
      expect(ids).toContain(e2);
      expect(ids).not.toContain(e1);
      expect(ids).not.toContain(e3);
      expect(ids).not.toContain(e4);
      expect(JSON.stringify(data)).not.toContain('Private note about DebtCo');
      expect(JSON.stringify(data)).not.toContain('quokkaword');
      expect(data.revisions).toEqual([]);
    });
  });

  describe('Incident scope', () => {
    let ctx: AccessContext;
    beforeAll(async () => {
      ctx = (await grantHelper(owner, { scopeType: 'incidents', incidentIds: [I1] })).ctx;
    });

    it("sees exactly the Incident's Events", async () => {
      const ids = (await listEvents(ctx, {})).items.map((e) => e.id).sort();
      expect(ids).toEqual([e2, e3].sort());
      expect((await listIncidents(ctx)).items.map((i) => i.id)).toEqual([I1]);
      await expect(getIncident(ctx, I2)).rejects.toMatchObject({ status: 404 });
      const inc = await getIncident(ctx, I1);
      expect(inc.eventCount).toBe(2);
    });

    it('sees attachments on those Events, and their text', async () => {
      expect((await getAttachment(ctx, attOnE3)).originalFilename).toBe('debtco-ledger.txt');
      expect((await getAttachmentText(ctx, attOnE3)).text).toContain('quokkaword');
    });

    it('does not see Events added to other Incidents', async () => {
      await expect(getEvent(ctx, e4)).rejects.toMatchObject({ status: 404 });
      await expect(getEvent(ctx, e1)).rejects.toMatchObject({ status: 404 });
    });

    it('sees only related Events that are themselves visible', async () => {
      const e = await getEvent(ctx, e2);
      expect(e.related.map((r) => r.id)).toEqual([e3]);
    });
  });

  describe('All records within a date range', () => {
    let ctx: AccessContext;
    beforeAll(async () => {
      ctx = (await grantHelper(owner, { scopeType: 'all', dateFrom: '2026-03-01', dateTo: '2026-03-31' })).ctx;
    });

    it('limits Events, Incident timelines and Actor statistics to the range', async () => {
      expect((await listEvents(ctx, {})).items.map((e) => e.id)).toEqual([e3]);
      const inc = await getIncident(ctx, I1);
      expect(inc.eventCount).toBe(1);
      await expect(getIncident(ctx, I2)).rejects.toMatchObject({ status: 404 });
      const d = await getActor(ctx, D);
      expect(d.stats.eventCount).toBe(1);
      await expect(getActor(ctx, H)).rejects.toMatchObject({ status: 404 });
    });
  });

  describe('Actor merges preserve Helper access exactly', () => {
    it('neither widens nor narrows access unless explicitly extended', async () => {
      const B2 = (await actor(owner, 'Barclays Bank UK')).id;
      const e5 = (await event(owner, { title: 'Duplicate-actor event', occurredAt: '2026-06-01', actors: [{ actorId: B2 }] })).id;
      const { ctx } = await grantHelper(owner, { scopeType: 'actors', actorIds: [B], dateFrom: '2026-01-01' });
      const before = (await listEvents(ctx, {})).items.map((e) => e.id).sort();
      await mergeActors(owner, B, [B2]);
      const after = (await listEvents(ctx, {})).items.map((e) => e.id).sort();
      expect(after).toEqual(before);
      expect(after).not.toContain(e5);
      // The merged Event now shows the target Actor for the owner.
      const merged = await getEvent(owner, e5);
      expect(merged.actors.map((a) => (a as { id: string }).id)).toEqual([B]);
      expect(merged.revision).toBe(2);
    });

    it('extends access when the owner chooses to', async () => {
      const B3 = (await actor(owner, 'Barclaycard')).id;
      const e6 = (await event(owner, { title: 'Barclaycard event', occurredAt: '2026-06-02', actors: [{ actorId: B3 }] })).id;
      const { ctx } = await grantHelper(owner, { scopeType: 'actors', actorIds: [B], dateFrom: '2026-01-01' });
      await mergeActors(owner, B, [B3], { extendHelperAccess: true });
      const refreshed = await resolveContext({ userId: ctx.userId, ownerId: ctx.ownerId, via: 'web' });
      expect((await listEvents(refreshed, {})).items.map((e) => e.id)).toContain(e6);
    });
  });

  describe('Revocation', () => {
    it('removes access immediately when a grant is revoked or the Helper is ended', async () => {
      const { ctx, helper } = await grantHelper(owner, { scopeType: 'all' });
      expect((await listEvents(ctx, {})).items.length).toBeGreaterThan(0);
      await revokeGrant(owner, ctx.grants[0]!.id);
      await expect(helperCtx(helper.id, owner.ownerId)).rejects.toMatchObject({ status: 404 });
      const second = await grantHelper(owner, { scopeType: 'all' });
      await endHelper(owner, second.ctx.grants[0]!.relationshipId);
      await expect(helperCtx(second.helper.id, owner.ownerId)).rejects.toMatchObject({ status: 404 });
    });

    it('a stranger cannot open someone else’s record', async () => {
      const stranger = await makeUser();
      await expect(helperCtx(stranger.id, owner.ownerId)).rejects.toMatchObject({ status: 404 });
    });
  });

  describe('Helpers adding to Incidents', () => {
    it('an Incident Helper with Add can only add Events inside the Incident', async () => {
      const { ctx } = await grantHelper(owner, { scopeType: 'incidents', incidentIds: [I1], canAdd: true });
      const created = await createEvent(ctx, { typeId: 'note', occurredAt: '2026-03-10', title: 'Added by incident helper', incidentIds: [I1] });
      expect(created.incidents.map((i) => i.id)).toEqual([I1]);
      await expect(createEvent(ctx, { typeId: 'note', occurredAt: '2026-03-10', title: 'Loose' })).rejects.toMatchObject({ status: 403 });
      await expect(createEvent(ctx, { typeId: 'note', occurredAt: '2026-03-10', incidentIds: [I2] })).rejects.toMatchObject({ status: 400 });
      await expect(addEventsToIncident(ctx, I1, [e4])).rejects.toMatchObject({ status: 404 });
    });
  });

  describe('OAuth scopes on top of record access', () => {
    it('events:read alone does not reveal attachments, documents or OCR matches', async () => {
      const ctx = oauthCtx(owner, ['events:read', 'search:read']);
      const e = await getEvent(ctx, e3);
      expect(e.attachments).toEqual([]);
      const r = await search(ctx, 'quokkaword');
      expect(r.totals.events).toBe(0);
      expect(r.totals.documents).toBe(0);
      await expect(getAttachment(ctx, attOnE3)).rejects.toMatchObject({ code: 'insufficient_scope' });
      await expect(getAttachmentText(ctx, attOnE3)).rejects.toMatchObject({ code: 'insufficient_scope' });
    });

    it('attachments:metadata reveals names and hashes but not contents', async () => {
      const ctx = oauthCtx(owner, ['events:read', 'search:read', 'attachments:metadata']);
      const e = await getEvent(ctx, e3);
      expect(e.attachments.map((a) => a.originalFilename)).toEqual(['debtco-ledger.txt']);
      expect((await searchDocuments(ctx, 'quokkaword')).total).toBe(0);
      const byName = await searchDocuments(ctx, 'ledger');
      expect(byName.total).toBe(1);
      expect(byName.items[0]!.snippet).toBeNull();
      await expect(getAttachmentText(ctx, attOnE3)).rejects.toMatchObject({ code: 'insufficient_scope' });
    });

    it('attachments:read allows contents', async () => {
      const ctx = oauthCtx(owner, ['events:read', 'search:read', 'attachments:read']);
      expect((await getAttachmentText(ctx, attOnE3)).text).toContain('quokkaword');
      const docs = await searchDocuments(ctx, 'quokkaword');
      expect(docs.items[0]!.snippet).toContain('quokkaword');
    });

    it('read scopes cannot write and nothing is searchable without search:read', async () => {
      const ctx = oauthCtx(owner, ['events:read']);
      await expect(createEvent(ctx, { typeId: 'note', occurredAt: '2026-01-01' })).rejects.toMatchObject({ code: 'insufficient_scope' });
      await expect(search(ctx, 'Barclays')).rejects.toMatchObject({ code: 'insufficient_scope' });
      await expect(collectExport(ctx)).rejects.toMatchObject({ code: 'insufficient_scope' });
    });

    it('a Helper connected through OAuth is still limited to the Helper scope', async () => {
      const { ctx } = await grantHelper(owner, { scopeType: 'actors', actorIds: [H] });
      const oauth = oauthCtx(ctx, ['events:read', 'search:read', 'actors:read']);
      expect((await listEvents(oauth, {})).items.map((e) => e.id)).toEqual([e4]);
      expect((await search(oauth, 'Barclays')).totals.events).toBe(0);
    });
  });
});
