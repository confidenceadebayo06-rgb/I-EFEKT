# I-EFEKT API image: Node 22 + TypeScript + C++20 ranking worker
FROM node:22-alpine AS build
WORKDIR /app
RUN apk add --no-cache build-base python3 openssl
COPY package*.json ./
RUN npm install --no-audit --no-fund
COPY prisma ./prisma
COPY src ./src
COPY scripts ./scripts
COPY tsconfig.json ./
RUN npm run engine:build && npx prisma generate && npx tsc -p tsconfig.json

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN apk add --no-cache libstdc++ openssl mariadb-client redis && addgroup -S app && adduser -S app -G app
COPY --from=build --chown=app:app /app/node_modules ./node_modules
COPY --from=build --chown=app:app /app/dist ./dist
COPY --from=build --chown=app:app /app/build ./build
COPY --from=build --chown=app:app /app/prisma ./prisma
COPY --from=build --chown=app:app /app/package.json ./package.json
COPY --from=build --chown=app:app /app/scripts ./scripts
COPY --chown=app:app public ./public
USER app
EXPOSE 3000
# Single-replica staging fallback only: local ephemeral Redis keeps the staging auth limiter operational
# when the Railway Free plan cannot provision a separate Redis service. Production still requires managed Redis.
CMD ["sh","-c","redis-server --bind 127.0.0.1 --save '' --appendonly no --daemonize yes && exec node dist/server.js"]