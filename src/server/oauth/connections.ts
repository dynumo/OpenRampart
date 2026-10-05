import type { IncomingMessage, ServerResponse } from 'node:http';
import { and, desc, eq, isNull, or, sql } from 'drizzle-orm';
import { OAUTH_SCOPES, type OAuthScope } from '../../shared/scopes.js';
import { config } from '../config.js';
import { db } from '../db/client.js';
import { oauthConnections, users } from '../db/schema.js';
import { sharedRecords } from '../domain/access.js';
import { audit } from '../domain/audit.js';
import { NotFoundError, UnauthenticatedError, ValidationError } from '../lib/errors.js';
import { destroyGrantArtefacts } from './adapter.js';
import { getProvider, isOurResource } from './provider.js';

/**
 * The consent step of the OAuth flow, MCP access-token verification and the
 * user's list of connected applications ("MCP Connections").
 */

/** Requested when a client asks for no particular scope: read-only basics. */
export const DEFAULT_SCOPES: OAuthScope[] = [
  'events:read',
  'incidents:read',
  'actors:read',
  'search:read',
  'attachments:metadata',
];

function parseScopes(scope: unknown): OAuthScope[] {
  const requested = String(scope ?? '')
    .split(/\s+/)
    .filter((s): s is OAuthScope => (OAUTH_SCOPES as readonly string[]).includes(s));
  return requested.length ? [...new Set(requested)] : DEFAULT_SCOPES;
}

function isLoopback(uri: string): boolean {
  try {
    const host = new URL(uri).hostname;
    return (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '[::1]' ||
      host.endsWith('.localhost')
    );
  } catch {
    return false;
  }
}

export interface InteractionView {
  uid: string;
  client: {
    id: string;
    name: string;
    uri: string | null;
    registration: 'metadata_document' | 'dynamic' | 'static';
  };
  redirectUri: string;
  redirectHost: string;
  redirectIsLocalhost: boolean;
  resource: string;
  requestedScopes: OAuthScope[];
  records: { ownerId: string; name: string; relationship: 'own' | 'helper' }[];
}

export async function describeInteraction(
  req: IncomingMessage,
  res: ServerResponse,
  userId: string,
): Promise<InteractionView> {
  const provider = await getProvider();
  const details = await provider.interactionDetails(req, res);
  const params = details.params as Record<string, string | undefined>;
  const client = await provider.Client.find(String(params.client_id));
  if (!client) throw new NotFoundError('Application');
  const resource = params.resource ?? config().mcpResourceUrl;
  if (!isOurResource(resource))
    throw new ValidationError('This application asked for access to an unknown resource');
  const redirectUri = String(params.redirect_uri ?? client.redirectUris?.[0] ?? '');
  const [me] = await db()
    .select({ displayName: users.displayName })
    .from(users)
    .where(eq(users.id, userId));
  const shared = await sharedRecords(userId);
  const meta = client as unknown as {
    clientIdMetadataDocument?: boolean;
    clientName?: string;
    clientUri?: string;
    metadata(): Record<string, unknown>;
  };
  const md = meta.metadata();
  return {
    uid: details.uid,
    client: {
      id: client.clientId,
      name: String(md.client_name ?? client.clientId),
      uri: (md.client_uri as string | undefined) ?? null,
      registration: meta.clientIdMetadataDocument
        ? 'metadata_document'
        : md.registration_access_token || md.client_id_issued_at
          ? 'dynamic'
          : 'static',
    },
    redirectUri,
    redirectHost: (() => {
      try {
        return new URL(redirectUri).host;
      } catch {
        return redirectUri;
      }
    })(),
    redirectIsLocalhost: isLoopback(redirectUri),
    resource,
    requestedScopes: parseScopes(params.scope),
    records: [
      { ownerId: userId, name: me?.displayName ?? 'Your record', relationship: 'own' },
      ...shared.map((s) => ({
        ownerId: s.ownerId,
        name: s.ownerName,
        relationship: 'helper' as const,
      })),
    ],
  };
}

export async function approveInteraction(
  req: IncomingMessage,
  res: ServerResponse,
  input: {
    userId: string;
    ownerId: string;
    scopes: string[];
    ip?: string | null;
    userAgent?: string | null;
  },
): Promise<string> {
  const provider = await getProvider();
  const view = await describeInteraction(req, res, input.userId);
  if (!view.records.some((r) => r.ownerId === input.ownerId))
    throw new ValidationError('Choose a record to share');
  const granted = input.scopes.filter((s): s is OAuthScope =>
    view.requestedScopes.includes(s as OAuthScope),
  );
  if (!granted.length) throw new ValidationError('Allow at least one permission, or choose Deny');
  const details = await provider.interactionDetails(req, res);
  const params = details.params as Record<string, string | undefined>;
  const grant = new provider.Grant({ accountId: input.userId, clientId: view.client.id });
  grant.addResourceScope(view.resource, granted.join(' '));
  // Scopes the user unticked are recorded as rejected so the request completes
  // with only what was allowed (the client sees the narrower scope in the token response).
  const rejected = String(params.scope ?? '')
    .split(/\s+/)
    .filter(
      (s) => s && s !== 'openid' && s !== 'offline_access' && !granted.includes(s as OAuthScope),
    );
  if (rejected.length) grant.rejectResourceScope(view.resource, rejected.join(' '));
  const requestedOidc = String(params.scope ?? '')
    .split(/\s+/)
    .filter((s) => s === 'openid' || s === 'offline_access');
  if (requestedOidc.length) grant.addOIDCScope(requestedOidc.join(' '));
  const grantId = await grant.save();
  await db().insert(oauthConnections).values({
    grantId,
    userId: input.userId,
    ownerId: input.ownerId,
    clientId: view.client.id,
    clientName: view.client.name,
    clientUri: view.client.uri,
    redirectHost: view.redirectHost,
    scopes: granted,
  });
  await audit({
    action: 'oauth.granted',
    ownerId: input.ownerId,
    actorUserId: input.userId,
    targetType: 'oauth_connection',
    targetId: grantId,
    oauthClientId: view.client.id,
    ip: input.ip,
    userAgent: input.userAgent,
    metadata: {
      client: view.client.name,
      scopes: granted,
      redirectHost: view.redirectHost,
      registration: view.client.registration,
    },
  });
  return provider.interactionResult(
    req,
    res,
    {
      login: { accountId: input.userId, amr: ['pwd', 'otp'], remember: false },
      consent: { grantId },
    },
    { mergeWithLastSubmission: false },
  );
}

export async function denyInteraction(
  req: IncomingMessage,
  res: ServerResponse,
  userId: string,
  meta: { ip?: string | null; userAgent?: string | null },
): Promise<string> {
  const provider = await getProvider();
  const details = await provider.interactionDetails(req, res);
  await audit({
    action: 'oauth.denied',
    ownerId: userId,
    actorUserId: userId,
    oauthClientId: String((details.params as Record<string, unknown>).client_id ?? ''),
    ip: meta.ip,
    userAgent: meta.userAgent,
  });
  return provider.interactionResult(
    req,
    res,
    { error: 'access_denied', error_description: 'The account holder declined this request.' },
    { mergeWithLastSubmission: false },
  );
}

export interface VerifiedToken {
  token: string;
  userId: string;
  ownerId: string;
  clientId: string;
  clientName: string | null;
  grantId: string;
  scopes: string[];
  expiresAt: number;
}

/**
 * Validate an MCP bearer token: it must be a live access token issued by this
 * server, for this MCP resource (audience), backed by a grant the user has not
 * revoked. A token from any other issuer, or for any other audience, is refused.
 */
export async function verifyAccessToken(token: string): Promise<VerifiedToken> {
  if (!token || token.length > 512) throw new UnauthenticatedError('Invalid access token');
  const provider = await getProvider();
  const at = await provider.AccessToken.find(token);
  if (!at || at.isExpired) throw new UnauthenticatedError('Invalid or expired access token');
  const audiences = Array.isArray(at.aud) ? at.aud : [at.aud];
  if (!audiences.some((a) => typeof a === 'string' && isOurResource(a))) {
    throw new UnauthenticatedError('Access token was not issued for this resource');
  }
  if (!at.accountId || !at.grantId) throw new UnauthenticatedError('Invalid access token');
  const [conn] = await db()
    .select()
    .from(oauthConnections)
    .where(and(eq(oauthConnections.grantId, at.grantId), isNull(oauthConnections.revokedAt)))
    .limit(1);
  if (!conn || conn.userId !== at.accountId || conn.clientId !== at.clientId) {
    throw new UnauthenticatedError('This connection has been revoked');
  }
  const [user] = await db()
    .select({ disabledAt: users.disabledAt })
    .from(users)
    .where(eq(users.id, conn.userId));
  if (!user || user.disabledAt) throw new UnauthenticatedError('Account disabled');
  if (!conn.lastUsedAt || Date.now() - conn.lastUsedAt.getTime() > 60_000) {
    await db()
      .update(oauthConnections)
      .set({ lastUsedAt: new Date() })
      .where(eq(oauthConnections.grantId, conn.grantId));
  }
  // Scopes are the intersection of what the token carries and what was consented.
  const tokenScopes = String(at.scope ?? '')
    .split(/\s+/)
    .filter(Boolean);
  const scopes = tokenScopes.filter((s) => conn.scopes.includes(s));
  return {
    token,
    userId: conn.userId,
    ownerId: conn.ownerId,
    clientId: conn.clientId,
    clientName: conn.clientName,
    grantId: conn.grantId,
    scopes,
    expiresAt: at.exp ?? 0,
  };
}

export async function listConnections(userId: string) {
  const list = await db()
    .select({
      grantId: oauthConnections.grantId,
      clientId: oauthConnections.clientId,
      clientName: oauthConnections.clientName,
      clientUri: oauthConnections.clientUri,
      redirectHost: oauthConnections.redirectHost,
      scopes: oauthConnections.scopes,
      createdAt: oauthConnections.createdAt,
      lastUsedAt: oauthConnections.lastUsedAt,
      userId: oauthConnections.userId,
      ownerId: oauthConnections.ownerId,
      userName: users.displayName,
    })
    .from(oauthConnections)
    .innerJoin(users, eq(users.id, oauthConnections.userId))
    .where(
      and(
        isNull(oauthConnections.revokedAt),
        or(eq(oauthConnections.userId, userId), eq(oauthConnections.ownerId, userId)),
      ),
    )
    .orderBy(desc(oauthConnections.createdAt));
  return list.map((c) => ({
    ...c,
    createdAt: c.createdAt.toISOString(),
    lastUsedAt: c.lastUsedAt?.toISOString() ?? null,
    authorisedByYou: c.userId === userId,
    onYourRecord: c.ownerId === userId,
  }));
}

/** Revoke a connection: its grant, access tokens and refresh tokens stop working immediately. */
export async function revokeConnection(
  userId: string,
  grantId: string,
  meta: { ip?: string | null; userAgent?: string | null },
): Promise<void> {
  const [conn] = await db()
    .select()
    .from(oauthConnections)
    .where(
      and(
        eq(oauthConnections.grantId, grantId),
        isNull(oauthConnections.revokedAt),
        or(eq(oauthConnections.userId, userId), eq(oauthConnections.ownerId, userId)),
      ),
    )
    .limit(1);
  if (!conn) throw new NotFoundError('Connection');
  await db()
    .update(oauthConnections)
    .set({ revokedAt: new Date() })
    .where(eq(oauthConnections.grantId, grantId));
  await destroyGrantArtefacts(grantId);
  await audit({
    action: 'oauth.revoked',
    ownerId: conn.ownerId,
    actorUserId: userId,
    targetType: 'oauth_connection',
    targetId: grantId,
    oauthClientId: conn.clientId,
    ip: meta.ip,
    userAgent: meta.userAgent,
    metadata: { client: conn.clientName },
  });
}

export async function revokeAllConnectionsFor(userId: string): Promise<number> {
  const list = await db()
    .update(oauthConnections)
    .set({ revokedAt: new Date() })
    .where(and(eq(oauthConnections.userId, userId), isNull(oauthConnections.revokedAt)))
    .returning({ grantId: oauthConnections.grantId });
  for (const c of list) await destroyGrantArtefacts(c.grantId);
  void sql;
  return list.length;
}
