import { Router } from 'express';
import { z } from 'zod';
import {
  beginTotpSetup,
  changePassword,
  completePasswordReset,
  confirmTotpSetup,
  createAccount,
  finishEnrolmentLogin,
  getUser,
  loginWithPassword,
  newRecoveryCodes,
  registrationStatus,
  requestPasswordReset,
  toPublicUser,
  updateProfile,
  verifySecondFactor,
} from '../../auth/accounts.js';
import * as rate from '../../auth/rateLimit.js';
import { remainingRecoveryCodes } from '../../auth/recoveryCodes.js';
import { createSession, listSessions, revokeAllSessions, revokeSession } from '../../auth/sessions.js';
import { config } from '../../config.js';
import { sharedRecords } from '../../domain/access.js';
import { audit } from '../../domain/audit.js';
import { acceptInvitation, describeInvitation } from '../../domain/helpers.js';
import { UnauthenticatedError, ValidationError } from '../../lib/errors.js';
import { mailConfigured } from '../../mail/index.js';
import {
  clearSessionCookie,
  locals,
  requestMeta,
  requireStage,
  requireUser,
  setSessionCookie,
} from '../middleware.js';

function body<T extends z.ZodTypeAny>(schema: T, input: unknown): z.output<T> {
  const r = schema.safeParse(input);
  if (!r.success) {
    const fields: Record<string, string> = {};
    for (const i of r.error.issues) fields[i.path.join('.') || 'input'] = i.message;
    throw new ValidationError('Please check the details entered', fields);
  }
  return r.data;
}

const accountSchema = z.object({
  username: z.string().max(64),
  email: z.string().max(320).nullish(),
  displayName: z.string().max(120),
  password: z.string().max(256),
  timezone: z.string().max(64).optional(),
});

export function authRouter(): Router {
  const r = Router();

  r.get('/state', async (_req, res) => {
    const { user, session } = locals(res);
    const registration = await registrationStatus();
    const base = {
      registration,
      mailConfigured: mailConfigured(),
      requireTotp: config().REQUIRE_TOTP,
      maxUploadMb: config().MAX_UPLOAD_MB,
    };
    if (!user || !session) return res.json({ ...base, stage: null });
    res.json({
      ...base,
      stage: session.stage,
      csrfToken: session.csrfToken,
      user: session.stage === 'active' ? toPublicUser(user) : { displayName: user.displayName, username: user.username },
      sharedRecords: session.stage === 'active' ? await sharedRecords(user.id) : [],
      recoveryCodesRemaining: session.stage === 'active' && user.totpEnabledAt ? await remainingRecoveryCodes(user.id) : null,
    });
  });

  r.post('/register', async (req, res) => {
    await rate.hit('register', req.ip ?? 'unknown');
    const input = body(accountSchema, req.body);
    const user = await createAccount(input, requestMeta(req));
    const stage = config().REQUIRE_TOTP ? 'totp_setup' : 'active';
    const { token } = await createSession(user.id, stage, requestMeta(req));
    setSessionCookie(res, token, stage);
    res.status(201).json({ stage });
  });

  r.post('/login', async (req, res) => {
    const input = body(z.object({ login: z.string().min(1).max(320), password: z.string().min(1).max(256) }), req.body);
    const result = await loginWithPassword(input.login, input.password, requestMeta(req));
    setSessionCookie(res, result.token, result.stage);
    res.json({ stage: result.stage });
  });

  r.post('/mfa', requireStage('mfa'), async (req, res) => {
    const input = body(z.object({ code: z.string().min(1).max(40) }), req.body);
    const { session, user } = locals(res);
    const result = await verifySecondFactor(session!.id, user!, input.code, requestMeta(req));
    setSessionCookie(res, result.token, 'active');
    res.json({ stage: 'active', usedRecoveryCode: result.usedRecoveryCode, remainingRecoveryCodes: result.remainingRecoveryCodes ?? null });
  });

  r.post('/totp/begin', requireStage('totp_setup', 'active'), async (_req, res) => {
    res.json(await beginTotpSetup(locals(res).user!));
  });

  r.post('/totp/confirm', requireStage('totp_setup', 'active'), async (req, res) => {
    const input = body(z.object({ code: z.string().min(1).max(20), currentCode: z.string().max(20).optional() }), req.body);
    const { session } = locals(res);
    const user = (await getUser(locals(res).user!.id))!;
    const result = await confirmTotpSetup(user, input.code, requestMeta(req), {
      currentSessionId: session!.stage === 'active' ? session!.id : undefined,
      currentCode: input.currentCode,
    });
    if (session!.stage === 'totp_setup') {
      const { token } = await finishEnrolmentLogin(session!.id, user, requestMeta(req));
      setSessionCookie(res, token, 'active');
    }
    res.json({ recoveryCodes: result.recoveryCodes });
  });

  r.post('/logout', async (req, res) => {
    const { session, user } = locals(res);
    if (session) {
      await revokeSession(session.id, 'logout');
      await audit({ action: 'auth.logout', ownerId: user?.id, actorUserId: user?.id, ...requestMeta(req) });
    }
    clearSessionCookie(res);
    res.json({ ok: true });
  });

  r.post('/password', requireUser, async (req, res) => {
    const input = body(z.object({ currentPassword: z.string().max(256), newPassword: z.string().max(256) }), req.body);
    const { user, session } = locals(res);
    const { token } = await changePassword(user!, input.currentPassword, input.newPassword, { ...requestMeta(req), sessionId: session!.id });
    setSessionCookie(res, token, 'active');
    res.json({ ok: true });
  });

  r.post('/recovery-codes', requireUser, async (req, res) => {
    const input = body(z.object({ password: z.string().max(256) }), req.body);
    res.json({ recoveryCodes: await newRecoveryCodes(locals(res).user!, input.password, requestMeta(req)) });
  });

  r.patch('/profile', requireUser, async (req, res) => {
    const input = body(z.object({ displayName: z.string().max(120).optional(), email: z.string().max(320).nullish(), timezone: z.string().max(64).optional() }), req.body);
    const user = await updateProfile(locals(res).user!, input);
    res.json({ user: toPublicUser(user) });
  });

  r.get('/sessions', requireUser, async (_req, res) => {
    const { user, session } = locals(res);
    const list = await listSessions(user!.id);
    res.json({ sessions: list.map((s) => ({ ...s, current: s.id === session!.id })) });
  });

  r.delete('/sessions/:id', requireUser, async (req, res) => {
    const { user } = locals(res);
    const ok = await revokeSession(String(req.params.id), 'revoked_by_user', user!.id);
    if (!ok) throw new ValidationError('That session was not found');
    await audit({ action: 'session.revoked', ownerId: user!.id, actorUserId: user!.id, targetType: 'session', targetId: String(req.params.id), ...requestMeta(req) });
    res.json({ ok: true });
  });

  r.post('/sessions/revoke-others', requireUser, async (req, res) => {
    const { user, session } = locals(res);
    const count = await revokeAllSessions(user!.id, 'revoked_by_user', session!.id);
    await audit({ action: 'session.revoked', ownerId: user!.id, actorUserId: user!.id, ...requestMeta(req), metadata: { count, allOthers: true } });
    res.json({ revoked: count });
  });

  r.post('/password-reset/request', async (req, res) => {
    const input = body(z.object({ login: z.string().min(1).max(320) }), req.body);
    await requestPasswordReset(input.login, requestMeta(req));
    res.json({ ok: true });
  });

  r.post('/password-reset/complete', async (req, res) => {
    const input = body(z.object({ token: z.string().min(10).max(100), password: z.string().max(256) }), req.body);
    await completePasswordReset(input.token, input.password, requestMeta(req));
    res.json({ ok: true });
  });

  return r;
}

export function invitationRouter(): Router {
  const r = Router();

  r.get('/:token', async (req, res) => {
    await rate.hit('invitation', req.ip ?? 'unknown');
    res.json(await describeInvitation(String(req.params.token)));
  });

  r.post('/:token/accept', requireUser, async (req, res) => {
    await rate.hit('invitation', req.ip ?? 'unknown');
    const result = await acceptInvitation(String(req.params.token), locals(res).user!.id, requestMeta(req));
    res.json(result);
  });

  /** Create an account and accept in one step (registration closed or not). */
  r.post('/:token/register', async (req, res) => {
    await rate.hit('invitation', req.ip ?? 'unknown');
    const token = String(req.params.token);
    const state = await describeInvitation(token);
    if (state.state !== 'valid') throw new ValidationError('This invitation link is no longer valid. Ask for a new one.');
    const input = body(accountSchema, req.body);
    const user = await createAccount(input, requestMeta(req), { viaInvitation: true });
    await acceptInvitation(token, user.id, requestMeta(req));
    const stage = config().REQUIRE_TOTP ? 'totp_setup' : 'active';
    const session = await createSession(user.id, stage, requestMeta(req));
    setSessionCookie(res, session.token, stage);
    res.status(201).json({ stage, ownerId: (await sharedRecords(user.id))[0]?.ownerId ?? null });
  });

  return r;
}

export function requireNoSession() {
  return (_req: unknown, res: import('express').Response, next: import('express').NextFunction) => {
    if (locals(res).session?.stage === 'active') return next(new UnauthenticatedError('Already signed in'));
    next();
  };
}
