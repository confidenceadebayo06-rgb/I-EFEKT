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
