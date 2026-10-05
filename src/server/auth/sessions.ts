import { and, desc, eq, gt, isNull, ne, sql } from 'drizzle-orm';
import { config } from '../config.js';
import { db } from '../db/client.js';
import { sessions, users } from '../db/schema.js';
import { randomToken, tokenHash } from '../lib/crypto.js';

/**
 * Server-side sessions. The browser holds only a random 256-bit token in an
 * HttpOnly cookie; the database stores a keyed hash of it, so a database leak
 * does not yield usable session tokens.
 *
 * Stages:
 *  - mfa         password accepted, waiting for a TOTP or recovery code
 *  - totp_setup  password accepted, account must enrol TOTP before continuing
 *  - active      fully signed in
 */
export type SessionStage = 'mfa' | 'totp_setup' | 'active';

export interface SessionMeta {
  ip?: string | null;
  userAgent?: string | null;
}

const STAGE_TTL_MINUTES: Record<Exclude<SessionStage, 'active'>, number> = {
  mfa: 10,
  totp_setup: 30,
};

export async function createSession(
  userId: string,
  stage: SessionStage,
  meta: SessionMeta,
  mfaMethod: 'totp' | 'recovery_code' | null = null,
) {
  const token = randomToken(32);
  const ttlMs =
    stage === 'active'
      ? config().SESSION_MAX_AGE_HOURS * 3600_000
      : STAGE_TTL_MINUTES[stage] * 60_000;
  const [session] = await db()
    .insert(sessions)
    .values({
      userId,
      tokenHash: tokenHash(token, 'session'),
      csrfToken: randomToken(24),
      stage,
      mfaMethod,
      expiresAt: new Date(Date.now() + ttlMs),
      ip: meta.ip ?? null,
      userAgent: meta.userAgent?.slice(0, 400) ?? null,
    })
    .returning();
  return { token, session: session! };
}

export async function findSession(token: string) {
  if (!token || token.length > 200) return null;
  const now = new Date();
  const rows = await db()
    .select({ session: sessions, user: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(
      and(
        eq(sessions.tokenHash, tokenHash(token, 'session')),
        isNull(sessions.revokedAt),
        gt(sessions.expiresAt, now),
        isNull(users.disabledAt),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  if (row.session.stage === 'active') {
    const idleMs = config().SESSION_IDLE_TIMEOUT_MINUTES * 60_000;
    if (now.getTime() - row.session.lastSeenAt.getTime() > idleMs) {
      await revokeSession(row.session.id, 'idle_timeout');
      return null;
    }
    // A password change invalidates sessions created before it.
    if (row.session.createdAt.getTime() < row.user.passwordChangedAt.getTime() - 1000) {
      await revokeSession(row.session.id, 'password_changed');
      return null;
    }
  }
  return row;
}

/** Update last-seen at most once a minute to avoid a write per request. */
export async function touchSession(
  sessionId: string,
  lastSeenAt: Date,
  meta: SessionMeta,
): Promise<void> {
  if (Date.now() - lastSeenAt.getTime() < 60_000) return;
  await db()
    .update(sessions)
    .set({ lastSeenAt: new Date(), ip: meta.ip ?? null })
    .where(eq(sessions.id, sessionId));
}

export async function revokeSession(
  sessionId: string,
  reason: string,
  userId?: string,
): Promise<boolean> {
  const rows = await db()
    .update(sessions)
    .set({ revokedAt: new Date(), revokedReason: reason })
    .where(
      and(
        eq(sessions.id, sessionId),
        isNull(sessions.revokedAt),
        ...(userId ? [eq(sessions.userId, userId)] : []),
      ),
    )
    .returning({ id: sessions.id });
  return rows.length > 0;
}

export async function revokeAllSessions(
  userId: string,
  reason: string,
  exceptSessionId?: string,
): Promise<number> {
  const rows = await db()
    .update(sessions)
    .set({ revokedAt: new Date(), revokedReason: reason })
    .where(
      and(
        eq(sessions.userId, userId),
        isNull(sessions.revokedAt),
        ...(exceptSessionId ? [ne(sessions.id, exceptSessionId)] : []),
      ),
    )
    .returning({ id: sessions.id });
  return rows.length;
}

export async function listSessions(userId: string) {
  return db()
    .select({
      id: sessions.id,
      stage: sessions.stage,
      createdAt: sessions.createdAt,
      lastSeenAt: sessions.lastSeenAt,
      expiresAt: sessions.expiresAt,
      ip: sessions.ip,
      userAgent: sessions.userAgent,
      mfaMethod: sessions.mfaMethod,
    })
    .from(sessions)
    .where(
      and(
        eq(sessions.userId, userId),
        isNull(sessions.revokedAt),
        gt(sessions.expiresAt, new Date()),
        eq(sessions.stage, 'active'),
      ),
    )
    .orderBy(desc(sessions.lastSeenAt));
}

/** Remove long-expired and revoked session rows (housekeeping job). */
export async function pruneSessions(): Promise<number> {
  const result = await db().execute(
    sql`DELETE FROM sessions WHERE expires_at < now() - interval '30 days' OR revoked_at < now() - interval '30 days'`,
  );
  return result.rowCount ?? 0;
}
