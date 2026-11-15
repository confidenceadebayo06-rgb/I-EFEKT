# I-EFEKT cloud foundation — Phase 0–1

## Scope and compatibility

This package extends the existing Node.js 22 + TypeScript + Fastify + Prisma + MySQL 8.4 + Redis + Socket.IO application. It does not replace `public/index.html`, rewrite the frontend, or introduce a second backend. The current HTML/PWA remains the client during staged migration.

Existing routes already present in `src/server.ts` include email registration, verification, login, logout, password reset, `/api/me`, profile updates, preferences, export/deletion, and Redis-backed authentication throttling. These are existing code paths, not evidence of a production identity provider or verified production deployment.

## Current security findings to close before production

1. Authentication currently uses a signed seven-day JWT cookie. There is no server-side session registry, so clearing the cookie on logout does not revoke a copied token.
2. Password reset changes the password but does not revoke previously issued JWTs.
3. Socket.IO validates the JWT but does not consult a revocable server-side session.
4. The media presign route trusts the declared MIME type, accepts a 30 MB limit, and returns a public URL. Actual file signature scanning and private-object authorization are not implemented in this Phase 0–1 package.
5. The Docker startup currently runs `prisma db push`. The repository has no checked-in migration baseline, so do not switch a live database to `prisma migrate deploy` until a baseline has been reviewed and recorded.

## Phase 0 — environment and migration discipline

- Keep development, staging and production credentials separate.
- Set a unique high-entropy `JWT_SECRET` (at least 32 random bytes); never commit real secrets.
- Require HTTPS and `COOKIE_SECURE=true` in production.
- Restrict `APP_ORIGIN` to the exact deployed origin; do not use wildcard credentialed CORS.
- Require Redis in production; the existing auth limiter fails closed if Redis is unavailable.
- Back up the database before schema changes.
- Review the current live schema against `prisma/schema.prisma`.
- Baseline the existing schema before applying future incremental Prisma migrations. Never run `migrate reset` or destructive schema sync against production data.
- Apply `202611150001_cloud_foundation_sessions_audit` only after confirming the existing `User` table and columns match the current Prisma schema.

## Phase 1 — identity/session implementation contract

### Required session behavior

- Replace long-lived self-contained bearer semantics with a random opaque session secret in a Secure, HttpOnly, SameSite=Lax cookie.
- Persist only SHA-256 of the random secret in `DeviceSession.tokenHash`; never persist or log the raw cookie secret.
- Resolve each request to an active session and user. Reject revoked or expired sessions.
- Rotate the session on successful login and sensitive account changes.
- Logout revokes the current server-side session before clearing the cookie.
- Password reset revokes every active session for that user.
- Add a "log out other devices" operation that revokes all sessions except the current one.
- Socket.IO handshake must resolve the same active session and reject revoked/expired sessions. Recheck session validity for long-lived connections or disconnect them on revocation.
- Keep email verification mandatory before login.
- Keep password hashing with Argon2id as the target; the current code uses bcryptjs. A hash migration must be version-aware and must not lock users out. Until the migration is implemented and tested, do not claim Argon2id is active.
- Use generic forgot-password responses and single-use, expiring, hashed reset tokens.
- Add CSRF protection for cookie-authenticated state-changing routes; SameSite cookies alone are not the complete CSRF strategy.
- Audit login success/failure, logout, password reset, session revocation, email verification and account deletion. Store only a one-way IP hash if operationally required; never store credentials or message bodies in audit metadata.

### DeviceSession and AuditLog models

The additive Prisma models and matching MySQL migration in this package provide:
- server-side revocable sessions;
- device label, user-agent and hashed IP metadata;
- expiration, last-seen and revocation timestamps;
- security audit records with optional user association.

These models are now wired into the authentication middleware and Socket.IO handshake on this feature branch. Login and email verification issue random opaque cookies; only token hashes are persisted. Logout revokes the current session, password reset revokes all sessions, session listing/revocation endpoints are available, and Socket.IO checks active session status at connection and periodically while connected. A one-time legacy JWT exchange is included for existing browser sessions. This is implementation work on a feature branch; Phase 1 is not complete until CI, staging integration tests, migration review and two-device verification pass.

## API contract

The companion `AUTH_API.yaml` describes the intended v1 contract. Keep the current `/api/auth/*` routes backward compatible during transition; add aliases or versioned routes rather than breaking the existing HTML client.

## PWA integration — no frontend rewrite

1. Keep `public/index.html` and existing interaction handlers intact.
2. Add a small auth adapter that calls the existing API with `credentials: 'include'`.
3. On app startup, call `GET /api/me`; render signed-out or signed-in state without storing credentials in localStorage.
4. Add session/device management UI only after the server-side session endpoints exist.
5. Keep preferences and personalization opt-in; default to disabled.
6. Keep existing localStorage data readable. Introduce IndexedDB for queued mutations/media cache in a later sync phase; do not delete legacy keys during Phase 0–1.
7. Register the existing service worker only over HTTPS (localhost is permitted for development). Do not cache authenticated API responses, account exports, private messages or signed media URLs.
8. Add an explicit, user-confirmed import path for existing compatible backups after the account is authenticated.

## Rollout and rollback

- Deploy schema additions before code that requires them.
- Deploy API session changes behind a feature flag or compatible transition path.
- During transition, accept the old JWT only for a short, documented migration window; exchange it for a new server-side session, then remove JWT-cookie acceptance.
- Roll back application code without dropping the new tables.
- Keep database restore points and test restoration before production rollout.

## Exit criteria

- Two devices can sign in independently and are listed as separate sessions.
- Logout revokes the current session server-side.
- Password reset revokes all existing sessions.
- A copied/revoked cookie cannot access `/api/me` or Socket.IO.
- Email verification and password recovery are single-use and expire.
- Unauthenticated profile access returns 401; unauthorized resources return 403/404 without leaking ownership.
- Auth routes are rate-limited across API replicas using Redis.
- Existing HTML prototype still loads and local data remains untouched.
- CI runs TypeScript build and security contract tests.
- A staging migration and rollback rehearsal completes without data loss.

## Explicitly not delivered in this package

No live cloud account has been created, no secrets have been provisioned, no production database has been migrated, and no deployment or real cross-device session behavior has been verified. Cloud media hardening, sync mutations/change-feed correctness, offline retry queues and full account lifecycle are subsequent phases.
