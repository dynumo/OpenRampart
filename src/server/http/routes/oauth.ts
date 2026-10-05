import type { NextFunction, Request, Response, Router as ExpressRouter } from 'express';
import { Router } from 'express';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { z } from 'zod';
import * as rate from '../../auth/rateLimit.js';
import { config } from '../../config.js';
import {
  approveInteraction,
  DEFAULT_SCOPES,
  denyInteraction,
  describeInteraction,
  verifyAccessToken,
} from '../../oauth/connections.js';
import { getProvider, INTERACTION_PATH, OAUTH_MOUNT } from '../../oauth/provider.js';
import { authInfoFor, mcpHandler, protectedResourceMetadataUrl } from '../../mcp/server.js';
import { OAUTH_SCOPES } from '../../../shared/scopes.js';
import { AppError, RateLimitedError, UnauthenticatedError } from '../../lib/errors.js';
import { csrfProtection, locals, requestMeta, requireUser } from '../middleware.js';

/** Consent screen API, used by the web UI page at /oauth/interaction/:uid. */
export function interactionRouter(): ExpressRouter {
  const r = Router();
  r.get('/:uid/details', requireUser, async (req, res) => {
    res.json(await describeInteraction(req, res, locals(res).user!.id));
  });
  r.post('/:uid/approve', requireUser, csrfProtection, async (req, res) => {
    const input = z
      .object({ ownerId: z.string().uuid(), scopes: z.array(z.string()).max(20) })
      .parse(req.body);
    const redirectTo = await approveInteraction(req, res, {
      userId: locals(res).user!.id,
      ...input,
      ...requestMeta(req),
    });
    res.json({ redirectTo });
  });
  r.post('/:uid/deny', requireUser, csrfProtection, async (req, res) => {
    res.json({
      redirectTo: await denyInteraction(req, res, locals(res).user!.id, requestMeta(req)),
    });
  });
  return r;
}

/** Hand a request to oidc-provider (mounted at /oauth). */
export async function oauthProvider(req: Request, res: Response, next: NextFunction) {
  try {
    if (['/oauth/token', '/oauth/register', '/oauth/revoke'].includes(req.path)) {
      await rate.hit('oauthToken', req.ip ?? 'unknown');
    }
    const provider = await getProvider();
    // A client that asks for no scope gets the read-only default set (RFC 6749 §3.3).
    if (req.method === 'GET' && req.path === '/authorize' && !req.query.scope) {
      const url = new URL(req.url, 'http://x');
      url.searchParams.set('scope', DEFAULT_SCOPES.join(' '));
      req.url = url.pathname + url.search;
      req.originalUrl = OAUTH_MOUNT + req.url;
    }
    // Express has already stripped the /oauth mount from req.url; oidc-provider
    // derives its mount path from req.originalUrl, so endpoint URLs stay correct.
    provider.callback()(req, res);
  } catch (err) {
    if (err instanceof RateLimitedError) {
      res
        .set('Retry-After', String(err.retryAfterSeconds))
        .status(429)
        .json({ error: 'slow_down', error_description: err.message });
      return;
    }
    next(err);
  }
}

/** RFC 8414 / OpenID discovery documents served from the issuer root. */
export async function authorizationServerMetadata(req: Request, res: Response, next: NextFunction) {
  try {
    const provider = await getProvider();
    // Present the request as if it reached the mounted provider, so the
    // endpoints it advertises carry the /oauth prefix.
    req.url = '/.well-known/openid-configuration';
    req.originalUrl = `${OAUTH_MOUNT}/.well-known/openid-configuration`;
    provider.callback()(req, res);
  } catch (err) {
    next(err);
  }
}

/** RFC 9728 Protected Resource Metadata for the MCP endpoint. */
export function protectedResourceMetadata(_req: Request, res: Response) {
  const c = config();
  res.set({ 'Cache-Control': 'public, max-age=3600', 'Access-Control-Allow-Origin': '*' });
  res.json({
    resource: c.mcpResourceUrl,
    authorization_servers: [c.oauthIssuer],
    scopes_supported: [...OAUTH_SCOPES],
    bearer_methods_supported: ['header'],
    resource_name: 'OpenRampart',
    resource_documentation: 'https://github.com/dynumo/OpenRampart/blob/main/docs/mcp.md',
  });
}

function challenge(res: Response, status: 401 | 403, params: Record<string, string>) {
  const parts = [
    `resource_metadata="${protectedResourceMetadataUrl()}"`,
    ...Object.entries(params).map(([k, v]) => `${k}="${v.replace(/"/g, "'")}"`),
  ];
  res.set('WWW-Authenticate', `Bearer ${parts.join(', ')}`);
  res.status(status).json({
    error: params.error ?? 'unauthorized',
    error_description: params.error_description ?? 'Authorisation required',
  });
}

const MCP_CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers':
    'Authorization, Content-Type, Accept, Mcp-Protocol-Version, Mcp-Session-Id, Mcp-Method, Last-Event-ID',
  'Access-Control-Expose-Headers': 'WWW-Authenticate, Mcp-Session-Id, Mcp-Protocol-Version',
  'Access-Control-Max-Age': '600',
};

let nodeHandler: ReturnType<typeof toNodeHandler> | undefined;

/**
 * The MCP endpoint. Only bearer tokens issued by this server for this resource
 * are accepted; the token never leaves OpenRampart (no pass-through).
 */
export async function mcpEndpoint(req: Request, res: Response, next: NextFunction) {
  res.set(MCP_CORS_HEADERS);
  if (req.method === 'OPTIONS') return void res.status(204).end();
  // DNS-rebinding protection: the Host must be this server.
  const host = req.get('host');
  if (host && host.toLowerCase() !== new URL(config().mcpResourceUrl).host.toLowerCase()) {
    return void res
      .status(403)
      .json({ error: 'forbidden', error_description: 'Unexpected Host header' });
  }
  const header = req.get('authorization') ?? '';
  const match = /^Bearer\s+([A-Za-z0-9\-._~+/]+=*)$/i.exec(header);
  if (!match) {
    return challenge(res, 401, {
      scope: DEFAULT_SCOPES.join(' '),
      error_description: 'Authorisation required',
    });
  }
  try {
    const verified = await verifyAccessToken(match[1]!);
    (req as Request & { auth?: unknown }).auth = await authInfoFor(verified, requestMeta(req));
  } catch (err) {
    if (err instanceof UnauthenticatedError || err instanceof AppError) {
      return challenge(res, 401, { error: 'invalid_token', error_description: err.message });
    }
    return next(err);
  }
  nodeHandler ??= toNodeHandler(mcpHandler(), { maxRequestBodySize: 32 * 1024 * 1024 });
  await nodeHandler(req, res);
}

export const INTERACTION_BASE = INTERACTION_PATH;
