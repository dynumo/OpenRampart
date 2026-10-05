import { createHash, randomBytes } from 'node:crypto';

/**
 * OpenTimestamps proof format and calendar protocol.
 *
 * This module implements the documented `.ots` serialisation used by the
 * reference clients (python-opentimestamps / opentimestamps-client): a tree of
 * operations (append, prepend, SHA-256, …) leading from a document digest to
 * attestations (a pending calendar promise, or a Bitcoin block header). It uses
 * only Node's standard hash functions. It is tested against the reference
 * example proofs in tests/fixtures/ots.
 *
 * Only digests (hashes) are ever sent to calendar servers — never documents.
 */

export const HEADER_MAGIC = Buffer.from(
  '004f70656e54696d657374616d7073000050726f6f6600bf89e2e884e89294',
  'hex',
);
export const MAJOR_VERSION = 1;

const TAG_PENDING = Buffer.from('83dfe30d2ef90c8e', 'hex');
const TAG_BITCOIN = Buffer.from('0588960d73d71901', 'hex');

export class OtsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OtsError';
  }
}

// ---------------------------------------------------------------------------
// Byte streams
// ---------------------------------------------------------------------------

class Reader {
  private pos = 0;
  constructor(private readonly buf: Buffer) {}
  bytes(n: number): Buffer {
    if (this.pos + n > this.buf.length) throw new OtsError('Unexpected end of proof data');
    const out = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
  byte(): number {
    return this.bytes(1)[0]!;
  }
  varuint(): number {
    let value = 0;
    let shift = 0;
    for (;;) {
      const b = this.byte();
      value += (b & 0x7f) * 2 ** shift;
      if (!(b & 0x80)) break;
      shift += 7;
      if (shift > 49) throw new OtsError('varuint too large');
    }
    return value;
  }
  varbytes(max = 8192): Buffer {
    const len = this.varuint();
    if (len > max) throw new OtsError('varbytes too long');
    return this.bytes(len);
  }
  atEnd(): boolean {
    return this.pos >= this.buf.length;
  }
}

class Writer {
  private parts: Buffer[] = [];
  bytes(b: Buffer | Uint8Array): void {
    this.parts.push(Buffer.from(b));
  }
  byte(n: number): void {
    this.parts.push(Buffer.from([n]));
  }
  varuint(n: number): void {
    if (n === 0) {
      this.byte(0);
      return;
    }
    while (n > 0) {
      let b = n & 0x7f;
      n = Math.floor(n / 128);
      if (n > 0) b |= 0x80;
      this.byte(b);
    }
  }
  varbytes(b: Buffer): void {
    this.varuint(b.length);
    this.bytes(b);
  }
  toBuffer(): Buffer {
    return Buffer.concat(this.parts);
  }
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

export type Op =
  | { kind: 'sha256' }
  | { kind: 'sha1' }
  | { kind: 'ripemd160' }
  | { kind: 'keccak256' }
  | { kind: 'reverse' }
  | { kind: 'hexlify' }
  | { kind: 'append'; arg: Buffer }
  | { kind: 'prepend'; arg: Buffer };

const OP_TAGS: Record<Op['kind'], number> = {
  sha1: 0x02,
  ripemd160: 0x03,
  sha256: 0x08,
  keccak256: 0x67,
  append: 0xf0,
  prepend: 0xf1,
  reverse: 0xf2,
  hexlify: 0xf3,
};

function opFromTag(tag: number, r: Reader): Op {
  switch (tag) {
    case 0x02:
      return { kind: 'sha1' };
    case 0x03:
      return { kind: 'ripemd160' };
    case 0x08:
      return { kind: 'sha256' };
    case 0x67:
      return { kind: 'keccak256' };
    case 0xf0:
      return { kind: 'append', arg: Buffer.from(r.varbytes(4096)) };
    case 0xf1:
      return { kind: 'prepend', arg: Buffer.from(r.varbytes(4096)) };
    case 0xf2:
      return { kind: 'reverse' };
    case 0xf3:
      return { kind: 'hexlify' };
    default:
      throw new OtsError(`Unknown operation tag 0x${tag.toString(16)}`);
  }
}

function writeOp(w: Writer, op: Op): void {
  w.byte(OP_TAGS[op.kind]);
  if (op.kind === 'append' || op.kind === 'prepend') w.varbytes(op.arg);
}

export function applyOp(op: Op, msg: Buffer): Buffer {
  switch (op.kind) {
    case 'sha256':
      return createHash('sha256').update(msg).digest();
    case 'sha1':
      return createHash('sha1').update(msg).digest();
    case 'ripemd160':
      return createHash('ripemd160').update(msg).digest();
    case 'keccak256':
      throw new OtsError('keccak256 operations are not supported');
    case 'append':
      return Buffer.concat([msg, op.arg]);
    case 'prepend':
      return Buffer.concat([op.arg, msg]);
    case 'reverse':
      return Buffer.from(msg).reverse();
    case 'hexlify':
      return Buffer.from(msg.toString('hex'), 'ascii');
  }
}

function opKey(op: Op): string {
  const tag = OP_TAGS[op.kind].toString(16).padStart(2, '0');
  return op.kind === 'append' || op.kind === 'prepend' ? `${tag}:${op.arg.toString('hex')}` : tag;
}

function compareOps(a: Op, b: Op): number {
  const ta = OP_TAGS[a.kind];
  const tb = OP_TAGS[b.kind];
  if (ta !== tb) return ta - tb;
  if (
    (a.kind === 'append' || a.kind === 'prepend') &&
    (b.kind === 'append' || b.kind === 'prepend')
  ) {
    return Buffer.compare(a.arg, b.arg);
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Attestations
// ---------------------------------------------------------------------------

export type Attestation =
  | { kind: 'pending'; uri: string }
  | { kind: 'bitcoin'; height: number }
  | { kind: 'unknown'; tag: Buffer; payload: Buffer };

function readAttestation(r: Reader): Attestation {
  const tag = Buffer.from(r.bytes(8));
  const payload = Buffer.from(r.varbytes(8192));
  const pr = new Reader(payload);
  if (tag.equals(TAG_PENDING)) {
    const uri = pr.varbytes(1000).toString('utf8');
    if (!/^[A-Za-z0-9.\-_/:]+$/.test(uri))
      throw new OtsError('Invalid calendar URI in pending attestation');
    return { kind: 'pending', uri };
  }
  if (tag.equals(TAG_BITCOIN)) return { kind: 'bitcoin', height: pr.varuint() };
  return { kind: 'unknown', tag, payload };
}

function writeAttestation(w: Writer, a: Attestation): void {
  const payload = new Writer();
  if (a.kind === 'pending') {
    w.bytes(TAG_PENDING);
    payload.varbytes(Buffer.from(a.uri, 'utf8'));
  } else if (a.kind === 'bitcoin') {
    w.bytes(TAG_BITCOIN);
    payload.varuint(a.height);
  } else {
    w.bytes(a.tag);
    payload.bytes(a.payload);
  }
  w.varbytes(payload.toBuffer());
}

function attestationTag(a: Attestation): Buffer {
  return a.kind === 'pending' ? TAG_PENDING : a.kind === 'bitcoin' ? TAG_BITCOIN : a.tag;
}

function compareAttestations(a: Attestation, b: Attestation): number {
  if (a.kind !== b.kind || a.kind === 'unknown' || b.kind === 'unknown') {
    const t = Buffer.compare(attestationTag(a), attestationTag(b));
    if (t !== 0 || a.kind !== 'unknown' || b.kind !== 'unknown') return t;
    return Buffer.compare(a.payload, b.payload);
  }
  if (a.kind === 'pending' && b.kind === 'pending')
    return a.uri < b.uri ? -1 : a.uri > b.uri ? 1 : 0;
  if (a.kind === 'bitcoin' && b.kind === 'bitcoin') return a.height - b.height;
  return 0;
}

function attestationKey(a: Attestation): string {
  return a.kind === 'pending'
    ? `p:${a.uri}`
    : a.kind === 'bitcoin'
      ? `b:${a.height}`
      : `u:${a.tag.toString('hex')}:${a.payload.toString('hex')}`;
}

// ---------------------------------------------------------------------------
// Timestamp tree
// ---------------------------------------------------------------------------

export class Timestamp {
  readonly attestations: Attestation[] = [];
  readonly ops = new Map<string, { op: Op; stamp: Timestamp }>();

  constructor(readonly msg: Buffer) {
    if (msg.length > 4096) throw new OtsError('Message too long');
  }

  /** Add an operation (or return the existing branch for it). */
  add(op: Op): Timestamp {
    const key = opKey(op);
    const existing = this.ops.get(key);
    if (existing) return existing.stamp;
    const stamp = new Timestamp(applyOp(op, this.msg));
    this.ops.set(key, { op, stamp });
    return stamp;
  }

  addAttestation(a: Attestation): void {
    if (!this.attestations.some((x) => attestationKey(x) === attestationKey(a)))
      this.attestations.push(a);
  }

  merge(other: Timestamp): void {
    if (!other.msg.equals(this.msg))
      throw new OtsError('Cannot merge timestamps for different messages');
    for (const a of other.attestations) this.addAttestation(a);
    for (const { op, stamp } of other.ops.values()) this.add(op).merge(stamp);
  }

  static deserialize(r: Reader, msg: Buffer, depth = 256): Timestamp {
    if (depth < 0) throw new OtsError('Proof is nested too deeply');
    const self = new Timestamp(msg);
    const handle = (tag: number) => {
      if (tag === 0x00) {
        self.addAttestation(readAttestation(r));
      } else {
        const op = opFromTag(tag, r);
        const stamp = Timestamp.deserialize(r, applyOp(op, msg), depth - 1);
        self.ops.set(opKey(op), { op, stamp });
      }
    };
    let tag = r.byte();
    while (tag === 0xff) {
      handle(r.byte());
      tag = r.byte();
    }
    handle(tag);
    return self;
  }

  serialize(w: Writer): void {
    const atts = [...this.attestations].sort(compareAttestations);
    const ops = [...this.ops.values()].sort((a, b) => compareOps(a.op, b.op));
    if (!atts.length && !ops.length) throw new OtsError('An empty timestamp cannot be serialised');
    for (const a of atts.slice(0, -1)) {
      w.bytes(Buffer.from([0xff, 0x00]));
      writeAttestation(w, a);
    }
    if (ops.length === 0) {
      w.byte(0x00);
      writeAttestation(w, atts[atts.length - 1]!);
    } else if (atts.length > 0) {
      w.bytes(Buffer.from([0xff, 0x00]));
      writeAttestation(w, atts[atts.length - 1]!);
    }
    for (const { op, stamp } of ops.slice(0, -1)) {
      w.byte(0xff);
      writeOp(w, op);
      stamp.serialize(w);
    }
    const last = ops[ops.length - 1];
    if (last) {
      writeOp(w, last.op);
      last.stamp.serialize(w);
    }
  }

  toBytes(): Buffer {
    const w = new Writer();
    this.serialize(w);
    return w.toBuffer();
  }

  static fromBytes(buf: Buffer, msg: Buffer): Timestamp {
    const r = new Reader(buf);
    const t = Timestamp.deserialize(r, msg);
    return t;
  }

  /** Every attestation in the tree, with the message it commits to. */
  allAttestations(): { msg: Buffer; attestation: Attestation }[] {
    const out: { msg: Buffer; attestation: Attestation }[] = [];
    const walk = (t: Timestamp) => {
      for (const a of t.attestations) out.push({ msg: t.msg, attestation: a });
      for (const { stamp } of t.ops.values()) walk(stamp);
    };
    walk(this);
    return out;
  }

  /** Find the sub-timestamp whose message equals `msg`. */
  find(msg: Buffer): Timestamp | null {
    if (this.msg.equals(msg)) return this;
    for (const { stamp } of this.ops.values()) {
      const f = stamp.find(msg);
      if (f) return f;
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// Detached timestamp files (.ots)
// ---------------------------------------------------------------------------

export interface DetachedTimestamp {
  hashOp: 'sha256';
  digest: Buffer;
  timestamp: Timestamp;
}

export function parseOtsFile(buf: Buffer): DetachedTimestamp {
  const r = new Reader(buf);
  if (!r.bytes(HEADER_MAGIC.length).equals(HEADER_MAGIC))
    throw new OtsError('Not an OpenTimestamps proof file');
  const version = r.varuint();
  if (version !== MAJOR_VERSION) throw new OtsError(`Unsupported proof version ${version}`);
  const hashTag = r.byte();
  if (hashTag !== 0x08) throw new OtsError('Only SHA-256 proofs are supported');
  const digest = Buffer.from(r.bytes(32));
  const timestamp = Timestamp.deserialize(r, digest);
  if (!r.atEnd()) throw new OtsError('Trailing data after proof');
  return { hashOp: 'sha256', digest, timestamp };
}

export function serializeOtsFile(d: DetachedTimestamp): Buffer {
  const w = new Writer();
  w.bytes(HEADER_MAGIC);
  w.varuint(MAJOR_VERSION);
  w.byte(0x08);
  w.bytes(d.digest);
  d.timestamp.serialize(w);
  return w.toBuffer();
}

// ---------------------------------------------------------------------------
// Stamping
// ---------------------------------------------------------------------------

/**
 * Build one Merkle tree over many digests, exactly as `ots stamp` does: each
 * digest is first hashed with a random 128-bit nonce so that calendars (and
 * anyone seeing a sibling proof) learn nothing about the other items.
 * Returns the per-digest timestamps and the root to submit.
 */
export function buildMerkleBatch(digests: Buffer[]): { leaves: Timestamp[]; root: Timestamp } {
  if (!digests.length) throw new OtsError('Nothing to timestamp');
  const leaves = digests.map((d) => new Timestamp(Buffer.from(d)));
  let level = leaves.map((t) =>
    t.add({ kind: 'append', arg: randomBytes(16) }).add({ kind: 'sha256' }),
  );
  while (level.length > 1) {
    const next: Timestamp[] = [];
    for (let i = 0; i + 1 < level.length; i += 2) {
      const left = level[i]!;
      const right = level[i + 1]!;
      const joined = left.add({ kind: 'append', arg: right.msg });
      // The right branch prepends the left message and reaches the same node.
      right.ops.set(opKey({ kind: 'prepend', arg: left.msg }), {
        op: { kind: 'prepend', arg: left.msg },
        stamp: joined,
      });
      next.push(joined.add({ kind: 'sha256' }));
    }
    if (level.length % 2 === 1) next.push(level[level.length - 1]!);
    level = next;
  }
  return { leaves, root: level[0]! };
}

// ---------------------------------------------------------------------------
// Calendar client
// ---------------------------------------------------------------------------

const ACCEPT = 'application/vnd.opentimestamps.v1';

export interface CalendarClientOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

async function readLimited(res: Response, limit = 10_000): Promise<Buffer> {
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > limit) throw new OtsError('Calendar response too large');
  return buf;
}

export async function submitToCalendar(
  calendarUrl: string,
  digest: Buffer,
  opts: CalendarClientOptions = {},
): Promise<Timestamp> {
  const res = await (opts.fetchImpl ?? fetch)(`${calendarUrl.replace(/\/+$/, '')}/digest`, {
    method: 'POST',
    headers: {
      Accept: ACCEPT,
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'OpenRampart',
    },
    body: new Uint8Array(digest),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
  });
  if (res.status !== 200) throw new OtsError(`Calendar ${calendarUrl} returned HTTP ${res.status}`);
  return Timestamp.fromBytes(await readLimited(res), digest);
}

/** Ask a calendar for the completed timestamp of a commitment. Returns null while still pending. */
export async function fetchFromCalendar(
  calendarUrl: string,
  commitment: Buffer,
  opts: CalendarClientOptions = {},
): Promise<Timestamp | null> {
  const res = await (opts.fetchImpl ?? fetch)(
    `${calendarUrl.replace(/\/+$/, '')}/timestamp/${commitment.toString('hex')}`,
    {
      headers: { Accept: ACCEPT, 'User-Agent': 'OpenRampart' },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
    },
  );
  if (res.status === 404) return null;
  if (res.status !== 200) throw new OtsError(`Calendar ${calendarUrl} returned HTTP ${res.status}`);
  return Timestamp.fromBytes(await readLimited(res), commitment);
}

/**
 * Upgrade pending attestations by asking their calendars for the completed
 * path to a Bitcoin block. Only calendars on the allow-list are contacted.
 * Returns true if anything changed.
 */
export async function upgradeTimestamp(
  timestamp: Timestamp,
  allowedCalendars: string[],
  opts: CalendarClientOptions = {},
): Promise<boolean> {
  const allowed = new Set(allowedCalendars.map((c) => c.replace(/\/+$/, '')));
  let changed = false;
  const pending = timestamp.allAttestations().filter((a) => a.attestation.kind === 'pending');
  for (const { msg, attestation } of pending) {
    if (attestation.kind !== 'pending') continue;
    const uri = attestation.uri.replace(/\/+$/, '');
    if (!allowed.has(uri) || !uri.startsWith('https://')) continue;
    const node = timestamp.find(msg);
    if (!node) continue;
    try {
      const upgraded = await fetchFromCalendar(uri, msg, opts);
      if (upgraded) {
        const before = node.toBytes().length;
        node.merge(upgraded);
        if (node.toBytes().length !== before) changed = true;
      }
    } catch {
      // A calendar being unavailable is normal; try again later.
    }
  }
  return changed;
}

// ---------------------------------------------------------------------------
// Verification against Bitcoin
// ---------------------------------------------------------------------------

export interface BlockHeaderInfo {
  height: number;
  merkleRootHex: string; // as displayed by block explorers (big-endian)
  time: number; // unix seconds
}

export type BlockLookup = (height: number) => Promise<BlockHeaderInfo>;

export function esploraLookup(baseUrl: string, fetchImpl: typeof fetch = fetch): BlockLookup {
  const base = baseUrl.replace(/\/+$/, '');
  return async (height) => {
    const hashRes = await fetchImpl(`${base}/block-height/${height}`, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!hashRes.ok) throw new OtsError(`Block explorer returned HTTP ${hashRes.status}`);
    const hash = (await hashRes.text()).trim();
    if (!/^[0-9a-f]{64}$/.test(hash)) throw new OtsError('Unexpected block hash from explorer');
    const blockRes = await fetchImpl(`${base}/block/${hash}`, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!blockRes.ok) throw new OtsError(`Block explorer returned HTTP ${blockRes.status}`);
    const block = (await blockRes.json()) as {
      height: number;
      merkle_root: string;
      timestamp: number;
    };
    return { height: block.height, merkleRootHex: block.merkle_root, time: block.timestamp };
  };
}

export interface VerificationResult {
  verified: boolean;
  height?: number;
  attestedTime?: Date;
  pendingCalendars: string[];
  reason?: string;
}

/**
 * Verify Bitcoin attestations: the message at each attestation must equal the
 * Merkle root of the block at that height. A verified result proves the digest
 * existed no later than that block's time. It says nothing about whether the
 * document's contents are true.
 */
export async function verifyTimestamp(
  timestamp: Timestamp,
  lookup: BlockLookup,
): Promise<VerificationResult> {
  const atts = timestamp.allAttestations();
  const pendingCalendars = atts.flatMap((a) =>
    a.attestation.kind === 'pending' ? [a.attestation.uri] : [],
  );
  const bitcoin = atts
    .filter(
      (a): a is { msg: Buffer; attestation: { kind: 'bitcoin'; height: number } } =>
        a.attestation.kind === 'bitcoin',
    )
    .sort((a, b) => a.attestation.height - b.attestation.height);
  if (!bitcoin.length) return { verified: false, pendingCalendars, reason: 'pending' };
  let lastError = 'no matching block';
  for (const { msg, attestation } of bitcoin) {
    if (msg.length !== 32) {
      lastError = 'attestation message has the wrong length';
      continue;
    }
    try {
      const header = await lookup(attestation.height);
      const expected = Buffer.from(header.merkleRootHex, 'hex').reverse();
      if (expected.equals(msg)) {
        return {
          verified: true,
          height: attestation.height,
          attestedTime: new Date(header.time * 1000),
          pendingCalendars,
        };
      }
      lastError = `Merkle root does not match block ${attestation.height}`;
    } catch (err) {
      lastError = (err as Error).message;
    }
  }
  return { verified: false, pendingCalendars, reason: lastError };
}
