# Security model

OpenRampart holds sensitive personal records: letters about money, health, housing,
immigration, benefits and disputes. This page explains what the software protects, how, and
where responsibility passes to the person running it. For threats and mitigations, see
[threat-model.md](threat-model.md). To report a vulnerability, see
[../SECURITY.md](../SECURITY.md).

## Principles

1. **Your record is yours.** No administrator, Helper or AI client sees anything unless the
   record owner granted it. An instance administrator manages accounts, not records.
2. **Enforce on the server, in one place.** Access rules live in SQL predicates in
   `src/server/domain/access.ts`. Every interface (web, MCP, search, export) uses them. See
   [authorisation.md](authorisation.md).
3. **Never silently change history.** Event revisions are append-only and hash-chained.
   Originals are stored byte-for-byte and re-hashed after upload.
4. **Collect nothing.** No analytics, telemetry, third-party scripts, fonts or trackers. See
   [privacy.md](privacy.md).
5. **Fail closed.** Bad configuration stops start-up. Unknown file types are refused. Missing
   scopes return 403. Unknown or inaccessible ids return 404.

## Data at rest

| Data                                              | Where                   | Protection                                                                  |
| ------------------------------------------------- | ----------------------- | --------------------------------------------------------------------------- |
| Events, Actors, Incidents                         | PostgreSQL              | Database access control; encrypt the disk or volume (operator)              |
| Original files, previews                          | S3-compatible bucket    | Private bucket; server-side encryption if the provider offers it (operator) |
| Passwords                                         | `users.password_hash`   | argon2id                                                                    |
| TOTP secrets                                      | `users.totp_secret_enc` | AES-256-GCM with `ENCRYPTION_KEY`                                           |
| OAuth signing key                                 | `system_keys`           | AES-256-GCM with `ENCRYPTION_KEY`                                           |
| Session, invitation, reset tokens, recovery codes | PostgreSQL              | HMAC-SHA-256 with `SESSION_SECRET` (never stored in plain text)             |
| OAuth tokens and codes                            | `oauth_payloads`        | Opaque random values; expiring; revoked with the connection                 |

Field-level encryption of the record itself is **not** provided. It would stop full-text
search and offer little against an attacker who controls the running server. Protect the
database and bucket with disk encryption, network isolation and access control. Keep backups
encrypted (see [backup-restore.md](backup-restore.md)).

## Data in transit

- In production, `APP_URL` must be `https://`. Configuration validation refuses `http://`
  except for `localhost`.
- When served over HTTPS, cookies are `Secure` with the `__Host-` prefix, and
  `Strict-Transport-Security` is sent.
- The server talks to PostgreSQL (`DATABASE_SSL`), object storage, mail providers and
  OpenTimestamps calendars over TLS where the endpoint supports it.

## Browser security

- **Content Security Policy:** `default-src 'self'`, no inline or external scripts, no
  `eval`, `object-src 'none'`, `frame-ancestors 'none'`, `form-action 'self'`, `base-uri
'self'`.
- **Other headers:**
  - `Referrer-Policy: no-referrer`;
  - `X-Content-Type-Options: nosniff`;
  - `Cross-Origin-Resource-Policy: same-origin`;
  - a restrictive `Permissions-Policy` (camera allowed for this origin, for letter capture;
    microphone, geolocation and others denied).
- **Uploaded files** are served with their own policy:
  - images, text and media get `sandbox; default-src 'none'`;
  - PDFs get `default-src 'none'`.

  Only a short list of types is ever shown inline (common images, PDF, plain text and audio).
  Everything else is a download. Uploaded content therefore cannot run script in the
  application's origin.

- **CSRF:** a per-session token in a header, an `Origin` check, Fetch Metadata
  (`Sec-Fetch-Site`) and `SameSite=Lax` cookies.
- **Service worker:** caches the application shell only. It never caches record data,
  attachments or API responses.

## Uploads

- Uploads are streamed to a private temporary file, hashed (SHA-256) and size-limited
  (`MAX_UPLOAD_MB`) without being held in memory.
- The type is decided from the file's **content** (magic bytes), not its name or the
  browser's claim, and must be on an allow-list: images (including HEIC), PDF, plain text
  and CSV, common audio formats, and Word/Excel/OpenDocument files. Executables, scripts,
  HTML, SVG and general archives are refused.
- Filenames are sanitised: no path separators, control characters or leading dots, and a
  bounded length. Storage keys are generated (`originals/<owner>/<uuid>`), never derived
  from user input, which rules out path traversal.
- Processing tools (Tesseract, OCRmyPDF, Poppler, libheif) run as the unprivileged container
  user. They have time limits, page limits and a scratch directory that is removed afterwards.
  They are invoked with argument arrays, never through a shell.

## Authentication and sessions

See [authentication.md](authentication.md). In summary:

- argon2id passwords;
- mandatory TOTP by default, with replay protection;
- single-use recovery codes;
- server-side sessions with hashed tokens and idle and absolute expiry;
- device list and remote sign-out;
- PostgreSQL-backed rate limits and lock-out.

## OAuth and MCP

See [oauth.md](oauth.md) and [mcp.md](mcp.md). In summary:

- OAuth 2.1 with mandatory PKCE (S256), exact redirect URI matching, and resource indicators.
- Access tokens are bound to the MCP resource, and the MCP endpoint checks the audience.
- Refresh tokens rotate.
- The consent screen is always shown, with granular scopes. Write and attachment-content
  scopes are unticked by default.
- Every tool checks its scopes **and** the person's record permissions.
- Connections are listed and revocable. Revoking destroys every token and grant behind the
  connection.

## Logging and audit

- **Operational logs** (stdout, JSON) are for operators. They never contain passwords,
  tokens, cookies, CSRF tokens, Event descriptions, attachment contents or OCR text. Pino
  redaction removes known sensitive fields. Request logs record only the method, a path with
  query strings and one-time tokens removed, the status and the duration.
- The **Audit Log** (database) is for the record owner. It records security-relevant actions
  on their record and account, with time, IP address and user agent. It is separate from the
  timeline and cannot be edited.

## Dependencies and supply chain

- `package-lock.json` is committed, and `npm ci` is used in CI and the image.
- CI runs `npm audit` (failing on high or critical production advisories), GitHub dependency
  review, CodeQL (`security-extended`), gitleaks secret scanning and a Trivy image scan.
  Dependabot proposes updates weekly.
- The image is built from the official `node:22-bookworm-slim` base. It runs as the
  unprivileged `node` user, with a read-only root filesystem and all capabilities dropped in
  the provided Compose file.

## What the operator is responsible for

- Running behind HTTPS, with `TRUST_PROXY` set to match the proxy chain.
- Keeping `SESSION_SECRET` and `ENCRYPTION_KEY` secret and backed up separately from data
  backups.
- Restricting network access to PostgreSQL and the bucket (they never need to be public).
- Encrypting disks and backups, and testing restores.
- Applying image and OS updates.
- Choosing a mail provider and storage provider whose data handling is acceptable.

## Known limitations

- An attacker with control of the running server, or with database and bucket credentials,
  can read records. OpenRampart is not end-to-end encrypted.
- A malicious administrator of the host can read the database directly. Run OpenRampart on
  infrastructure you trust.
- OCR runs third-party parsers (Ghostscript via OCRmyPDF, Poppler, libheif) on uploaded
  files. They are sandboxed only by the container's user, read-only filesystem and dropped
  capabilities. Keep the image updated.
- Timestamps show that a hash existed no later than a time. They do not show that a
  document's contents are true. See [timestamping.md](timestamping.md).
