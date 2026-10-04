import type { NextFunction, Request, Response } from 'express';
import { findSession, touchSession } from '../auth/sessions.js';
import type { User } from '../auth/accounts.js';
import { config } from '../config.js';
import type { sessions } from '../db/schema.js';
import { resolveContext } from '../domain/access.js';
import type { AccessContext } from '../domain/context.js';
import { AppError, ForbiddenError, RateLimitedError, UnauthenticatedError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

export type Session = typeof sessions.$inferSelect;

export interface Locals {
  session?: Session;
  user?: User;
  ctx?: AccessContext;
}

export function locals(res: Response): Locals {
  return res.locals as Locals;
}

export function sessionCookieName(): string {
  // The __Host- prefix pins the cookie to this exact origin over HTTPS.
  return config().cookieSecure ? '__Host-or_session' : 'or_session';
}

export function setSessionCookie(res: Response, token: string, stage: 'mfa' | 'totp_setup' | 'active'): void {
  const c = config();
  res.cookie(sessionCookieName(), token, {
    httpOnly: true,
    secure: c.cookieSecure,
    sameSite: 'lax',
    path: '/',
    maxAge: stage === 'active' ? c.SESSION_MAX_AGE_HOURS * 3600_000 : 30 * 60_000,
  });
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(sessionCookieName(), { httpOnly: true, secure: config().cookieSecure, sameSite: 'lax', path: '/' });
}

export function requestMeta(req: Request) {
  return { ip: req.ip ?? null, userAgent: req.get('user-agent') ?? null };
}

/** Load the browser session (if any) from its cookie. */
export async function loadSession(req: Request, res: Response, next: NextFunction) {
  const token = req.cookies?.[sessionCookieName()] as string | undefined;
  if (token) {
    const found = await findSession(token);
    if (found) {
      locals(res).session = found.session;
      locals(res).user = found.user;
      await touchSession(found.session.id, found.session.lastSeenAt, requestMeta(req));
    } else {
      clearSessionCookie(res);
    }
  }
  next();
}

/**
 * CSRF protection for the JSON API. State-changing requests must carry the
 * X-CSRF-Token header (which a cross-site form cannot set without a CORS
 * preflight that we never approve) and, when signed in, it must equal the
 * session's CSRF token. A present Origin header must be this application.
 */
export function csrfProtection(req: Request, res: Response, next: NextFunction) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.get('origin');
  if (origin && origin !== config().appUrl.origin) {
    return next(new ForbiddenError('Cross-origin request refused'));
  }
  const header = req.get('x-csrf-token');
  const session = locals(res).session;
  if (!header || (session && header !== session.csrfToken)) {
    return next(new ForbiddenError('Security check failed. Please reload the page and try again.'));
  }
  next();
}

export function requireStage(...stages: Session['stage'][]) {
  return (_req: Request, res: Response, next: NextFunction) => {
    const session = locals(res).session;
    if (!session || !stages.includes(session.stage)) return next(new UnauthenticatedError());
    next();
  };
}

export const requireUser = requireStage('active');

export function requireAdmin(_req: Request, res: Response, next: NextFunction) {
  if (!locals(res).user?.isAdmin) return next(new ForbiddenError('Administrators only'));
  next();
}

/**
 * Resolve the record being worked on. The web UI sends the record owner's id
 * in X-OpenRampart-Record when a Helper is viewing someone else's record.
 */
export async function recordContext(req: Request, res: Response, next: NextFunction) {
  const user = locals(res).user;
  if (!user) return next(new UnauthenticatedError());
  // Images and documents are loaded by the browser without custom headers, so
  // GET requests may name the record in the query string instead.
  const fromQuery = req.method === 'GET' && typeof req.query.record === 'string' ? req.query.record : null;
  const requested = req.get('x-openrampart-record') || fromQuery || null;
  try {
    locals(res).ctx = await resolveContext({ userId: user.id, ownerId: requested, via: 'web', ...requestMeta(req) });
    next();
  } catch (err) {
    next(err);
  }
}

export function ctxOf(res: Response): AccessContext {
  const ctx = locals(res).ctx;
  if (!ctx) throw new UnauthenticatedError();
  return ctx;
}

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  if (err instanceof AppError) {
    if (err instanceof RateLimitedError) res.set('Retry-After', String(err.retryAfterSeconds));
    res.status(err.status).json({ error: { code: err.code, message: err.message, ...(err.details ?? {}) } });
    return;
  }
  const e = err as { type?: string; status?: number; message?: string };
  if (e?.type === 'entity.parse.failed') {
    res.status(400).json({ error: { code: 'bad_request', message: 'The request body is not valid JSON' } });
    return;
  }
  if (e?.type === 'entity.too.large') {
    res.status(413).json({ error: { code: 'too_large', message: 'The request is too large' } });
    return;
  }
  logger.error({ err: e?.message, path: req.path, method: req.method }, 'unhandled error');
  res.status(500).json({ error: { code: 'server_error', message: 'Something went wrong. Please try again.' } });
}
