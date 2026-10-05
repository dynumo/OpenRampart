import { createHash, randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import { createServer } from 'node:http';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerBrowser, testApp, type Browser } from './helpers.js';

const BASE = 'http://localhost:3999';
const REDIRECT = 'http://127.0.0.1:43123/callback';
const RESOURCE = `${BASE}/mcp`;

function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

async function form(url: string, body: Record<string, string>) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, string> };
}

async function mcpClient(token: string, mode: 'legacy' | { pin: string } = 'legacy') {
  const client = new Client({ name: 'test-client', version: '1.0.0' }, {
    versionNegotiation: { mode },
  } as never);
  const transport = new StreamableHTTPClientTransport(new URL(RESOURCE), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  return client;
}

describe('OAuth 2.1 authorisation and the MCP server', () => {
  let server: Server;
  let browser: Browser;
  let clientId: string;

  beforeAll(async () => {
    server = createServer(testApp());
    await new Promise<void>((r) => server.listen(3999, '127.0.0.1', r));
    browser = await registerBrowser(undefined, BASE);
    const actor = await browser.agent
      .post('/api/actors')
      .set('X-CSRF-Token', browser.csrf)
      .send({ name: 'Companies House' })
      .expect(201);
    await browser.agent
      .post('/api/events')
      .set('X-CSRF-Token', browser.csrf)
      .send({
        typeId: 'portal',
        title: 'Login unavailable',
        occurredAt: '2026-03-24',
        actors: [{ actorId: actor.body.id }],
        riskLevel: 'high',
        riskNote: 'Confirmation statement due tomorrow',
      })
      .expect(201);
  });

  afterAll(async () => {
    await new Promise((r) => server.close(r));
  });

  async function authorise(scopes: string[], grant: string[]) {
    const { verifier, challenge } = pkce();
    const state = randomBytes(8).toString('hex');
    const authUrl = `/oauth/authorize?${new URLSearchParams({
      client_id: clientId,
      redirect_uri: REDIRECT,
      response_type: 'code',
      scope: scopes.join(' '),
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
      resource: RESOURCE,
    })}`;
    const start = await browser.agent.get(authUrl).redirects(0);
    expect(start.status).toBe(303);
    const interaction = new URL(start.headers.location!, BASE).pathname;
    expect(interaction).toMatch(/^\/oauth\/interaction\/[\w-]+$/);
    const details = await browser.agent.get(`${interaction}/details`).expect(200);
    const approve = await browser.agent
      .post(`${interaction}/approve`)
      .set('X-CSRF-Token', browser.csrf)
      .send({ ownerId: browser.userId, scopes: grant })
      .expect(200);
    const resume = await browser.agent
      .get(
        new URL(approve.body.redirectTo, BASE).pathname +
          new URL(approve.body.redirectTo, BASE).search,
      )
      .redirects(0);
    expect(resume.status).toBe(303);
    const callback = new URL(resume.headers.location!);
    expect(callback.origin + callback.pathname).toBe(REDIRECT);
    expect(callback.searchParams.get('state')).toBe(state);
    expect(callback.searchParams.get('iss')).toBe(BASE);
    return { code: callback.searchParams.get('code')!, verifier, details: details.body };
  }

  it('challenges unauthenticated MCP requests with protected resource metadata', async () => {
    const res = await fetch(RESOURCE, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(401);
    const header = res.headers.get('www-authenticate')!;
    expect(header).toContain(
      `resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp"`,
    );
    const prm = await (await fetch(`${BASE}/.well-known/oauth-protected-resource/mcp`)).json();
    expect(prm.resource).toBe(RESOURCE);
    expect(prm.authorization_servers).toEqual([BASE]);
    const as = await (await fetch(`${BASE}/.well-known/oauth-authorization-server`)).json();
    expect(as.issuer).toBe(BASE);
    expect(as.code_challenge_methods_supported).toEqual(['S256']);
    expect(as.client_id_metadata_document_supported).toBe(true);
    expect(as.authorization_response_iss_parameter_supported).toBe(true);
  });

  it('registers a client dynamically', async () => {
    const res = await fetch(`${BASE}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Test MCP Client',
        redirect_uris: [REDIRECT],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        application_type: 'native',
      }),
    });
    expect(res.status).toBe(201);
    clientId = (await res.json()).client_id;
    expect(clientId).toBeTruthy();
  });

  it('refuses authorisation requests without PKCE or with an unregistered redirect URI', async () => {
    const noPkce = await browser.agent
      .get(
        `/oauth/authorize?${new URLSearchParams({ client_id: clientId, redirect_uri: REDIRECT, response_type: 'code', scope: 'events:read', resource: RESOURCE })}`,
      )
      .redirects(0);
    expect(noPkce.status).toBe(303);
    expect(noPkce.headers.location).toContain('error=invalid_request');
    const badRedirect = await browser.agent
      .get(
        `/oauth/authorize?${new URLSearchParams({ client_id: clientId, redirect_uri: 'http://127.0.0.1:43123/other', response_type: 'code', scope: 'events:read', code_challenge: 'x'.repeat(43), code_challenge_method: 'S256' })}`,
      )
      .redirects(0);
    expect(badRedirect.status).toBe(400);
    expect(badRedirect.headers.location).toBeUndefined();
  });

  it('refuses tokens for any other resource', async () => {
    const res = await browser.agent
      .get(
        `/oauth/authorize?${new URLSearchParams({ client_id: clientId, redirect_uri: REDIRECT, response_type: 'code', scope: 'events:read', code_challenge: pkce().challenge, code_challenge_method: 'S256', resource: 'https://other.example/mcp' })}`,
      )
      .redirects(0);
    expect(res.headers.location).toContain('error=invalid_target');
  });

  let accessToken: string;
  let refreshToken: string;

  it('shows a consent screen and issues audience-bound tokens for the granted scopes only', async () => {
    const { code, verifier, details } = await authorise(
      ['events:read', 'search:read', 'attachments:read'],
      ['events:read', 'search:read'],
    );
    expect(details.client.name).toBe('Test MCP Client');
    expect(details.redirectHost).toBe('127.0.0.1:43123');
    expect(details.redirectIsLocalhost).toBe(true);
    expect(details.requestedScopes).toEqual(['events:read', 'search:read', 'attachments:read']);
    const bad = await form(`${BASE}/oauth/token`, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT,
      client_id: clientId,
      code_verifier: 'wrong'.repeat(10),
      resource: RESOURCE,
    });
    expect(bad.status).toBe(400);
    // The code was spent by the failed attempt; get a fresh one.
    const second = await authorise(
      ['events:read', 'search:read', 'attachments:read'],
      ['events:read', 'search:read'],
    );
    const ok = await form(`${BASE}/oauth/token`, {
      grant_type: 'authorization_code',
      code: second.code,
      redirect_uri: REDIRECT,
      client_id: clientId,
      code_verifier: second.verifier,
      resource: RESOURCE,
    });
    expect(ok.status).toBe(200);
    expect(ok.body.token_type).toBe('Bearer');
    expect(ok.body.scope!.split(' ').sort()).toEqual(['events:read', 'search:read']);
    accessToken = ok.body.access_token!;
    refreshToken = ok.body.refresh_token!;
    expect(refreshToken).toBeTruthy();
    void verifier;
  });

  it('serves MCP tools over the 2025 protocol with the token', async () => {
    const client = await mcpClient(accessToken);
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name);
    for (const t of [
      'search_events',
      'get_event',
      'get_actor',
      'get_actor_timeline',
      'get_incident',
      'get_incident_timeline',
      'list_incidents',
      'search_documents',
      'get_attachment_metadata',
      'get_attachment',
      'create_event',
      'update_event',
      'create_actor',
      'update_actor',
      'create_incident',
      'update_incident',
      'add_event_to_incident',
      'remove_event_from_incident',
      'link_events',
      'attach_file',
    ]) {
      expect(names).toContain(t);
    }
    const result = await client.callTool({
      name: 'search_events',
      arguments: { query: 'Companies House login' },
    });
    expect(result.isError).toBeFalsy();
    const payload = JSON.parse((result.content as { text: string }[])[0]!.text);
    expect(payload.events[0].title).toBe('Login unavailable');
    expect(payload.events[0].actors[0].name).toBe('Companies House');
    await client.close();
  });

  it('serves the 2026-07-28 protocol too', async () => {
    const client = await mcpClient(accessToken, { pin: '2026-07-28' });
    const result = await client.callTool({ name: 'search_events', arguments: {} });
    expect(result.isError).toBeFalsy();
    await client.close();
  });

  it('enforces scopes on tools (no writes, no attachment contents)', async () => {
    const client = await mcpClient(accessToken);
    await expect(
      client.callTool({
        name: 'create_event',
        arguments: { eventType: 'note', occurredAt: '2026-01-01' },
      }),
    ).rejects.toThrow();
    await expect(
      client.callTool({
        name: 'get_attachment',
        arguments: { attachmentId: '00000000-0000-4000-8000-000000000000' },
      }),
    ).rejects.toThrow();
    await client.close();
    const raw = await fetch(RESOURCE, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'create_event',
          arguments: { eventType: 'note', occurredAt: '2026-01-01' },
        },
      }),
    });
    expect(raw.status).toBe(403);
    expect(raw.headers.get('www-authenticate')).toContain('insufficient_scope');
    expect(raw.headers.get('www-authenticate')).toContain('events:write');
  });

  it('rejects unknown tokens', async () => {
    const res = await fetch(RESOURCE, {
      method: 'POST',
      headers: { authorization: 'Bearer not-a-real-token', 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain('invalid_token');
  });

  it('rotates refresh tokens and rejects reuse', async () => {
    const first = await form(`${BASE}/oauth/token`, {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
      resource: RESOURCE,
    });
    expect(first.status).toBe(200);
    expect(first.body.refresh_token).not.toBe(refreshToken);
    const reuse = await form(`${BASE}/oauth/token`, {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
      resource: RESOURCE,
    });
    expect(reuse.status).toBe(400);
    expect(reuse.body.error).toBe('invalid_grant');
  });

  it('a write-capable grant can create and organise records through MCP', async () => {
    const { code, verifier } = await authorise(
      [
        'events:read',
        'events:write',
        'actors:read',
        'actors:write',
        'incidents:write',
        'incidents:read',
        'attachments:write',
        'attachments:metadata',
      ],
      [
        'events:read',
        'events:write',
        'actors:read',
        'actors:write',
        'incidents:write',
        'incidents:read',
        'attachments:write',
        'attachments:metadata',
      ],
    );
    const tok = await form(`${BASE}/oauth/token`, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT,
      client_id: clientId,
      code_verifier: verifier,
      resource: RESOURCE,
    });
    const client = await mcpClient(tok.body.access_token!);
    const created = await client.callTool({
      name: 'create_event',
      arguments: {
        eventType: 'phone_call',
        title: 'Called the helpline',
        occurredAt: '2026-03-25T10:15',
        newActors: [{ name: 'Helpline' }],
      },
    });
    expect(created.isError).toBeFalsy();
    const ev = JSON.parse((created.content as { text: string }[])[0]!.text);
    expect(ev.createdVia).toBe('mcp');
    const inc = await client.callTool({
      name: 'create_incident',
      arguments: { title: 'Portal outage', eventIds: [ev.id] },
    });
    expect(inc.isError).toBeFalsy();
    const file = await client.callTool({
      name: 'attach_file',
      arguments: {
        eventId: ev.id,
        filename: 'notes.txt',
        contentBase64: Buffer.from('call notes').toString('base64'),
      },
    });
    expect(file.isError).toBeFalsy();
    const meta = JSON.parse((file.content as { text: string }[])[0]!.text);
    expect(meta.sha256).toBe(createHash('sha256').update('call notes').digest('hex'));
    const html = await client.callTool({
      name: 'attach_file',
      arguments: {
        eventId: ev.id,
        filename: 'x.html',
        contentBase64: Buffer.from('<html><script>alert(1)</script></html>').toString('base64'),
      },
    });
    expect(html.isError).toBe(true);
    await client.close();
    // Revoking the connection stops the token immediately.
    const list = await browser.agent.get('/api/settings/connections').expect(200);
    for (const c of list.body.items) {
      await browser.agent
        .delete(`/api/settings/connections/${c.grantId}`)
        .set('X-CSRF-Token', browser.csrf)
        .expect(200);
    }
    const after = await fetch(RESOURCE, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${tok.body.access_token}`,
        'content-type': 'application/json',
      },
      body: '{}',
    });
    expect(after.status).toBe(401);
    const old = await fetch(RESOURCE, {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(old.status).toBe(401);
  });

  it('records grants, MCP access and revocation in the audit log, never as Events', async () => {
    const audit = await browser.agent.get('/api/settings/audit?limit=200').expect(200);
    const actions = audit.body.entries.map((e: { action: string }) => e.action);
    expect(actions).toContain('oauth.granted');
    expect(actions).toContain('mcp.access');
    expect(actions).toContain('oauth.revoked');
    const events = await browser.agent.get('/api/events').expect(200);
    expect(
      events.body.items.every(
        (e: { title: string }) =>
          !/oauth|mcp|login/i.test(e.title) || e.title === 'Login unavailable',
      ),
    ).toBe(true);
  });
});
