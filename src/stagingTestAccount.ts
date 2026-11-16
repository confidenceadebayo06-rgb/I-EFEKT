import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

/**
 * A narrowly scoped staging-only account bootstrap for environments without SMTP.
 * This route is not registered unless APP_ENV=staging and a 32+ character
 * STAGING_TEST_ADMIN_SECRET is configured. It refuses all non-staging contexts.
 */
export function registerStagingTestAccountRoute(app: FastifyInstance, prisma: PrismaClient) {
  const secret = process.env.STAGING_TEST_ADMIN_SECRET || '';
  if (process.env.APP_ENV !== 'staging' || secret.length < 32) return;

  app.post('/api/staging/test-account', async (req, reply) => {
    if (process.env.APP_ENV !== 'staging' || process.env.NODE_ENV !== 'production') {
      return reply.code(404).send({ error: 'Not found.' });
    }

    const supplied = String(req.headers['x-staging-test-secret'] || '');
    const suppliedBytes = Buffer.from(supplied);
    const expectedBytes = Buffer.from(secret);
    if (suppliedBytes.length !== expectedBytes.length || !timingSafeEqual(suppliedBytes, expectedBytes)) {
      return reply.code(404).send({ error: 'Not found.' });
    }

    const parsed = z.object({
      email: z.string().email().max(254),
      password: z.string().min(12).max(128),
      handle: z.string().regex(/^[a-zA-Z0-9_]{3,24}$/),
      displayName: z.string().min(1).max(60)
    }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid staging test-account details.' });

    const { email, password, handle, displayName } = parsed.data;
    const normalizedEmail = email.toLowerCase();
    const normalizedHandle = handle.toLowerCase();
    const existing = await prisma.user.findFirst({
      where: { OR: [{ email: normalizedEmail }, { handle: normalizedHandle }] },
      select: { id: true }
    });
    if (existing) return reply.code(409).send({ error: 'Email or handle is already in use.' });

    const user = await prisma.user.create({
      data: {
        email: normalizedEmail,
        passwordHash: await bcrypt.hash(password, 12),
        handle: normalizedHandle,
        displayName,
        emailVerifiedAt: new Date()
      } as any,
      select: { id: true, email: true, handle: true }
    });
    await prisma.auditLog.create({
      data: { userId: user.id, action: 'staging.test_account_created', metadata: { verification: 'staging-only-bootstrap' } }
    }).catch(() => undefined);

    return reply.code(201).send({ message: 'Disposable staging test account created and verified.', user });
  });
}


/**
 * TEMPORARY: reset only the known disposable staging backup-test account.
 * Remove this route after the user has signed in successfully.
 */
export function registerStagingTestAccountPasswordResetRoute(app: FastifyInstance, prisma: PrismaClient) {
  const secret = process.env.STAGING_TEST_ADMIN_SECRET || '';
  const targetUserId = 'cmwisjnz90000pe01dljqiyfu';
  if (process.env.APP_ENV !== 'staging' || secret.length < 32) return;

  app.post('/api/staging/reset-test-account-password', async (req, reply) => {
    if (process.env.APP_ENV !== 'staging' || process.env.NODE_ENV !== 'production') {
      return reply.code(404).send({ error: 'Not found.' });
    }

    const supplied = String(req.headers['x-staging-test-secret'] || '');
    const suppliedBytes = Buffer.from(supplied);
    const expectedBytes = Buffer.from(secret);
    if (suppliedBytes.length !== expectedBytes.length || !timingSafeEqual(suppliedBytes, expectedBytes)) {
      return reply.code(404).send({ error: 'Not found.' });
    }

    const parsed = z.object({ password: z.string().min(12).max(128) }).strict().safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Provide a password between 12 and 128 characters.' });

    const target = await prisma.user.findUnique({
      where: { id: targetUserId },
      select: { id: true, handle: true, emailVerifiedAt: true }
    });
    if (!target || target.handle !== 'backup_test_admin' || !target.emailVerifiedAt) {
      return reply.code(404).send({ error: 'The designated disposable staging account was not found.' });
    }

    const passwordHash = await bcrypt.hash(parsed.data.password, 12);
    await prisma.$transaction(async tx => {
      await tx.user.update({ where: { id: targetUserId }, data: { passwordHash } });
      await tx.passwordResetToken.deleteMany({ where: { userId: targetUserId } });
      await tx.deviceSession.updateMany({
        where: { userId: targetUserId, revokedAt: null },
        data: { revokedAt: new Date() }
      });
      await tx.auditLog.create({
        data: { userId: targetUserId, action: 'staging.test_account_password_reset' }
      });
    });

    return { ok: true, message: 'Disposable staging test-account password updated. Sign in with the account email and the new password.' };
  });
}
