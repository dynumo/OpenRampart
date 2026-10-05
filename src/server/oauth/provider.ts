import { createHmac } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { exportJWK, generateKeyPair } from 'jose';
import Provider, { errors, type Configuration, type KoaContextWithOIDC } from 'oidc-provider';
import { OAUTH_SCOPES } from '../../shared/scopes.js';
import { config } from '../config.js';
import { db } from '../db/client.js';
import { systemKeys, users } from '../db/schema.js';
import { decryptSecret, encryptSecret } from '../lib/crypto.js';
import { logger } from '../lib/logger.js';
import { PostgresAdapter } from './adapter.js';

/**
 * OAuth 2.1 authorisation server for MCP clients, built on oidc-provider (an
 * OpenID Certified, actively maintained implementation). OpenRampart does not
 * implement OAuth itself.
 *
 *  - Authorization Code flow only, PKCE (S256) required for every client
 *  - Resource Indicators (RFC 8707): tokens are issued only for the
 *    OpenRampart MCP resource, with that resource as their audience
 *  - Client ID Metadata Documents (preferred by MCP 2026-07-28) and, for
 *    older clients, Dynamic Client Registration (RFC 7591)
 *  - exact redirect URI matching, refresh-token rotation for public clients,
 *    token revocation (RFC 7009), issuer identification (RFC 9207)
 *  - every authorisation goes through OpenRampart's own sign-in (password +
 *    TOTP) and an explicit consent screen
 */

export const OAUTH_MOUNT = '/oauth';
export const INTERACTION_PATH = `${OAUTH_MOUNT}/interaction`;

let provider: Provider | undefined;

async function signingKeys() {
  const [row] = await db()
    .select()
    .from(systemKeys)
    .where(eq(systemKeys.id, 'oauth_jwks'))
    .limit(1);
  if (row) {
    try {
      return JSON.parse(decryptSecret(row.valueEnc)) as { keys: Record<string, unknown>[] };
    } catch {
      // ENCRYPTION_KEY was changed or lost. The key only signs ID tokens (access tokens are
      // opaque), so replace it rather than leave every OAuth endpoint failing.
      logger.error(
        'The stored OAuth signing key cannot be decrypted with the current ENCRYPTION_KEY; generating a new one',
      );
      await db().delete(systemKeys).where(eq(systemKeys.id, 'oauth_jwks'));
    }
  }
  const { privateKey } = await generateKeyPair('ES256', { extractable: true });
  const jwk = {
    ...(await exportJWK(privateKey)),
    use: 'sig',
    alg: 'ES256',
    kid: `or-${Date.now().toString(36)}`,
  };
  const jwks = { keys: [jwk] };
  await db()
    .insert(systemKeys)
    .values({ id: 'oauth_jwks', valueEnc: encryptSecret(JSON.stringify(jwks)) })
    .onConflictDoNothing();
  // Another replica may have won the race; always use the stored value.
  const [stored] = await db()
    .select()
    .from(systemKeys)
    .where(eq(systemKeys.id, 'oauth_jwks'))
    .limit(1);
  return JSON.parse(decryptSecret(stored!.valueEnc)) as { keys: Record<string, unknown>[] };
}

function cookieKeys(): string[] {
  const secret = config().SESSION_SECRET;
  return [createHmac('sha256', secret).update('oauth-cookies-v1').digest('base64url')];
}

export const RESOURCE_SCOPE = OAUTH_SCOPES.join(' ');

export function isOurResource(resource: string): boolean {
  try {
    const want = new URL(config().mcpResourceUrl);
    const got = new URL(resource);
    // Scheme and host compare case-insensitively (URL normalises them); path exactly.
    return (
      got.origin === want.origin &&
      got.pathname.replace(/\/+$/, '') === want.pathname.replace(/\/+$/, '') &&
      !got.search &&
      !got.hash
    );
  } catch {
    return false;
  }
}

export async function buildProvider(): Promise<Provider> {
  const c = config();
  const configuration: Configuration = {
    adapter: PostgresAdapter as unknown as Configuration['adapter'],
    jwks: (await signingKeys()) as Configuration['jwks'],
    cookies: {
      keys: cookieKeys(),
      long: { signed: true, secure: c.cookieSecure, sameSite: 'lax', httpOnly: true },
      short: { signed: true, secure: c.cookieSecure, sameSite: 'lax', httpOnly: true },
    },
    routes: {
      authorization: '/authorize',
      token: '/token',
      registration: '/register',
      revocation: '/revoke',
      jwks: '/jwks',
      end_session: '/logout',
      userinfo: '/userinfo',
      introspection: '/introspect',
    },
    scopes: ['openid', 'offline_access'],
    claims: { openid: ['sub'] },
    responseTypes: ['code'],
    clientAuthMethods: ['none', 'client_secret_basic', 'client_secret_post', 'private_key_jwt'],
    clientDefaults: {
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      id_token_signed_response_alg: 'ES256',
    },
    pkce: { required: () => true },
    features: {
      devInteractions: { enabled: false },
      userinfo: { enabled: false },
      revocation: { enabled: true },
      introspection: { enabled: false },
      rpInitiatedLogout: { enabled: false },
      registration: {
        enabled: c.OAUTH_ENABLE_DCR,
        issueRegistrationAccessToken: false,
      },
      clientIdMetadataDocument: {
        enabled: c.OAUTH_ENABLE_CIMD,
        ack: 'draft-02',
        cacheDuration: { min: 300, max: 86_400 },
      },
      resourceIndicators: {
        enabled: true,
        defaultResource: async () => c.mcpResourceUrl,
        useGrantedResource: async () => true,
        getResourceServerInfo: async (_ctx: KoaContextWithOIDC, resourceIndicator: string) => {
          if (!isOurResource(resourceIndicator)) {
            throw new errors.InvalidTarget(
              'This authorisation server only issues tokens for the OpenRampart MCP server',
            );
          }
          return {
            scope: RESOURCE_SCOPE,
            audience: c.mcpResourceUrl,
            accessTokenTTL: c.OAUTH_ACCESS_TOKEN_TTL_SECONDS,
            accessTokenFormat: 'opaque',
          };
        },
      },
    },
    ttl: {
      AccessToken: c.OAUTH_ACCESS_TOKEN_TTL_SECONDS,
      AuthorizationCode: 60,
      Interaction: 30 * 60,
      Session: 10 * 60,
      Grant: c.OAUTH_REFRESH_TOKEN_TTL_DAYS * 86_400 * 12,
      RefreshToken: c.OAUTH_REFRESH_TOKEN_TTL_DAYS * 86_400,
    },
    issueRefreshToken: async (_ctx, client) => client.grantTypeAllowed('refresh_token'),
    rotateRefreshToken: true,
    // Never resume from a stored grant without going through OpenRampart's own
    // sign-in and consent screen: only a grant created during this interaction counts.
    loadExistingGrant: async (ctx) => {
      const grantId = ctx.oidc.result?.consent?.grantId;
      return grantId ? ctx.oidc.provider.Grant.find(grantId) : undefined;
    },
    interactions: {
      url: async (_ctx, interaction) => `${INTERACTION_PATH}/${interaction.uid}`,
    },
    async findAccount(_ctx, sub) {
      const [user] = await db()
        .select({ id: users.id, disabledAt: users.disabledAt })
        .from(users)
        .where(eq(users.id, sub))
        .limit(1);
      if (!user || user.disabledAt) return undefined;
      return { accountId: user.id, claims: async () => ({ sub: user.id }) };
    },
    async renderError(ctx, out) {
      ctx.type = 'html';
      const esc = (s: unknown) =>
        String(s ?? '').replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
      ctx.body = `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connection could not be authorised — OpenRampart</title><link rel="stylesheet" href="/oauth-error.css"></head><body><main><h1>This connection could not be authorised</h1><p>The application that sent you here made a request OpenRampart could not accept. No access has been granted.</p><dl><dt>Reason</dt><dd>${esc(out.error_description ?? out.error)}</dd></dl><p><a href="/">Return to OpenRampart</a></p></main></body></html>`;
    },
    extraClientMetadata: { properties: [] },
    enabledJWA: { idTokenSigningAlgValues: ['ES256'] },
    conformIdTokenClaims: true,
  };
  const p = new Provider(c.oauthIssuer, configuration);
  p.proxy = c.trustProxy !== false;
  p.on('server_error', (_ctx, err) => logger.error({ err: err.message }, 'oauth server error'));
  p.on('grant.error', (_ctx, err) => logger.warn({ err: err.message }, 'oauth grant error'));
  return p;
}

export async function getProvider(): Promise<Provider> {
  provider ??= await buildProvider();
  return provider;
}

export function resetProvider(): void {
  provider = undefined;
}
