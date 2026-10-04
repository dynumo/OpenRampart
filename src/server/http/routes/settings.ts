import { Router } from 'express';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  adminResetTotp,
  adminSetAdmin,
  adminSetDisabled,
  listUsersForAdmin,
} from '../../auth/accounts.js';
import { config } from '../../config.js';
import { db } from '../../db/client.js';
import { auditEntries } from '../../db/schema.js';
import { resolveContext, sharedRecords } from '../../domain/access.js';
import { audit, listAuditEntries } from '../../domain/audit.js';
import { createEventType, updateEventType } from '../../domain/eventTypes.js';
import { createEvent } from '../../domain/events.js';
import * as helpers from '../../domain/helpers.js';
import { getSystemSettings, setSystemSetting } from '../../domain/settings.js';
import { rows } from '../../domain/sqlutil.js';
import { toolVersion } from '../../ocr/engine.js';
import { listConnections, revokeConnection } from '../../oauth/connections.js';
import { ForbiddenError, NotFoundError, ValidationError } from '../../lib/errors.js';
import { mailConfigured, mailProvider, sendMail } from '../../mail/index.js';
import { locals, requestMeta, requireAdmin } from '../middleware.js';

async function ownerCtx(res: import('express').Response, req: import('express').Request) {
  // Settings always act on the signed-in user's own record.
  return resolveContext({ userId: locals(res).user!.id, via: 'web', ...requestMeta(req) });
}

export function settingsRouter(): Router {
  const r = Router();

  // -------------------------------------------------------------- helpers
  r.get('/helpers', async (req, res) => {
    res.json({ items: await helpers.listHelpers(await ownerCtx(res, req)) });
  });

  r.post('/helpers', async (req, res) => {
    const input = z
      .object({ label: z.string().max(120), email: z.string().max(320).nullish(), sendEmail: z.boolean().optional(), grant: z.record(z.string(), z.unknown()) })
      .parse(req.body);
    res.status(201).json(await helpers.inviteHelper(await ownerCtx(res, req), input as Parameters<typeof helpers.inviteHelper>[1]));
  });

  r.post('/helpers/:id/reinvite', async (req, res) => {
    const input = z.object({ sendEmail: z.boolean().optional() }).parse(req.body ?? {});
    res.json(await helpers.reissueInvitation(await ownerCtx(res, req), String(req.params.id), input.sendEmail ?? true));
  });

  r.post('/helpers/:id/grants', async (req, res) => {
    res.status(201).json(await helpers.addGrant(await ownerCtx(res, req), String(req.params.id), req.body));
  });

  r.put('/grants/:id', async (req, res) => {
    res.json(await helpers.updateGrant(await ownerCtx(res, req), String(req.params.id), req.body));
  });

  r.delete('/grants/:id', async (req, res) => {
    await helpers.revokeGrant(await ownerCtx(res, req), String(req.params.id));
    res.json({ ok: true });
  });

  r.delete('/helpers/:id', async (req, res) => {
    await helpers.endHelper(await ownerCtx(res, req), String(req.params.id));
    res.json({ ok: true });
  });

  // ---------------------------------------------------- shared with me
  r.get('/shared', async (_req, res) => {
    res.json({ items: await sharedRecords(locals(res).user!.id) });
  });

  r.delete('/shared/:ownerId', async (req, res) => {
    await helpers.leaveRecord(locals(res).user!.id, String(req.params.ownerId));
    res.json({ ok: true });
  });

  // ------------------------------------------------------------ audit log
  r.get('/audit', async (req, res) => {
    const before = Number(req.query.before) || undefined;
    const action = typeof req.query.action === 'string' ? req.query.action : undefined;
    res.json(await listAuditEntries(locals(res).user!.id, { before, action, limit: Number(req.query.limit) || 50 }));
  });

  /** Turn an Audit Log entry into a normal Event — only ever on request. */
  r.post('/audit/:id/event', async (req, res) => {
    const user = locals(res).user!;
    const input = z.object({ typeId: z.string().optional(), title: z.string().max(300).optional() }).parse(req.body ?? {});
    const [entry] = await db()
      .select()
      .from(auditEntries)
      .where(and(eq(auditEntries.id, Number(req.params.id)), eq(auditEntries.ownerId, user.id)))
      .limit(1);
    if (!entry) throw new NotFoundError('Audit entry');
    const ctx = await ownerCtx(res, req);
    const description = [
      `Recorded from the security Audit Log.`,
      `Activity: ${entry.action}${entry.outcome === 'failure' ? ' (failed)' : ''}`,
      entry.ip ? `IP address: ${entry.ip}` : null,
      entry.userAgent ? `Device: ${entry.userAgent}` : null,
      entry.oauthClientId ? `Connected application: ${entry.oauthClientId}` : null,
    ]
      .filter(Boolean)
      .join('\n');
    const event = await createEvent(ctx, {
      typeId: input.typeId ?? 'portal',
      title: input.title ?? `Account activity: ${entry.action.replace(/[._]/g, ' ')}`,
      occurredAt: entry.occurredAt.toISOString(),
      description,
    });
    res.status(201).json(event);
  });

  // ------------------------------------------------- MCP / OAuth connections
  r.get('/connections', async (_req, res) => {
    res.json({ items: await listConnections(locals(res).user!.id) });
  });

  r.delete('/connections/:grantId', async (req, res) => {
    await revokeConnection(locals(res).user!.id, String(req.params.grantId), requestMeta(req));
    res.json({ ok: true });
  });

  // -------------------------------------------------------------- storage
  r.get('/storage', async (_req, res) => {
    const userId = locals(res).user!.id;
    const [usage] = await rows<Record<string, number>>(sql`
      SELECT count(*)::int AS files,
             coalesce(sum(size_bytes), 0)::bigint AS bytes,
             count(*) FILTER (WHERE deleted_at IS NOT NULL)::int AS deleted_files,
             count(*) FILTER (WHERE ocr_status = 'done')::int AS ocr_done,
             count(*) FILTER (WHERE ocr_status IN ('pending','processing'))::int AS ocr_pending,
             count(*) FILTER (WHERE ocr_status = 'failed')::int AS ocr_failed,
             count(*) FILTER (WHERE integrity_ok = false)::int AS integrity_failures
      FROM attachments WHERE owner_id = ${userId}::uuid`);
    const [ts] = await rows<Record<string, number>>(sql`
      SELECT count(*) FILTER (WHERE status = 'complete')::int AS complete,
             count(*) FILTER (WHERE status IN ('queued','pending'))::int AS pending,
             count(*) FILTER (WHERE status = 'failed')::int AS failed
      FROM timestamp_proofs WHERE owner_id = ${userId}::uuid`);
    const c = config();
    res.json({
      usage: { ...usage, bytes: Number(usage?.bytes ?? 0) },
      timestamps: ts,
      settings: {
        bucket: c.S3_BUCKET,
        endpointHost: c.S3_ENDPOINT ? new URL(c.S3_ENDPOINT).host : 'AWS S3',
        region: c.S3_REGION,
        maxUploadMb: c.MAX_UPLOAD_MB,
        retentionDays: c.DELETION_RETENTION_DAYS,
        ocrEnabled: c.OCR_ENABLED,
        ocrLanguages: c.OCR_LANGUAGES,
        timestampProvider: c.TIMESTAMP_PROVIDER,
      },
    });
  });

  // ---------------------------------------------------------------- admin
  const admin = Router();
  admin.use(requireAdmin);

  admin.get('/system', async (_req, res) => {
    const c = config();
    const [counts] = await rows<Record<string, number>>(sql`SELECT (SELECT count(*)::int FROM users) AS users, (SELECT count(*)::int FROM events) AS events, (SELECT count(*)::int FROM attachments) AS attachments`);
    res.json({
      settings: await getSystemSettings(),
      environment: {
        appUrl: c.APP_URL,
        mcpResource: c.mcpResourceUrl,
        oauthIssuer: c.oauthIssuer,
        requireTotp: c.REQUIRE_TOTP,
        mailProvider: mailProvider()?.name ?? 'none',
        mailFrom: c.MAIL_FROM_ADDRESS ?? null,
        timestampProvider: c.TIMESTAMP_PROVIDER,
        ocrEnabled: c.OCR_ENABLED,
        oauthDynamicRegistration: c.OAUTH_ENABLE_DCR,
        oauthClientMetadataDocuments: c.OAUTH_ENABLE_CIMD,
        telemetry: 'none',
      },
      tools: {
        tesseract: await toolVersion('tesseract'),
        ocrmypdf: await toolVersion('ocrmypdf'),
        pdftotext: await toolVersion('pdftotext'),
        pdftoppm: await toolVersion('pdftoppm'),
        heifConvert: await toolVersion('heif-convert'),
      },
      counts,
    });
  });

  admin.patch('/settings', async (req, res) => {
    const input = z.object({ registrationMode: z.enum(['first-user', 'open', 'closed']) }).parse(req.body);
    await setSystemSetting('registrationMode', input.registrationMode, locals(res).user!.id);
    await audit({ action: 'admin.action', actorUserId: locals(res).user!.id, ...requestMeta(req), metadata: { operation: 'registration_mode', value: input.registrationMode } });
    res.json(await getSystemSettings());
  });

  admin.get('/users', async (_req, res) => {
    res.json({ items: await listUsersForAdmin() });
  });

  admin.post('/users/:id/:action', async (req, res) => {
    const me = locals(res).user!;
    const id = String(req.params.id);
    switch (req.params.action) {
      case 'disable':
        await adminSetDisabled(me, id, true, requestMeta(req));
        break;
      case 'enable':
        await adminSetDisabled(me, id, false, requestMeta(req));
        break;
      case 'reset-totp':
        await adminResetTotp(me, id, requestMeta(req));
        break;
      case 'make-admin':
        await adminSetAdmin(me, id, true, requestMeta(req));
        break;
      case 'remove-admin':
        await adminSetAdmin(me, id, false, requestMeta(req));
        break;
      default:
        throw new NotFoundError('Action');
    }
    res.json({ ok: true });
  });

  admin.post('/event-types', async (req, res) => {
    res.status(201).json(await createEventType(req.body, locals(res).user!.id));
  });

  admin.patch('/event-types/:id', async (req, res) => {
    res.json(await updateEventType(String(req.params.id), req.body, locals(res).user!.id));
  });

  admin.post('/test-email', async (req, res) => {
    const input = z.object({ to: z.string().email() }).parse(req.body);
    if (!mailConfigured()) throw new ValidationError('No mail provider is configured (MAIL_PROVIDER)');
    await sendMail({
      to: input.to,
      subject: 'OpenRampart test email',
      text: 'This is a test message from your OpenRampart server. Email delivery is working.',
      html: '<p>This is a test message from your OpenRampart server. Email delivery is working.</p>',
    });
    await audit({ action: 'admin.action', actorUserId: locals(res).user!.id, ...requestMeta(req), metadata: { operation: 'test_email' } });
    res.json({ ok: true });
  });

  r.use('/admin', admin);
  void ForbiddenError;
  return r;
}
