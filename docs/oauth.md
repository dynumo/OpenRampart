# OAuth 2.1 authorisation server

OpenRampart includes its own OAuth 2.1 authorisation server, built on
[`oidc-provider`](https://github.com/panva/node-oidc-provider). Its only purpose is to let
people connect MCP clients, such as AI assistants, to their record with explicit, revocable,
scoped consent. It does not provide "Sign in with OpenRampart" for other websites.

## Endpoints

With `APP_URL=https://rampart.example.org`:

| Purpose                                  | URL                                                                                        |
| ---------------------------------------- | ------------------------------------------------------------------------------------------ |
| Issuer                                   | `https://rampart.example.org`                                                              |
| Authorisation server metadata (RFC 8414) | `/.well-known/oauth-authorization-server` (also `/.well-known/openid-configuration`)       |
| Protected resource metadata (RFC 9728)   | `/.well-known/oauth-protected-resource/mcp` (also `/.well-known/oauth-protected-resource`) |
| Authorisation                            | `/oauth/authorize`                                                                         |
| Token                                    | `/oauth/token`                                                                             |
| Dynamic client registration (RFC 7591)   | `/oauth/register` (when `OAUTH_ENABLE_DCR=true`)                                           |
| Revocation (RFC 7009)                    | `/oauth/revoke`                                                                            |
| JWKS                                     | `/oauth/jwks`                                                                              |
| Consent screen                           | `/oauth/interaction/<uid>` (OpenRampart's own page)                                        |
| Protected resource (MCP)                 | `/mcp`                                                                                     |

`OAUTH_ISSUER` and `MCP_RESOURCE_URL` can override the defaults. You should not normally need
to change them.

## How a client connects

1. The client calls `/mcp` without a token. It receives `401` with a header pointing to the
   protected resource metadata:

   ```
   WWW-Authenticate: Bearer resource_metadata="https://rampart.example.org/.well-known/oauth-protected-resource/mcp"
   ```

2. It reads the resource metadata, then the authorisation server metadata.
3. It identifies itself in one of two ways:
   - **Client ID Metadata Document:** the `client_id` is an HTTPS URL that hosts the client's
     metadata (when `OAUTH_ENABLE_CIMD=true`).
   - **Dynamic Client Registration:** `POST /oauth/register` (when `OAUTH_ENABLE_DCR=true`).
     Clients are public (`token_endpoint_auth_method=none`) and use `authorization_code` +
     `refresh_token`.
4. It sends the person to `/oauth/authorize` with:
   - `response_type=code`;
   - `code_challenge` and `code_challenge_method=S256` (**PKCE is required for every
     client**);
   - a `redirect_uri` that **exactly** matches a registered one;
   - `resource=https://rampart.example.org/mcp` (RFC 8707);
   - the requested `scope`. If none is requested, the read-only set is offered.
5. The person signs in to OpenRampart if needed, with two-step sign-in, and sees the
   **consent screen**:
   - the client's name and the host it will return to, with a warning when that is a local
     address;
   - which record to connect: their own, or one shared with them as a Helper;
   - each requested scope as a checkbox. Write scopes and `attachments:read` are **unticked
     by default**.

   They can approve some scopes and refuse others, or deny the request entirely. The consent
   screen is shown **every time**. A previous approval is never silently reused.

6. The client exchanges the code at `/oauth/token` (with `code_verifier` and `resource`). It
   receives:
   - an opaque **access token**, bound to the MCP resource (audience), with only the approved
     scopes, valid for `OAUTH_ACCESS_TOKEN_TTL_SECONDS` (one hour by default);
   - a **refresh token**, valid for `OAUTH_REFRESH_TOKEN_TTL_DAYS` (30 days by default). It
     **rotates** on each use. Reusing an old refresh token fails.
7. The client calls `/mcp` with `Authorization: Bearer <token>`.

Tokens for any other resource are refused (`invalid_target`). The authorisation server only
issues tokens for its own MCP server.

## Token validation at `/mcp`

On every request the MCP endpoint:

1. parses the bearer token from the `Authorization` header (never from query strings);
2. looks it up, rejecting unknown, expired or revoked tokens with `401` and a
   `WWW-Authenticate` challenge;
3. checks the token's audience equals the MCP resource URL;
4. checks the underlying **connection** is still active and the person's account is not
   disabled;
5. builds the access context from the connection's person, record and approved scopes. The
   person's Helper grants are re-loaded each time, so revoked sharing applies at once;
6. checks each tool's required scopes. A missing scope returns `403` with
   `WWW-Authenticate: Bearer error="insufficient_scope", scope="…"`, so the client can ask
   for more.

## Scopes

| Scope                  | Allows                                                                         |
| ---------------------- | ------------------------------------------------------------------------------ |
| `events:read`          | Read Events and timelines                                                      |
| `events:write`         | Create and update Events, link related Events (every change makes a revision)  |
| `incidents:read`       | Read Incidents                                                                 |
| `incidents:write`      | Create and update Incidents; add and remove Events                             |
| `actors:read`          | Read Actors                                                                    |
| `actors:write`         | Create and update Actors                                                       |
| `attachments:metadata` | Attachment names, types, sizes, hashes and processing status: **not contents** |
| `attachments:read`     | Attachment **contents**: original files and OCR text (implies metadata)        |
| `attachments:write`    | Upload attachments to Events                                                   |
| `search:read`          | Search the record                                                              |
| `export:read`          | Structured export of the accessible record                                     |

The default read-only set, used when a client asks for nothing specific, is: `events:read`,
`incidents:read`, `actors:read`, `attachments:metadata` and `search:read`.

Scopes never add to what the person can do. A Helper's connection is limited by their grants,
and an owner's by their own record.

## Managing connections

**Settings → MCP Connections** lists every connection with:

- the client name and redirect host;
- the record it uses;
- the approved scopes;
- when it was created and last used.

**Revoke** destroys the connection's grant, access tokens, refresh tokens and authorisation
codes. The next request from that client gets `401`.

Owners also see connections that Helpers made to their record, and can revoke them.

Grants, denials and revocations are recorded in the Audit Log (`oauth.granted`,
`oauth.denied`, `oauth.revoked`). Tool use is recorded as `mcp.access`.

## Keys and storage

- The ES256 key used for the (unused but protocol-required) ID token signing and JWKS is
  generated on first start. It is stored in `system_keys`, encrypted with `ENCRYPTION_KEY`.
- OAuth artefacts (codes, tokens, grants, registered clients, interactions) are stored in the
  `oauth_payloads` table with expiry. Expired rows are removed by the maintenance job.

## Operating behind a proxy

The issuer and every URL are derived from `APP_URL`, so they are correct behind a reverse
proxy. Set `TRUST_PROXY` correctly so that rate limiting and audit entries see the real client
IP.

## Testing a client by hand

```sh
curl -s https://rampart.example.org/.well-known/oauth-protected-resource/mcp | jq
curl -s https://rampart.example.org/.well-known/oauth-authorization-server | jq
```

The integration suite (`tests/integration/oauth-mcp.test.ts`) and the end-to-end test
(`tests/e2e/oauth-consent.spec.ts`) cover the complete flow. That includes DCR, PKCE, resource
binding, partial consent, refresh rotation, scope challenges and revocation.
