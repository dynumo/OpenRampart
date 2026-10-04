import { createServer, type IncomingMessage } from 'node:http';
import { createHash } from 'node:crypto';
import nodemailer from 'nodemailer';
import yauzl from 'yauzl';
import { afterAll, describe, expect, it } from 'vitest';
import { ElasticEmailProvider } from '../../src/server/mail/elasticEmail.js';
import { setMailProvider } from '../../src/server/mail/index.js';
import { SmtpProvider } from '../../src/server/mail/smtp.js';
import { inviteHelper } from '../../src/server/domain/helpers.js';
import { Timestamp, parseOtsFile } from '../../src/server/integrity/ots.js';
import { OpenTimestampsProvider, setTimestampProvider, submitQueuedTimestamps, upgradePendingTimestamps } from '../../src/server/integrity/timestamping.js';
import { db } from '../../src/server/db/client.js';
import { timestampProofs } from '../../src/server/db/schema.js';
import { sql } from 'drizzle-orm';
import { ownerCtx, registerBrowser } from './helpers.js';

function unzip(buf: Buffer): Promise<Map<string, Buffer>> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buf, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return reject(err);
      const files = new Map<string, Buffer>();
      zip.on('entry', (entry: yauzl.Entry) => {
        zip.openReadStream(entry, (e2, stream) => {
          if (e2 || !stream) return reject(e2);
          const chunks: Buffer[] = [];
          stream.on('data', (c: Buffer) => chunks.push(c));
          stream.on('end', () => {
            files.set(entry.fileName, Buffer.concat(chunks));
            zip.readEntry();
          });
        });
      });
      zip.on('end', () => resolve(files));
      zip.readEntry();
    });
  });
}

const binary = (res: import('superagent').Response, cb: (err: Error | null, body: Buffer) => void) => {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};

describe('Export', () => {
  it('exports JSON, original files, OCR text, hashes and a README', async () => {
    const b = await registerBrowser();
    const actor = await b.agent.post('/api/actors').set('X-CSRF-Token', b.csrf).send({ name: 'Water company' }).expect(201);
    const ev = await b.agent.post('/api/events').set('X-CSRF-Token', b.csrf).send({ typeId: 'observation', title: 'Mould in bathroom', occurredAt: '2026-02-02', actors: [{ actorId: actor.body.id }] }).expect(201);
    const content = Buffer.from('Photo notes: black mould on ceiling');
    const att = await b.agent.post(`/api/events/${ev.body.id}/attachments`).set('X-CSRF-Token', b.csrf).attach('file', content, '../weird/name?.txt').expect(201);
    await b.agent.post('/api/incidents').set('X-CSRF-Token', b.csrf).send({ title: 'Damp and mould', eventIds: [ev.body.id] }).expect(201);
    const res = await b.agent.get('/api/export').buffer(true).parse(binary).expect(200);
    expect(res.headers['content-type']).toBe('application/zip');
    const files = await unzip(res.body as Buffer);
    for (const name of ['README.md', 'manifest.json', 'events.json', 'actors.json', 'incidents.json', 'relations.json', 'revisions.json', 'attachments.json', 'timeline.md']) {
      expect(files.has(name)).toBe(true);
    }
    for (const name of files.keys()) {
      expect(name.startsWith('/')).toBe(false);
      expect(name.split('/')).not.toContain('..');
    }
    const events = JSON.parse(files.get('events.json')!.toString());
    expect(events[0].title).toBe('Mould in bathroom');
    expect(events[0].actors[0].name).toBe('Water company');
    const atts = JSON.parse(files.get('attachments.json')!.toString());
    expect(atts[0].sha256).toBe(createHash('sha256').update(content).digest('hex'));
    const original = files.get(atts[0].path)!;
    expect(original.equals(content)).toBe(true);
    expect(JSON.parse(files.get('incidents.json')!.toString())[0].eventIds).toEqual([ev.body.id]);
    const revisions = JSON.parse(files.get('revisions.json')!.toString());
    expect(revisions.length).toBeGreaterThanOrEqual(2);
    const manifest = JSON.parse(files.get('manifest.json')!.toString());
    expect(manifest.schema).toBe('openrampart.export.v1');
    void att;
  });
});

describe('Mail providers', () => {
  const received: { headers: IncomingMessage['headers']; body: Record<string, unknown> }[] = [];
  const api = createServer((req, res) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      received.push({ headers: req.headers, body: JSON.parse(data) });
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ TransactionID: 't1', MessageID: 'm1' }));
    });
  });
  afterAll(() => {
    api.close();
    setMailProvider(undefined as never);
  });

  it('sends Helper invitations through the Elastic Email API with the API key header and no tracking', async () => {
    await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
    const port = (api.address() as { port: number }).port;
    setMailProvider(new ElasticEmailProvider({ apiKey: 'test-api-key', baseUrl: `http://127.0.0.1:${port}/v4`, fromAddress: 'noreply@example.test', fromName: 'OpenRampart' }));
    const b = await registerBrowser();
    const ctx = await ownerCtx(b.userId);
    const result = await inviteHelper(ctx, { label: 'Support worker', email: 'helper@example.test', sendEmail: true, grant: { scopeType: 'all', canAdd: false, canExport: false } });
    expect(result.emailed).toBe(true);
    const msg = received.at(-1)!;
    expect(msg.headers['x-elasticemail-apikey']).toBe('test-api-key');
    expect((msg.body.Recipients as { To: string[] }).To).toEqual(['helper@example.test']);
    expect(msg.body.Options).toEqual({ TrackOpens: false, TrackClicks: false });
    const bodies = (msg.body.Content as { Body: { ContentType: string; Content: string }[] }).Body;
    expect(bodies.find((x) => x.ContentType === 'PlainText')!.Content).toContain(result.url);
  });

  it('surfaces Elastic Email API errors', async () => {
    const failing = new ElasticEmailProvider({
      apiKey: 'k',
      baseUrl: 'http://example.invalid',
      fromAddress: 'a@b.c',
      fromName: 'x',
      fetchImpl: (async () => new Response('{"Error":"Invalid API key"}', { status: 401 })) as unknown as typeof fetch,
    });
    await expect(failing.send({ to: 'x@y.z', subject: 's', text: 't', html: '<p>t</p>' })).rejects.toThrow(/401/);
  });

  it('sends through SMTP as an alternative provider', async () => {
    const transport = nodemailer.createTransport({ jsonTransport: true });
    const smtp = new SmtpProvider({ host: 'smtp.example.test', port: 587, secure: false, fromAddress: 'noreply@example.test', fromName: 'OpenRampart' }, transport);
    const result = await smtp.send({ to: 'someone@example.test', subject: 'Hello', text: 'Body', html: '<p>Body</p>' });
    expect(result.id).toBeTruthy();
  });
});

describe('External timestamping (OpenTimestamps)', () => {
  it('batches queued hashes, stores per-item proofs, upgrades them and serves .ots files', async () => {
    const b = await registerBrowser();
    const ev = await b.agent.post('/api/events').set('X-CSRF-Token', b.csrf).send({ typeId: 'note', title: 'Timestamp me', occurredAt: '2026-05-05' }).expect(201);
    const att = await b.agent.post(`/api/events/${ev.body.id}/attachments`).set('X-CSRF-Token', b.csrf).attach('file', Buffer.from('to be stamped'), 'stamp.txt').expect(201);

    const calendarRoots: Buffer[] = [];
    const fakeFetch = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith('/digest')) {
        const digest = Buffer.from(init!.body as Uint8Array);
        calendarRoots.push(digest);
        const t = new Timestamp(digest);
        t.add({ kind: 'append', arg: Buffer.from('cal') }).add({ kind: 'sha256' }).addAttestation({ kind: 'pending', uri: u.replace('/digest', '') });
        return new Response(new Uint8Array(t.toBytes()), { status: 200 });
      }
      const commitment = Buffer.from(u.split('/timestamp/')[1]!, 'hex');
      const done = new Timestamp(commitment);
      done.addAttestation({ kind: 'bitcoin', height: 900000 });
      return new Response(new Uint8Array(done.toBytes()), { status: 200 });
    }) as unknown as typeof fetch;
    let expectedRoot = '';
    const provider = new OpenTimestampsProvider(['https://calendar-a.test', 'https://calendar-b.test'], 2, async (height) => ({ height, merkleRootHex: expectedRoot, time: 1_790_000_000 }), fakeFetch);
    setTimestampProvider(provider);
    const submitted = await submitQueuedTimestamps();
    expect(submitted).toBeGreaterThanOrEqual(2);
    expect(calendarRoots).toHaveLength(2);
    const [row] = await db().select().from(timestampProofs).where(sql`${timestampProofs.subjectId} = ${att.body.id}::uuid`);
    expect(row!.status).toBe('pending');
    const parsed = parseOtsFile(row!.proof!);
    expect(parsed.digest.toString('hex')).toBe(att.body.sha256);
    // The completed attestation's message is what the "block" must contain.
    const node = parsed.timestamp.allAttestations()[0]!;
    expectedRoot = Buffer.from(node.msg).reverse().toString('hex');
    await db().update(timestampProofs).set({ lastCheckedAt: new Date(0) });
    const completedCount = await upgradePendingTimestamps();
    expect(completedCount).toBeGreaterThanOrEqual(2);
    const ots = await b.agent.get(`/api/attachments/${att.body.id}/timestamp.ots`).buffer(true).parse(binary).expect(200);
    expect(parseOtsFile(ots.body as Buffer).digest.toString('hex')).toBe(att.body.sha256);
    const meta = (await b.agent.get(`/api/attachments/${att.body.id}`)).body;
    expect(meta.timestamp.status).toBe('complete');
    expect(meta.timestamp.attestedHeight).toBe(900000);
    expect(meta.timestamp.attestedTime).toBe(new Date(1_790_000_000 * 1000).toISOString());
    setTimestampProvider(undefined as never);
  });
});
