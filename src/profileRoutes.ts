import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';

type AuthGuard = (request: FastifyRequest, reply: FastifyReply) => Promise<unknown> | unknown;
type SyncWriter = (userId: string, entityType: string, entityId: string) => Promise<unknown>;

const visibility = z.enum(['PRIVATE', 'CIRCLES', 'PUBLIC']);
const skillLevel = z.enum(['BEGINNER', 'INTERMEDIATE', 'ADVANCED', 'EXPERT']);
const goalStatus = z.enum(['ACTIVE', 'COMPLETED', 'PAUSED']);
const intentType = z.enum(['OFFER', 'SEEK']);
const idParams = z.object({ id: z.string().min(1).max(191) });

const skillInput = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().max(500).default(''),
  experienceLevel: skillLevel.default('BEGINNER'),
  visibility: visibility.default('PRIVATE')
});
const skillPatch = skillInput.partial();

const goalInput = z.object({
  title: z.string().trim().min(1).max(120),
  description: z.string().max(1000).default(''),
  category: z.string().trim().min(1).max(40).default('PERSONAL'),
  status: goalStatus.default('ACTIVE'),
  targetDate: z.string().datetime().nullable().optional(),
  visibility: visibility.default('PRIVATE')
});
const goalPatch = goalInput.partial();

const interestInput = z.object({
  name: z.string().trim().min(1).max(80),
  category: z.string().trim().min(1).max(40).default('GENERAL'),
  visibility: visibility.default('PRIVATE')
});
const interestPatch = interestInput.partial();

const intentInput = z.object({
  type: intentType,
  title: z.string().trim().min(1).max(120),
  description: z.string().max(1000).default(''),
  category: z.string().trim().min(1).max(40).default('GENERAL'),
  visibility: visibility.default('PRIVATE'),
  active: z.boolean().default(true)
});
const intentPatch = intentInput.partial();

function invalid(reply: FastifyReply, message: string) {
  return reply.code(400).send({ error: message });
}

export function registerProfileRoutes(
  app: FastifyInstance,
  prisma: PrismaClient,
  auth: AuthGuard,
  emitSync: SyncWriter
) {
  app.get('/api/me/profile', { preHandler: auth }, async (request) => {
    const userId = request.user!.id;
    const [user, skills, goals, interests, intents] = await Promise.all([
      prisma.user.findUnique({ where: { id: userId }, select: { id: true, handle: true, displayName: true, bio: true, avatarUrl: true } }),
      prisma.userSkill.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } }),
      prisma.userGoal.findMany({ where: { userId }, orderBy: { updatedAt: 'desc' } }),
      prisma.userInterest.findMany({ where: { userId }, orderBy: { name: 'asc' } }),
      prisma.profileIntent.findMany({ where: { userId }, orderBy: { updatedAt: 'desc' } })
    ]);
    return { user, skills, goals, interests, intents };
  });

  app.get('/api/users/:id/profile', { preHandler: auth }, async (request, reply) => {
    const parsed = idParams.safeParse(request.params);
    if (!parsed.success) return invalid(reply, 'Invalid user ID.');
    const userId = parsed.data.id;
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, handle: true, displayName: true, bio: true, avatarUrl: true }
    });
    if (!user) return reply.code(404).send({ error: 'Profile not found.' });
    const [skills, interests, intents] = await Promise.all([
      prisma.userSkill.findMany({ where: { userId, visibility: 'PUBLIC' }, select: { id: true, name: true, description: true, experienceLevel: true } }),
      prisma.userInterest.findMany({ where: { userId, visibility: 'PUBLIC' }, select: { id: true, name: true, category: true } }),
      prisma.profileIntent.findMany({ where: { userId, visibility: 'PUBLIC', active: true }, select: { id: true, type: true, title: true, description: true, category: true } })
    ]);
    return { user, skills, interests, intents };
  });

  app.get('/api/me/skills', { preHandler: auth }, async (request) => ({
    skills: await prisma.userSkill.findMany({ where: { userId: request.user!.id }, orderBy: { createdAt: 'asc' } })
  }));
  app.post('/api/me/skills', { preHandler: auth }, async (request, reply) => {
    const parsed = skillInput.safeParse(request.body);
    if (!parsed.success) return invalid(reply, 'Invalid skill details.');
    try {
      const skill = await prisma.userSkill.create({ data: { ...parsed.data, userId: request.user!.id } });
      await emitSync(request.user!.id, 'profile_skill', skill.id);
      return reply.code(201).send({ skill });
    } catch (error: any) {
      if (error?.code === 'P2002') return reply.code(409).send({ error: 'That skill is already on your profile.' });
      throw error;
    }
  });
  app.patch('/api/me/skills/:id', { preHandler: auth }, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    const parsed = skillPatch.safeParse(request.body);
    if (!params.success) return invalid(reply, 'Invalid skill ID.');
    if (!parsed.success || Object.keys(parsed.data).length === 0) return invalid(reply, 'Provide valid skill fields to update.');
    const result = await prisma.userSkill.updateMany({ where: { id: params.data.id, userId: request.user!.id }, data: parsed.data });
    if (!result.count) return reply.code(404).send({ error: 'Skill not found.' });
    const skill = await prisma.userSkill.findFirst({ where: { id: params.data.id, userId: request.user!.id } });
    await emitSync(request.user!.id, 'profile_skill', params.data.id);
    return { skill };
  });
  app.delete('/api/me/skills/:id', { preHandler: auth }, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return invalid(reply, 'Invalid skill ID.');
    const result = await prisma.userSkill.deleteMany({ where: { id: params.data.id, userId: request.user!.id } });
    if (!result.count) return reply.code(404).send({ error: 'Skill not found.' });
    await emitSync(request.user!.id, 'profile_skill', params.data.id);
    return reply.code(204).send();
  });

  app.get('/api/me/goals', { preHandler: auth }, async (request) => ({
    goals: await prisma.userGoal.findMany({ where: { userId: request.user!.id }, orderBy: { updatedAt: 'desc' } })
  }));
  app.post('/api/me/goals', { preHandler: auth }, async (request, reply) => {
    const parsed = goalInput.safeParse(request.body);
    if (!parsed.success) return invalid(reply, 'Invalid goal details.');
    const { targetDate, ...fields } = parsed.data;
    const goal = await prisma.userGoal.create({ data: { ...fields, targetDate: targetDate ? new Date(targetDate) : null, userId: request.user!.id } });
    await emitSync(request.user!.id, 'profile_goal', goal.id);
    return reply.code(201).send({ goal });
  });
  app.patch('/api/me/goals/:id', { preHandler: auth }, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    const parsed = goalPatch.safeParse(request.body);
    if (!params.success) return invalid(reply, 'Invalid goal ID.');
    if (!parsed.success || Object.keys(parsed.data).length === 0) return invalid(reply, 'Provide valid goal fields to update.');
    const { targetDate, ...fields } = parsed.data;
    const data = { ...fields, ...(targetDate !== undefined ? { targetDate: targetDate ? new Date(targetDate) : null } : {}) };
    const result = await prisma.userGoal.updateMany({ where: { id: params.data.id, userId: request.user!.id }, data });
    if (!result.count) return reply.code(404).send({ error: 'Goal not found.' });
    const goal = await prisma.userGoal.findFirst({ where: { id: params.data.id, userId: request.user!.id } });
    await emitSync(request.user!.id, 'profile_goal', params.data.id);
    return { goal };
  });
  app.delete('/api/me/goals/:id', { preHandler: auth }, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return invalid(reply, 'Invalid goal ID.');
    const result = await prisma.userGoal.deleteMany({ where: { id: params.data.id, userId: request.user!.id } });
    if (!result.count) return reply.code(404).send({ error: 'Goal not found.' });
    await emitSync(request.user!.id, 'profile_goal', params.data.id);
    return reply.code(204).send();
  });

  app.get('/api/me/interests', { preHandler: auth }, async (request) => ({
    interests: await prisma.userInterest.findMany({ where: { userId: request.user!.id }, orderBy: { name: 'asc' } })
  }));
  app.post('/api/me/interests', { preHandler: auth }, async (request, reply) => {
    const parsed = interestInput.safeParse(request.body);
    if (!parsed.success) return invalid(reply, 'Invalid interest details.');
    try {
      const interest = await prisma.userInterest.create({ data: { ...parsed.data, userId: request.user!.id } });
      await emitSync(request.user!.id, 'profile_interest', interest.id);
      return reply.code(201).send({ interest });
    } catch (error: any) {
      if (error?.code === 'P2002') return reply.code(409).send({ error: 'That interest is already on your profile.' });
      throw error;
    }
  });
  app.patch('/api/me/interests/:id', { preHandler: auth }, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    const parsed = interestPatch.safeParse(request.body);
    if (!params.success) return invalid(reply, 'Invalid interest ID.');
    if (!parsed.success || Object.keys(parsed.data).length === 0) return invalid(reply, 'Provide valid interest fields to update.');
    const result = await prisma.userInterest.updateMany({ where: { id: params.data.id, userId: request.user!.id }, data: parsed.data });
    if (!result.count) return reply.code(404).send({ error: 'Interest not found.' });
    const interest = await prisma.userInterest.findFirst({ where: { id: params.data.id, userId: request.user!.id } });
    await emitSync(request.user!.id, 'profile_interest', params.data.id);
    return { interest };
  });
  app.delete('/api/me/interests/:id', { preHandler: auth }, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return invalid(reply, 'Invalid interest ID.');
    const result = await prisma.userInterest.deleteMany({ where: { id: params.data.id, userId: request.user!.id } });
    if (!result.count) return reply.code(404).send({ error: 'Interest not found.' });
    await emitSync(request.user!.id, 'profile_interest', params.data.id);
    return reply.code(204).send();
  });

  app.get('/api/me/intents', { preHandler: auth }, async (request) => ({
    intents: await prisma.profileIntent.findMany({ where: { userId: request.user!.id }, orderBy: { updatedAt: 'desc' } })
  }));
  app.post('/api/me/intents', { preHandler: auth }, async (request, reply) => {
    const parsed = intentInput.safeParse(request.body);
    if (!parsed.success) return invalid(reply, 'Invalid offer or help request details.');
    const intent = await prisma.profileIntent.create({ data: { ...parsed.data, userId: request.user!.id } });
    await emitSync(request.user!.id, 'profile_intent', intent.id);
    return reply.code(201).send({ intent });
  });
  app.patch('/api/me/intents/:id', { preHandler: auth }, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    const parsed = intentPatch.safeParse(request.body);
    if (!params.success) return invalid(reply, 'Invalid intent ID.');
    if (!parsed.success || Object.keys(parsed.data).length === 0) return invalid(reply, 'Provide valid offer or help request fields to update.');
    const result = await prisma.profileIntent.updateMany({ where: { id: params.data.id, userId: request.user!.id }, data: parsed.data });
    if (!result.count) return reply.code(404).send({ error: 'Offer or help request not found.' });
    const intent = await prisma.profileIntent.findFirst({ where: { id: params.data.id, userId: request.user!.id } });
    await emitSync(request.user!.id, 'profile_intent', params.data.id);
    return { intent };
  });
  app.delete('/api/me/intents/:id', { preHandler: auth }, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return invalid(reply, 'Invalid intent ID.');
    const result = await prisma.profileIntent.deleteMany({ where: { id: params.data.id, userId: request.user!.id } });
    if (!result.count) return reply.code(404).send({ error: 'Offer or help request not found.' });
    await emitSync(request.user!.id, 'profile_intent', params.data.id);
    return reply.code(204).send();
  });
}
