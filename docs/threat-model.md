# Threat model

This is a STRIDE-style threat model for a typical deployment. It covers one OpenRampart
container behind an HTTPS reverse proxy, with PostgreSQL and an S3-compatible bucket, used by
one or a few people and their Helpers. It is reviewed whenever a feature changes a trust
boundary.

## Assets

1. **Record contents**: Events, notes, Actors, Incidents and relationships.
2. **Original documents and OCR text**: often the most sensitive part.
3. **Account credentials**: passwords, TOTP secrets, recovery codes, sessions.
4. **Sharing configuration**: who can see what.
5. **Integrity evidence**: hashes, revision chains, timestamp proofs.
6. **Instance secrets**: `SESSION_SECRET`, `ENCRYPTION_KEY`, database and storage credentials,
   mail API keys.

## Actors and trust levels

| Actor                                                                         | Trust                                                                     |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Record owner                                                                  | Full trust over their own record                                          |
| Helper                                                                        | Trusted only within their grants                                          |
| Instance administrator                                                        | Trusted to run the service; **not** trusted with records through the app  |
| MCP client / AI assistant                                                     | Trusted only within the approved scopes and the person's own permissions  |
| Other users on the instance                                                   | Untrusted with respect to each other's records                            |
| Anonymous internet                                                            | Untrusted                                                                 |
| Infrastructure operator (host, database, bucket)                              | Trusted. OpenRampart cannot protect data from whoever controls the server |
| External services (mail provider, OpenTimestamps calendars, Bitcoin explorer) | Receive only the minimum (see below)                                      |

## Trust boundaries

1. Browser ↔ server (HTTPS, session cookie, CSRF).
2. MCP client ↔ server (OAuth bearer token, audience-bound).
3. Server ↔ PostgreSQL and object storage (credentials, private network).
4. Server ↔ OCR tools (untrusted file input, local process).
5. Server ↔ external services:
   - mail: the recipient address, subject and a link (never record contents);
   - OpenTimestamps: a Merkle root of salted hashes only;
   - block explorer: block heights only.

## Threats and mitigations

### Spoofing

| Threat                                           | Mitigation                                                                                                                                           |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Password guessing / credential stuffing          | argon2id, minimum length and common-password checks, IP and account rate limits, lock-out, TOTP required by default                                  |
| Stolen password                                  | TOTP second factor; sign-in alerts in the Audit Log; session list with remote sign-out                                                               |
| TOTP code replay                                 | Last-used time step stored; codes at or before it refused                                                                                            |
| Session theft                                    | `HttpOnly`, `Secure`, `__Host-` cookie; tokens stored hashed; idle and absolute expiry; revoked on password or TOTP change                           |
| Malicious OAuth client impersonating a known app | Consent screen shows the client name and the host it returns to, with a warning when that is a local address; exact redirect matching; PKCE required |
| Invitation link forwarded to the wrong person    | Single use; expiry; the owner sees who accepted and can end access immediately                                                                       |

### Tampering

| Threat                                          | Mitigation                                                                                                           |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Silent edits to history                         | Every change appends a revision. Revisions are hash-chained and a database trigger refuses `UPDATE`/`DELETE` on them |
| Altered stored original                         | SHA-256 recorded at upload and re-checked after storage; on-demand integrity check; optional OpenTimestamps proof    |
| Cross-site request forgery                      | CSRF header token, `Origin` and `Sec-Fetch-Site` checks, `SameSite=Lax`                                              |
| Helper widening their own access by adding data | Post-check: anything a Helper creates must fall inside one of their Add grants, or the change is rolled back         |
| Merging Actors to change who sees what          | Grants evaluated on `origin_actor_id`; widening requires an explicit, audited choice                                 |

### Repudiation

| Threat                                    | Mitigation                                                                          |
| ----------------------------------------- | ----------------------------------------------------------------------------------- |
| "I never changed that"                    | Revisions record who (person and channel: web or MCP client) and when               |
| Unnoticed access by a Helper or assistant | Audit Log entries for sharing changes, original downloads, exports and MCP tool use |

### Information disclosure

| Threat                                                                                | Mitigation                                                                                                                           |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| IDOR: guessing another record's ids                                                   | All queries are filtered by SQL visibility predicates; inaccessible ids return 404                                                   |
| Leakage through search, counts, suggestions, autocomplete, OCR suggestions or exports | Every one of these is built from the same predicates; more than 30 integration tests target leakage                                  |
| Co-Actor names on shared Events                                                       | Redacted by default for Actor-scoped grants                                                                                          |
| Revision snapshots revealing redacted names                                           | Canonical snapshots shown to the owner only                                                                                          |
| AI assistant reading documents                                                        | `attachments:read` is a separate scope, unticked by default; metadata scope reveals no contents; tokens are audience-bound to `/mcp` |
| Uploaded HTML/SVG running script                                                      | Content-sniffed allow-list; sandboxed CSP on file responses; `nosniff`                                                               |
| Secrets or contents in logs                                                           | Pino redaction; request logs drop query strings and one-time tokens; no OCR text or descriptions logged                              |
| Data left on a shared or lost device                                                  | Service worker caches only the app shell; sign-out clears in-memory data with a full page load                                       |
| Account enumeration                                                                   | Uniform responses and timing for sign-in and password reset; 404 for records without access                                          |
| Telemetry or third parties                                                            | None: no analytics, external fonts, scripts or CDNs                                                                                  |
| Timestamping revealing contents                                                       | Only salted hashes in a Merkle tree are sent; calendars cannot recover content                                                       |

### Denial of service

| Threat                            | Mitigation                                                                                                                                    |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Very large uploads                | Streaming with a hard size limit; temporary files removed on failure                                                                          |
| Decompression bombs and huge PDFs | Page limits (`OCR_MAX_PDF_PAGES`), time limits (`OCR_TIMEOUT_SECONDS`), limited OCR concurrency; image processing via sharp with pixel limits |
| Brute force on the token endpoint | Rate limit                                                                                                                                    |
| Job queue flooding                | Jobs run with bounded concurrency; failures retried a limited number of times                                                                 |

Volumetric attacks are out of scope and belong at the reverse proxy or CDN.

### Elevation of privilege

| Threat                                            | Mitigation                                                                                                       |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Administrator reading records                     | No application path exists; administrator actions are audited on the affected account                            |
| MCP token used beyond its scopes                  | Scope checks in the MCP layer **and** the domain layer                                                           |
| MCP token used against another resource or server | Resource indicators; audience validation on every request                                                        |
| Helper editing others' entries or deleting        | Helpers can edit only their own Events, within Add grants; deletion is owner-only                                |
| Exploit in an OCR parser                          | Unprivileged user, read-only root filesystem, dropped capabilities, no shell, time limits; image kept up to date |

## Residual risks (accepted)

- Compromise of the server, database or bucket exposes records. There is no end-to-end
  encryption.
- The mail provider sees recipient addresses and the text of notification emails. These carry
  names and links, never record contents.
- A Helper can copy anything they are allowed to see. Sharing is trust, and the interface says
  so.
- OpenTimestamps depends on public calendars and the Bitcoin network. Proofs remain verifiable
  offline once complete.

## Review checklist for changes

- [ ] Does this add a new read path? It must use the predicates in `access.ts`.
- [ ] Does it return Actor names? Check redaction for Helpers.
- [ ] Does it add an MCP tool? Declare scopes and test the 403 challenge.
- [ ] Does it log anything new? No contents, tokens or OCR text.
- [ ] Does it accept a file or URL? Validate type, size and destination.
- [ ] Add a leakage test to `tests/integration/permissions.test.ts`.
