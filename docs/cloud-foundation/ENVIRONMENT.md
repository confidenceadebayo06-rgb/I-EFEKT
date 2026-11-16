# Environment configuration — Phase 0–1

The checked-in `.env.example` contains local MySQL, Redis, MinIO and Mailpit defaults. Copy it to `.env` for local development and replace every production value using the deployment platform's secret manager.

## Existing required variables

| Variable | Purpose |
|---|---|
| NODE_ENV | development / production |
| PORT | Fastify listener |
| APP_ORIGIN | Exact browser origin |
| DATABASE_URL | MySQL 8.4 connection |
| REDIS_URL | Shared authentication rate limiter |
| JWT_SECRET | Current transitional JWT signing key; minimum 32 random characters in production |
| COOKIE_SECURE | Must be true in production |
| SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS | Verification and recovery email |
| S3_ENDPOINT / S3_REGION / S3_BUCKET | S3-compatible object storage |
| S3_ACCESS_KEY / S3_SECRET_KEY | Object storage credentials |
| S3_PUBLIC_URL | Current media URL configuration; replace public media delivery with private authorized access before production |

## Phase 1 target variables

The following are reserved for the server-managed session implementation and are not consumed by the current server until that implementation is merged:

```dotenv
SESSION_COOKIE_NAME=iefekt_session
SESSION_TTL_DAYS=30
SESSION_IDLE_TTL_DAYS=14
SESSION_ROTATE_AFTER_HOURS=24
SESSION_IP_HASH_KEY=replace-with-independent-random-secret
AUTH_CSRF_SECRET=replace-with-independent-random-secret
AUTH_REQUIRE_EMAIL_VERIFICATION=true
```

Use independent high-entropy secrets for the IP hashing and CSRF keys. Do not reuse JWT_SECRET. Never commit `.env`, credentials, signed URLs or real user data.


## Dropbox encrypted backup connection (OAuth preparation)

Configure these only after the OAuth callback code has been reviewed and deployed:
- `DROPBOX_APP_KEY`: Dropbox app key.
- `DROPBOX_APP_SECRET`: Dropbox app secret; keep it in Railway's secret variable store.
- `DROPBOX_REDIRECT_URI`: exact HTTPS callback URL registered in the Dropbox app console, e.g. `https://<production-domain>/api/backup/dropbox/callback`.
- `DROPBOX_TOKEN_ENCRYPTION_KEY`: base64 encoding of 32 cryptographically random bytes, used for AES-256-GCM encryption of the offline refresh token before it is stored in MySQL.
- `DROPBOX_BACKUP_ADMIN_USER_ID`: exact I-EFEKT user ID permitted to initiate the system-wide Dropbox connection; do not leave unset in production.
- `BACKUP_ENCRYPTION_KEY`: a separate base64-encoded 32-byte key for encrypting database dumps. Keep it separate from the OAuth token key and store it only in Railway secrets.

The OAuth flow requests offline access and validates a one-time, ten-minute, HttpOnly state cookie. The callback stores only an AES-256-GCM encrypted refresh token in the `DropboxCredential` singleton row. It never returns or logs the token. Keep Dropbox app permissions limited to the four scopes above; the backup uploader must additionally constrain all paths to `/I-EFEKT/Production-Backups`.

Do not register the production redirect URI or set production secrets until this branch passes review and deployment is explicitly approved. This connection alone does not create or verify any backup.


## Encrypted MySQL backup operation

The app's Redis-coordinated scheduler attempts one backup per UTC day at or after 03:00 UTC. It invokes `scripts/backup-mysql.mjs`, which runs `mariadb-dump` with a consistent InnoDB snapshot, gzip-compresses the dump, encrypts it with AES-256-GCM, and uploads it using Dropbox upload sessions. The uploader accepts no user-supplied path: its destination is fixed to `/I-EFEKT/Production-Backups/MySQL`. Backup files include a small authenticated-encryption header; the encryption key is held separately in Railway secrets.

For local/CI testing only, set `BACKUP_OUTPUT_DIR` and `BACKUP_ENCRYPTION_KEY`, then run `node scripts/backup-mysql.mjs --local-only`. The isolated restore smoke test is `node scripts/restore-backup-smoke.mjs <file>`; it creates and drops a uniquely named test database and must never be pointed at a production credential. Do not mark backups reliable until a restore has been tested against a disposable database and the restored contents have been checked.
