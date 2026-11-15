import 'dotenv/config';
import Fastify, { FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { Server as SocketServer } from 'socket.io';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { Redis } from 'ioredis';
import jwt from 'jsonwebtoken';
import nodemailer from 'nodemailer';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { CppRankingEngine } from './engine/CppRankingEngine.js';

const prisma = new PrismaClient();
const rankingEngine = new CppRankingEngine();
const s3 = new S3Client({ region: process.env.S3_REGION || 'us-east-1', endpoint: process.env.S3_ENDPOINT || undefined, forcePathStyle: !!process.env.S3_ENDPOINT, credentials: process.env.S3_ACCESS_KEY && process.env.S3_SECRET_KEY ? { accessKeyId: process.env.S3_ACCESS_KEY, secretAccessKey: process.env.S3_SECRET_KEY } : undefined });
const mediaBucket = process.env.S3_BUCKET || 'iefekt-media';
const app = Fastify({ logger: true, bodyLimit: 12 * 1024 * 1024 });
const port = Number(process.env.PORT || 3000);
const secret = process.env.JWT_SECRET || (process.env.NODE_ENV === 'production' ? '' : 'development-only-change-me-please-32chars');
if (process.env.NODE_ENV === 'production' && secret.length < 32) throw new Error('JWT_SECRET must be configured with at least 32 characters in production.');
if (process.env.NODE_ENV === 'production' && !process.env.REDIS_URL) throw new Error('REDIS_URL must be configured in production.');
const limiterRedis = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', { lazyConnect: true, maxRetriesPerRequest: 1, enableOfflineQueue: false });
await limiterRedis.connect();
const origin = process.env.APP_ORIGIN || 'http://localhost:3000';
const cookieName = 'iefekt_session';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, '../public');
const mailer = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'localhost', port: Number(process.env.SMTP_PORT || 1025),
  secure: false,
  ...(process.env.SMTP_USER ? { auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS || '' } } : {})
});

type SessionUser = { id: string; email: string; handle: string; sessionId: string };
declare module 'fastify' { interface FastifyRequest { user: SessionUser | null } }
const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
const sessionTtlDays = Math.min(90, Math.max(1, Number(process.env.SESSION_TTL_DAYS || 30)));
const sessionCookieOptions = { path: '/', httpOnly: true, sameSite: 'lax' as const, secure: process.env.COOKIE_SECURE === 'true', maxAge: 60 * 60 * 24 * sessionTtlDays };
const createSession = async (user: { id: string; email: string; handle: string }, req: FastifyRequest, reply: any) => {
  const raw = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + sessionTtlDays * 86400000);
  const row = await prisma.deviceSession.create({ data: { userId: user.id, tokenHash: hashToken(raw), expiresAt, deviceName: String(req.headers['x-device-name'] || '').slice(0, 120) || null, userAgent: String(req.headers['user-agent'] || '').slice(0, 512) || null, ipHash: process.env.SESSION_IP_HASH_KEY ? createHmac('sha256', process.env.SESSION_IP_HASH_KEY).update(req.ip).digest('hex') : null } });
  reply.setCookie(cookieName, raw, sessionCookieOptions);
  return row;
};
const audit = async (userId: string | null, action: string, req: FastifyRequest, targetId?: string) => {
  try { await prisma.auditLog.create({ data: { userId, action, targetId: targetId || null, ipHash: process.env.SESSION_IP_HASH_KEY ? createHmac('sha256', process.env.SESSION_IP_HASH_KEY).update(req.ip).digest('hex') : null } }); }
  catch (error) { req.log.error({ error }, 'Audit event write failed'); }
};

await app.register(cookie);
await app.register(cors, { origin, credentials: true });

// Security headers are set centrally so API and static responses receive the same baseline protections.
app.addHook('onSend', async (_req, reply, payload) => {
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('X-Frame-Options', 'DENY');
  reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  reply.header('Cross-Origin-Opener-Policy', 'same-origin');
  return payload;
});

// Shared Redis fixed-window limits apply consistently across every app replica.
const authRateRules: Array<{ matches: (path: string) => boolean; limit: number; windowMs: number }> = [
  { matches: p => p === '/api/auth/login', limit: 10, windowMs: 15 * 60 * 1000 },
  { matches: p => p === '/api/auth/register', limit: 5, windowMs: 60 * 60 * 1000 },
  { matches: p => p === '/api/auth/forgot-password', limit: 5, windowMs: 60 * 60 * 1000 },
  { matches: p => p === '/api/auth/reset-password', limit: 10, windowMs: 60 * 60 * 1000 },
  { matches: p => p === '/api/auth/verify', limit: 20, windowMs: 60 * 60 * 1000 }
];
const consumeRateLimit = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
local ttl = redis.call('PTTL', KEYS[1])
return { count, ttl }
`;
app.addHook('onRequest', async (req, reply) => {
  const requestPath = req.url.split('?')[0] || req.url;
  const rule = authRateRules.find(candidate => candidate.matches(requestPath));
  if (!rule) return;
  const keyHash = createHash('sha256').update(`${req.ip}:${requestPath}`).digest('hex');
  try {
    const result = await limiterRedis.eval(consumeRateLimit, 1, `iefekt:auth-limit:${keyHash}`, String(rule.windowMs)) as [number, number];
    const count = Number(result[0]);
    const ttlMs = Math.max(0, Number(result[1]));
    const resetAt = Math.ceil((Date.now() + ttlMs) / 1000);
    reply.header('RateLimit-Limit', rule.limit);
    reply.header('RateLimit-Remaining', Math.max(0, rule.limit - count));
    reply.header('RateLimit-Reset', resetAt);
    if (count > rule.limit) {
      reply.header('Retry-After', Math.max(1, Math.ceil(ttlMs / 1000)));
      return reply.code(429).send({ error: 'Too many attempts. Please try again later.' });
    }
  } catch (error) {
    req.log.error({ error }, 'Redis rate limiter unavailable');
    return reply.code(503).send({ error: 'Authentication protection is temporarily unavailable. Please try again shortly.' });
  }
});
await app.register(fastifyStatic, { root: publicDir, prefix: '/' });
app.decorateRequest('user', null);
app.addHook('preHandler', async (req, reply) => {
  const raw = req.cookies[cookieName];
  if (!raw) { req.user = null; return; }
  const session = await prisma.deviceSession.findUnique({ where: { tokenHash: hashToken(raw) }, include: { user: { select: { id: true, email: true, handle: true, emailVerifiedAt: true } } } });
  if (session) {
    if (session.revokedAt || session.expiresAt <= new Date() || !session.user.emailVerifiedAt) { req.user = null; reply.clearCookie(cookieName, { path: '/' }); return; }
    req.user = { id: session.user.id, email: session.user.email, handle: session.user.handle, sessionId: session.id };
    if (Date.now() - session.lastSeenAt.getTime() > 5 * 60 * 1000) void prisma.deviceSession.update({ where: { id: session.id }, data: { lastSeenAt: new Date() } }).catch(error => req.log.warn({ error }, 'Session activity update failed'));
    return;
  }
  // Exchange a still-valid legacy JWT once, then replace it with an opaque revocable session.
  try {
    const legacy = jwt.verify(raw, secret) as { id?: string };
    if (!legacy.id) throw new Error('Invalid legacy session');
    const user = await prisma.user.findUnique({ where: { id: legacy.id }, select: { id: true, email: true, handle: true, emailVerifiedAt: true } });
    if (!user?.emailVerifiedAt) throw new Error('Legacy account is not verified');
    const created = await createSession(user, req, reply);
    req.user = { id: user.id, email: user.email, handle: user.handle, sessionId: created.id };
    await audit(user.id, 'session.legacy_exchanged', req, created.id);
  } catch { req.user = null; reply.clearCookie(cookieName, { path: '/' }); }
});
const auth = async (req: FastifyRequest, reply: any) => { if (!req.user) return reply.code(401).send({ error: 'Please sign in to continue.' }); };
app.addHook('onRequest', async (req, reply) => {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return;
  const requestOrigin = req.headers.origin;
  if (req.cookies?.[cookieName] && requestOrigin && requestOrigin !== origin) return reply.code(403).send({ error: 'Request origin is not allowed.' });
});
const emitSync = async (userId: string, entityType: string, entityId: string) => {
  const row = await prisma.syncChange.create({ data: { userId, entityType, entityId } });
  io.to(`user:${userId}`).emit('sync:changed', { cursor: row.id.toString(), entity_type: entityType, entity_id: entityId });
};
const sendMail = async (to: string, subject: string, html: string) => {
  await mailer.sendMail({ from: process.env.EMAIL_FROM || 'I-EFEKT <no-reply@iefekt.local>', to, subject, html });
};

app.get('/api/health', async (_req, reply) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return { ok: true, service: 'iefekt-api', database: 'connected', rankingEngine: rankingEngine.status(), timestamp: new Date().toISOString() };
  } catch (error) {
    app.log.error({ error }, 'Database health check failed');
    return reply.code(503).send({ ok: false, service: 'iefekt-api', database: 'unavailable' });
  }
});
app.get('/api/engine/status', { preHandler: auth }, async () => ({ ranking: rankingEngine.status(), database: 'MySQL 8.4 via Prisma' }));

app.post('/api/auth/register', async (req, reply) => {
  const schema = z.object({ email: z.string().email().max(254), password: z.string().min(12).max(128), handle: z.string().regex(/^[a-zA-Z0-9_]{3,24}$/), displayName: z.string().min(1).max(60) });
  const parsed = schema.safeParse(req.body); if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message || 'Invalid registration details.' });
  const { email, password, handle, displayName } = parsed.data;
  if (await prisma.user.findFirst({ where: { OR: [{ email: email.toLowerCase() }, { handle: handle.toLowerCase() }] } })) return reply.code(409).send({ error: 'Email or handle is already in use.' });
  const user = await prisma.user.create({ data: { email: email.toLowerCase(), passwordHash: await bcrypt.hash(password, 12), handle: handle.toLowerCase(), displayName, } as any });
  const token = randomBytes(32).toString('hex');
  await prisma.verificationToken.create({ data: { userId: user.id, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) } });
  const verifyUrl = `${origin}/api/auth/verify?token=${token}`;
  try { await sendMail(user.email, 'Verify your I-EFEKT email', `<p>Welcome to I-EFEKT.</p><p><a href="${verifyUrl}">Verify your email address</a></p><p>This link expires in 24 hours.</p>`); }
  catch (error) { req.log.error(error, 'Email delivery failed'); }
  return reply.code(201).send({ message: 'Account created. Check your email for the verification link. In local development, open Mailpit at http://localhost:8025.' });
});
app.get('/api/auth/verify', async (req, reply) => {
  const token = String((req.query as any).token || ''); if (!token) return reply.code(400).send({ error: 'Missing verification token.' });
  const record = await prisma.verificationToken.findUnique({ where: { tokenHash: hashToken(token) } });
  if (!record || record.expiresAt < new Date()) return reply.code(400).send({ error: 'Verification link is invalid or expired.' });
  const user = await prisma.$transaction(async tx => {
    const consumed = await tx.verificationToken.deleteMany({ where: { id: record.id, expiresAt: { gt: new Date() } } });
    if (!consumed.count) return null;
    return tx.user.update({ where: { id: record.userId }, data: { emailVerifiedAt: new Date() } });
  });
  if (!user) return reply.code(400).send({ error: 'Verification link is invalid or expired.' });
  const session = await createSession(user, req, reply);
  await audit(user.id, 'auth.email_verified', req, session.id);
  return reply.redirect('/?verified=1');
});
app.post('/api/auth/login', async (req, reply) => {
  const schema = z.object({ email: z.string().email(), password: z.string().min(1) }); const p = schema.safeParse(req.body);
  if (!p.success) return reply.code(400).send({ error: 'Enter a valid email and password.' });
  const user = await prisma.user.findUnique({ where: { email: p.data.email.toLowerCase() } });
  if (!user || !(await bcrypt.compare(p.data.password, user.passwordHash))) return reply.code(401).send({ error: 'Incorrect email or password.' });
  if (!user.emailVerifiedAt) return reply.code(403).send({ error: 'Please verify your email address before signing in.' });
  const session = await createSession(user, req, reply);
  await audit(user.id, 'auth.login', req, session.id);
  return { user: { id: user.id, email: user.email, handle: user.handle, display_name: user.displayName, bio: user.bio, avatar_url: user.avatarUrl } };
});
app.post('/api/auth/logout', async (req, reply) => {
  const raw = req.cookies[cookieName];
  if (raw) {
    const session = await prisma.deviceSession.findUnique({ where: { tokenHash: hashToken(raw) } });
    if (session && !session.revokedAt) {
      await prisma.deviceSession.update({ where: { id: session.id }, data: { revokedAt: new Date() } });
      await audit(session.userId, 'auth.logout', req, session.id);
      for (const socket of io.sockets.sockets.values()) if (socket.data.sessionId === session.id) socket.disconnect(true);
    }
  }
  reply.clearCookie(cookieName, { path: '/' }); return { ok: true };
});
app.post('/api/auth/forgot-password', async (req, reply) => {
  const email = String((req.body as any)?.email || '').toLowerCase();
  const user = await prisma.user.findUnique({ where: { email } });
  if (user) { await prisma.passwordResetToken.deleteMany({ where: { userId: user.id } }); const token = randomBytes(32).toString('hex'); await prisma.passwordResetToken.create({ data: { userId: user.id, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + 60 * 60 * 1000) } }); const url = `${origin}/api/auth/reset-password?token=${token}`; try { await sendMail(email, 'Reset your I-EFEKT password', `<p><a href="${url}">Reset password</a></p><p>This link expires in one hour.</p>`); } catch (e) { req.log.error(e); } }
  return { message: 'If that email is registered, a password reset link has been sent.' };
});
app.post('/api/auth/reset-password', async (req, reply) => {
  const p = z.object({ token: z.string(), password: z.string().min(12).max(128) }).safeParse(req.body); if (!p.success) return reply.code(400).send({ error: 'Provide a valid token and a password of at least 12 characters.' });
  const record = await prisma.passwordResetToken.findUnique({ where: { tokenHash: hashToken(p.data.token) } }); if (!record || record.expiresAt < new Date()) return reply.code(400).send({ error: 'Reset link is invalid or expired.' });
  const passwordHash = await bcrypt.hash(p.data.password, 12);
  const changed = await prisma.$transaction(async tx => {
    const consumed = await tx.passwordResetToken.deleteMany({ where: { id: record.id, expiresAt: { gt: new Date() } } });
    if (!consumed.count) return false;
    await tx.user.update({ where: { id: record.userId }, data: { passwordHash } });
    await tx.passwordResetToken.deleteMany({ where: { userId: record.userId } });
    await tx.deviceSession.updateMany({ where: { userId: record.userId, revokedAt: null }, data: { revokedAt: new Date() } });
    await tx.auditLog.create({ data: { userId: record.userId, action: 'auth.password_reset' } });
    return true;
  });
  if (!changed) return reply.code(400).send({ error: 'Reset link is invalid or expired.' });
  return { ok: true, message: 'Password updated. You can now sign in.' };
});

app.get('/api/me/sessions', { preHandler: auth }, async (req) => ({
  sessions: await prisma.deviceSession.findMany({ where: { userId: req.user!.id, revokedAt: null, expiresAt: { gt: new Date() } }, orderBy: { lastSeenAt: 'desc' }, select: { id: true, deviceName: true, userAgent: true, createdAt: true, lastSeenAt: true, expiresAt: true } }).then(sessions => sessions.map(session => ({ ...session, isCurrent: session.id === req.user!.sessionId })))
}));
app.delete('/api/me/sessions/:sessionId', { preHandler: auth }, async (req, reply) => {
  const sessionId = String((req.params as any).sessionId);
  const result = await prisma.deviceSession.updateMany({ where: { id: sessionId, userId: req.user!.id, revokedAt: null }, data: { revokedAt: new Date() } });
  if (!result.count) return reply.code(404).send({ error: 'Session not found.' });
  if (sessionId === req.user!.sessionId) reply.clearCookie(cookieName, { path: '/' });
  await audit(req.user!.id, 'session.revoked', req, sessionId);
  for (const socket of io.sockets.sockets.values()) if (socket.data.sessionId === sessionId) socket.disconnect(true);
  return reply.code(204).send();
});
app.post('/api/me/sessions/logout-others', { preHandler: auth }, async (req) => {
  const result = await prisma.deviceSession.updateMany({ where: { userId: req.user!.id, id: { not: req.user!.sessionId }, revokedAt: null }, data: { revokedAt: new Date() } });
  await audit(req.user!.id, 'session.others_revoked', req);
  for (const socket of io.sockets.sockets.values()) if (socket.data.userId === req.user!.id && socket.data.sessionId !== req.user!.sessionId) socket.disconnect(true);
  return { revoked: result.count };
});
app.get('/api/me', { preHandler: auth }, async (req) => ({ user: await prisma.user.findUnique({ where: { id: req.user!.id }, select: { id: true, email: true, handle: true, displayName: true, bio: true, avatarUrl: true, emailVerifiedAt: true, createdAt: true } }) }));
app.patch('/api/me/profile', { preHandler: auth }, async (req, reply) => {
  const p = z.object({ handle: z.string().regex(/^[a-zA-Z0-9_]{3,24}$/).optional(), displayName: z.string().max(60).optional(), bio: z.string().max(300).optional(), avatarAssetId: z.string().optional() }).safeParse(req.body); if (!p.success) return reply.code(400).send({ error: 'Invalid profile update.' });
  if (p.data.handle && await prisma.user.findFirst({ where: { handle: p.data.handle.toLowerCase(), id: { not: req.user!.id } } })) return reply.code(409).send({ error: 'That handle is unavailable.' });
  const data: any = { ...p.data }; if (data.handle) data.handle = data.handle.toLowerCase(); if (data.avatarAssetId) { const asset = await prisma.mediaAsset.findFirst({ where: { id: data.avatarAssetId, userId: req.user!.id, status: 'uploaded' } }); if (!asset) return reply.code(400).send({ error: 'Media asset is not ready.' }); data.avatarUrl = `${process.env.S3_PUBLIC_URL || ''}/${asset.objectKey}`; delete data.avatarAssetId; }
  const user = await prisma.user.update({ where: { id: req.user!.id }, data }); return { user: { handle: user.handle, display_name: user.displayName, bio: user.bio, avatar_url: user.avatarUrl } };
});
app.delete('/api/me', { preHandler: auth }, async (req, reply) => { if ((req.body as any)?.confirm !== 'DELETE MY ACCOUNT') return reply.code(400).send({ error: 'Account deletion confirmation is required.' }); await prisma.user.delete({ where: { id: req.user!.id } }); reply.clearCookie(cookieName, { path: '/' }); return { ok: true }; });
app.get('/api/me/export', { preHandler: auth }, async (req) => { const user = await prisma.user.findUnique({ where: { id: req.user!.id }, include: { posts: true, memberships: { include: { conversation: { include: { messages: true } } } }, preferences: true, stories: true } }); return { exportedAt: new Date().toISOString(), account: user }; });
app.get('/api/preferences', { preHandler: auth }, async (req) => { const p = await prisma.preference.findUnique({ where: { userId: req.user!.id } }); return { enabled: p?.enabled ?? false, preferences: p?.preferences ?? {} }; });
app.put('/api/preferences', { preHandler: auth }, async (req) => { const body = req.body as any; const p = await prisma.preference.upsert({ where: { userId: req.user!.id }, create: { userId: req.user!.id, enabled: !!body.enabled, preferences: body.preferences || {} }, update: { enabled: !!body.enabled, preferences: body.preferences || {} } }); return { enabled: p.enabled, preferences: p.preferences }; });
app.get('/api/users/search', { preHandler: auth }, async (req) => { const q = String((req.query as any).q || '').trim(); if (q.length < 2) return { users: [] }; const users = await prisma.user.findMany({ where: { id: { not: req.user!.id }, OR: [{ handle: { contains: q } }, { displayName: { contains: q } }] }, take: 20, select: { id: true, handle: true, displayName: true, avatarUrl: true } }); return { users: users.map(u => ({ ...u, display_name: u.displayName })) }; });

app.get('/api/feed', { preHandler: auth }, async (req) => {
  const candidates = await prisma.post.findMany({ take: 250, orderBy: { createdAt: 'desc' }, include: { user: true, likes: { where: { userId: req.user!.id } }, _count: { select: { likes: true, comments: true } } } });
  let ordered = candidates;
  if (rankingEngine.status().available && candidates.length) {
    try {
      const preference = await prisma.preference.findUnique({ where: { userId: req.user!.id }, select: { enabled: true } });
      const follows = preference?.enabled ? await prisma.follow.findMany({ where: { followerId: req.user!.id }, select: { followingId: true } }) : [];
      const followed = new Set(follows.map(f => f.followingId));
      const now = Date.now();
      const features = candidates.map(post => ({
        affinity: followed.has(post.userId) ? 1 : 0,
        freshness: Math.exp(-Math.max(0, now - post.createdAt.getTime()) / 129600000),
        engagement: Math.min(1, Math.log1p(post._count.likes * 2 + post._count.comments) / Math.log1p(500)),
        completion: 0.5,
        negative: 0
      }));
      const indexes = await rankingEngine.rank(features);
      ordered = indexes.flatMap(index => candidates[index] ? [candidates[index]!] : []);
    } catch (error) { req.log.warn({ error }, 'C++ ranking failed; using chronological feed'); }
  }
  const preference = await prisma.preference.findUnique({ where: { userId: req.user!.id }, select: { enabled: true } });
  return { posts: ordered.slice(0, 50).map(p => ({ postId: p.id, author: p.user.handle, authorId: p.user.id, displayName: p.user.displayName, avatar: p.user.avatarUrl, mediaUrl: p.mediaUrl, mediaType: p.mediaType, caption: p.caption, likes: p._count.likes, commentsCount: p._count.comments, liked: p.likes.length > 0 })), ranking: { engine: rankingEngine.status().available ? 'C++20' : 'chronological-fallback', personalization: preference?.enabled ? 'enabled-by-user' : 'disabled' } };
});
app.get('/api/feed/ranked', { preHandler: auth }, async (req, reply) => {
  const [candidates, preference] = await Promise.all([
    prisma.post.findMany({ take: 250, orderBy: { createdAt: 'desc' }, include: { user: true, likes: { where: { userId: req.user!.id } }, _count: { select: { likes: true, comments: true } } } }),
    prisma.preference.findUnique({ where: { userId: req.user!.id }, select: { enabled: true } })
  ]);
  const follows = preference?.enabled ? await prisma.follow.findMany({ where: { followerId: req.user!.id }, select: { followingId: true } }) : [];
  if (!rankingEngine.status().available) return reply.code(503).send({ error: 'C++ ranking engine is unavailable. Build it with npm run engine:build.', engine: rankingEngine.status() });
  const followed = new Set(follows.map(f => f.followingId));
  const now = Date.now();
  const features = candidates.map(post => {
    const ageHours = Math.max(0, (now - post.createdAt.getTime()) / 3600000);
    const freshness = Math.exp(-ageHours / 36);
    const engagement = Math.min(1, Math.log1p(post._count.likes * 2 + post._count.comments) / Math.log1p(500));
    return { affinity: followed.has(post.userId) ? 1 : 0, freshness, engagement, completion: 0.5, negative: 0 };
  });
  try {
    const order = await rankingEngine.rank(features);
    const posts = order.flatMap(index => { const p = candidates[index]; return p ? [{ postId: p.id, author: p.user.handle, authorId: p.user.id, displayName: p.user.displayName, avatar: p.user.avatarUrl, mediaUrl: p.mediaUrl, mediaType: p.mediaType, caption: p.caption, likes: p._count.likes, commentsCount: p._count.comments, liked: p.likes.length > 0 }] : []; });
    return { posts, ranking: { engine: 'C++20', candidates: candidates.length, personalized: !!preference?.enabled, note: 'Uses follow affinity only when the user has opted in; otherwise ranks by freshness and public engagement.' } };
  } catch (error) { req.log.error(error); return reply.code(503).send({ error: 'C++ ranking request failed.' }); }
});
app.post('/api/posts', { preHandler: auth }, async (req, reply) => { const p = z.object({ mediaUrl: z.string().url(), mediaType: z.string().default('video'), caption: z.string().max(2200).optional(), genre: z.string().optional(), track: z.string().optional(), originalAudio: z.boolean().optional(), filter: z.string().optional(), speed: z.number().min(.25).max(4).optional() }).safeParse(req.body); if (!p.success) return reply.code(400).send({ error: 'Invalid post data. A media URL is required.' }); const post = await prisma.post.create({ data: { ...p.data, userId: req.user!.id } }); await emitSync(req.user!.id, 'post', post.id); io.emit('feed:post-created', { postId: post.id }); return reply.code(201).send({ postId: post.id }); });
app.post('/api/posts/:id/like', { preHandler: auth }, async (req, reply) => { const postId = (req.params as any).id; const exists = await prisma.like.findUnique({ where: { userId_postId: { userId: req.user!.id, postId } } }); if (exists) await prisma.like.delete({ where: { id: exists.id } }); else await prisma.like.create({ data: { userId: req.user!.id, postId } }); await emitSync(req.user!.id, 'like', postId); return { liked: !exists }; });
app.post('/api/posts/:id/comments', { preHandler: auth }, async (req, reply) => { const body = String((req.body as any)?.body || '').trim(); if (!body || body.length > 1000) return reply.code(400).send({ error: 'Comment must be 1–1000 characters.' }); const comment = await prisma.comment.create({ data: { userId: req.user!.id, postId: (req.params as any).id, body } }); return reply.code(201).send({ comment }); });
app.post('/api/users/:id/follow', { preHandler: auth }, async (req, reply) => { const followingId = (req.params as any).id; if (followingId === req.user!.id) return reply.code(400).send({ error: 'You cannot follow yourself.' }); const where = { followerId_followingId: { followerId: req.user!.id, followingId } }; const existing = await prisma.follow.findUnique({ where }); if (existing) await prisma.follow.delete({ where: { id: existing.id } }); else await prisma.follow.create({ data: { followerId: req.user!.id, followingId } }); await emitSync(req.user!.id, 'follow', followingId); return { following: !existing }; });
app.post('/api/reports', { preHandler: auth }, async (req, reply) => { const p = z.object({ postId: z.string().optional(), reason: z.string().min(2).max(60), details: z.string().max(1000).optional() }).safeParse(req.body); if (!p.success) return reply.code(400).send({ error: 'Invalid report.' }); const report = await prisma.report.create({ data: { reporterId: req.user!.id, ...p.data } }); return reply.code(201).send({ reportId: report.id, status: report.status }); });
app.get('/api/sync/changes', { preHandler: auth }, async (req) => { const after = BigInt(String((req.query as any).after || '0')); const rows = await prisma.syncChange.findMany({ where: { userId: req.user!.id, id: { gt: after } }, orderBy: { id: 'asc' }, take: 100 }); return { changes: rows.map(r => ({ cursor: r.id.toString(), entity_type: r.entityType, entity_id: r.entityId })), nextCursor: rows.at(-1)?.id.toString() || after.toString() }; });

app.post('/api/conversations', { preHandler: auth }, async (req, reply) => { const ids = Array.isArray((req.body as any)?.memberIds) ? [...new Set([req.user!.id, ...(req.body as any).memberIds.map(String)])] : [req.user!.id]; if (ids.length < 2 || ids.length > 20) return reply.code(400).send({ error: 'Choose between one and nineteen other members.' }); const conversation = await prisma.conversation.create({ data: { members: { create: ids.map(userId => ({ userId })) } } }); return reply.code(201).send({ conversationId: conversation.id }); });
app.get('/api/conversations', { preHandler: auth }, async (req) => { const rows = await prisma.conversation.findMany({ where: { members: { some: { userId: req.user!.id } } }, include: { members: { include: { user: { select: { id: true, handle: true, displayName: true } } } }, messages: { orderBy: { createdAt: 'desc' }, take: 1 } }, orderBy: { createdAt: 'desc' } }); return { conversations: rows.map(c => ({ id: c.id, peers: c.members.filter(m => m.userId !== req.user!.id).map(m => ({ id: m.user.id, handle: m.user.handle, display_name: m.user.displayName })), last_message: c.messages[0]?.body || '' })) }; });
app.get('/api/conversations/:id/messages', { preHandler: auth }, async (req, reply) => { const id = (req.params as any).id; const member = await prisma.conversationMember.findUnique({ where: { conversationId_userId: { conversationId: id, userId: req.user!.id } } }); if (!member) return reply.code(403).send({ error: 'You are not a member of this conversation.' }); const messages = await prisma.message.findMany({ where: { conversationId: id }, orderBy: { createdAt: 'asc' }, take: 200 }); return { messages: messages.map(m => ({ id: m.id, sender_id: m.senderId, body: m.body, created_at: m.createdAt })) }; });
app.post('/api/conversations/:id/messages', { preHandler: auth }, async (req, reply) => { const id = (req.params as any).id; const member = await prisma.conversationMember.findUnique({ where: { conversationId_userId: { conversationId: id, userId: req.user!.id } } }); if (!member) return reply.code(403).send({ error: 'You are not a member of this conversation.' }); const body = String((req.body as any)?.body || (req.body as any)?.text || '').trim(); if (!body || body.length > 4000) return reply.code(400).send({ error: 'Message must be 1–4000 characters.' }); const clientId = String((req.body as any)?.clientId || '') || null; const message = await prisma.message.create({ data: { conversationId: id, senderId: req.user!.id, body, clientId } }); const recipients = await prisma.conversationMember.findMany({ where: { conversationId: id }, select: { userId: true } }); for (const r of recipients) { io.to(`user:${r.userId}`).emit('message:new', { conversation_id: id, sender_id: req.user!.id, body, id: message.id }); await emitSync(r.userId, 'message', message.id); } return reply.code(201).send({ messageId: message.id }); });

app.post('/api/stories', { preHandler: auth }, async (req, reply) => {
  const p = z.object({ text: z.string().max(500).optional(), assetId: z.string().optional() }).safeParse(req.body);
  if (!p.success || (!p.data.text?.trim() && !p.data.assetId)) return reply.code(400).send({ error: 'A status needs text or uploaded media.' });
  let mediaUrl: string | undefined;
  if (p.data.assetId) {
    const asset = await prisma.mediaAsset.findFirst({ where: { id: p.data.assetId, userId: req.user!.id, status: 'uploaded' } });
    if (!asset) return reply.code(400).send({ error: 'Uploaded media was not found or is not ready.' });
    mediaUrl = `${(process.env.S3_PUBLIC_URL || '').replace(/\/$/, '')}/${asset.objectKey}`;
  }
  const story = await prisma.story.create({ data: { userId: req.user!.id, text: p.data.text?.trim() || '', mediaUrl, expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) }, include: { user: { select: { handle: true, displayName: true, avatarUrl: true } } } });
  io.emit('story:new', story);
  await emitSync(req.user!.id, 'story', story.id);
  return reply.code(201).send({ story });
});
app.get('/api/stories/feed', { preHandler: auth }, async (req) => {
  const stories = await prisma.story.findMany({ where: { expiresAt: { gt: new Date() } }, include: { user: { select: { id: true, handle: true, displayName: true, avatarUrl: true } } }, orderBy: { createdAt: 'asc' }, take: 500 });
  const grouped = new Map<string, any>();
  for (const story of stories) { const key = story.userId; if (!grouped.has(key)) grouped.set(key, { user: story.user, stories: [] }); grouped.get(key).stories.push({ id: story.id, text: story.text, mediaUrl: story.mediaUrl, createdAt: story.createdAt, expiresAt: story.expiresAt }); }
  return { users: [...grouped.values()], stories, viewerId: req.user!.id };
});
app.delete('/api/stories/:id', { preHandler: auth }, async (req, reply) => { const id = (req.params as any).id; const result = await prisma.story.deleteMany({ where: { id, userId: req.user!.id } }); return result.count ? { ok: true } : reply.code(404).send({ error: 'Status not found or not yours.' }); });
app.post('/api/groups', { preHandler: auth }, async (req, reply) => { const name = String((req.body as any)?.name || '').trim(); const memberIds = Array.isArray((req.body as any)?.memberIds) ? (req.body as any).memberIds.map(String) : []; if (!name || name.length > 80) return reply.code(400).send({ error: 'Group name is required.' }); const ids = [...new Set([req.user!.id, ...memberIds])]; const group = await prisma.socialGroup.create({ data: { name, ownerId: req.user!.id, members: { create: ids.map(userId => ({ userId })) } } }); return reply.code(201).send({ group }); });
app.get('/api/groups', { preHandler: auth }, async (req) => ({ groups: await prisma.socialGroup.findMany({ where: { members: { some: { userId: req.user!.id } } }, include: { _count: { select: { members: true } } } }) }));
app.get('/api/groups/:id/messages', { preHandler: auth }, async (req, reply) => { const id = (req.params as any).id; const member = await prisma.groupMember.findUnique({ where: { groupId_userId: { groupId: id, userId: req.user!.id } } }); if (!member) return reply.code(403).send({ error: 'Not a group member.' }); return { messages: await prisma.groupMessage.findMany({ where: { groupId: id }, orderBy: { createdAt: 'asc' }, take: 200 }) }; });
app.post('/api/groups/:id/messages', { preHandler: auth }, async (req, reply) => { const id = (req.params as any).id; const member = await prisma.groupMember.findUnique({ where: { groupId_userId: { groupId: id, userId: req.user!.id } } }); if (!member) return reply.code(403).send({ error: 'Not a group member.' }); const body = String((req.body as any)?.body || '').trim(); if (!body || body.length > 4000) return reply.code(400).send({ error: 'Invalid message.' }); const m = await prisma.groupMessage.create({ data: { groupId: id, userId: req.user!.id, body } }); io.to(`group:${id}`).emit('group:message', m); return reply.code(201).send({ message: m }); });
app.post('/api/groups/:id/calls', { preHandler: auth }, async (req, reply) => { const id = (req.params as any).id; const member = await prisma.groupMember.findUnique({ where: { groupId_userId: { groupId: id, userId: req.user!.id } } }); if (!member) return reply.code(403).send({ error: 'Not a group member.' }); return reply.code(501).send({ error: 'Call signalling is scaffolded. Configure a WebRTC SFU or managed media provider to create a live call room.' }); });

app.get('/api/communities', { preHandler: auth }, async () => ({ communities: await prisma.community.findMany({ include: { _count: { select: { members: true } } }, orderBy: { name: 'asc' } }) }));
app.post('/api/communities/:id/join', { preHandler: auth }, async (req, reply) => { const communityId = (req.params as any).id; try { await prisma.communityMember.create({ data: { communityId, userId: req.user!.id } }); } catch { return reply.code(409).send({ error: 'Already a member or community not found.' }); } return { joined: true }; });
app.post('/api/communities/:id/leave', { preHandler: auth }, async (req) => { await prisma.communityMember.deleteMany({ where: { communityId: (req.params as any).id, userId: req.user!.id } }); return { joined: false }; });
app.get('/api/challenges', { preHandler: auth }, async () => ({ challenges: await prisma.challenge.findMany({ include: { _count: { select: { entries: true } } }, orderBy: { startsAt: 'desc' } }) }));
app.post('/api/challenges/:id/join', { preHandler: auth }, async (req, reply) => { try { await prisma.challengeEntry.create({ data: { challengeId: (req.params as any).id, userId: req.user!.id } }); } catch { return reply.code(409).send({ error: 'Already joined or challenge unavailable.' }); } return { joined: true }; });
app.post('/api/fan-connect/questions', { preHandler: auth }, async (req, reply) => { const p = z.object({ creatorHandle: z.string().min(2).optional(), question: z.string().min(3).max(1000).optional(), text: z.string().min(3).max(1000).optional() }).refine(v => !!(v.question || v.text), 'Question is required.').safeParse(req.body); if (!p.success) return reply.code(400).send({ error: 'Invalid question.' }); const q = await prisma.fanQuestion.create({ data: { userId: req.user!.id, creatorHandle: (p.data.creatorHandle || req.user!.handle).replace(/^@/, ''), question: p.data.question || p.data.text! } }); return reply.code(201).send({ question: q }); });
app.post('/api/playlists', { preHandler: auth }, async (req, reply) => { const title = String((req.body as any)?.title || (req.body as any)?.name || '').trim(); const trackTitle = String((req.body as any)?.track || '').trim(); if (!title || title.length > 100) return reply.code(400).send({ error: 'Playlist title is required.' }); if (trackTitle.length > 200) return reply.code(400).send({ error: 'Track title must be 200 characters or fewer.' }); const playlist = await prisma.playlist.create({ data: { userId: req.user!.id, title, ...(trackTitle ? { tracks: { create: { title: trackTitle } } } : {}) }, include: { tracks: true } }); return reply.code(201).send({ playlist }); });
app.post('/api/playlists/:id/tracks', { preHandler: auth }, async (req, reply) => { const id = (req.params as any).id; const playlist = await prisma.playlist.findFirst({ where: { id, userId: req.user!.id } }); if (!playlist) return reply.code(404).send({ error: 'Playlist not found.' }); const title = String((req.body as any)?.title || '').trim(); if (!title || title.length > 200) return reply.code(400).send({ error: 'Track title is required.' }); const track = await prisma.playlistTrack.create({ data: { playlistId: id, title } }); return reply.code(201).send({ track }); });
app.post('/api/creator-tips', { preHandler: auth }, async (req, reply) => { const p = z.object({ creatorHandle: z.string(), amount: z.number().int().min(20000), currency: z.literal('EFK') }).safeParse(req.body); if (!p.success) return reply.code(400).send({ error: 'Tips must be at least 20,000 EFK.' }); const creator = await prisma.user.findUnique({ where: { handle: p.data.creatorHandle.replace(/^@/, '').toLowerCase() } }); if (!creator) return reply.code(404).send({ error: 'Creator not found.' }); const followers = await prisma.follow.count({ where: { followingId: creator.id } }); if (followers < 50000) return reply.code(403).send({ error: 'Creator tipping requires at least 50,000 followers.' }); return reply.code(501).send({ error: 'Creator meets the follower threshold. Connect and audit an EFK wallet/payment provider before tips can be charged.' }); });
app.post('/api/media/presign', { preHandler: auth }, async (req, reply) => {
  const p = z.object({ fileName: z.string().min(1).max(255), contentType: z.string().startsWith('video/').or(z.string().startsWith('image/')), size: z.number().int().positive().max(30 * 1024 * 1024) }).safeParse(req.body);
  if (!p.success) return reply.code(400).send({ error: 'Choose an image or video no larger than 30 MB.' });
  if (!process.env.S3_ACCESS_KEY || !process.env.S3_SECRET_KEY || !process.env.S3_PUBLIC_URL) return reply.code(503).send({ error: 'Cloud media storage is not configured. Set S3 credentials and public URL.' });
  const safeName = p.data.fileName.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-120);
  const objectKey = `stories/${req.user!.id}/${Date.now()}-${randomBytes(8).toString('hex')}-${safeName}`;
  const asset = await prisma.mediaAsset.create({ data: { userId: req.user!.id, objectKey, contentType: p.data.contentType, size: p.data.size, status: 'pending' } });
  try {
    const command = new PutObjectCommand({ Bucket: mediaBucket, Key: objectKey, ContentType: p.data.contentType, ContentLength: p.data.size });
    const uploadUrl = await getSignedUrl(s3, command, { expiresIn: 600 });
    return { assetId: asset.id, uploadUrl, publicUrl: `${process.env.S3_PUBLIC_URL!.replace(/\/$/, '')}/${objectKey}`, method: 'PUT', expiresIn: 600 };
  } catch (error) { await prisma.mediaAsset.delete({ where: { id: asset.id } }); req.log.error(error); return reply.code(503).send({ error: 'Could not create a secure media upload URL.' }); }
});
app.post('/api/media/:id/complete', { preHandler: auth }, async (req, reply) => {
  const id = (req.params as any).id;
  const asset = await prisma.mediaAsset.findFirst({ where: { id, userId: req.user!.id, status: 'pending' } });
  if (!asset) return reply.code(404).send({ error: 'Upload not found.' });
  const { HeadObjectCommand } = await import('@aws-sdk/client-s3');
  try { const head = await s3.send(new HeadObjectCommand({ Bucket: mediaBucket, Key: asset.objectKey })); if (Number(head.ContentLength || 0) !== asset.size || head.ContentType !== asset.contentType) return reply.code(400).send({ error: 'Uploaded file validation failed.' }); }
  catch { return reply.code(400).send({ error: 'Uploaded file could not be verified in cloud storage.' }); }
  await prisma.mediaAsset.update({ where: { id }, data: { status: 'uploaded' } });
  return { ok: true, assetId: id, publicUrl: `${(process.env.S3_PUBLIC_URL || '').replace(/\/$/, '')}/${asset.objectKey}` };
});
app.post('/api/live/sessions', { preHandler: auth }, async (_req, reply) => reply.code(501).send({ error: 'Live streaming requires an RTMP/WebRTC ingest and distribution provider. The API integration point is reserved.' }));

const io = new SocketServer(app.server, { cors: { origin, credentials: true } });
io.use(async (socket, next) => {
  try {
    const raw = socket.handshake.headers.cookie?.split(';').map(v => v.trim()).find(v => v.startsWith(cookieName + '='))?.split('=').slice(1).join('=');
    if (!raw) return next(new Error('unauthorized'));
    const session = await prisma.deviceSession.findUnique({ where: { tokenHash: hashToken(decodeURIComponent(raw)) }, include: { user: { select: { id: true, email: true, handle: true, emailVerifiedAt: true } } } });
    if (!session || session.revokedAt || session.expiresAt <= new Date() || !session.user.emailVerifiedAt) return next(new Error('unauthorized'));
    socket.data.user = { id: session.user.id, email: session.user.email, handle: session.user.handle };
    socket.data.userId = session.user.id; socket.data.sessionId = session.id; next();
  } catch { next(new Error('unauthorized')); }
});
io.on('connection', socket => {
  const user = socket.data.user as { id: string; email: string; handle: string };
  socket.join('user:' + user.id);
  const sessionCheck = setInterval(async () => {
    const active = await prisma.deviceSession.findFirst({ where: { id: socket.data.sessionId, revokedAt: null, expiresAt: { gt: new Date() } }, select: { id: true } }).catch(() => null);
    if (!active) socket.disconnect(true);
  }, 60000);
  socket.on('disconnect', () => clearInterval(sessionCheck));
  socket.on('conversation:join', async (conversationId: string) => { const member = await prisma.conversationMember.findUnique({ where: { conversationId_userId: { conversationId, userId: user.id } } }); if (member) socket.join('conversation:' + conversationId); });
  socket.on('group:join', async (groupId: string) => { const member = await prisma.groupMember.findUnique({ where: { groupId_userId: { groupId, userId: user.id } } }); if (member) socket.join('group:' + groupId); });
});

app.setErrorHandler((error, _req, reply) => { app.log.error(error); reply.code(500).send({ error: process.env.NODE_ENV === 'production' ? 'An unexpected server error occurred.' : (error instanceof Error ? error.message : String(error)) }); });
try { await app.listen({ port, host: '0.0.0.0' }); app.log.info(`I-EFEKT API listening on ${port}`); }
catch (err) { app.log.error(err); process.exit(1); }
const shutdown = async () => { rankingEngine.close(); await limiterRedis.quit().catch(() => undefined); await prisma.$disconnect(); await app.close(); process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);