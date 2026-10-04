import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import type { AttachmentDTO, DocumentSuggestionsDTO } from '../../shared/types.js';
import { config } from '../config.js';
import { db } from '../db/client.js';
import { attachments, events, incidents } from '../db/schema.js';
import { enqueue, QUEUES } from '../jobs/queue.js';
import { ForbiddenError, NotFoundError, ValidationError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { categoryOf, detectFileType, sanitiseFilename } from '../storage/fileTypes.js';
import { deleteObject, getObjectStream, originalKey, putFile } from '../storage/s3.js';
import { actorFullAccess, eventVisible, incidentVisible, restrictContext } from './access.js';
import { attachmentRow, toAttachmentDTO } from './attachmentQueries.js';
import { auditCtx } from './audit.js';
import { isOwner, requireScopes, type AccessContext } from './context.js';
import { appendRevision, queueTimestamp } from './revisions.js';
import { isUuid, rows, uuidList } from './sqlutil.js';

export interface UploadedFile {
  tmpPath: string;
  originalFilename: string;
  sizeBytes: number;
  sha256: string;
}

function ocrApplicable(category: string | null): boolean {
  return category === 'image' || category === 'heif' || category === 'pdf' || category === 'text';
}

function derivativesApplicable(category: string | null): boolean {
  return category === 'image' || category === 'heif' || category === 'pdf';
}

async function assertCanAttachToEvent(ctx: AccessContext, eventId: string): Promise<void> {
  if (!isUuid(eventId)) throw new NotFoundError('Event');
  const [visible] = await rows<{ id: string; deleted_at: Date | null }>(
    sql`SELECT e.id, e.deleted_at FROM events e WHERE e.id = ${eventId}::uuid AND ${eventVisible(ctx, 'e')}`,
  );
  if (!visible) throw new NotFoundError('Event');
  if (isOwner(ctx)) return;
  const [ok] = await rows<{ id: string }>(
    sql`SELECT e.id FROM events e WHERE e.id = ${eventId}::uuid AND ${eventVisible(restrictContext(ctx, 'add'), 'e')}`,
  );
  if (!ok) throw new ForbiddenError('Your access does not include adding attachments to this Event');
}

/**
 * Store an uploaded original. The file has already been streamed to a local
 * temporary path by the HTTP layer, which computed its SHA-256 and size while
 * enforcing the upload limit. Here the content type is verified from the bytes,
 * the original is written to object storage unchanged, and processing (OCR,
 * thumbnails) is queued. Processing failures never affect the stored original
 * or the Event.
 */
export async function storeAttachment(
  ctx: AccessContext,
  target: { eventId?: string; incidentId?: string },
  file: UploadedFile,
): Promise<AttachmentDTO> {
  requireScopes(ctx, 'attachments:write');
  if (Boolean(target.eventId) === Boolean(target.incidentId)) throw new ValidationError('Attach to an Event or an Incident');
  if (target.eventId) await assertCanAttachToEvent(ctx, target.eventId);
  if (target.incidentId) {
    if (!isOwner(ctx)) throw new ForbiddenError('Only the owner can attach files to an Incident');
    if (!isUuid(target.incidentId)) throw new NotFoundError('Incident');
    const [inc] = await rows<{ id: string }>(sql`SELECT i.id FROM incidents i WHERE i.id = ${target.incidentId}::uuid AND ${incidentVisible(ctx, 'i')}`);
    if (!inc) throw new NotFoundError('Incident');
  }
  if (file.sizeBytes > config().maxUploadBytes) {
    throw new ValidationError(`Files must be no larger than ${config().MAX_UPLOAD_MB} MB`);
  }
  if (!/^[0-9a-f]{64}$/.test(file.sha256)) throw new Error('upload hash missing');
  const filename = sanitiseFilename(file.originalFilename);
  const type = await detectFileType(file.tmpPath, filename);
  const id = randomUUID();
  const key = originalKey(ctx.ownerId, id);
  await putFile(key, file.tmpPath, type.mimeType);
  const ocrEnabled = config().OCR_ENABLED;
  try {
    await db().transaction(async (tx) => {
      const [pos] = await rows<{ n: number }>(
        target.eventId
          ? sql`SELECT coalesce(max(position) + 1, 0)::int AS n FROM attachments WHERE event_id = ${target.eventId}::uuid`
          : sql`SELECT coalesce(max(position) + 1, 0)::int AS n FROM attachments WHERE incident_id = ${target.incidentId!}::uuid`,
        tx,
      );
      await tx.insert(attachments).values({
        id,
        ownerId: ctx.ownerId,
        eventId: target.eventId ?? null,
        incidentId: target.incidentId ?? null,
        position: pos?.n ?? 0,
        originalFilename: filename,
        mimeType: type.mimeType,
        sizeBytes: file.sizeBytes,
        storageKey: key,
        sha256: file.sha256,
        uploadedBy: ctx.userId,
        derivativeStatus: derivativesApplicable(type.category) ? 'pending' : 'not_applicable',
        ocrStatus: !ocrApplicable(type.category) ? 'not_applicable' : ocrEnabled ? 'pending' : 'disabled',
      });
      await queueTimestamp(tx, ctx.ownerId, 'attachment', id, file.sha256);
      if (target.eventId) {
        await tx.update(events).set({ updatedAt: new Date(), updatedBy: ctx.userId }).where(eq(events.id, target.eventId));
        await appendRevision(tx, {
          eventId: target.eventId,
          ownerId: ctx.ownerId,
          changeKind: 'update',
          changedFields: ['attachments'],
          userId: ctx.userId,
          via: ctx.via,
        });
      } else {
        await tx.update(incidents).set({ updatedAt: new Date() }).where(eq(incidents.id, target.incidentId!));
      }
      await auditCtx(
        ctx,
        'attachment.uploaded',
        { type: 'attachment', id, metadata: { eventId: target.eventId, incidentId: target.incidentId, mimeType: type.mimeType, sizeBytes: file.sizeBytes, sha256: file.sha256 } },
        tx,
      );
    });
  } catch (err) {
    await deleteObject(key).catch(() => undefined);
    throw err;
  }
  if (derivativesApplicable(type.category) || (ocrApplicable(type.category) && ocrEnabled)) {
    await enqueue(QUEUES.processAttachment, { attachmentId: id }).catch((err) =>
      logger.error({ err: (err as Error).message, attachmentId: id }, 'could not queue attachment processing'),
    );
  }
  const row = await attachmentRow(ctx, id);
  return toAttachmentDTO(row!);
}

export async function getAttachment(ctx: AccessContext, id: string): Promise<AttachmentDTO> {
  requireScopes(ctx, 'attachments:metadata');
  if (!isUuid(id)) throw new NotFoundError('Attachment');
  const row = await attachmentRow(ctx, id);
  if (!row) throw new NotFoundError('Attachment');
  return toAttachmentDTO(row);
}

export type AttachmentVariant = 'original' | 'thumbnail' | 'preview';

/**
 * Open attachment content for streaming. Thumbnails and previews are derived
 * from the contents, so they need the same permission as the original.
 */
export async function openAttachment(
  ctx: AccessContext,
  id: string,
  variant: AttachmentVariant,
  range?: string,
) {
  requireScopes(ctx, 'attachments:read');
  if (!isUuid(id)) throw new NotFoundError('Attachment');
  const row = await attachmentRow(ctx, id);
  if (!row) throw new NotFoundError('Attachment');
  const key = variant === 'original' ? row.storage_key : variant === 'thumbnail' ? row.thumbnail_key : row.preview_key;
  if (!key) throw new NotFoundError('Preview');
  const stream = await getObjectStream(key, variant === 'original' ? range : undefined);
  if (variant === 'original' && !range) {
    await auditCtx(ctx, 'attachment.downloaded', { type: 'attachment', id, metadata: { eventId: row.event_id, incidentId: row.incident_id } });
  }
  return {
    ...stream,
    mimeType: variant === 'original' ? row.mime_type : 'image/webp',
    filename: row.original_filename,
    sizeBytes: Number(row.size_bytes),
    sha256: row.sha256,
  };
}

export interface AttachmentText {
  attachmentId: string;
  status: string;
  engine: string | null;
  processedAt: string | null;
  text: string | null;
  originalText: string | null;
  corrected: boolean;
  correctedAt: string | null;
  error: string | null;
  suggestions: DocumentSuggestionsDTO | null;
}

/** OCR/extracted text. Reveals contents, so requires attachments:read. */
export async function getAttachmentText(ctx: AccessContext, id: string): Promise<AttachmentText> {
  requireScopes(ctx, 'attachments:read');
  if (!isUuid(id)) throw new NotFoundError('Attachment');
  const row = await attachmentRow(ctx, id);
  if (!row) throw new NotFoundError('Attachment');
  const [full] = await db().select().from(attachments).where(eq(attachments.id, id)).limit(1);
  const s = full!.suggestions;
  let suggestions: DocumentSuggestionsDTO | null = null;
  if (s) {
    // Actor suggestions are filtered to Actors the viewer can access fully.
    const ids = s.actors.map((a) => a.actorId).filter((v): v is string => Boolean(v));
    const allowed = ids.length
      ? new Set(
          (await rows<{ id: string; name: string }>(sql`SELECT a.id, a.name FROM actors a WHERE a.id IN (${uuidList(ids)}) AND ${actorFullAccess(ctx, 'a')}`)).map(
            (r) => r.id,
          ),
        )
      : new Set<string>();
    suggestions = {
      ...s,
      actors: s.actors.filter((a) => (a.actorId ? allowed.has(a.actorId) : true)),
    };
  }
  return {
    attachmentId: id,
    status: full!.ocrStatus,
    engine: full!.ocrEngine,
    processedAt: full!.ocrProcessedAt?.toISOString() ?? null,
    text: full!.ocrCorrectedText ?? full!.ocrText,
    originalText: full!.ocrText,
    corrected: full!.ocrCorrectedText !== null,
    correctedAt: full!.ocrCorrectedAt?.toISOString() ?? null,
    error: full!.ocrError,
    suggestions,
  };
}

/** Store corrected OCR text. The original file and the machine OCR text are kept. */
export async function correctAttachmentText(ctx: AccessContext, id: string, text: string | null): Promise<AttachmentText> {
  requireScopes(ctx, 'attachments:write');
  if (!isUuid(id)) throw new NotFoundError('Attachment');
  const row = await attachmentRow(ctx, id);
  if (!row) throw new NotFoundError('Attachment');
  if (!isOwner(ctx) && row.uploaded_by !== ctx.userId) {
    throw new ForbiddenError('Only the owner, or the person who uploaded this file, can correct its text');
  }
  if (text !== null && text.length > 2_000_000) throw new ValidationError('The corrected text is too long');
  await db()
    .update(attachments)
    .set({ ocrCorrectedText: text, ocrCorrectedBy: text === null ? null : ctx.userId, ocrCorrectedAt: text === null ? null : new Date() })
    .where(eq(attachments.id, id));
  await auditCtx(ctx, 'attachment.ocr_corrected', { type: 'attachment', id, metadata: { reverted: text === null } });
  return getAttachmentText(ctx, id);
}

export async function deleteAttachment(ctx: AccessContext, id: string): Promise<void> {
  requireScopes(ctx, 'attachments:write');
  if (!isOwner(ctx)) throw new ForbiddenError('Only the owner of this record can delete attachments');
  const row = await attachmentRow(ctx, id);
  if (!row) throw new NotFoundError('Attachment');
  const now = new Date();
  await db().transaction(async (tx) => {
    await tx
      .update(attachments)
      .set({ deletedAt: now, deletedBy: ctx.userId, purgeAfter: new Date(now.getTime() + config().DELETION_RETENTION_DAYS * 86400_000) })
      .where(eq(attachments.id, id));
    if (row.event_id) {
      await appendRevision(tx, { eventId: row.event_id, ownerId: ctx.ownerId, changeKind: 'update', changedFields: ['attachments'], userId: ctx.userId, via: ctx.via });
    }
    await auditCtx(ctx, 'attachment.deleted', { type: 'attachment', id, metadata: { eventId: row.event_id, incidentId: row.incident_id } }, tx);
  });
}

export async function restoreAttachment(ctx: AccessContext, id: string): Promise<AttachmentDTO> {
  if (!isOwner(ctx)) throw new ForbiddenError();
  const row = await attachmentRow(ctx, id, { includeDeleted: true });
  if (!row) throw new NotFoundError('Attachment');
  await db().transaction(async (tx) => {
    await tx.update(attachments).set({ deletedAt: null, deletedBy: null, purgeAfter: null }).where(eq(attachments.id, id));
    if (row.event_id) {
      await appendRevision(tx, { eventId: row.event_id, ownerId: ctx.ownerId, changeKind: 'update', changedFields: ['attachments'], userId: ctx.userId, via: ctx.via });
    }
    await auditCtx(ctx, 'attachment.restored', { type: 'attachment', id }, tx);
  });
  return getAttachment(ctx, id);
}

/** Reorder an Event's attachments (e.g. pages of a letter). */
export async function reorderAttachments(ctx: AccessContext, eventId: string, orderedIds: string[]): Promise<void> {
  requireScopes(ctx, 'attachments:write');
  if (!isOwner(ctx)) throw new ForbiddenError();
  await assertCanAttachToEvent(ctx, eventId);
  await db().transaction(async (tx) => {
    for (const [i, id] of orderedIds.entries()) {
      if (!isUuid(id)) continue;
      await tx
        .update(attachments)
        .set({ position: i })
        .where(and(eq(attachments.id, id), eq(attachments.eventId, eventId), eq(attachments.ownerId, ctx.ownerId)));
    }
  });
}

/**
 * Re-read the stored original and confirm its SHA-256 still matches the hash
 * recorded at upload ("Original unchanged").
 */
export async function verifyAttachmentIntegrity(ctx: AccessContext, id: string): Promise<{ ok: boolean; checkedAt: string; sha256: string }> {
  requireScopes(ctx, 'attachments:metadata');
  const row = await attachmentRow(ctx, id);
  if (!row) throw new NotFoundError('Attachment');
  const result = await checkStoredHash(row.id);
  await auditCtx(ctx, 'attachment.integrity_checked', { type: 'attachment', id, metadata: { ok: result.ok } });
  return result;
}

export async function checkStoredHash(attachmentId: string): Promise<{ ok: boolean; checkedAt: string; sha256: string }> {
  const [row] = await db().select().from(attachments).where(eq(attachments.id, attachmentId)).limit(1);
  if (!row) throw new NotFoundError('Attachment');
  const { body } = await getObjectStream(row.storageKey);
  const hash = createHash('sha256');
  for await (const chunk of body) hash.update(chunk as Uint8Array);
  const actual = hash.digest('hex');
  const ok = actual === row.sha256;
  const checkedAt = new Date();
  await db().update(attachments).set({ integrityCheckedAt: checkedAt, integrityOk: ok }).where(eq(attachments.id, attachmentId));
  if (!ok) logger.error({ attachmentId }, 'stored original does not match its recorded SHA-256');
  return { ok, checkedAt: checkedAt.toISOString(), sha256: row.sha256 };
}

export { categoryOf };
