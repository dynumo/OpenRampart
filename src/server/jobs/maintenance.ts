import { readdir, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { pruneSessions } from '../auth/sessions.js';
import { db } from '../db/client.js';
import { audit } from '../domain/audit.js';
import { rows } from '../domain/sqlutil.js';
import { logger } from '../lib/logger.js';
import { deleteObject, deletePrefix } from '../storage/s3.js';
import { enqueue, QUEUES } from './queue.js';
import { resetStuckProcessing } from './processAttachment.js';

export const UPLOAD_TMP_DIR = path.join(os.tmpdir(), 'openrampart-uploads');

/**
 * Housekeeping, run on a schedule:
 *  - permanently remove soft-deleted records whose recovery period has ended
 *    (including their stored files)
 *  - remove abandoned temporary upload files
 *  - prune expired sessions, OAuth artefacts, reset tokens and invitations
 *  - re-queue attachment processing interrupted by a restart
 */
export async function runMaintenance(): Promise<Record<string, number>> {
  const stats: Record<string, number> = {};

  // Attachments first (their own deletion, or their Event/Incident's).
  const expiredFiles = await rows<{ id: string; owner_id: string; storage_key: string }>(sql`
    SELECT a.id, a.owner_id, a.storage_key FROM attachments a
    LEFT JOIN events e ON e.id = a.event_id
    LEFT JOIN incidents i ON i.id = a.incident_id
    WHERE (a.purge_after IS NOT NULL AND a.purge_after < now())
       OR (e.purge_after IS NOT NULL AND e.purge_after < now())
       OR (i.purge_after IS NOT NULL AND i.purge_after < now())
    LIMIT 500`);
  for (const f of expiredFiles) {
    try {
      await deleteObject(f.storage_key);
      await deletePrefix(`derived/${f.owner_id}/${f.id}/`);
      await db().execute(
        sql`DELETE FROM timestamp_proofs WHERE subject_type = 'attachment' AND subject_id = ${f.id}::uuid`,
      );
      await db().execute(sql`DELETE FROM attachments WHERE id = ${f.id}::uuid`);
      await audit({
        action: 'attachment.deleted',
        ownerId: f.owner_id,
        via: 'system',
        targetType: 'attachment',
        targetId: f.id,
        metadata: { permanent: true },
      });
    } catch (err) {
      logger.warn(
        { attachmentId: f.id, err: (err as Error).message },
        'could not purge attachment',
      );
    }
  }
  stats.attachmentsPurged = expiredFiles.length;

  const purgedEvents = await rows<{ id: string; owner_id: string }>(sql`
    DELETE FROM events WHERE purge_after IS NOT NULL AND purge_after < now()
      AND NOT EXISTS (SELECT 1 FROM attachments a WHERE a.event_id = events.id)
    RETURNING id, owner_id`);
  for (const e of purgedEvents) {
    await db().execute(
      sql`DELETE FROM timestamp_proofs WHERE subject_type = 'event_revision' AND subject_id NOT IN (SELECT id FROM event_revisions)`,
    );
    await audit({
      action: 'event.purged',
      ownerId: e.owner_id,
      via: 'system',
      targetType: 'event',
      targetId: e.id,
    });
  }
  stats.eventsPurged = purgedEvents.length;

  const purgedIncidents = await rows<{ id: string; owner_id: string }>(sql`
    DELETE FROM incidents WHERE purge_after IS NOT NULL AND purge_after < now()
      AND NOT EXISTS (SELECT 1 FROM attachments a WHERE a.incident_id = incidents.id)
    RETURNING id, owner_id`);
  for (const i of purgedIncidents) {
    await audit({
      action: 'incident.deleted',
      ownerId: i.owner_id,
      via: 'system',
      targetType: 'incident',
      targetId: i.id,
      metadata: { permanent: true },
    });
  }
  stats.incidentsPurged = purgedIncidents.length;

  const purgedActors = await rows<{ id: string }>(sql`
    DELETE FROM actors WHERE purge_after IS NOT NULL AND purge_after < now()
      AND NOT EXISTS (SELECT 1 FROM event_actors ea WHERE ea.actor_id = actors.id OR ea.origin_actor_id = actors.id)
      AND NOT EXISTS (SELECT 1 FROM actors m WHERE m.merged_into_id = actors.id)
    RETURNING id`);
  stats.actorsPurged = purgedActors.length;

  stats.sessionsPruned = await pruneSessions();
  const oauth = await db().execute(
    sql`DELETE FROM oauth_payloads WHERE expires_at IS NOT NULL AND expires_at < now() - interval '1 day'`,
  );
  stats.oauthPruned = oauth.rowCount ?? 0;
  await db().execute(
    sql`DELETE FROM password_reset_tokens WHERE expires_at < now() - interval '7 days'`,
  );
  await db().execute(
    sql`DELETE FROM rate_limits WHERE expire IS NOT NULL AND expire < (extract(epoch from now()) * 1000)::bigint`,
  );

  stats.tempFilesRemoved = await cleanTempUploads();

  stats.processingReset = await resetStuckProcessing();
  const unprocessed = await rows<{ id: string }>(sql`
    SELECT id FROM attachments
    WHERE deleted_at IS NULL AND (ocr_status = 'pending' OR derivative_status = 'pending')
      AND uploaded_at < now() - interval '30 minutes'
    LIMIT 200`);
  for (const a of unprocessed) {
    await enqueue(QUEUES.processAttachment, { attachmentId: a.id }, { singletonKey: a.id });
  }
  stats.processingRequeued = unprocessed.length;
  return stats;
}

export async function cleanTempUploads(maxAgeMs = 60 * 60 * 1000): Promise<number> {
  let removed = 0;
  let entries: string[] = [];
  try {
    entries = await readdir(UPLOAD_TMP_DIR);
  } catch {
    return 0;
  }
  for (const name of entries) {
    const p = path.join(UPLOAD_TMP_DIR, name);
    try {
      const s = await stat(p);
      if (Date.now() - s.mtimeMs > maxAgeMs) {
        await rm(p, { recursive: true, force: true });
        removed++;
      }
    } catch {
      // already gone
    }
  }
  return removed;
}
