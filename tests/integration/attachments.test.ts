import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../../src/server/db/client.js';
import { attachments } from '../../src/server/db/schema.js';
import { processAttachment } from '../../src/server/jobs/processAttachment.js';
import { getObjectBuffer } from '../../src/server/storage/s3.js';
import { registerBrowser } from './helpers.js';

const fixture = (name: string) => path.join(__dirname, '../fixtures/documents', name);

async function newEvent(b: Awaited<ReturnType<typeof registerBrowser>>) {
  const res = await b.agent.post('/api/events').set('X-CSRF-Token', b.csrf).send({ typeId: 'letter_in', occurredAt: '2026-09-12' }).expect(201);
  return res.body.id as string;
}

describe('Attachments, originals and OCR', () => {
  it('stores the original byte-for-byte with its SHA-256 and runs OCR asynchronously', async () => {
    const b = await registerBrowser();
    const hmrc = await b.agent.post('/api/actors').set('X-CSRF-Token', b.csrf).send({ name: 'HM Revenue and Customs' }).expect(201);
    const eventId = await newEvent(b);
    const bytes = readFileSync(fixture('letter.png'));
    const up = await b.agent.post(`/api/events/${eventId}/attachments`).set('X-CSRF-Token', b.csrf).attach('file', bytes, { filename: 'page-1.png', contentType: 'application/octet-stream' }).expect(201);
    expect(up.body.mimeType).toBe('image/png'); // detected from content, not the declared type
    expect(up.body.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(up.body.ocrStatus).toBe('pending');
    const [row] = await db().select().from(attachments).where(eq(attachments.id, up.body.id));
    expect((await getObjectBuffer(row!.storageKey)).equals(bytes)).toBe(true);

    await processAttachment(up.body.id);
    const text = await b.agent.get(`/api/attachments/${up.body.id}/text`).expect(200);
    expect(text.body.status).toBe('done');
    expect(text.body.text).toContain('penguinword');
    expect(text.body.engine).toMatch(/tesseract/);
    expect(text.body.suggestions.dates[0].value).toBe('2026-09-12');
    expect(text.body.suggestions.amounts[0]).toMatchObject({ value: '1234.56', currency: 'GBP' });
    expect(text.body.suggestions.actors[0]).toMatchObject({ actorId: hmrc.body.id });
    // The original is untouched by processing; derivatives are separate objects.
    expect((await getObjectBuffer(row!.storageKey)).equals(bytes)).toBe(true);
    const thumb = await b.agent.get(`/api/attachments/${up.body.id}/thumbnail`).expect(200);
    expect(thumb.headers['content-type']).toBe('image/webp');
    const original = await b.agent.get(`/api/attachments/${up.body.id}/original`).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    }).expect(200);
    expect((original.body as Buffer).equals(bytes)).toBe(true);
    expect(original.headers['content-security-policy']).toContain('sandbox');
    expect(original.headers['x-content-type-options']).toBe('nosniff');

    // OCR text is searchable, and corrections never touch the original.
    const found = await b.agent.get('/api/search?q=penguinword').expect(200);
    expect(found.body.documents[0].attachmentId).toBe(up.body.id);
    expect(found.body.events.map((e: { id: string }) => e.id)).toContain(eventId);
    await b.agent.put(`/api/attachments/${up.body.id}/text`).set('X-CSRF-Token', b.csrf).send({ text: 'Corrected text with ostrichword' }).expect(200);
    expect((await b.agent.get('/api/search?q=ostrichword').expect(200)).body.totals.documents).toBe(1);
    const t2 = await b.agent.get(`/api/attachments/${up.body.id}/text`).expect(200);
    expect(t2.body.corrected).toBe(true);
    expect(t2.body.originalText).toContain('penguinword');
    expect((await getObjectBuffer(row!.storageKey)).equals(bytes)).toBe(true);

    const verify = await b.agent.post(`/api/attachments/${up.body.id}/verify`).set('X-CSRF-Token', b.csrf).expect(200);
    expect(verify.body.integrity.ok).toBe(true);
    // A new revision captured the attachment's hash.
    const revs = await b.agent.get(`/api/events/${eventId}/revisions`).expect(200);
    expect(JSON.parse(revs.body.items[0].canonical).attachments[0].sha256).toBe(up.body.sha256);
  });

  it('extracts the text layer of text PDFs and OCRs scanned PDFs', async () => {
    const b = await registerBrowser();
    const eventId = await newEvent(b);
    const textPdf = await b.agent.post(`/api/events/${eventId}/attachments`).set('X-CSRF-Token', b.csrf).attach('file', fixture('text-letter.pdf')).expect(201);
    expect(textPdf.body.mimeType).toBe('application/pdf');
    await processAttachment(textPdf.body.id);
    const t1 = (await b.agent.get(`/api/attachments/${textPdf.body.id}/text`)).body;
    expect(t1.text).toContain('falconword');
    expect(t1.engine).toMatch(/pdftotext/);
    const meta = (await b.agent.get(`/api/attachments/${textPdf.body.id}`)).body;
    expect(meta.pageCount).toBe(1);
    expect(meta.hasThumbnail).toBe(true);

    const scanned = await b.agent.post(`/api/events/${eventId}/attachments`).set('X-CSRF-Token', b.csrf).attach('file', fixture('scanned-letter.pdf')).expect(201);
    await processAttachment(scanned.body.id);
    const t2 = (await b.agent.get(`/api/attachments/${scanned.body.id}/text`)).body;
    expect(t2.status).toBe('done');
    expect(t2.engine).toMatch(/ocrmypdf/);
    expect(t2.text).toContain('penguinword');
  }, 120_000);

  it('accepts multi-page letters as several attachments in order', async () => {
    const b = await registerBrowser();
    const eventId = await newEvent(b);
    for (const name of ['page 1.png', 'page 2.png', 'page 3.png']) {
      await b.agent.post(`/api/events/${eventId}/attachments`).set('X-CSRF-Token', b.csrf).attach('file', readFileSync(fixture('letter.png')), name).expect(201);
    }
    const e = (await b.agent.get(`/api/events/${eventId}`)).body;
    expect(e.attachments.map((a: { originalFilename: string }) => a.originalFilename)).toEqual(['page 1.png', 'page 2.png', 'page 3.png']);
    expect(e.attachmentCount).toBe(3);
  });

  it('rejects active content and disguised files', async () => {
    const b = await registerBrowser();
    const eventId = await newEvent(b);
    const html = await b.agent.post(`/api/events/${eventId}/attachments`).set('X-CSRF-Token', b.csrf).attach('file', Buffer.from('<!doctype html><script>alert(1)</script>'), 'letter.txt');
    expect(html.status).toBe(400);
    const svg = await b.agent.post(`/api/events/${eventId}/attachments`).set('X-CSRF-Token', b.csrf).attach('file', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), 'image.svg');
    expect(svg.status).toBe(400);
    const exe = await b.agent.post(`/api/events/${eventId}/attachments`).set('X-CSRF-Token', b.csrf).attach('file', Buffer.from('MZ\x90\x00\x03\x00\x00\x00\x04\x00\x00\x00\xff\xff'), 'photo.jpg');
    expect(exe.status).toBe(400);
    const traversal = await b.agent.post(`/api/events/${eventId}/attachments`).set('X-CSRF-Token', b.csrf).attach('file', Buffer.from('plain notes'), '../../etc/passwd.txt').expect(201);
    expect(traversal.body.originalFilename).toBe('passwd.txt');
  });

  it("does not serve another user's attachment by id", async () => {
    const owner = await registerBrowser();
    const other = await registerBrowser();
    const eventId = await newEvent(owner);
    const up = await owner.agent.post(`/api/events/${eventId}/attachments`).set('X-CSRF-Token', owner.csrf).attach('file', Buffer.from('private'), 'private.txt').expect(201);
    await other.agent.get(`/api/attachments/${up.body.id}`).expect(404);
    await other.agent.get(`/api/attachments/${up.body.id}/original`).expect(404);
    await other.agent.get(`/api/events/${eventId}`).expect(404);
    await other.agent.post(`/api/events/${eventId}/attachments`).set('X-CSRF-Token', other.csrf).attach('file', Buffer.from('x'), 'x.txt').expect(404);
    // Requesting the owner's record explicitly is refused too.
    await other.agent.get('/api/events').set('X-OpenRampart-Record', owner.userId).expect(404);
  });
});
