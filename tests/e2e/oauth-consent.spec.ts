import { createHash, randomBytes } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { apiCall, expectAccessible, register } from './helpers';

const REDIRECT = 'http://127.0.0.1:43123/callback';

test('MCP client connects through OAuth consent; scopes and attachment contents are enforced', async ({
  page,
  baseURL,
}) => {
  await register(page);
  const ev = await apiCall<{ id: string }>(page, 'POST', '/events', {
    typeId: 'letter_in',
    title: 'Council tax bill',
    occurredAt: '2026-04-01',
  });
  const state = await (await page.request.get('/api/auth/state')).json();
  const up = await page.request.post(`/api/events/${ev.id}/attachments`, {
    headers: { 'X-CSRF-Token': state.csrfToken },
    multipart: {
      file: {
        name: 'bill.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from('Council tax due: 1,450 pounds'),
      },
    },
  });
  const attachment = await up.json();

  const reg = await page.request.post('/oauth/register', {
    data: {
      client_name: 'E2E Assistant',
      redirect_uris: [REDIRECT],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      application_type: 'native',
    },
  });
  const { client_id } = await reg.json();
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  let callback: URL | null = null;
  await page.route('http://127.0.0.1:43123/**', async (route) => {
    callback = new URL(route.request().url());
    await route.fulfill({
      status: 200,
      contentType: 'text/plain',
      body: 'You can close this window.',
    });
  });
  const resource = `${baseURL}/mcp`;
  await page.goto(
    `/oauth/authorize?${new URLSearchParams({ client_id, redirect_uri: REDIRECT, response_type: 'code', scope: 'events:read search:read attachments:metadata attachments:read events:write', code_challenge: challenge, code_challenge_method: 'S256', state: 'xyz', resource })}`,
  );
  await expect(
    page.getByRole('heading', { name: 'E2E Assistant is requesting access to OpenRampart' }),
  ).toBeVisible();
  await expect(page.getByText('This application runs on your own device')).toBeVisible();
  // Reading document contents and writing are opt-in.
  await expect(page.getByLabel(/Read attachment contents/)).not.toBeChecked();
  await expect(page.getByLabel(/Add and edit Events/)).not.toBeChecked();
  await expect(page.getByLabel(/See attachment details/)).toBeChecked();
  await expectAccessible(page, 'OAuth consent');
  await page.getByRole('button', { name: 'Allow access' }).click();
  await expect.poll(() => callback?.searchParams.get('code') ?? null).not.toBeNull();
  expect(callback!.searchParams.get('state')).toBe('xyz');

  const tokenRes = await page.request.post('/oauth/token', {
    form: {
      grant_type: 'authorization_code',
      code: callback!.searchParams.get('code')!,
      redirect_uri: REDIRECT,
      client_id,
      code_verifier: verifier,
      resource,
    },
  });
  expect(tokenRes.status()).toBe(200);
  const tokens = await tokenRes.json();
  expect(tokens.scope.split(' ').sort()).toEqual([
    'attachments:metadata',
    'events:read',
    'search:read',
  ]);

  const mcp = (body: object) =>
    page.request.post('/mcp', {
      headers: {
        Authorization: `Bearer ${tokens.access_token}`,
        Accept: 'application/json, text/event-stream',
        'Content-Type': 'application/json',
      },
      data: { jsonrpc: '2.0', id: 1, ...body },
    });
  // Metadata is allowed …
  const meta = await mcp({
    method: 'tools/call',
    params: { name: 'get_attachment_metadata', arguments: { attachmentId: attachment.id } },
  });
  expect(meta.status()).toBe(200);
  expect(await meta.text()).toContain('bill.txt');
  // … but the contents are not.
  const contents = await mcp({
    method: 'tools/call',
    params: { name: 'get_attachment', arguments: { attachmentId: attachment.id } },
  });
  expect(contents.status()).toBe(403);
  expect(contents.headers()['www-authenticate']).toContain('attachments:read');
  const write = await mcp({
    method: 'tools/call',
    params: { name: 'create_event', arguments: { eventType: 'note', occurredAt: '2026-01-01' } },
  });
  expect(write.status()).toBe(403);

  // The connection is listed and can be revoked.
  await page.unroute('http://127.0.0.1:43123/**');
  await page.goto('/settings/connections');
  await expect(page.getByRole('heading', { name: 'E2E Assistant' })).toBeVisible();
  await expectAccessible(page, 'MCP connections');
  await page.getByRole('button', { name: 'Disconnect' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Disconnect' }).click();
  await expect(page.getByText('No applications are connected.')).toBeVisible();
  const after = await mcp({
    method: 'tools/call',
    params: { name: 'get_attachment_metadata', arguments: { attachmentId: attachment.id } },
  });
  expect(after.status()).toBe(401);
});
