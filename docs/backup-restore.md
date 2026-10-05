# Backup and restore

A complete OpenRampart backup has three parts. **You need all three to restore.**

| Part                | Contains                                                                                        | How to back it up                         |
| ------------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------- |
| PostgreSQL database | Everything except files: Events, Actors, revisions, accounts, sharing, OCR text, hashes, proofs | `pg_dump`                                 |
| Object storage      | Original files and their previews                                                               | Bucket sync, versioning or replication    |
| Secrets             | `SESSION_SECRET`, `ENCRYPTION_KEY` (and your `.env`)                                            | A password manager or sealed offline copy |

Without `ENCRYPTION_KEY`, the restored instance cannot decrypt two-step sign-in secrets. Every
person would have to be reset with `cli.js reset-totp` and enrol again. Without
`SESSION_SECRET`, sessions, pending invitations and recovery codes stop working. Recovery codes
can be regenerated after signing in.

Each person can also download their own **export** (Settings → Export your data). This is a
portable, human-readable copy that does not need OpenRampart to read. Encourage people to keep
one, but it is not a substitute for server backups.

## Backing up

### Database

With the bundled PostgreSQL service:

```sh
docker compose exec -T postgres \
  pg_dump -U openrampart -d openrampart --format=custom --no-owner \
  > openrampart-$(date +%F).dump
```

For an external database, run `pg_dump` with the same options against `DATABASE_URL`.

The custom format is compressed and allows selective restore. Run it daily at least, and keep
several generations.

### Object storage

Pick one approach:

- **Provider features:** enable versioning (and, where available, object lock or bucket
  replication) on R2, B2, S3 or Hetzner.
- **Sync to a second location** with [rclone](https://rclone.org):

  ```sh
  rclone sync primary:openrampart backup:openrampart-backup --checksum
  ```

  `sync` mirrors deletions. To keep deleted objects, use `copy`, or enable versioning on the
  destination.

- **Bundled SeaweedFS:** back up the `s3-data` Docker volume, or rclone it as above using the
  S3 endpoint.

Take the database dump **before** the bucket copy. Then every attachment referenced by the
dump is guaranteed to be in the copy. Objects whose database rows are not in the dump are
harmless.

### Encrypt and test

- Encrypt backups at rest, for example with `age`, `gpg` or your backup tool's encryption.
  They contain everything.
- Store at least one copy off the server.
- **Test a restore** regularly, as below, on a separate machine.

## Restoring

1. **Prepare a fresh installation** with the same `SESSION_SECRET` and `ENCRYPTION_KEY`. Keep
   the app stopped:

   ```sh
   docker compose up -d postgres
   ```

2. **Restore the database:**

   ```sh
   docker compose exec -T postgres dropdb -U openrampart --if-exists openrampart
   docker compose exec -T postgres createdb -U openrampart openrampart
   docker compose exec -T postgres \
     pg_restore -U openrampart -d openrampart --no-owner < openrampart-2026-10-05.dump
   ```

3. **Restore the bucket** by copying the objects back, with the same keys and the same
   `S3_KEY_PREFIX`:

   ```sh
   rclone copy backup:openrampart-backup primary:openrampart --checksum
   ```

4. **Start the app:**

   ```sh
   docker compose up -d
   ```

   Any newer migrations are applied automatically.

5. **Check:**
   - Sign in. Open a few Events and attachments.
   - On some attachments, choose **Verify now** to confirm the stored files match their
     recorded SHA-256 hashes.
   - Check **Settings → System settings** for storage and OCR status.

## Moving to a new server

Follow the restore steps on the new server, then point DNS at it. If `APP_URL` changes,
existing MCP connections must reconnect, because their tokens are bound to the old resource
URL. Invitation links already sent use the old address too.

## Disaster scenarios

| Lost             | Effect                                                                | Recovery                                                                                                                 |
| ---------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Database         | Everything except raw files                                           | Restore the dump; files in the bucket are re-linked by id                                                                |
| Bucket           | Original files and previews (text, hashes and metadata remain)        | Restore from the bucket backup. Files that cannot be restored show as missing, and **Verify now** reports them           |
| `ENCRYPTION_KEY` | Two-step sign-in secrets (sign-in shows a message asking for a reset) | `cli.js reset-totp` for each person. The OAuth signing key is regenerated automatically and MCP connections keep working |
| `SESSION_SECRET` | Sessions, invitations, password-reset links, recovery codes           | Everyone signs in again; regenerate recovery codes; reissue invitations                                                  |
