import { expandScopes, type OAuthScope } from '../../shared/scopes.js';
import { ForbiddenError, InsufficientScopeError } from '../lib/errors.js';

/**
 * Every domain operation receives an AccessContext describing who is acting,
 * on whose record, through which interface, and with what limits. All
 * authorisation decisions are derived from it on the server.
 */

export interface ResolvedGrant {
  id: string;
  relationshipId: string;
  scopeType: 'all' | 'actors' | 'incidents';
  actorIds: string[];
  incidentIds: string[];
  dateFrom: string | null;
  dateTo: string | null;
  canAdd: boolean;
  canExport: boolean;
  coActorVisibility: 'redacted' | 'name';
}

export interface OAuthAccess {
  clientId: string;
  grantId: string;
  scopes: Set<OAuthScope>;
}

export interface AccessContext {
  /** The signed-in account performing the action. */
  userId: string;
  /** The account whose record is being accessed. */
  ownerId: string;
  /** IANA timezone of the record owner, used for date-bounded grants. */
  ownerTimezone: string;
  role: 'owner' | 'helper';
  /** Active grants (helpers only). Empty for owners. */
  grants: ResolvedGrant[];
  via: 'web' | 'mcp' | 'system' | 'cli';
  oauth?: OAuthAccess;
  ip?: string | null;
  userAgent?: string | null;
}

export function isOwner(ctx: AccessContext): boolean {
  return ctx.role === 'owner' && ctx.userId === ctx.ownerId;
}

/**
 * OAuth scope enforcement. Web sessions are not scope-limited; MCP/OAuth
 * access must hold every listed scope.
 */
export function requireScopes(ctx: AccessContext, ...scopes: OAuthScope[]): void {
  if (!ctx.oauth) return;
  const missing = scopes.filter((s) => !ctx.oauth!.scopes.has(s));
  if (missing.length) throw new InsufficientScopeError(missing);
}

export function hasScope(ctx: AccessContext, scope: OAuthScope): boolean {
  return !ctx.oauth || ctx.oauth.scopes.has(scope);
}

export function requireOwner(ctx: AccessContext, message?: string): void {
  if (!isOwner(ctx))
    throw new ForbiddenError(message ?? 'Only the owner of this record can do that');
}

export function canAddAnything(ctx: AccessContext): boolean {
  return isOwner(ctx) || ctx.grants.some((g) => g.canAdd);
}

export function canExportAnything(ctx: AccessContext): boolean {
  return isOwner(ctx) || ctx.grants.some((g) => g.canExport);
}

export function systemContext(ownerId: string, timezone = 'Europe/London'): AccessContext {
  return {
    userId: ownerId,
    ownerId,
    ownerTimezone: timezone,
    role: 'owner',
    grants: [],
    via: 'system',
  };
}

export function withOAuth(
  ctx: AccessContext,
  oauth: { clientId: string; grantId: string; scopes: string[] },
): AccessContext {
  return { ...ctx, via: 'mcp', oauth: { ...oauth, scopes: expandScopes(oauth.scopes) } };
}
