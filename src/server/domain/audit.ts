import { and, desc, eq, lt, or, sql, type SQL } from 'drizzle-orm';
import { db, type Executor } from '../db/client.js';
import { auditEntries } from '../db/schema.js';
import { logger } from '../lib/logger.js';
import type { AccessContext } from './context.js';

/**
 * Security Audit Log. Separate from the personal Event timeline: routine
 * application activity is recorded here and never becomes an Event unless the
 * owner explicitly converts an entry.
 *
 * Metadata must contain identifiers and non-sensitive facts only — never
 * passwords, tokens, attachment contents or OCR text.
 */

export type AuditAction =
  | 'auth.login'
  | 'auth.login_failed'
  | 'auth.totp_failed'
  | 'auth.recovery_code_used'
  | 'auth.logout'
  | 'auth.account_created'
  | 'auth.password_changed'
  | 'auth.password_reset_requested'
  | 'auth.password_reset'
  | 'auth.totp_enabled'
  | 'auth.totp_reset'
  | 'auth.recovery_codes_regenerated'
  | 'auth.locked'
  | 'session.created'
  | 'session.revoked'
  | 'helper.invited'
  | 'helper.invitation_revoked'
  | 'helper.accepted'
  | 'helper.ended'
  | 'grant.created'
  | 'grant.updated'
  | 'grant.revoked'
  | 'event.created'
  | 'event.updated'
  | 'event.deleted'
  | 'event.restored'
  | 'event.purged'
  | 'event.linked'
  | 'event.unlinked'
  | 'actor.created'
  | 'actor.updated'
  | 'actor.archived'
  | 'actor.deleted'
  | 'actor.restored'
  | 'actor.merged'
  | 'incident.created'
  | 'incident.updated'
  | 'incident.deleted'
  | 'incident.restored'
  | 'incident.event_added'
  | 'incident.event_removed'
  | 'attachment.uploaded'
  | 'attachment.downloaded'
  | 'attachment.deleted'
  | 'attachment.restored'
  | 'attachment.ocr_corrected'
  | 'attachment.integrity_checked'
  | 'export.created'
  | 'oauth.granted'
  | 'oauth.revoked'
  | 'oauth.denied'
  | 'mcp.access'
  | 'admin.action';

export interface AuditInput {
  action: AuditAction;
  ownerId?: string | null;
  actorUserId?: string | null;
  outcome?: 'success' | 'failure';
  targetType?: string;
  targetId?: string;
  via?: 'web' | 'mcp' | 'system' | 'cli';
  oauthClientId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  metadata?: Record<string, unknown>;
}

export async function audit(entry: AuditInput, executor: Executor = db()): Promise<void> {
  try {
    await executor.insert(auditEntries).values({
      action: entry.action,
      ownerId: entry.ownerId ?? null,
      actorUserId: entry.actorUserId ?? null,
      outcome: entry.outcome ?? 'success',
      targetType: entry.targetType ?? null,
      targetId: entry.targetId ?? null,
      via: entry.via ?? 'web',
      oauthClientId: entry.oauthClientId ?? null,
      ip: entry.ip ?? null,
      userAgent: entry.userAgent?.slice(0, 400) ?? null,
      metadata: entry.metadata ?? {},
    });
  } catch (err) {
    // Audit failure must be visible to operators but must not leak content.
    logger.error(
      { err: (err as Error).message, action: entry.action },
      'failed to write audit entry',
    );
    if (executor !== db()) throw err;
  }
}

/** Record an action performed through an AccessContext. */
export function auditCtx(
  ctx: AccessContext,
  action: AuditAction,
  target: { type?: string; id?: string; metadata?: Record<string, unknown> } = {},
  executor?: Executor,
): Promise<void> {
  return audit(
    {
      action,
      ownerId: ctx.ownerId,
      actorUserId: ctx.userId,
      targetType: target.type,
      targetId: target.id,
      via: ctx.via,
      oauthClientId: ctx.oauth?.clientId ?? null,
      ip: ctx.ip ?? null,
      userAgent: ctx.userAgent ?? null,
      metadata: {
        ...(ctx.role === 'helper' ? { asHelper: true } : {}),
        ...(target.metadata ?? {}),
      },
    },
    executor,
  );
}

export interface AuditQuery {
  before?: number;
  limit?: number;
  action?: string;
}

/**
 * Entries visible to a user: activity on their own account/record (including
 * what Helpers and MCP clients did there) plus their own actions elsewhere.
 * Entries about other owners' records are only shown when the user performed
 * them, and never include that owner's record content.
 */
export async function listAuditEntries(userId: string, q: AuditQuery = {}) {
  const conditions: SQL[] = [
    or(eq(auditEntries.ownerId, userId), eq(auditEntries.actorUserId, userId))!,
  ];
  if (q.before) conditions.push(lt(auditEntries.id, q.before));
  if (q.action)
    conditions.push(sql`${auditEntries.action} LIKE ${q.action.replace(/[%_]/g, '') + '%'}`);
  const limit = Math.min(Math.max(q.limit ?? 50, 1), 200);
  const rows = await db()
    .select()
    .from(auditEntries)
    .where(and(...conditions))
    .orderBy(desc(auditEntries.id))
    .limit(limit + 1);
  return {
    entries: rows.slice(0, limit).map((r) => ({
      ...r,
      // Another owner's IP/user agent are not shown to a Helper.
      ip: r.ownerId === userId || r.actorUserId === userId ? r.ip : null,
      ownRecord: r.ownerId === userId,
    })),
    nextBefore: rows.length > limit ? rows[limit - 1]!.id : null,
  };
}
