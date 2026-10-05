# Deploying on Dokploy

[Dokploy](https://dokploy.com) can deploy OpenRampart directly from this repository's
`docker-compose.yml`. The Compose file deliberately has no `container_name`, publishes no host
ports and keeps all state in named volumes, as Dokploy expects.

## 1. Create the service

1. In your Dokploy project, choose **Create Service → Compose**.
2. **Provider:** Git or GitHub, pointing at your fork or `https://github.com/dynumo/OpenRampart`,
   branch `main`.
3. **Compose path:** `./docker-compose.yml`.
4. **Compose type:** Docker Compose.

## 2. Environment

Open the **Environment** tab and paste the contents of `.env.example`, then fill in:

```sh
APP_URL=https://rampart.example.org
POSTGRES_PASSWORD=<long random>
SESSION_SECRET=<openssl rand -base64 48>
ENCRYPTION_KEY=<openssl rand -base64 32>
TRUST_PROXY=1

# Object storage: either an external provider…
S3_ENDPOINT=https://<account>.r2.cloudflarestorage.com
S3_REGION=auto
S3_BUCKET=openrampart
S3_ACCESS_KEY_ID=…
S3_SECRET_ACCESS_KEY=…

# …or the bundled SeaweedFS service:
# COMPOSE_PROFILES=bundled-s3
# S3_ENDPOINT=http://s3:8333
# S3_FORCE_PATH_STYLE=true
# S3_CREATE_BUCKET=true
# S3_BUCKET=openrampart
# S3_ACCESS_KEY_ID=openrampart
# S3_SECRET_ACCESS_KEY=<long random>
```

Keep a copy of `SESSION_SECRET` and `ENCRYPTION_KEY` somewhere safe, outside Dokploy. You need
them to restore a backup.

Add a mail provider if you want invitation and password-reset emails (see
[email.md](email.md)).

## 3. Domain

In the **Domains** tab, add your domain:

- **Service:** `app`
- **Container port:** `3000`
- **HTTPS:** on, with Let's Encrypt

Dokploy's Traefik terminates TLS and forwards to the app, which is one proxy hop, so
`TRUST_PROXY=1` is correct. The domain must match `APP_URL` exactly.

If uploads larger than Traefik's default body limit fail, raise the limit in Dokploy's Traefik
settings to a little above `MAX_UPLOAD_MB`.

## 4. Deploy

Select **Deploy**. Dokploy builds the image from the `Dockerfile` and starts PostgreSQL (and
SeaweedFS if enabled), then the app. Watch the **Logs** tab for:

```
database migrations applied
web server listening
```

Visit your domain and create the first account. It becomes the administrator and is asked to
set up two-step sign-in.

## 5. Check

- Go to **Settings → System settings** and check that the OCR tools and storage show as
  available.
- To check email, use **Send test email** on the same page.
- To check the MCP endpoint, open
  `https://rampart.example.org/.well-known/oauth-protected-resource/mcp`.

## Backups on Dokploy

Dokploy can schedule PostgreSQL backups for **database services** it manages. Because
PostgreSQL here runs inside the Compose stack, use one of these options:

- Run the `pg_dump` command in [backup-restore.md](backup-restore.md) from a Dokploy
  **Schedule** (Compose service → Schedules) against the `postgres` service.
- Or create PostgreSQL as a separate Dokploy **Database** service, point `DATABASE_URL` at
  it, remove the `postgres` service from your fork's Compose file, and use Dokploy's built-in
  database backups.

Object storage must be backed up separately: use your provider's versioning or replication,
or sync the bucket (see [backup-restore.md](backup-restore.md)).

## Updating

Select **Deploy** again after pulling a new version, or enable auto-deploy on push for your
fork. Migrations run automatically on start. Take a backup first.
