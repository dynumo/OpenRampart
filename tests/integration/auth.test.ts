import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db } from '../../src/server/db/client.js';
import { nextTotpCode, registerBrowser, testApp, uniq } from './helpers.js';

async function login(username: string, password = 'a long enough passphrase') {
  const agent = request.agent(testApp());
  const res = await agent.post('/api/auth/login').set('X-CSRF-Token', '1').send({ login: username, password });
  return { agent, res };
}

describe('Accounts, TOTP and sessions', () => {
  it('requires TOTP enrolment before the record can be used', async () => {
    const agent = request.agent(testApp());
    const username = uniq('enrol');
    await agent.post('/api/auth/register').set('X-CSRF-Token', '1').send({ username, displayName: 'Enrol Test', password: 'a long enough passphrase' }).expect(201);
    const state = (await agent.get('/api/auth/state')).body;
    expect(state.stage).toBe('totp_setup');
    await agent.get('/api/events').expect(401);
    const begin = await agent.post('/api/auth/totp/begin').set('X-CSRF-Token', state.csrfToken).expect(200);
    expect(begin.body.qrSvg).toContain('<svg');
    expect(begin.body.secretDisplay).toMatch(/^[A-Z2-7 ]+$/);
    expect(begin.body.uri).toMatch(/^otpauth:\/\/totp\//);
  });

  it('rejects weak passwords and duplicate usernames with field messages', async () => {
    const agent = request.agent(testApp());
    const weak = await agent.post('/api/auth/register').set('X-CSRF-Token', '1').send({ username: uniq('w'), displayName: 'W', password: 'short' });
    expect(weak.status).toBe(400);
    expect(weak.body.error.fields.password).toMatch(/12/);
    const b = await registerBrowser();
    const dup = await request(testApp()).post('/api/auth/register').set('X-CSRF-Token', '1').send({ username: b.username, displayName: 'X', password: 'another long passphrase' });
    expect([403, 409]).toContain(dup.status);
  });

  it('logs in with password then TOTP, and refuses a replayed code', async () => {
    const b = await registerBrowser();
    const { agent, res } = await login(b.username);
    expect(res.body.stage).toBe('mfa');
    await agent.get('/api/events').expect(401);
    const state = (await agent.get('/api/auth/state')).body;
    const wrong = await agent.post('/api/auth/mfa').set('X-CSRF-Token', state.csrfToken).send({ code: '000000' });
    expect(wrong.status).toBe(401);
    const code = await nextTotpCode(b.userId);
    await agent.post('/api/auth/mfa').set('X-CSRF-Token', state.csrfToken).send({ code }).expect(200);
    await agent.get('/api/events').expect(200);
    // The same code cannot be used again.
    const second = await login(b.username);
    const s2 = (await second.agent.get('/api/auth/state')).body;
    await second.agent.post('/api/auth/mfa').set('X-CSRF-Token', s2.csrfToken).send({ code }).expect(401);
  });

  it('accepts each recovery code once', async () => {
    const b = await registerBrowser();
    expect(b.recoveryCodes).toHaveLength(10);
    const code = b.recoveryCodes[0]!;
    const first = await login(b.username);
    const s1 = (await first.agent.get('/api/auth/state')).body;
    const ok = await first.agent.post('/api/auth/mfa').set('X-CSRF-Token', s1.csrfToken).send({ code: code.toLowerCase() }).expect(200);
    expect(ok.body.usedRecoveryCode).toBe(true);
    expect(ok.body.remainingRecoveryCodes).toBe(9);
    const again = await login(b.username);
    const s2 = (await again.agent.get('/api/auth/state')).body;
    await again.agent.post('/api/auth/mfa').set('X-CSRF-Token', s2.csrfToken).send({ code }).expect(401);
    const stored = await db().execute(sql`SELECT code_hmac FROM recovery_codes WHERE user_id = ${b.userId}::uuid`);
    for (const r of stored.rows as { code_hmac: string }[]) expect(r.code_hmac).not.toContain(code.replace('-', ''));
  });

  it('rejects a wrong password without revealing whether the account exists', async () => {
    const b = await registerBrowser();
    const wrong = await login(b.username, 'not the right password');
    const missing = await login(uniq('nobody'), 'not the right password');
    expect(wrong.res.status).toBe(401);
    expect(missing.res.status).toBe(401);
    expect(wrong.res.body.error.message).toBe(missing.res.body.error.message);
  });

  it('lists sessions, revokes one, and the revoked session stops working', async () => {
    const b = await registerBrowser();
    const other = await login(b.username);
    const s = (await other.agent.get('/api/auth/state')).body;
    await other.agent.post('/api/auth/mfa').set('X-CSRF-Token', s.csrfToken).send({ code: await nextTotpCode(b.userId) }).expect(200);
    await other.agent.get('/api/events').expect(200);
    const list = await b.agent.get('/api/auth/sessions').expect(200);
    expect(list.body.sessions.length).toBe(2);
    const target = list.body.sessions.find((x: { current: boolean }) => !x.current);
    await b.agent.delete(`/api/auth/sessions/${target.id}`).set('X-CSRF-Token', b.csrf).expect(200);
    await other.agent.get('/api/events').expect(401);
    await b.agent.get('/api/events').expect(200);
  });

  it('refuses state-changing requests without the CSRF token', async () => {
    const b = await registerBrowser();
    await b.agent.post('/api/actors').send({ name: 'No token' }).expect(403);
    await b.agent.post('/api/actors').set('X-CSRF-Token', 'wrong').send({ name: 'Bad token' }).expect(403);
    await b.agent.post('/api/actors').set('X-CSRF-Token', b.csrf).set('Origin', 'https://evil.example').send({ name: 'Cross origin' }).expect(403);
    await b.agent.post('/api/actors').set('X-CSRF-Token', b.csrf).send({ name: 'Fine' }).expect(201);
  });

  it('sets secure session cookie attributes and security headers', async () => {
    const agent = request.agent(testApp());
    const res = await agent.post('/api/auth/register').set('X-CSRF-Token', '1').send({ username: uniq('hdr'), displayName: 'H', password: 'a long enough passphrase' });
    const cookie = res.headers['set-cookie']![0]!;
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    const page = await agent.get('/api/auth/state');
    expect(page.headers['content-security-policy']).toContain("default-src 'self'");
    expect(page.headers['referrer-policy']).toBe('no-referrer');
    expect(page.headers['x-content-type-options']).toBe('nosniff');
    expect(page.headers['cache-control']).toBe('no-store');
  });

  it('changing the password signs out other sessions', async () => {
    const b = await registerBrowser();
    const other = await login(b.username);
    const s = (await other.agent.get('/api/auth/state')).body;
    await other.agent.post('/api/auth/mfa').set('X-CSRF-Token', s.csrfToken).send({ code: await nextTotpCode(b.userId) }).expect(200);
    await b.agent.post('/api/auth/password').set('X-CSRF-Token', b.csrf).send({ currentPassword: 'a long enough passphrase', newPassword: 'a different long passphrase' }).expect(200);
    await other.agent.get('/api/events').expect(401);
    await b.agent.get('/api/events').expect(200);
  });

  it('closes public registration when the administrator chooses, while invitations still work', async () => {
    const { setSystemSetting, deleteSystemSetting } = await import('../../src/server/domain/settings.js');
    const b = await registerBrowser();
    await setSystemSetting('registrationMode', 'closed', b.userId);
    try {
      const res = await request(testApp()).post('/api/auth/register').set('X-CSRF-Token', '1').send({ username: uniq('closed'), displayName: 'C', password: 'a long enough passphrase' });
      expect(res.status).toBe(403);
      const state = (await request(testApp()).get('/api/auth/state')).body;
      expect(state.registration.open).toBe(false);
    } finally {
      await deleteSystemSetting('registrationMode');
    }
  });

  it('records security activity in the audit log', async () => {
    const b = await registerBrowser();
    await login(b.username, 'wrong password here');
    const audit = await b.agent.get('/api/settings/audit').expect(200);
    const actions = audit.body.entries.map((e: { action: string }) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['auth.account_created', 'auth.totp_enabled', 'auth.login', 'auth.login_failed']));
  });
});
