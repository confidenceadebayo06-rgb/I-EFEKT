# I-EFEKT production deployment on Render

This is a **preparation blueprint**, not permission to switch production traffic. It creates a Docker web service and private Render Key Value (Redis) service. Automatic deploys are disabled so production changes remain deliberate.

## Important database gate

I-EFEKT currently uses Prisma with **MySQL**. This Blueprint intentionally does not create or migrate a database and prompts for `DATABASE_URL` rather than guessing a connection string.

Before deploying the API:
1. Provision a MySQL 8-compatible production database reachable from the Render Singapore region (a private Render MySQL service or a suitable managed MySQL provider).
2. Take a database-aware backup of the current production database and verify that it can be restored. Do not use the Railway private hostname from Render; it is not reachable across providers.
3. Compare the source schema with the actual database schema, including legacy tables and columns. Preserve AuditLog, DeviceSession, UserGoal, UserSkill and the legacy GroupMember/SocialGroup columns until their data and dependencies are accounted for.
4. Reconcile the migration history. The repository currently has a UserNotification migration, not a complete baseline for the full schema. Do not run `prisma migrate deploy` against a blank database and assume it will create all application tables.
5. Prepare and review a complete baseline / migration sequence. Never use `prisma db push --accept-data-loss`, `--force-reset`, or an equivalent destructive shortcut.
6. Only then enter the verified MySQL connection string in Render's `DATABASE_URL` setting and deploy manually.

## Render service configuration

- Region: Singapore (choose the same region for the API, Redis, and MySQL).
- Runtime: Docker using the repository Dockerfile.
- Health check: `/api/health`.
- Automatic deploy: disabled.
- Redis: private Render Key Value service; its internal connection string is wired to `REDIS_URL`.
- `APP_ORIGIN`: set to the final HTTPS origin serving the I-EFEKT frontend/API.
- `DATABASE_URL`: set only after the MySQL database is provisioned and its schema/migration plan is approved.
- SMTP values: supply a real production mail provider before enabling account verification and password reset.
- S3/R2 media: optional for this first deployment; do not configure or upgrade R2 as part of this step.

## Cutover checklist

Do not point the production domain at Render until:
- the production database is restored and verified;
- Prisma schema and migrations are reconciled without dropping legacy data;
- Render deploy is healthy at `/api/health`;
- login, registration/email verification, posts, Circles, owner approvals, notifications, Redis-backed sessions/rate limits, and Socket.IO/WebRTC signalling have been tested;
- a rollback plan and DNS rollback window are agreed.

The existing Railway production service and Railway staging environment must remain untouched during preparation.
