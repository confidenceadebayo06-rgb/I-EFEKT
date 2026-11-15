# Deploy I-EFEKT to Railway

1. Create a Railway project and add a MySQL service.
2. Add this GitHub repository as the API service. The Dockerfile and railway.json are at the repository root.
3. Set API variables:
   - NODE_ENV=production
   - DATABASE_URL=${{MySQL.MYSQL_URL}} (replace MySQL with the exact database service name)
   - JWT_SECRET: unique random value of at least 32 characters
   - COOKIE_SECURE=true
   - APP_ORIGIN: public HTTPS API domain
   - SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, EMAIL_FROM
   - S3_ENDPOINT, S3_REGION, S3_BUCKET, S3_ACCESS_KEY, S3_SECRET_KEY, S3_PUBLIC_URL
4. Deploy and check https://YOUR-DOMAIN/api/health. A healthy response should report database connected.

Keep MySQL private and use the Railway internal service reference. Do not commit .env or secrets. Media requires a separate production S3-compatible provider. Calls/live streaming require an external WebRTC/SFU provider; paid gifts require a secure wallet/payment integration.

The current Docker startup uses prisma db push as an initial prototype bootstrap. Before storing production data, use reviewed versioned migrations and backups. Full build, database integration and Railway deployment have not yet been verified.