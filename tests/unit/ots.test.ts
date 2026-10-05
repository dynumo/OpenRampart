import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildMerkleBatch,
  parseOtsFile,
  serializeOtsFile,
  Timestamp,
  upgradeTimestamp,
  verifyTimestamp,
  type BlockLookup,
} from '../../src/server/integrity/ots.js';

const fixture = (name: string) => readFileSync(path.join(__dirname, '../fixtures/ots', name));
const block = JSON.parse(fixture('block-358391.json').toString()) as {
  height: number;
  merkle_root: string;
  timestamp: number;
};
const lookup: BlockLookup = async (height) => {
  if (height !== block.height) throw new Error('unknown block');
  return { height, merkleRootHex: block.merkle_root, time: block.timestamp };
};

describe('OpenTimestamps proof format', () => {
  for (const name of ['hello-world.txt', 'incomplete.txt', 'two-calendars.txt', 'merkle1.txt']) {
    it(`parses and re-serialises ${name}.ots byte-for-byte`, () => {
      const raw = fixture(`${name}.ots`);
      const parsed = parseOtsFile(raw);
      const digest = createHash('sha256').update(fixture(name)).digest();
      expect(parsed.digest.equals(digest)).toBe(true);
      expect(serializeOtsFile(parsed).equals(raw)).toBe(true);
    });
  }

  it('verifies the reference Bitcoin attestation for hello-world.txt', async () => {
    const parsed = parseOtsFile(fixture('hello-world.txt.ots'));
    const result = await verifyTimestamp(parsed.timestamp, lookup);
    expect(result.verified).toBe(true);
    expect(result.height).toBe(358391);
    expect(result.attestedTime?.toISOString()).toBe('2015-05-28T15:41:18.000Z');
  });

  it('reports an incomplete proof as pending, not verified', async () => {
    const parsed = parseOtsFile(fixture('incomplete.txt.ots'));
    const result = await verifyTimestamp(parsed.timestamp, lookup);
    expect(result.verified).toBe(false);
    expect(result.pendingCalendars.length).toBeGreaterThan(0);
  });

  it('rejects a proof whose digest was altered', async () => {
    const raw = Buffer.from(fixture('hello-world.txt.ots'));
    raw[35] = raw[35]! ^ 0xff; // flip a byte of the document digest
    const parsed = parseOtsFile(raw);
    const result = await verifyTimestamp(parsed.timestamp, lookup);
    expect(result.verified).toBe(false);
  });

  it('rejects files that are not proofs', () => {
    expect(() => parseOtsFile(Buffer.from('not a proof'))).toThrow();
  });

  it('builds a Merkle batch where every leaf reaches the same root', () => {
    const digests = Array.from({ length: 5 }, (_, i) =>
      createHash('sha256').update(`doc ${i}`).digest(),
    );
    const { leaves, root } = buildMerkleBatch(digests);
    root.addAttestation({ kind: 'pending', uri: 'https://calendar.example' });
    for (const leaf of leaves) {
      const atts = leaf.allAttestations();
      expect(atts).toHaveLength(1);
      expect(atts[0]!.msg.equals(root.msg)).toBe(true);
      // Round-trip each leaf proof through the file format.
      const file = serializeOtsFile({ hashOp: 'sha256', digest: leaf.msg, timestamp: leaf });
      const back = parseOtsFile(file);
      expect(back.timestamp.allAttestations()[0]!.msg.equals(root.msg)).toBe(true);
    }
  });

  it('upgrades a pending attestation from an allow-listed calendar only', async () => {
    const digest = createHash('sha256').update('x').digest();
    const t = new Timestamp(digest);
    const commitment = t.add({ kind: 'sha256' });
    commitment.addAttestation({ kind: 'pending', uri: 'https://good.example' });
    const completion = new Timestamp(commitment.msg);
    completion.addAttestation({ kind: 'bitcoin', height: 123 });
    let calls = 0;
    const fetchImpl = (async (url: string) => {
      calls++;
      expect(url).toBe(`https://good.example/timestamp/${commitment.msg.toString('hex')}`);
      return new Response(new Uint8Array(completion.toBytes()), { status: 200 });
    }) as unknown as typeof fetch;
    expect(await upgradeTimestamp(t, ['https://other.example'], { fetchImpl })).toBe(false);
    expect(calls).toBe(0);
    expect(await upgradeTimestamp(t, ['https://good.example'], { fetchImpl })).toBe(true);
    expect(t.allAttestations().some((a) => a.attestation.kind === 'bitcoin')).toBe(true);
  });
});
