# Configuration reference

OpenRampart is configured only through environment variables. In Docker Compose they come from
`.env`; in Dokploy, from the Environment tab. They are validated at start-up. If anything is
wrong, the process prints **every** problem and exits with code 78, so misconfiguration is
caught before anyone uses the service.

[`.env.example`](../.env.example) lists every setting with comments. A unit test
(`tests/unit/config.test.ts`) keeps it in step with the code.

Boolean settings accept `true/false`, `1/0`, `yes/no` and `on/off`.

## Required

| Variable               | Description                                                                                                                                                                                                                  |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `APP_URL`              | Public base URL, without a trailing slash. Must be `https://` in production (except `localhost`). Used for links, cookies, OAuth issuer and MCP resource.                                                                    |
| `DATABASE_URL`         | `postgres://user:password@host:5432/database`                                                                                                                                                                                |
| `SESSION_SECRET`       | At least 32 characters (`openssl rand -base64 48`). Keys the hashes of sessions, invitation and reset tokens, and recovery codes. **Changing it signs everyone out and invalidates recovery codes and pending invitations.** |
| `ENCRYPTION_KEY`       | 32 bytes, base64 (`openssl rand -base64 32`). Encrypts TOTP secrets and the OAuth signing key. **If lost, everyone must re-enrol two-step sign-in, and MCP clients must reconnect.**                                         |
| `S3_BUCKET`            | Bucket name                                                                                                                                                                                                                  |
| `S3_ACCESS_KEY_ID`     | Access key                                                                                                                                                                                                                   |
| `S3_SECRET_ACCESS_KEY` | Secret key                                                                                                                                                                                                                   |

## Application

| Variable           | Default      | Description                                                                                               |
| ------------------ | ------------ | --------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`         | `production` | `development`, `production` or `test`                                                                     |
| `OPENRAMPART_ROLE` | `all`        | `all` (web and worker), `web` or `worker`. Run several `web` replicas and one or more `worker`s to scale. |
| `HOST`             | `0.0.0.0`    | Listen address                                                                                            |
| `PORT`             | `3000`       | Listen port                                                                                               |
| `TRUST_PROXY`      | `1`          | Number of trusted proxy hops, `true`/`false`, or an Express trust list such as `loopback, 10.0.0.0/8`     |
| `LOG_LEVEL`        | `info`       | `fatal`, `error`, `warn`, `info`, `debug`, `trace` or `silent`                                            |

## Database

| Variable            | Default   | Description                                                               |
| ------------------- | --------- | ------------------------------------------------------------------------- |
| `DATABASE_SSL`      | `disable` | `require` (verify certificate) or `no-verify` (encrypt without verifying) |
| `DATABASE_POOL_MAX` | `10`      | Connections per process                                                   |

PostgreSQL 15 or newer is required (17 is recommended and used in Compose). Migrations create
the `pg_trgm` and `pgcrypto` extensions. The database user needs permission to do so on the
first run.

## Accounts and sessions

| Variable                       | Default      | Description                                                                                                                 |
| ------------------------------ | ------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `REGISTRATION_MODE`            | `first-user` | `first-user`, `open` or `closed` (see [authentication.md](authentication.md)). An administrator can override it in the app. |
| `REQUIRE_TOTP`                 | `true`       | Require an authenticator app for every account                                                                              |
| `SESSION_MAX_AGE_HOURS`        | `336`        | Absolute session lifetime (14 days)                                                                                         |
| `SESSION_IDLE_TIMEOUT_MINUTES` | `4320`       | Sign out after this long without use (3 days)                                                                               |
| `COOKIE_SECURE`                | _(auto)_     | Leave empty to follow `APP_URL`. Set `true` when TLS ends at a proxy and `APP_URL` is `https://` (automatic).               |
| `INVITATION_TTL_HOURS`         | `72`         | Helper invitation lifetime                                                                                                  |

## Object storage

| Variable              | Default     | Description                                             |
| --------------------- | ----------- | ------------------------------------------------------- |
| `S3_ENDPOINT`         | _(AWS)_     | Endpoint URL for non-AWS providers                      |
| `S3_REGION`           | `us-east-1` | Region (`auto` for Cloudflare R2)                       |
| `S3_FORCE_PATH_STYLE` | `false`     | `true` for MinIO, SeaweedFS and most self-hosted stores |
| `S3_CREATE_BUCKET`    | `false`     | Create the bucket at start-up if missing                |
| `S3_KEY_PREFIX`       | _(empty)_   | Prefix for every key when sharing a bucket              |
| `MAX_UPLOAD_MB`       | `50`        | Largest accepted upload                                 |

See [object-storage.md](object-storage.md) for provider-specific examples.

## Deletion

| Variable                  | Default | Description                                                                                                                                                                                                          |
| ------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DELETION_RETENTION_DAYS` | `30`    | Days that deleted items stay in the Trash before being purged (originals included). The purge date is fixed when an item is deleted, so a change applies to later deletions. `0` purges at the next maintenance run. |

## OCR

| Variable              | Default | Description                                                                                                             |
| --------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------- |
| `OCR_ENABLED`         | `true`  | Turn text recognition off entirely                                                                                      |
| `OCR_LANGUAGES`       | `eng`   | Tesseract languages, joined with `+` (e.g. `eng+cym`). Install extra data with the `OCR_LANGUAGE_PACKS` build argument. |
| `OCR_TIMEOUT_SECONDS` | `300`   | Per-document limit                                                                                                      |
| `OCR_CONCURRENCY`     | `1`     | Documents processed at once per worker                                                                                  |
| `OCR_MAX_PDF_PAGES`   | `200`   | Only the first this-many pages of a longer scanned PDF are OCR'd (the whole file is still stored)                       |

## Timestamping

| Variable                       | Default                        | Description                                                   |
| ------------------------------ | ------------------------------ | ------------------------------------------------------------- |
| `TIMESTAMP_PROVIDER`           | `none`                         | `opentimestamps` to enable                                    |
| `OTS_CALENDARS`                | _(three public calendars)_     | Comma-separated calendar URLs                                 |
| `OTS_MIN_CALENDARS`            | `1`                            | Calendars that must accept a submission                       |
| `OTS_BATCH_INTERVAL_MINUTES`   | `10`                           | How often pending hashes are submitted                        |
| `OTS_UPGRADE_INTERVAL_MINUTES` | `180`                          | How often pending proofs are checked for Bitcoin attestations |
| `BITCOIN_EXPLORER_URL`         | `https://blockstream.info/api` | Esplora-compatible API for block headers                      |

See [timestamping.md](timestamping.md).

## OAuth and MCP

| Variable                         | Default       | Description                              |
| -------------------------------- | ------------- | ---------------------------------------- |
| `OAUTH_ISSUER`                   | `APP_URL`     | Override only if you know you need to    |
| `MCP_RESOURCE_URL`               | `APP_URL/mcp` | The MCP resource identifier and audience |
| `OAUTH_ACCESS_TOKEN_TTL_SECONDS` | `3600`        | Access token lifetime                    |
| `OAUTH_REFRESH_TOKEN_TTL_DAYS`   | `30`          | Refresh token lifetime (rotated on use)  |
| `OAUTH_ENABLE_DCR`               | `true`        | Dynamic Client Registration              |
| `OAUTH_ENABLE_CIMD`              | `true`        | Client ID Metadata Documents             |

## Email

| Variable                     | Default                           | Description                                                                                 |
| ---------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------- |
| `MAIL_PROVIDER`              | `none`                            | `none`, `elasticemail` or `smtp` (`log` prints to the console and is refused in production) |
| `MAIL_FROM_ADDRESS`          | —                                 | Required with a provider                                                                    |
| `MAIL_FROM_NAME`             | `OpenRampart`                     |                                                                                             |
| `ELASTIC_EMAIL_API_KEY`      | —                                 | Required for `elasticemail`                                                                 |
| `ELASTIC_EMAIL_API_URL`      | `https://api.elasticemail.com/v4` |                                                                                             |
| `SMTP_HOST`                  | —                                 | Required for `smtp`                                                                         |
| `SMTP_PORT`                  | `587`                             |                                                                                             |
| `SMTP_SECURE`                | `false`                           | `true` for implicit TLS (usually port 465)                                                  |
| `SMTP_USER`, `SMTP_PASSWORD` | —                                 |                                                                                             |

See [email.md](email.md). Without email, OpenRampart works fully. Invitation links are shown
to the owner to share, and password reset is handled by an operator.

## Operator-only variables

| Variable                          | Description                                                                        |
| --------------------------------- | ---------------------------------------------------------------------------------- |
| `OPENRAMPART_SKIP_MIGRATIONS`     | `true` to start without applying migrations (when they are run as a separate step) |
| `MIGRATIONS_DIR`                  | Override the migrations directory (default `./migrations`)                         |
| `OPENRAMPART_PASSWORD`            | Password for `cli.js create-admin`                                                 |
| `OPENRAMPART_DISABLE_RATE_LIMITS` | Tests only. **Never set in production.**                                           |

## Docker build arguments

| Argument             | Default                 | Description                                                             |
| -------------------- | ----------------------- | ----------------------------------------------------------------------- |
| `OCR_LANGUAGE_PACKS` | `eng`                   | Space-separated Debian `tesseract-ocr-*` suffixes, e.g. `"eng cym gla"` |
| `NODE_IMAGE`         | `node:22-bookworm-slim` | Base image                                                              |

## Compose-only variables

| Variable                                            | Description                                                                                             |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB` | Bundled PostgreSQL credentials (the app's `DATABASE_URL` is built from them)                            |
| `COMPOSE_PROFILES`                                  | `bundled-s3` to run the bundled SeaweedFS service                                                       |
| `OPENRAMPART_IMAGE`                                 | Image to run (default `openrampart:latest`, built locally)                                              |
| `UPLOAD_TMPFS_SIZE`                                 | Size of the in-memory `/tmp` used while receiving uploads (default `1g`); keep it above `MAX_UPLOAD_MB` |
| `SEAWEEDFS_TAG`                                     | SeaweedFS image tag                                                                                     |
