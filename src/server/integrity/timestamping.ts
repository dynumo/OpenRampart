import { and, asc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { config } from '../config.js';
import { db } from '../db/client.js';
import { attachments, eventRevisions, timestampProofs } from '../db/schema.js';
import { logger } from '../lib/logger.js';
import {
  buildMerkleBatch,
  esploraLookup,
  parseOtsFile,
  serializeOtsFile,
  submitToCalendar,
  upgradeTimestamp,
  verifyTimestamp,
  type BlockLookup,
} from './ots.js';

/**
 * External timestamping behind a provider interface. OpenTimestamps is the
 * built-in provider; others (e.g. an RFC 3161 time-stamping authority) can be
 * added by implementing TimestampProvider.
 *
 * A timestamp shows that a particular hash existed no later than a particular
 * time. It does not show that the contents of a document are true.
 */
export interface TimestampProvider {
  readonly name: string;
  /** Timestamp many digests at once; returns one proof per digest, in order. */
  stampBatch(digests: Buffer[]): Promise<{ proofs: Buffer[]; calendars: string[] }>;
  /** Try to complete a pending proof. */
  upgrade(proof: Buffer): Promise<{ proof: Buffer; changed: boolean }>;
  /** Check a proof for a digest. */
  verify(
    proof: Buffer,
    digest: Buffer,
  ): Promise<{
    status: 'complete' | 'pending' | 'invalid';
    attestedTime?: Date;
    height?: number;
    detail?: string;
  }>;
}

export class OpenTimestampsProvider implements TimestampProvider {
  readonly name = 'opentimestamps';
  constructor(
    private readonly calendars: string[],
    private readonly minCalendars: number,
    private readonly lookup: BlockLookup,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async stampBatch(digests: Buffer[]) {
    const { leaves, root } = buildMerkleBatch(digests);
    const results = await Promise.allSettled(
      this.calendars.map(async (url) => ({
        url,
        stamp: await submitToCalendar(url, root.msg, { fetchImpl: this.fetchImpl }),
      })),
    );
    const ok = results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
    if (ok.length < this.minCalendars) {
      const reasons = results.flatMap((r) =>
        r.status === 'rejected' ? [(r.reason as Error).message] : [],
      );
      throw new Error(
        `Only ${ok.length} of ${this.calendars.length} timestamp calendars responded: ${reasons.join('; ')}`,
      );
    }
    for (const { stamp } of ok) root.merge(stamp);
    return {
      proofs: leaves.map((leaf) =>
        serializeOtsFile({ hashOp: 'sha256', digest: leaf.msg, timestamp: leaf }),
      ),
      calendars: ok.map((o) => o.url),
    };
  }

  async upgrade(proof: Buffer) {
    const parsed = parseOtsFile(proof);
    const changed = await upgradeTimestamp(parsed.timestamp, this.calendars, {
      fetchImpl: this.fetchImpl,
    });
    return { proof: changed ? serializeOtsFile(parsed) : proof, changed };
  }

  async verify(proof: Buffer, digest: Buffer) {
    const parsed = parseOtsFile(proof);
    if (!parsed.digest.equals(digest))
      return { status: 'invalid' as const, detail: 'The proof is for a different hash' };
    const result = await verifyTimestamp(parsed.timestamp, this.lookup);
    if (result.verified)
      return {
        status: 'complete' as const,
        attestedTime: result.attestedTime,
        height: result.height,
      };
    if (result.reason === 'pending') return { status: 'pending' as const };
    return { status: 'invalid' as const, detail: result.reason };
  }
}

let provider: TimestampProvider | null | undefined;

export function timestampProvider(): TimestampProvider | null {
  if (provider !== undefined) return provider;
  const c = config();
  provider =
    c.TIMESTAMP_PROVIDER === 'opentimestamps'
      ? new OpenTimestampsProvider(
          c.OTS_CALENDARS,
          c.OTS_MIN_CALENDARS,
          esploraLookup(c.BITCOIN_EXPLORER_URL),
        )
      : null;
  return provider;
}

export function setTimestampProvider(p: TimestampProvider | null): void {
  provider = p;
}

/** Submit queued digests as one batch (scheduled job). */
export async function submitQueuedTimestamps(limit = 1000): Promise<number> {
  const p = timestampProvider();
  if (!p) return 0;
  const queued = await db()
    .select({ id: timestampProofs.id, digest: timestampProofs.digest })
    .from(timestampProofs)
    .where(and(eq(timestampProofs.status, 'queued'), eq(timestampProofs.provider, p.name)))
    .orderBy(asc(timestampProofs.createdAt))
    .limit(limit);
  if (!queued.length) return 0;
  try {
    const { proofs, calendars } = await p.stampBatch(
      queued.map((q) => Buffer.from(q.digest, 'hex')),
    );
    const now = new Date();
    await db().transaction(async (tx) => {
      for (const [i, q] of queued.entries()) {
        await tx
          .update(timestampProofs)
          .set({
            status: 'pending',
            proof: proofs[i]!,
            calendars,
            submittedAt: now,
            lastCheckedAt: now,
            error: null,
          })
          .where(eq(timestampProofs.id, q.id));
      }
    });
    logger.info({ count: queued.length, calendars: calendars.length }, 'timestamps submitted');
    return queued.length;
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'timestamp submission failed; will retry');
    await db()
      .update(timestampProofs)
      .set({
        attempts: sql`${timestampProofs.attempts} + 1`,
        error: 'Timestamp calendars could not be reached; will retry.',
      })
      .where(
        inArray(
          timestampProofs.id,
          queued.map((q) => q.id),
        ),
      );
    return 0;
  }
}

/** Try to complete pending proofs (scheduled job). */
export async function upgradePendingTimestamps(limit = 500): Promise<number> {
  const p = timestampProvider();
  if (!p) return 0;
  const minAge = new Date(Date.now() - config().OTS_UPGRADE_INTERVAL_MINUTES * 60_000);
  const pending = await db()
    .select()
    .from(timestampProofs)
    .where(
      and(
        eq(timestampProofs.status, 'pending'),
        eq(timestampProofs.provider, p.name),
        or(isNull(timestampProofs.lastCheckedAt), lt(timestampProofs.lastCheckedAt, minAge)),
      ),
    )
    .orderBy(asc(timestampProofs.lastCheckedAt))
    .limit(limit);
  let completed = 0;
  for (const row of pending) {
    if (!row.proof) continue;
    try {
      const { proof, changed } = await p.upgrade(row.proof);
      const verdict = changed
        ? await p.verify(proof, Buffer.from(row.digest, 'hex'))
        : { status: 'pending' as const };
      const now = new Date();
      await db()
        .update(timestampProofs)
        .set({
          proof,
          lastCheckedAt: now,
          upgradedAt: changed ? now : row.upgradedAt,
          ...(verdict.status === 'complete'
            ? {
                status: 'complete' as const,
                attestedTime: verdict.attestedTime,
                attestedHeight: verdict.height,
                verifiedAt: now,
                error: null,
              }
            : {}),
        })
        .where(eq(timestampProofs.id, row.id));
      if (verdict.status === 'complete') completed++;
    } catch (err) {
      await db()
        .update(timestampProofs)
        .set({ lastCheckedAt: new Date(), error: (err as Error).message.slice(0, 300) })
        .where(eq(timestampProofs.id, row.id));
    }
  }
  return completed;
}

/**
 * Re-verify a stored proof against the subject's current recorded hash
 * ("Timestamp verified").
 */
export async function verifyStoredProof(
  subjectType: 'attachment' | 'event_revision',
  subjectId: string,
) {
  const p = timestampProvider();
  const [row] = await db()
    .select()
    .from(timestampProofs)
    .where(
      and(eq(timestampProofs.subjectType, subjectType), eq(timestampProofs.subjectId, subjectId)),
    )
    .limit(1);
  if (!row) return { status: 'none' as const };
  let currentDigest: string | undefined;
  if (subjectType === 'attachment') {
    [{ sha256: currentDigest } = { sha256: undefined }] = await db()
      .select({ sha256: attachments.sha256 })
      .from(attachments)
      .where(eq(attachments.id, subjectId));
  } else {
    [{ sha256: currentDigest } = { sha256: undefined }] = await db()
      .select({ sha256: eventRevisions.sha256 })
      .from(eventRevisions)
      .where(eq(eventRevisions.id, subjectId));
  }
  if (!currentDigest || currentDigest !== row.digest)
    return {
      status: 'invalid' as const,
      detail: 'The recorded hash has changed since it was timestamped',
    };
  if (!row.proof || !p)
    return { status: row.status, detail: row.proof ? undefined : 'Not yet submitted' };
  const verdict = await p.verify(row.proof, Buffer.from(row.digest, 'hex'));
  if (verdict.status === 'complete') {
    await db()
      .update(timestampProofs)
      .set({
        status: 'complete',
        verifiedAt: new Date(),
        attestedTime: verdict.attestedTime,
        attestedHeight: verdict.height,
      })
      .where(eq(timestampProofs.id, row.id));
  }
  return verdict;
}
