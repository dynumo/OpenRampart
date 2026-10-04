import { randomBytes } from 'node:crypto';
import { generate } from 'otplib';
import request from 'supertest';
import type { Express } from 'express';
import { sql } from 'drizzle-orm';
import { createAccount } from '../../src/server/auth/accounts.js';
import { db } from '../../src/server/db/client.js';
import { resolveContext } from '../../src/server/domain/access.js';
import type { AccessContext } from '../../src/server/domain/context.js';
import { withOAuth } from '../../src/server/domain/context.js';
import { createActor } from '../../src/server/domain/actors.js';
import { createEvent } from '../../src/server/domain/events.js';
import { createIncident } from '../../src/server/domain/incidents.js';
import { inviteHelper, acceptInvitation, type GrantInput } from '../../src/server/domain/helpers.js';
import { createApp } from '../../src/server/http/app.js';
import { decryptSecret } from '../../src/server/lib/crypto.js';

let app: Express | undefined;
export function testApp(): Express {
  app ??= createApp({ webRoot: '/nonexistent' });
  return app;
}

export function uniq(prefix = 'u'): string {
  return `${prefix}${randomBytes(4).toString('hex')}`;
}

export async function makeUser(name = uniq('user'), opts: { admin?: boolean } = {}) {
  const user = await createAccount(
    { username: name, displayName: name, email: `${name}@example.test`, password: 'correct horse battery staple', timezone: 'Europe/London' },
    { ip: '127.0.0.1' },
    { viaInvitation: true, forceAdmin: opts.admin },
  );
  return user;
}

export async function ownerCtx(userId: string): Promise<AccessContext> {
  return resolveContext({ userId, via: 'web' });
}

export async function helperCtx(helperId: string, ownerId: string): Promise<AccessContext> {
  return resolveContext({ userId: helperId, ownerId, via: 'web' });
}

export function oauthCtx(ctx: AccessContext, scopes: string[]): AccessContext {
  return withOAuth(ctx, { clientId: 'test-client', grantId: 'test-grant', scopes });
}

export async function actor(ctx: AccessContext, name: string) {
  return createActor(ctx, { name });
}

export async function event(ctx: AccessContext, input: Record<string, unknown>) {
  return createEvent(ctx, { typeId: 'note', occurredAt: '2026-03-01', ...input });
}

export async function incident(ctx: AccessContext, title: string, eventIds: string[] = []) {
  return createIncident(ctx, { title, eventIds });
}

/** Invite and accept a helper with one grant; returns the helper user and their context. */
export async function grantHelper(owner: AccessContext, grant: GrantInput) {
  const helper = await makeUser(uniq('helper'));
  const { url } = await inviteHelper(owner, { label: 'Test helper', grant });
  const token = url.split('/invite/')[1]!;
  await acceptInvitation(token, helper.id, {});
  const ctx = await helperCtx(helper.id, owner.ownerId);
  return { helper, ctx, token };
}

export async function totpCodeFor(userId: string): Promise<string> {
  const rows = await db().execute(sql`SELECT totp_secret_enc, totp_pending_secret_enc FROM users WHERE id = ${userId}::uuid`);
  const row = rows.rows[0] as { totp_secret_enc: string | null; totp_pending_secret_enc: string | null };
  const enc = row.totp_pending_secret_enc ?? row.totp_secret_enc;
  return generate({ secret: decryptSecret(enc!) });
}

/** Code for the *next* time step, to avoid replay rejection in consecutive logins. */
export async function nextTotpCode(userId: string, offsetSeconds = 30): Promise<string> {
  const rows = await db().execute(sql`SELECT totp_secret_enc FROM users WHERE id = ${userId}::uuid`);
  const row = rows.rows[0] as { totp_secret_enc: string };
  return generate({ secret: decryptSecret(row.totp_secret_enc), epoch: Math.floor(Date.now() / 1000) + offsetSeconds });
}

export interface Browser {
  agent: ReturnType<typeof request.agent>;
  csrf: string;
  userId: string;
  username: string;
  recoveryCodes: string[];
}

/** Register through the HTTP API and complete TOTP enrolment. */
export async function registerBrowser(username = uniq('web')): Promise<Browser> {
  const agent = request.agent(testApp());
  await agent
    .post('/api/auth/register')
    .set('X-CSRF-Token', '1')
    .send({ username, displayName: username, email: `${username}@example.test`, password: 'a long enough passphrase', timezone: 'Europe/London' })
    .expect(201);
  let state = (await agent.get('/api/auth/state')).body;
  await agent.post('/api/auth/totp/begin').set('X-CSRF-Token', state.csrfToken).expect(200);
  const userRow = await db().execute(sql`SELECT id FROM users WHERE lower(username) = lower(${username})`);
  const userId = (userRow.rows[0] as { id: string }).id;
  const code = await totpCodeFor(userId);
  const confirm = await agent.post('/api/auth/totp/confirm').set('X-CSRF-Token', state.csrfToken).send({ code }).expect(200);
  state = (await agent.get('/api/auth/state')).body;
  return { agent, csrf: state.csrfToken, userId, username, recoveryCodes: confirm.body.recoveryCodes };
}
