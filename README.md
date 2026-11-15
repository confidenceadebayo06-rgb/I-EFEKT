# I-EFEKT — MySQL + TypeScript + C++ build

I-EFEKT is a social/video web PWA with a TypeScript API, MySQL 8.4 persistence, Socket.IO realtime events, and a C++20 worker for bounded feed-ranking calculations.

## Stack
- Web: HTML/CSS/JavaScript PWA
- API: Node.js 22, TypeScript, Fastify
- Database: MySQL 8.4, Prisma
- Realtime: Socket.IO
- Native ranking: C++20, compiled with -O3
- Local development: Docker Compose, MinIO, Mailpit

## Local setup
Requirements: Node.js 22+, Docker Compose, and a C++20 compiler.
1. Copy .env.example to .env and set a unique JWT_SECRET.
2. Start local dependencies: docker compose up -d.
3. Install dependencies: npm install.
4. Build native worker: npm run engine:build.
5. Generate Prisma client: npm run db:generate.
6. Apply local schema: npx prisma db push.
7. Compile: npm run build.
8. Start: npm run dev.
9. Open http://localhost:3000. Mailpit UI: http://localhost:8025.

## Railway
Railway uses the root Dockerfile and railway.json. Create a Railway MySQL service and set API variable DATABASE_URL to ${{MySQL.MYSQL_URL}} (replace MySQL with the exact Railway database service name). Also set NODE_ENV=production, JWT_SECRET, COOKIE_SECURE=true, APP_ORIGIN, SMTP settings, and production S3-compatible storage variables. Do not commit secrets.

## Important limits
The C++ worker accelerates ranking calculations only; it does not accelerate MySQL I/O, video transcoding or delivery. The Docker image currently uses Prisma db push for first-run bootstrap; switch to reviewed migrations before production data is valuable. SMTP, S3 media, WebRTC/SFU streaming and payment/wallet integrations need provider configuration. This source bundle has not yet passed a complete dependency install, TypeScript build, MySQL integration test or production deployment.