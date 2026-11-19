# I-EFEKT — MySQL + Redis + TypeScript + C++ build

I-EFEKT is a social/video web PWA with a TypeScript API, MySQL persistence, Redis-backed shared authentication rate limits, Socket.IO realtime events, and a C++20 worker for bounded feed-ranking calculations.

## Stack
- Web: HTML/CSS/JavaScript PWA
- API: Node.js 22, TypeScript, Fastify
- Database: MySQL 8.4, Prisma
- Rate limiting: Redis 7 + ioredis (atomic Lua fixed-window counters shared across API replicas)
- Realtime: Socket.IO
- Native ranking: C++20, compiled with -O3
- Local development: Docker Compose, Redis, MinIO, Mailpit

## Local setup
Requirements: Node.js 22+, Docker Compose, and a C++20 compiler.
1. Copy .env.example to .env and set a unique JWT_SECRET.
2. Start dependencies: docker compose up -d.
3. Install dependencies: npm install.
4. Build native worker: npm run engine:build.
5. Generate Prisma client: npm run db:generate.
6. Apply local schema: npx prisma db push.
7. Compile: npm run build.
8. Start: npm run dev.
9. Open http://localhost:3000. Mailpit UI: http://localhost:8025.

## Authentication rate limits
Redis enforces shared per-IP fixed windows for login (10 per 15 minutes), registration (5 per hour), forgot-password (5 per hour), reset-password (10 per hour), and email verification (20 per hour). Redis uses an atomic Lua script so simultaneous requests and multiple app replicas share one counter. If Redis is unavailable, sensitive authentication routes fail closed with HTTP 503 rather than silently falling back to per-process counters. Production startup requires REDIS_URL.

## Railway
Railway uses the root Dockerfile and railway.json. Create MySQL and Redis services in the same private network. Set API variable DATABASE_URL to `${{MySQL.MYSQL_URL}}` and REDIS_URL to `redis://redis.railway.internal:6379` (replace service hostname if your Redis service has a different name). Also set NODE_ENV=production, JWT_SECRET, COOKIE_SECURE=true, APP_ORIGIN, SMTP settings, and production S3-compatible storage variables. Do not commit secrets.

## Cloudflare R2 media storage (staging)

R2 is S3-compatible. For a bucket named `iefekt-media`, configure these variables on the staging API service only:

- `S3_ENDPOINT=https://<ACCOUNT_ID>.r2.cloudflarestorage.com`
- `S3_REGION=auto`
- `S3_BUCKET=iefekt-media`
- `S3_ACCESS_KEY` and `S3_SECRET_KEY`: an R2 API token scoped to this bucket with Object Read & Write permissions
- `S3_PUBLIC_URL`: the public media hostname or authorized media-delivery base URL, with no trailing slash

The upload API signs a PUT request and verifies the stored object's size and content type before marking the asset uploaded. Configure the bucket's CORS policy to allow the staging app origin, PUT, and the `Content-Type` request header; expose only the headers needed by the browser. Keep the bucket private unless a deliberate public/custom-domain delivery policy has been chosen. Never put R2 credentials in browser code or commit them. Do not copy staging credentials into production.

For R2, use `S3_REGION=auto`; the API also defaults custom S3 endpoints to `auto` when this variable is unset. The standard local MinIO setup continues to use `us-east-1`.

## WebRTC TURN configuration
I-EFEKT requests short-lived ICE credentials from the backend for each call. To use managed Turnix TURN relay, set `TURNIX_API_TOKEN` as a server-side secret. The API token is never sent to the browser; the authenticated API requests credentials from Turnix with a 3600-second TTL and returns only the ICE server list and expiry. If the token is absent, the app retains its existing optional `TURN_URLS` + `TURN_SHARED_SECRET` configuration and STUN-only fallback.

The backend sends Fastify's `req.ip` as `X-TURN-CLIENT-IP`. Fastify trusts no proxy by default. If the deployment is behind a known reverse-proxy chain, set `TRUST_PROXY_HOPS` to the exact trusted hop count; do not enable broad proxy trust or trust client-supplied forwarded headers.

Turnix setup: create a project and API token in the Turnix dashboard, then store the token in the deployment's server-side environment. Never commit it or put it in browser configuration. Check relay candidates in browser WebRTC diagnostics during staging tests. Provider credentials and relay traffic are subject to Turnix plan limits.

## Important limits
The C++ worker accelerates ranking calculations only; it does not accelerate MySQL I/O, video transcoding or delivery. The Railway Docker image starts the API without changing the database schema. Do not run `prisma db push` against shared staging or production databases. Apply reviewed Prisma migrations only after verifying the live schema and establishing a correct migration baseline; never use `--accept-data-loss` or reset commands to bypass destructive-change warnings. SMTP, S3 media, WebRTC/SFU streaming and payment/wallet integrations need provider configuration.
