# Architecture

OpenRampart is a single TypeScript application: an Express 5 HTTP server, a React single-page
app, and a background worker. It uses PostgreSQL for all structured data, the job queue and
search, and S3-compatible object storage for files. The same code runs as one process
(`OPENRAMPART_ROLE=all`, the default), or as separate web and worker processes that share the
database and bucket.

```
               ┌──────────── Browser (React PWA) ─────────────┐   ┌──── MCP client ────┐
               │  same-origin JSON API, session cookie, CSRF  │   │ OAuth 2.1 bearer   │
               └──────────────────────┬───────────────────────┘   └─────────┬──────────┘
                                      │                                     │
  ┌───────────────────────────────────▼─────────────────────────────────────▼──────────────┐
  │ Express 5  (src/server/http)                                                          │
  │   /api/*  web API          /oauth/*  authorisation server (oidc-provider)             │
  │   /mcp    MCP server        /.well-known/*  discovery            static SPA            │
  ├───────────────────────────────────────────────────────────────────────────────────────┤
  │ Domain layer (src/server/domain): one implementation shared by web API and MCP        │
  │   events · actors · incidents · attachments · search · helpers · export · audit       │
  │   access.ts: the only definition of "who can see what" (SQL predicates)               │
  ├──────────────────────────────┬─────────────────────────────┬──────────────────────────┤
  │ PostgreSQL                   │ S3-compatible bucket        │ Worker (pg-boss jobs)    │
  │  data, revisions, FTS,       │  originals/<owner>/<id>     │  hashing, previews, OCR, │
  │  sessions, OAuth, job queue  │  derived/<owner>/<id>/...   │  timestamps, housekeeping│
  └──────────────────────────────┴─────────────────────────────┴──────────────────────────┘
```

## Source layout

| Path                    | Responsibility                                                                  |
| ----------------------- | ------------------------------------------------------------------------------- |
| `src/server/config.ts`  | Environment schema (zod), validated once at start-up                            |
| `src/server/db/`        | PostgreSQL pool, Drizzle schema (mirrors the SQL migrations), migration runner  |
| `src/server/auth/`      | Passwords (argon2id), TOTP, recovery codes, sessions, rate limiting, accounts   |
| `src/server/domain/`    | Business rules shared by every interface; `access.ts` holds authorisation       |
| `src/server/http/`      | Express app, middleware (sessions, CSRF, record selection), routes, uploads     |
| `src/server/oauth/`     | oidc-provider configuration, PostgreSQL adapter, consent and connection records |
| `src/server/mcp/`       | MCP tool definitions over the domain layer                                      |
| `src/server/storage/`   | S3 client, file-type detection and allow-list, filename sanitising              |
| `src/server/jobs/`      | Job queue, attachment processing, maintenance, worker start-up                  |
| `src/server/ocr/`       | Tesseract / OCRmyPDF / Poppler / libheif wrappers and rule-based suggestions    |
| `src/server/integrity/` | RFC 8785 canonical JSON, OpenTimestamps format and provider                     |
| `src/server/mail/`      | Elastic Email HTTP API, SMTP, templates                                         |
| `src/shared/`           | Types, OAuth scope definitions and date handling shared by server and web       |
| `src/web/`              | React 19 SPA: pages, components, design tokens, PWA service worker              |
| `migrations/`           | Hand-written, forward-only SQL migrations                                       |
| `tests/`                | `unit/`, `integration/` (real PostgreSQL and S3) and `e2e/` (Playwright + axe)  |

## One domain layer, two front doors

The web API and the MCP server call the same functions in `src/server/domain`. Every function
takes an `AccessContext`:

```ts
{ userId, ownerId, ownerTimezone, role: 'owner' | 'helper', grants, via: 'web' | 'mcp', oauth?: { scopes, clientId, connectionId } }
```

- **Web sessions** build the context from the signed-in user and the record they selected. The
  record is chosen with the `X-OpenRampart-Record` header, or `?record=` for downloads.
- **MCP requests** build it from a verified OAuth access token. The record owner and scopes come
  from the stored connection that the person approved.

Domain functions check OAuth scopes (`requireScopes`) as well as record permissions. This
means a bug in a transport layer cannot widen access. Web sessions are not scope-limited.

## Authorisation in SQL

`src/server/domain/access.ts` turns a context into SQL predicates: `eventVisible`,
`actorLinkVisible`, `actorFullAccess`, `actorVisible`, `incidentVisible` and
`attachmentVisible`. Every read path uses these predicates in its `WHERE` clause, including:

- lists and timelines;
- counts;
- search ranking and "did you mean";
- autocomplete;
- exports;
- MCP tools.

Rows a viewer may not see are therefore never loaded, not filtered afterwards. See
[authorisation.md](authorisation.md).

## Data model (summary)

- **`users`, `sessions`, `recovery_codes`, `password_reset_tokens`, `rate_limits`**: accounts and
  sign-in.
- **`events`**: the core record. It holds the type, occurrence date or date-time (with
  precision), direction, description, tags, risk level and note, amount and currency,
  reference, due date, `revision` counter and soft-delete.
- **`event_types`**: 19 built-in types plus administrator-defined ones.
- **`actors`**: organisations and people. They can be archived, soft-deleted and merged
  (`merged_into_id`).
- **`event_actors`**: links with an optional role. `actor_id` is the current Actor and
  `origin_actor_id` the Actor originally linked, so a merge keeps Helper access unchanged.
- **`incidents`, `incident_events`**: optional groupings.
- **`event_relations`**: undirected links between Events (`event_a_id < event_b_id`).
- **`attachments`**: originals in S3 with SHA-256, size, MIME type, processing status, OCR text,
  corrections and suggestions.
- **`event_revisions`**: append-only. Each holds the canonical JSON snapshot, its SHA-256 and the
  previous revision's hash. A database trigger rejects `UPDATE` and `DELETE`.
- **`timestamp_proofs`**: OpenTimestamps proofs for attachment and revision hashes.
- **`helper_relationships`, `access_grants`, `grant_actors`, `grant_incidents`, `invitations`**:
  Helper sharing.
- **`audit_entries`**: security-relevant activity, kept separate from the timeline.
- **`oauth_payloads`, `oauth_connections`**: OAuth artefacts and the person-approved
  connections behind them.
- **`system_settings`, `system_keys`**: administrator settings and the encrypted OAuth signing
  key.

## Background work

The pg-boss queue lives in PostgreSQL, so no extra service is needed. It runs these queues:

| Queue                | Work                                                                                       |
| -------------------- | ------------------------------------------------------------------------------------------ |
| `attachment-process` | Re-hash the stored object, make a thumbnail and preview, extract text or run OCR, suggest  |
| `attachment-verify`  | Re-hash an original on request and compare it with the recorded SHA-256                    |
| `timestamp-submit`   | Batch pending hashes into a Merkle tree and submit them to OpenTimestamps calendars        |
| `timestamp-upgrade`  | Fetch completed Bitcoin attestations and verify block headers                              |
| `maintenance`        | Purge items past the deletion retention period, clean temporary files, re-queue stuck jobs |

Each step records its own status. A failure in one step never affects the Event or the
original file.

## Search

Search runs at query time over a document made of:

- the Event's own `tsvector`;
- the `tsvector`s of Actors **the viewer may see on that Event**;
- attachment text, only with permission to read contents (otherwise filenames only, with
  metadata permission);
- titles of visible Incidents.

It uses `websearch_to_tsquery` with a prefix fallback. "Did you mean" draws only on vocabulary
from rows the viewer can already see (`pg_trgm`). Snippets are produced with `ts_headline`.

## Front end

The SPA is built with Vite, React 19, React Router and TanStack Query. Design tokens are
generated from `design/rain-and-wind-on-rathlin.json` into `src/web/styles/tokens.css` by
`scripts/generate-tokens.mjs`. Rarely used screens are lazy-loaded. The service worker
(vite-plugin-pwa) caches only the application shell. Record data, attachments and API
responses are never cached for offline use, so a shared or lost device does not hold a copy of
the record.

## Start-up sequence

1. Validate configuration. Any problem stops start-up with exit code 78 and a list of every
   problem.
2. Connect to PostgreSQL.
3. Apply pending migrations, unless `OPENRAMPART_SKIP_MIGRATIONS=true`. Migrations run under an
   advisory lock, so several replicas can start at once safely.
4. Check the bucket, creating it when `S3_CREATE_BUCKET=true`.
5. Log which OCR tools are available.
6. Start the worker and/or web server, depending on `OPENRAMPART_ROLE`.
7. On `SIGTERM`, stop accepting requests, drain jobs and close the pool.

`/healthz` reports that the process is alive. `/readyz` checks PostgreSQL and object storage.
