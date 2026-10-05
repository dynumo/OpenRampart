import { rm } from 'node:fs/promises';
import { Router, type Request, type Response } from 'express';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import * as actors from '../../domain/actors.js';
import * as attachments from '../../domain/attachments.js';
import { eventVisible, incidentVisible } from '../../domain/access.js';
import { isOwner } from '../../domain/context.js';
import { allEventTypes, toEventTypeDTO } from '../../domain/eventTypes.js';
import * as events from '../../domain/events.js';
import { exportZip } from '../../domain/export.js';
import * as incidents from '../../domain/incidents.js';
import { search, suggest } from '../../domain/search.js';
import { rows } from '../../domain/sqlutil.js';
import { enqueue, QUEUES } from '../../jobs/queue.js';
import { verifyStoredProof } from '../../integrity/timestamping.js';
import { db } from '../../db/client.js';
import { attachments as attachmentsTable, timestampProofs } from '../../db/schema.js';
import { and, eq } from 'drizzle-orm';
import { ForbiddenError, NotFoundError, ValidationError } from '../../lib/errors.js';
import { isInlineSafe } from '../../storage/fileTypes.js';
import { ctxOf } from '../middleware.js';
import { receiveUpload } from '../upload.js';

const list = (v: unknown): string[] | undefined => {
  if (v === undefined || v === '') return undefined;
  return (Array.isArray(v) ? v : [v]).map(String).filter(Boolean);
};
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
const bool = (v: unknown): boolean => v === 'true' || v === '1';

function eventFilters(req: Request): events.EventFilters {
  const q = req.query;
  return {
    actorIds: list(q.actorId),
    typeIds: list(q.typeId),
    incidentIds: list(q.incidentId),
    from: str(q.from) ?? null,
    to: str(q.to) ?? null,
    hasAttachments: bool(q.hasAttachments),
    riskLevels: list(q.risk),
    direction: str(q.direction) ?? null,
    tags: list(q.tag),
    deleted: bool(q.deleted),
  };
}

function contentDisposition(kind: 'inline' | 'attachment', filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

async function streamAttachment(
  req: Request,
  res: Response,
  variant: attachments.AttachmentVariant,
) {
  const ctx = ctxOf(res);
  const range = variant === 'original' ? req.get('range') : undefined;
  const file = await attachments.openAttachment(ctx, String(req.params.id), variant, range);
  const inline =
    variant !== 'original' || (isInlineSafe(file.mimeType) && req.query.download !== '1');
  res.status(file.contentRange ? 206 : 200);
  res.set({
    'Content-Type': file.mimeType === 'text/plain' ? 'text/plain; charset=utf-8' : file.mimeType,
    'Content-Disposition': contentDisposition(
      inline ? 'inline' : 'attachment',
      variant === 'original' ? file.filename : `${variant}.webp`,
    ),
    'Cache-Control': 'private, max-age=300',
    'X-Content-Type-Options': 'nosniff',
    // Uploaded content can never run script in the application's origin.
    'Content-Security-Policy':
      file.mimeType === 'application/pdf'
        ? "default-src 'none'; frame-ancestors 'self'"
        : "sandbox; default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'self'",
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Accept-Ranges': variant === 'original' ? 'bytes' : 'none',
    ...(variant === 'original' ? { 'X-Content-SHA256': file.sha256 } : {}),
  });
  if (file.contentLength !== undefined) res.set('Content-Length', String(file.contentLength));
  if (file.contentRange) res.set('Content-Range', file.contentRange);
  file.body.on('error', () => res.destroy());
  file.body.pipe(res);
}

export function recordRouter(): Router {
  const r = Router();

  // ----------------------------------------------------------- record info
  r.get('/record', async (_req, res) => {
    const ctx = ctxOf(res);
    const [owner] = await rows<{ display_name: string; timezone: string }>(
      sql`SELECT display_name, timezone FROM users WHERE id = ${ctx.ownerId}::uuid`,
    );
    const [counts] = await rows<{ events: number; incidents: number; open_incidents: number }>(sql`
      SELECT (SELECT count(*)::int FROM events e WHERE ${eventVisible(ctx, 'e')}) AS events,
             (SELECT count(*)::int FROM incidents i WHERE ${incidentVisible(ctx, 'i')}) AS incidents,
             (SELECT count(*)::int FROM incidents i WHERE ${incidentVisible(ctx, 'i')} AND i.status IN ('open','monitoring')) AS open_incidents`);
    res.json({
      ownerId: ctx.ownerId,
      ownerName: owner?.display_name,
      timezone: ctx.ownerTimezone,
      role: ctx.role,
      capabilities: {
        add: isOwner(ctx) || ctx.grants.some((g) => g.canAdd),
        export: isOwner(ctx) || ctx.grants.some((g) => g.canExport),
        organise: isOwner(ctx),
      },
      grants:
        ctx.role === 'helper'
          ? ctx.grants.map((g) => ({
              scopeType: g.scopeType,
              dateFrom: g.dateFrom,
              dateTo: g.dateTo,
              canAdd: g.canAdd,
              canExport: g.canExport,
            }))
          : [],
      counts,
    });
  });

  r.get('/event-types', async (_req, res) => {
    res.json({ items: (await allEventTypes()).map(toEventTypeDTO) });
  });

  // --------------------------------------------------------------- events
  r.get('/events', async (req, res) => {
    const ctx = ctxOf(res);
    const q = str(req.query.q);
    if (q) {
      const result = await search(ctx, q, {
        include: ['events'],
        limit: Number(req.query.limit) || 50,
        filters: eventFilters(req),
      });
      return res.json({
        items: result.events,
        nextCursor: null,
        total: result.totals.events,
        correctedQuery: result.correctedQuery,
      });
    }
    res.json(
      await events.listEvents(ctx, eventFilters(req), {
        cursor: str(req.query.cursor),
        limit: Number(req.query.limit) || 50,
        order: req.query.order === 'asc' ? 'asc' : 'desc',
        withTotal: true,
      }),
    );
  });

  r.post('/events', async (req, res) => {
    res.status(201).json(await events.createEvent(ctxOf(res), req.body));
  });

  r.get('/events/:id', async (req, res) => {
    res.json(
      await events.getEvent(ctxOf(res), String(req.params.id), {
        includeDeleted: bool(req.query.deleted),
      }),
    );
  });

  r.patch('/events/:id', async (req, res) => {
    res.json(await events.updateEvent(ctxOf(res), String(req.params.id), req.body));
  });

  r.delete('/events/:id', async (req, res) => {
    await events.deleteEvent(ctxOf(res), String(req.params.id));
    res.json({ ok: true });
  });

  r.post('/events/:id/restore', async (req, res) => {
    res.json(await events.restoreEvent(ctxOf(res), String(req.params.id)));
  });

  r.get('/events/:id/revisions', async (req, res) => {
    const ctx = ctxOf(res);
    await events.getEvent(ctx, String(req.params.id), { includeDeleted: isOwner(ctx) });
    res.json({ items: await events.revisionsFor(ctx, String(req.params.id)) });
  });

  r.get('/events/:id/revisions/:revision/timestamp.ots', async (req, res) => {
    const ctx = ctxOf(res);
    await events.getEvent(ctx, String(req.params.id), { includeDeleted: isOwner(ctx) });
    const [row] = await rows<{ proof: Buffer | null; sha256: string }>(sql`
      SELECT tp.proof, r.sha256 FROM event_revisions r
      JOIN timestamp_proofs tp ON tp.subject_type = 'event_revision' AND tp.subject_id = r.id
      WHERE r.event_id = ${String(req.params.id)}::uuid AND r.revision = ${Number(req.params.revision)} AND r.owner_id = ${ctx.ownerId}::uuid`);
    if (!row?.proof) throw new NotFoundError('Timestamp proof');
    res.set({
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': contentDisposition(
        'attachment',
        `event-${req.params.id}-r${req.params.revision}.ots`,
      ),
    });
    res.send(row.proof);
  });

  r.post('/events/:id/relations', async (req, res) => {
    const input = z
      .object({ eventId: z.string(), note: z.string().max(500).nullish() })
      .parse(req.body);
    await events.linkEvents(ctxOf(res), String(req.params.id), input.eventId, input.note);
    res.status(201).json({ ok: true });
  });

  r.delete('/relations/:id', async (req, res) => {
    await events.unlinkEvents(ctxOf(res), String(req.params.id));
    res.json({ ok: true });
  });

  r.post('/events/:id/attachments', async (req, res) => {
    const ctx = ctxOf(res);
    const upload = await receiveUpload(req);
    try {
      res
        .status(201)
        .json(await attachments.storeAttachment(ctx, { eventId: String(req.params.id) }, upload));
    } finally {
      await rm(upload.tmpPath, { force: true });
    }
  });

  r.put('/events/:id/attachments/order', async (req, res) => {
    const input = z.object({ ids: z.array(z.string()).max(500) }).parse(req.body);
    await attachments.reorderAttachments(ctxOf(res), String(req.params.id), input.ids);
    res.json({ ok: true });
  });

  // --------------------------------------------------------------- actors
  r.get('/actors', async (req, res) => {
    res.json(
      await actors.listActors(ctxOf(res), {
        q: str(req.query.q),
        includeArchived: bool(req.query.archived),
        kind: str(req.query.kind),
        sort: req.query.sort === 'recent' ? 'recent' : 'name',
        limit: Number(req.query.limit) || 100,
        offset: Number(req.query.offset) || 0,
      }),
    );
  });

  r.get('/actors/suggest', async (req, res) => {
    res.json({ items: await actors.suggestActors(ctxOf(res), str(req.query.q) ?? '') });
  });

  r.post('/actors', async (req, res) => {
    res.status(201).json(await actors.createActor(ctxOf(res), req.body));
  });

  r.post('/actors/merge/preview', async (req, res) => {
    const input = z
      .object({ targetId: z.string(), sourceIds: z.array(z.string()).min(1).max(50) })
      .parse(req.body);
    res.json(await actors.previewMerge(ctxOf(res), input.targetId, input.sourceIds));
  });

  r.post('/actors/merge', async (req, res) => {
    const input = z
      .object({
        targetId: z.string(),
        sourceIds: z.array(z.string()).min(1).max(50),
        extendHelperAccess: z.boolean().optional(),
      })
      .parse(req.body);
    res.json(
      await actors.mergeActors(ctxOf(res), input.targetId, input.sourceIds, {
        extendHelperAccess: input.extendHelperAccess,
      }),
    );
  });

  r.get('/actors/:id', async (req, res) => {
    res.json(await actors.getActor(ctxOf(res), String(req.params.id)));
  });

  r.patch('/actors/:id', async (req, res) => {
    res.json(await actors.updateActor(ctxOf(res), String(req.params.id), req.body));
  });

  r.post('/actors/:id/archive', async (req, res) => {
    const input = z.object({ archived: z.boolean() }).parse(req.body);
    res.json(await actors.setActorArchived(ctxOf(res), String(req.params.id), input.archived));
  });

  r.delete('/actors/:id', async (req, res) => {
    await actors.deleteActor(ctxOf(res), String(req.params.id));
    res.json({ ok: true });
  });

  r.post('/actors/:id/restore', async (req, res) => {
    res.json(await actors.restoreActor(ctxOf(res), String(req.params.id)));
  });

  // ------------------------------------------------------------ incidents
  r.get('/incidents', async (req, res) => {
    res.json(
      await incidents.listIncidents(ctxOf(res), {
        status: list(req.query.status),
        search: str(req.query.q),
        deleted: bool(req.query.deleted),
      }),
    );
  });

  r.post('/incidents', async (req, res) => {
    res.status(201).json(await incidents.createIncident(ctxOf(res), req.body));
  });

  r.get('/incidents/:id', async (req, res) => {
    res.json(
      await incidents.getIncident(ctxOf(res), String(req.params.id), {
        includeDeleted: bool(req.query.deleted),
      }),
    );
  });

  r.patch('/incidents/:id', async (req, res) => {
    res.json(await incidents.updateIncident(ctxOf(res), String(req.params.id), req.body));
  });

  r.delete('/incidents/:id', async (req, res) => {
    await incidents.deleteIncident(ctxOf(res), String(req.params.id));
    res.json({ ok: true });
  });

  r.post('/incidents/:id/restore', async (req, res) => {
    res.json(await incidents.restoreIncident(ctxOf(res), String(req.params.id)));
  });

  r.post('/incidents/:id/events', async (req, res) => {
    const input = z.object({ eventIds: z.array(z.string()).min(1).max(1000) }).parse(req.body);
    res.json({
      added: await incidents.addEventsToIncident(ctxOf(res), String(req.params.id), input.eventIds),
    });
  });

  r.delete('/incidents/:id/events/:eventId', async (req, res) => {
    await incidents.removeEventFromIncident(
      ctxOf(res),
      String(req.params.id),
      String(req.params.eventId),
    );
    res.json({ ok: true });
  });

  r.post('/incidents/:id/attachments', async (req, res) => {
    const ctx = ctxOf(res);
    const upload = await receiveUpload(req);
    try {
      res
        .status(201)
        .json(
          await attachments.storeAttachment(ctx, { incidentId: String(req.params.id) }, upload),
        );
    } finally {
      await rm(upload.tmpPath, { force: true });
    }
  });

  // ---------------------------------------------------------- attachments
  r.get('/attachments/:id', async (req, res) => {
    res.json(await attachments.getAttachment(ctxOf(res), String(req.params.id)));
  });
  r.get('/attachments/:id/original', (req, res) => streamAttachment(req, res, 'original'));
  r.get('/attachments/:id/thumbnail', (req, res) => streamAttachment(req, res, 'thumbnail'));
  r.get('/attachments/:id/preview', (req, res) => streamAttachment(req, res, 'preview'));

  r.get('/attachments/:id/text', async (req, res) => {
    res.json(await attachments.getAttachmentText(ctxOf(res), String(req.params.id)));
  });

  r.put('/attachments/:id/text', async (req, res) => {
    const input = z.object({ text: z.string().max(2_000_000).nullable() }).parse(req.body);
    res.json(
      await attachments.correctAttachmentText(ctxOf(res), String(req.params.id), input.text),
    );
  });

  r.delete('/attachments/:id', async (req, res) => {
    await attachments.deleteAttachment(ctxOf(res), String(req.params.id));
    res.json({ ok: true });
  });

  r.post('/attachments/:id/restore', async (req, res) => {
    res.json(await attachments.restoreAttachment(ctxOf(res), String(req.params.id)));
  });

  r.post('/attachments/:id/verify', async (req, res) => {
    const ctx = ctxOf(res);
    const integrity = await attachments.verifyAttachmentIntegrity(ctx, String(req.params.id));
    const timestamp = await verifyStoredProof('attachment', String(req.params.id)).catch(
      (err: Error) => ({ status: 'error', detail: err.message }),
    );
    res.json({ integrity, timestamp });
  });

  r.post('/attachments/:id/reprocess', async (req, res) => {
    const ctx = ctxOf(res);
    if (!isOwner(ctx)) throw new ForbiddenError();
    const a = await attachments.getAttachment(ctx, String(req.params.id));
    await db()
      .update(attachmentsTable)
      .set({
        ...(a.ocrStatus === 'failed' || a.ocrStatus === 'disabled'
          ? { ocrStatus: 'pending' as const }
          : {}),
        ...(a.derivativeStatus === 'failed' ? { derivativeStatus: 'pending' as const } : {}),
      })
      .where(eq(attachmentsTable.id, a.id));
    await enqueue(QUEUES.processAttachment, { attachmentId: a.id }, { singletonKey: a.id });
    res.json({ queued: true });
  });

  r.get('/attachments/:id/timestamp.ots', async (req, res) => {
    const ctx = ctxOf(res);
    const a = await attachments.getAttachment(ctx, String(req.params.id));
    const [row] = await db()
      .select({ proof: timestampProofs.proof })
      .from(timestampProofs)
      .where(
        and(eq(timestampProofs.subjectType, 'attachment'), eq(timestampProofs.subjectId, a.id)),
      )
      .limit(1);
    if (!row?.proof) throw new NotFoundError('Timestamp proof');
    res.set({
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': contentDisposition('attachment', `${a.originalFilename}.ots`),
    });
    res.send(row.proof);
  });

  // ---------------------------------------------------------------- search
  r.get('/search', async (req, res) => {
    const q = str(req.query.q) ?? '';
    if (q.length > 300) throw new ValidationError('Search text is too long');
    res.json(await search(ctxOf(res), q, { limit: Number(req.query.limit) || 20 }));
  });

  r.get('/search/suggest', async (req, res) => {
    res.json(await suggest(ctxOf(res), str(req.query.q) ?? ''));
  });

  // ---------------------------------------------------------------- export
  r.get('/export', async (_req, res) => {
    const { stream, filename } = await exportZip(ctxOf(res));
    res.set({
      'Content-Type': 'application/zip',
      'Content-Disposition': contentDisposition('attachment', filename),
      'Cache-Control': 'no-store',
    });
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  });

  // ----------------------------------------------------------------- trash
  r.get('/trash', async (_req, res) => {
    const ctx = ctxOf(res);
    if (!isOwner(ctx)) throw new ForbiddenError();
    const deletedEvents = await events.listEvents(ctx, { deleted: true }, { limit: 200 });
    const deletedIncidents = await incidents.listIncidents(ctx, { deleted: true });
    const deletedAttachments = await rows<{
      id: string;
      original_filename: string;
      deleted_at: Date;
      purge_after: Date;
      event_id: string | null;
      incident_id: string | null;
    }>(sql`
      SELECT id, original_filename, deleted_at, purge_after, event_id, incident_id FROM attachments
      WHERE owner_id = ${ctx.ownerId}::uuid AND deleted_at IS NOT NULL ORDER BY deleted_at DESC LIMIT 200`);
    const deletedActors = await rows<{
      id: string;
      name: string;
      deleted_at: Date;
      purge_after: Date;
    }>(sql`
      SELECT id, name, deleted_at, purge_after FROM actors WHERE owner_id = ${ctx.ownerId}::uuid AND deleted_at IS NOT NULL ORDER BY deleted_at DESC LIMIT 200`);
    const purge = await rows<{ id: string; purge_after: Date }>(
      sql`SELECT id, purge_after FROM events WHERE owner_id = ${ctx.ownerId}::uuid AND deleted_at IS NOT NULL`,
    );
    const purgeMap = new Map(purge.map((p) => [p.id, p.purge_after.toISOString()]));
    res.json({
      events: deletedEvents.items.map((e) => ({ ...e, purgeAfter: purgeMap.get(e.id) ?? null })),
      incidents: deletedIncidents.items,
      attachments: deletedAttachments.map((a) => ({
        id: a.id,
        filename: a.original_filename,
        deletedAt: a.deleted_at.toISOString(),
        purgeAfter: a.purge_after?.toISOString() ?? null,
        eventId: a.event_id,
        incidentId: a.incident_id,
      })),
      actors: deletedActors.map((a) => ({
        id: a.id,
        name: a.name,
        deletedAt: a.deleted_at.toISOString(),
        purgeAfter: a.purge_after?.toISOString() ?? null,
      })),
    });
  });

  return r;
}
