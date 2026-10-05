# Running with Docker

## The image

The `Dockerfile` builds a multi-stage image:

1. **Build stage:** `npm ci`, build the web app (Vite) and bundle the server (esbuild), then
   prune development dependencies.
2. **Runtime stage:** `node:22-bookworm-slim` plus the OCR toolchain:
   - Tesseract with English;
   - OCRmyPDF with Ghostscript and qpdf;
   - Poppler (`pdftotext`, `pdftoppm`);
   - libheif (`heif-convert`) for iPhone HEIC photos;
   - `tini` as PID 1.

The image runs as the unprivileged `node` user (uid 1000), exposes port 3000 and has a
`HEALTHCHECK` on `/healthz`.

```sh
docker build -t openrampart .
# Extra OCR languages (Debian tesseract-ocr-* names):
docker build --build-arg OCR_LANGUAGE_PACKS="eng cym gla" -t openrampart .
```

Then set `OCR_LANGUAGES=eng+cym+gla`.

The image stores nothing on its own filesystem. Records live in PostgreSQL and files in object
storage. Uploads pass through the system temporary directory, which Compose mounts as a tmpfs.

## Docker Compose

`docker-compose.yml` is ready for production. It contains:

| Service    | Purpose                                            | Persistent data        |
| ---------- | -------------------------------------------------- | ---------------------- |
| `app`      | OpenRampart (web and worker)                       | none                   |
| `postgres` | PostgreSQL 17                                      | `postgres-data` volume |
| `s3`       | Optional SeaweedFS S3 store (profile `bundled-s3`) | `s3-data` volume       |

Notable choices:

- **No `container_name`**, so stacks can be duplicated and Dokploy can manage names.
- `app` is only `expose`d on the internal network. Publish it or put it behind a proxy.
- `read_only: true`, `cap_drop: [ALL]`, `no-new-privileges` and a tmpfs `/tmp` sized by
  `UPLOAD_TMPFS_SIZE`.
- `depends_on` waits for a healthy PostgreSQL. Migrations run automatically when the app
  starts.
- Required variables use `${VAR:?message}`, so Compose refuses to start with a clear error if
  one is missing.

### First run

```sh
cp .env.example .env
$EDITOR .env
docker compose up -d --build
docker compose logs -f app
```

Look for `database migrations applied` and `web server listening`. Then visit `APP_URL` and
create the first account, which becomes the administrator.

To create the administrator from the command line instead (useful with
`REGISTRATION_MODE=closed`):

```sh
docker compose exec -e OPENRAMPART_PASSWORD='a long passphrase' app \
  node dist/server/cli.js create-admin alex "Alex Example"
```

### Exposing it

For a quick local trial, publish the port with an override file:

```yaml
# docker-compose.override.yml
services:
  app:
    ports: ['127.0.0.1:3000:3000']
```

Then set `APP_URL=http://localhost:3000`.

For real use, terminate HTTPS at a reverse proxy (Caddy, Traefik, nginx) and forward to
`app:3000` on the Compose network. Keep `TRUST_PROXY=1` for one proxy hop. Example Caddyfile:

```
rampart.example.org {
  reverse_proxy app:3000
  request_body {
    max_size 60MB
  }
}
```

Allow request bodies a little larger than `MAX_UPLOAD_MB`.

### Splitting web and worker

For larger installations, run the worker separately. Add a `worker` service to your copy of
`docker-compose.yml` (it reuses the `x-app-env` block defined at the top of that file):

```yaml
services:
  app:
    environment:
      OPENRAMPART_ROLE: web
  worker:
    image: ${OPENRAMPART_IMAGE:-openrampart:latest}
    environment:
      <<: *app-env
      OPENRAMPART_ROLE: worker
    cap_drop: [ALL]
    read_only: true
    tmpfs: ['/tmp:size=2g,mode=1777']
    depends_on:
      postgres:
        condition: service_healthy
```

Web replicas can be scaled freely. Migrations use an advisory lock, and sessions, rate limits
and jobs all live in PostgreSQL.

### Operator commands

```sh
docker compose exec app node dist/server/cli.js migrate
docker compose exec -e OPENRAMPART_PASSWORD='…' app node dist/server/cli.js reset-password <username>
docker compose exec app node dist/server/cli.js reset-totp <username>
docker compose exec app node dist/server/cli.js disable <username>
docker compose exec app node dist/server/cli.js enable <username>
docker compose exec app node dist/server/cli.js maintenance   # purge expired Trash, clean temp files
```

### Upgrading

```sh
git pull
docker compose build app
docker compose up -d
```

Migrations are applied on start. Take a backup first (see
[backup-restore.md](backup-restore.md)) and read the release notes for anything marked as
needing action.

### Health checks

- `GET /healthz`: the process is up (used by the image `HEALTHCHECK`).
- `GET /readyz`: PostgreSQL and object storage are reachable (used by the Compose health
  check).

## Development dependencies only

`docker-compose.dev.yml` starts PostgreSQL on `127.0.0.1:5432` and SeaweedFS S3 on
`127.0.0.1:8333`, for running the app with `npm run dev`. See
[../CONTRIBUTING.md](../CONTRIBUTING.md).
