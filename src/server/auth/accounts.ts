import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { config } from '../config.js';
import { db } from '../db/client.js';
import { passwordResetTokens, users } from '../db/schema.js';
import { audit } from '../domain/audit.js';
import { getSystemSettings } from '../domain/settings.js';
import { decryptSecret, encryptSecret, randomToken, tokenHash } from '../lib/crypto.js';
import {
  pgErrorCode,
  ConflictError,
  ForbiddenError,
  UnauthenticatedError,
  ValidationError,
} from '../lib/errors.js';
import { passwordResetEmail, securityNotificationEmail } from '../mail/templates.js';
import { mailConfigured, sendMail, sendNotification } from '../mail/index.js';
import {
  burnPasswordCheck,
  hashPassword,
  needsRehash,
  validatePassword,
  verifyPassword,
} from './passwords.js';
import * as rate from './rateLimit.js';
import {
  consumeRecoveryCode,
  looksLikeRecoveryCode,
  regenerateRecoveryCodes,
  remainingRecoveryCodes,
} from './recoveryCodes.js';
import { createSession, revokeAllSessions, revokeSession, type SessionMeta } from './sessions.js';
import { checkTotp, formatSecretForDisplay, newTotpSecret, totpQrSvg, totpUri } from './totp.js';

export type User = typeof users.$inferSelect;

export interface PublicUser {
  id: string;
  username: string;
  email: string | null;
  displayName: string;
  isAdmin: boolean;
  timezone: string;
  totpEnabled: boolean;
  lastLoginAt: Date | null;
  previousLoginAt: Date | null;
  previousLoginIp: string | null;
  createdAt: Date;
}

export function toPublicUser(u: User): PublicUser {
  return {
    id: u.id,
    username: u.username,
    email: u.email,
    displayName: u.displayName,
    isAdmin: u.isAdmin,
    timezone: u.timezone,
    totpEnabled: u.totpEnabledAt !== null,
    lastLoginAt: u.lastLoginAt,
    previousLoginAt: u.previousLoginAt,
    previousLoginIp: u.previousLoginIp,
    createdAt: u.createdAt,
  };
}

const USERNAME_RE = /^[A-Za-z0-9._-]{3,64}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

async function userCount(): Promise<number> {
  const [row] = await db().select({ n: sql<number>`count(*)::int` }).from(users);
  return row?.n ?? 0;
}

export async function registrationStatus(): Promise<{ open: boolean; firstUser: boolean }> {
  const count = await userCount();
  if (count === 0) return { open: true, firstUser: true };
  const { registrationMode } = await getSystemSettings();
  return { open: registrationMode === 'open', firstUser: false };
}

export interface NewAccountInput {
  username: string;
  email?: string | null;
  displayName: string;
  password: string;
  timezone?: string;
}

/**
 * Create an account. `viaInvitation` allows Helper sign-up when public
 * registration is closed; the invitation itself is validated by the caller.
 */
export async function createAccount(
  input: NewAccountInput,
  meta: SessionMeta,
  opts: { viaInvitation?: boolean; forceAdmin?: boolean } = {},
): Promise<User> {
  const fields: Record<string, string> = {};
  const username = input.username.trim();
  const email = input.email?.trim() || null;
  const displayName = input.displayName.trim();
  if (!USERNAME_RE.test(username)) {
    fields.username = 'Use 3–64 letters, numbers, dots, hyphens or underscores.';
  }
  if (email && (!EMAIL_RE.test(email) || email.length > 320)) fields.email = 'Enter a valid email address.';
  if (!displayName || displayName.length > 120) fields.displayName = 'Enter a name of up to 120 characters.';
  const timezone = input.timezone?.trim() || 'Europe/London';
  if (!isValidTimezone(timezone)) fields.timezone = 'Choose a valid time zone.';
  if (Object.keys(fields).length) throw new ValidationError('Please correct the highlighted fields', fields);
  validatePassword(input.password, { username, email });

  const status = await registrationStatus();
  if (!status.open && !opts.viaInvitation && !opts.forceAdmin) {
    throw new ForbiddenError('New accounts can only be created with an invitation on this server');
  }

  const passwordHash = await hashPassword(input.password);
  try {
    const created = await db().transaction(async (tx) => {
      // Serialise first-account creation so two simultaneous sign-ups cannot both become admin.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(7314201002)`);
      const [{ n }] = (await tx.select({ n: sql<number>`count(*)::int` }).from(users)) as [{ n: number }];
      const [user] = await tx
        .insert(users)
        .values({
          username,
          email,
          displayName,
          passwordHash,
          timezone,
          isAdmin: n === 0 || Boolean(opts.forceAdmin),
        })
        .returning();
      return user!;
    });
    await audit({
      action: 'auth.account_created',
      ownerId: created.id,
      actorUserId: created.id,
      targetType: 'user',
      targetId: created.id,
      ip: meta.ip,
      userAgent: meta.userAgent,
      metadata: { admin: created.isAdmin, viaInvitation: Boolean(opts.viaInvitation) },
    });
    return created;
  } catch (err) {
    if (pgErrorCode(err) === '23505') {
      throw new ConflictError('That username or email address is already in use');
    }
    throw err;
  }
}

export async function findUserByLogin(login: string): Promise<User | undefined> {
  const value = login.trim().toLowerCase();
  const [user] = await db()
    .select()
    .from(users)
    .where(sql`lower(${users.username}) = ${value} OR lower(${users.email}) = ${value}`)
    .limit(2);
  return user;
}

export async function getUser(id: string): Promise<User | undefined> {
  const [user] = await db().select().from(users).where(eq(users.id, id)).limit(1);
  return user;
}

export interface LoginResult {
  token: string;
  stage: 'mfa' | 'totp_setup' | 'active';
  user: User;
}

/** Step one: username/email + password. */
export async function loginWithPassword(login: string, password: string, meta: SessionMeta): Promise<LoginResult> {
  const ipKey = meta.ip ?? 'unknown';
  await rate.hit('loginIp', ipKey);
  await rate.assertNotBlocked('loginAccount', login);
  const user = await findUserByLogin(login);
  if (!user || user.disabledAt) {
    await burnPasswordCheck(password);
    await rate.hit('loginAccount', login).catch(() => undefined);
    await audit({
      action: 'auth.login_failed',
      outcome: 'failure',
      ip: meta.ip,
      userAgent: meta.userAgent,
      metadata: { reason: 'unknown_account' },
    });
    throw new UnauthenticatedError('The username, email or password is not correct');
  }
  const ok = await verifyPassword(user.passwordHash, password);
  if (!ok) {
    await db()
      .update(users)
      .set({ failedLoginCount: sql`${users.failedLoginCount} + 1`, lastFailedLoginAt: new Date() })
      .where(eq(users.id, user.id));
    await audit({
      action: 'auth.login_failed',
      outcome: 'failure',
      ownerId: user.id,
      actorUserId: null,
      ip: meta.ip,
      userAgent: meta.userAgent,
      metadata: { reason: 'bad_password' },
    });
    try {
      await rate.hit('loginAccount', login);
    } catch (err) {
      await audit({ action: 'auth.locked', outcome: 'failure', ownerId: user.id, ip: meta.ip, userAgent: meta.userAgent });
      throw err;
    }
    throw new UnauthenticatedError('The username, email or password is not correct');
  }
  if (needsRehash(user.passwordHash)) {
    await db().update(users).set({ passwordHash: await hashPassword(password) }).where(eq(users.id, user.id));
  }
  let stage: LoginResult['stage'];
  if (user.totpEnabledAt) stage = 'mfa';
  else if (config().REQUIRE_TOTP) stage = 'totp_setup';
  else stage = 'active';
  const { token } = await createSession(user.id, stage, meta);
  if (stage === 'active') await completeLogin(user, meta, null);
  return { token, stage, user };
}

async function completeLogin(user: User, meta: SessionMeta, method: 'totp' | 'recovery_code' | null) {
  await db()
    .update(users)
    .set({
      previousLoginAt: user.lastLoginAt,
      previousLoginIp: user.lastLoginIp,
      lastLoginAt: new Date(),
      lastLoginIp: meta.ip ?? null,
      lastLoginUserAgent: meta.userAgent?.slice(0, 400) ?? null,
      failedLoginCount: 0,
    })
    .where(eq(users.id, user.id));
  await rate.reset('loginAccount', user.username).catch(() => undefined);
  if (user.email) await rate.reset('loginAccount', user.email).catch(() => undefined);
  await audit({
    action: 'auth.login',
    ownerId: user.id,
    actorUserId: user.id,
    ip: meta.ip,
    userAgent: meta.userAgent,
    metadata: { method: method ?? 'password' },
  });
  await audit({ action: 'session.created', ownerId: user.id, actorUserId: user.id, ip: meta.ip, userAgent: meta.userAgent });
}

/**
 * Step two: a TOTP code or a single-use recovery code. The intermediate
 * session is revoked and a fresh session token is issued (no fixation).
 */
export async function verifySecondFactor(
  mfaSessionId: string,
  user: User,
  code: string,
  meta: SessionMeta,
): Promise<{ token: string; usedRecoveryCode: boolean; remainingRecoveryCodes?: number }> {
  await rate.hit('mfa', user.id);
  let method: 'totp' | 'recovery_code' | null = null;
  if (user.totpSecretEnc && /^\s*\d{3}\s?\d{3}\s*$/.test(code)) {
    const result = await checkTotp(decryptSecret(user.totpSecretEnc), code, user.totpLastStep);
    if (result.valid) {
      method = 'totp';
      await db().update(users).set({ totpLastStep: result.timeStep ?? null }).where(eq(users.id, user.id));
    }
  } else if (looksLikeRecoveryCode(code) && (await consumeRecoveryCode(user.id, code))) {
    method = 'recovery_code';
  }
  if (!method) {
    await audit({
      action: 'auth.totp_failed',
      outcome: 'failure',
      ownerId: user.id,
      actorUserId: user.id,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    throw new UnauthenticatedError('That code is not correct. Check your authenticator app and try again.');
  }
  await rate.reset('mfa', user.id).catch(() => undefined);
  await revokeSession(mfaSessionId, 'mfa_completed');
  const { token } = await createSession(user.id, 'active', meta, method);
  await completeLogin(user, meta, method);
  if (method === 'recovery_code') {
    const remaining = await remainingRecoveryCodes(user.id);
    await audit({
      action: 'auth.recovery_code_used',
      ownerId: user.id,
      actorUserId: user.id,
      ip: meta.ip,
      userAgent: meta.userAgent,
      metadata: { remaining },
    });
    if (user.email) {
      await sendNotification(
        securityNotificationEmail({
          to: user.email,
          summary: 'a recovery code was used',
          detail: `A recovery code was used to sign in to your account. You have ${remaining} unused recovery codes left.`,
          url: `${config().APP_URL}/settings/security`,
        }),
      );
    }
    return { token, usedRecoveryCode: true, remainingRecoveryCodes: remaining };
  }
  return { token, usedRecoveryCode: false };
}

/** Begin (or restart) TOTP enrolment. The secret stays pending until confirmed. */
export async function beginTotpSetup(user: User) {
  const secret = newTotpSecret();
  await db().update(users).set({ totpPendingSecretEnc: encryptSecret(secret) }).where(eq(users.id, user.id));
  const uri = totpUri(secret, user.email ?? user.username);
  return {
    uri,
    secret,
    secretDisplay: formatSecretForDisplay(secret),
    qrSvg: await totpQrSvg(uri),
  };
}

/**
 * Confirm enrolment with a code from the app. Generates fresh recovery codes.
 * If the account already had TOTP (re-enrolment), the current code is required.
 */
export async function confirmTotpSetup(
  user: User,
  code: string,
  meta: SessionMeta,
  opts: { currentSessionId?: string; currentCode?: string } = {},
): Promise<{ recoveryCodes: string[] }> {
  await rate.hit('mfa', user.id);
  if (!user.totpPendingSecretEnc) throw new ValidationError('Start authenticator setup first');
  if (user.totpEnabledAt) {
    if (!opts.currentCode || !user.totpSecretEnc) {
      throw new ValidationError('Enter a code from your current authenticator to replace it', {
        currentCode: 'Enter a code from your existing authenticator app.',
      });
    }
    const current = await checkTotp(decryptSecret(user.totpSecretEnc), opts.currentCode, user.totpLastStep);
    if (!current.valid) throw new ValidationError('The code from your current authenticator is not correct', {
      currentCode: 'That code is not correct.',
    });
  }
  const secret = decryptSecret(user.totpPendingSecretEnc);
  const result = await checkTotp(secret, code);
  if (!result.valid) {
    throw new ValidationError('That code is not correct', {
      code: 'That code is not correct. Make sure the time on your phone is set automatically.',
    });
  }
  const wasEnabled = Boolean(user.totpEnabledAt);
  const recoveryCodes = await db().transaction(async (tx) => {
    await tx
      .update(users)
      .set({
        totpSecretEnc: encryptSecret(secret),
        totpPendingSecretEnc: null,
        totpEnabledAt: new Date(),
        totpLastStep: result.timeStep ?? null,
      })
      .where(eq(users.id, user.id));
    return regenerateRecoveryCodes(user.id, tx);
  });
  await audit({
    action: wasEnabled ? 'auth.totp_reset' : 'auth.totp_enabled',
    ownerId: user.id,
    actorUserId: user.id,
    ip: meta.ip,
    userAgent: meta.userAgent,
  });
  if (wasEnabled && user.email) {
    await sendNotification(
      securityNotificationEmail({
        to: user.email,
        summary: 'authenticator app changed',
        detail: 'The authenticator app used for two-factor sign-in on your account was replaced.',
        url: `${config().APP_URL}/settings/security`,
      }),
    );
  }
  if (opts.currentSessionId) await revokeAllSessions(user.id, 'totp_changed', opts.currentSessionId);
  return { recoveryCodes };
}

/** Upgrade a `totp_setup` session to a full session once enrolment completes. */
export async function finishEnrolmentLogin(setupSessionId: string, user: User, meta: SessionMeta) {
  await revokeSession(setupSessionId, 'totp_enrolled');
  const { token } = await createSession(user.id, 'active', meta, 'totp');
  const fresh = (await getUser(user.id))!;
  await completeLogin(fresh, meta, 'totp');
  return { token };
}

async function requireReauth(user: User, password: string, meta: SessionMeta): Promise<void> {
  await rate.hit('sensitive', user.id);
  if (!(await verifyPassword(user.passwordHash, password))) {
    await audit({
      action: 'auth.login_failed',
      outcome: 'failure',
      ownerId: user.id,
      actorUserId: user.id,
      ip: meta.ip,
      userAgent: meta.userAgent,
      metadata: { reason: 'reauthentication' },
    });
    throw new ValidationError('Your current password is not correct', {
      currentPassword: 'Your current password is not correct.',
    });
  }
}

export async function newRecoveryCodes(user: User, password: string, meta: SessionMeta): Promise<string[]> {
  await requireReauth(user, password, meta);
  const codes = await regenerateRecoveryCodes(user.id);
  await audit({ action: 'auth.recovery_codes_regenerated', ownerId: user.id, actorUserId: user.id, ip: meta.ip, userAgent: meta.userAgent });
  return codes;
}

export async function changePassword(
  user: User,
  currentPassword: string,
  newPassword: string,
  meta: SessionMeta & { sessionId: string },
): Promise<{ token: string }> {
  await requireReauth(user, currentPassword, meta);
  validatePassword(newPassword, { username: user.username, email: user.email });
  await db()
    .update(users)
    .set({ passwordHash: await hashPassword(newPassword), passwordChangedAt: new Date(), updatedAt: new Date() })
    .where(eq(users.id, user.id));
  await revokeAllSessions(user.id, 'password_changed');
  const { token } = await createSession(user.id, 'active', meta, null);
  await audit({ action: 'auth.password_changed', ownerId: user.id, actorUserId: user.id, ip: meta.ip, userAgent: meta.userAgent });
  if (user.email) {
    await sendNotification(
      securityNotificationEmail({
        to: user.email,
        summary: 'password changed',
        detail: 'The password for your OpenRampart account was changed and other sessions were signed out.',
        url: `${config().APP_URL}/settings/security`,
      }),
    );
  }
  return { token };
}

export async function updateProfile(
  user: User,
  input: { displayName?: string; email?: string | null; timezone?: string },
): Promise<User> {
  const patch: Partial<typeof users.$inferInsert> = { updatedAt: new Date() };
  const fields: Record<string, string> = {};
  if (input.displayName !== undefined) {
    const v = input.displayName.trim();
    if (!v || v.length > 120) fields.displayName = 'Enter a name of up to 120 characters.';
    patch.displayName = v;
  }
  if (input.email !== undefined) {
    const v = input.email?.trim() || null;
    if (v && !EMAIL_RE.test(v)) fields.email = 'Enter a valid email address.';
    patch.email = v;
  }
  if (input.timezone !== undefined) {
    if (!isValidTimezone(input.timezone)) fields.timezone = 'Choose a valid time zone.';
    patch.timezone = input.timezone;
  }
  if (Object.keys(fields).length) throw new ValidationError('Please correct the highlighted fields', fields);
  try {
    const [updated] = await db().update(users).set(patch).where(eq(users.id, user.id)).returning();
    return updated!;
  } catch (err) {
    if (pgErrorCode(err) === '23505') throw new ConflictError('That email address is already in use');
    throw err;
  }
}

/** Always responds the same way whether or not the account exists. */
export async function requestPasswordReset(login: string, meta: SessionMeta): Promise<void> {
  await rate.hit('passwordReset', meta.ip ?? 'unknown');
  const user = await findUserByLogin(login);
  if (!user || !user.email || user.disabledAt || !mailConfigured()) return;
  const token = randomToken(32);
  await db()
    .insert(passwordResetTokens)
    .values({ userId: user.id, tokenHash: tokenHash(token, 'password-reset'), expiresAt: new Date(Date.now() + 3600_000) });
  await audit({ action: 'auth.password_reset_requested', ownerId: user.id, ip: meta.ip, userAgent: meta.userAgent });
  await sendMail(passwordResetEmail({ to: user.email, url: `${config().APP_URL}/reset-password/${token}` }));
}

export async function completePasswordReset(token: string, newPassword: string, meta: SessionMeta): Promise<void> {
  await rate.hit('passwordReset', meta.ip ?? 'unknown');
  const now = new Date();
  const [row] = await db()
    .update(passwordResetTokens)
    .set({ usedAt: now })
    .where(
      and(
        eq(passwordResetTokens.tokenHash, tokenHash(token, 'password-reset')),
        isNull(passwordResetTokens.usedAt),
        gt(passwordResetTokens.expiresAt, now),
      ),
    )
    .returning();
  if (!row) throw new ValidationError('This reset link is invalid or has expired. Request a new one.');
  const user = await getUser(row.userId);
  if (!user || user.disabledAt) throw new ValidationError('This reset link is invalid or has expired.');
  validatePassword(newPassword, { username: user.username, email: user.email });
  await db()
    .update(users)
    .set({ passwordHash: await hashPassword(newPassword), passwordChangedAt: now })
    .where(eq(users.id, user.id));
  await revokeAllSessions(user.id, 'password_reset');
  await audit({ action: 'auth.password_reset', ownerId: user.id, actorUserId: user.id, ip: meta.ip, userAgent: meta.userAgent });
}

/** Administrative: clear a user's TOTP so they must re-enrol at next sign-in. */
export async function adminResetTotp(admin: User, targetId: string, meta: SessionMeta): Promise<void> {
  if (!admin.isAdmin) throw new ForbiddenError();
  await db()
    .update(users)
    .set({ totpSecretEnc: null, totpPendingSecretEnc: null, totpEnabledAt: null, totpLastStep: null })
    .where(eq(users.id, targetId));
  await revokeAllSessions(targetId, 'admin_totp_reset');
  await audit({
    action: 'admin.action',
    ownerId: targetId,
    actorUserId: admin.id,
    targetType: 'user',
    targetId,
    ip: meta.ip,
    userAgent: meta.userAgent,
    metadata: { operation: 'reset_totp' },
  });
}

export async function adminSetDisabled(admin: User, targetId: string, disabled: boolean, meta: SessionMeta) {
  if (!admin.isAdmin) throw new ForbiddenError();
  if (admin.id === targetId) throw new ValidationError('You cannot disable your own account');
  await db().update(users).set({ disabledAt: disabled ? new Date() : null }).where(eq(users.id, targetId));
  if (disabled) await revokeAllSessions(targetId, 'account_disabled');
  await audit({
    action: 'admin.action',
    ownerId: targetId,
    actorUserId: admin.id,
    targetType: 'user',
    targetId,
    ip: meta.ip,
    userAgent: meta.userAgent,
    metadata: { operation: disabled ? 'disable_account' : 'enable_account' },
  });
}

export async function adminSetAdmin(admin: User, targetId: string, isAdmin: boolean, meta: SessionMeta) {
  if (!admin.isAdmin) throw new ForbiddenError();
  if (admin.id === targetId && !isAdmin) throw new ValidationError('You cannot remove your own administrator role');
  await db().update(users).set({ isAdmin }).where(eq(users.id, targetId));
  await audit({
    action: 'admin.action',
    ownerId: targetId,
    actorUserId: admin.id,
    targetType: 'user',
    targetId,
    ip: meta.ip,
    userAgent: meta.userAgent,
    metadata: { operation: isAdmin ? 'grant_admin' : 'revoke_admin' },
  });
}

export async function listUsersForAdmin() {
  return db()
    .select({
      id: users.id,
      username: users.username,
      email: users.email,
      displayName: users.displayName,
      isAdmin: users.isAdmin,
      totpEnabledAt: users.totpEnabledAt,
      lastLoginAt: users.lastLoginAt,
      disabledAt: users.disabledAt,
      createdAt: users.createdAt,
    })
    .from(users)
    .orderBy(users.createdAt);
}
