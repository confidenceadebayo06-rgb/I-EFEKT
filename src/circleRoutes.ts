import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';

type AuthGuard = (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
type SyncWriter = (userId: string, entityType: string, entityId: string) => Promise<unknown>;

const idParams = z.object({ id: z.string().min(1).max(191) });
const circleInput = z.object({
  name: z.string().trim().min(2).max(80),
  description: z.string().max(1000).default(''),
  purpose: z.string().max(500).default(''),
  category: z.string().trim().min(1).max(40).default('GENERAL'),
  visibility: z.enum(['PRIVATE', 'DISCOVERABLE', 'INVITE_ONLY']).default('DISCOVERABLE'),
  joinPolicy: z.enum(['OPEN', 'APPROVAL']).default('APPROVAL'),
  maxMembers: z.number().int().min(2).max(50).default(12),
  rules: z.string().max(2000).default('')
});
const goalInput = z.object({
  title: z.string().trim().min(2).max(120),
  description: z.string().max(1000).default(''),
  dueAt: z.string().datetime().nullable().optional()
});
const updateInput = z.object({ body: z.string().trim().min(1).max(2000) });
const supportInput = z.object({
  title: z.string().trim().min(2).max(120),
  description: z.string().max(1000).default('')
});
const goalPatch = z.object({
  title: z.string().trim().min(2).max(120).optional(),
  description: z.string().max(1000).optional(),
  status: z.enum(['ACTIVE', 'COMPLETED', 'PAUSED']).optional(),
  dueAt: z.string().datetime().nullable().optional()
}).refine(value => Object.keys(value).length > 0);

async function activeMember(prisma: PrismaClient, groupId: string, userId: string) {
  return prisma.groupMember.findFirst({ where: { groupId, userId, status: 'ACTIVE' } });
}
async function canManage(prisma: PrismaClient, groupId: string, userId: string) {
  const member = await activeMember(prisma, groupId, userId);
  return !!member && ['OWNER', 'FACILITATOR'].includes(member.role);
}
function bad(reply: FastifyReply, message: string) {
  return reply.code(400).send({ error: message });
}

export function registerCircleRoutes(
  app: FastifyInstance,
  prisma: PrismaClient,
  auth: AuthGuard,
  emitSync: SyncWriter
) {
  app.get('/api/circles', { preHandler: auth }, async request => {
    const userId = request.user!.id;
    const circles = await prisma.socialGroup.findMany({
      where: {
        OR: [
          { visibility: 'DISCOVERABLE' },
          { members: { some: { userId, status: 'ACTIVE' } } }
        ]
      },
      orderBy: { updatedAt: 'desc' },
      include: { _count: { select: { members: true } } }
    });
    return { circles };
  });

  app.post('/api/circles', { preHandler: auth }, async (request, reply) => {
    const parsed = circleInput.safeParse(request.body);
    if (!parsed.success) return bad(reply, 'Invalid Circle details.');
    const circle = await prisma.socialGroup.create({
      data: {
        ...parsed.data,
        ownerId: request.user!.id,
        members: { create: { userId: request.user!.id, role: 'OWNER', status: 'ACTIVE' } }
      },
      include: { _count: { select: { members: true } } }
    });
    await emitSync(request.user!.id, 'circle', circle.id);
    return reply.code(201).send({ circle });
  });

  app.get('/api/circles/:id', { preHandler: auth }, async (request, reply) => {
    const parsed = idParams.safeParse(request.params);
    if (!parsed.success) return bad(reply, 'Invalid Circle ID.');
    const circle = await prisma.socialGroup.findUnique({
      where: { id: parsed.data.id },
      include: { _count: { select: { members: true } } }
    });
    if (!circle) return reply.code(404).send({ error: 'Circle not found.' });
    const membership = await prisma.groupMember.findUnique({
      where: { groupId_userId: { groupId: circle.id, userId: request.user!.id } }
    });
    if (!membership && circle.visibility !== 'DISCOVERABLE') return reply.code(404).send({ error: 'Circle not found.' });
    return { circle, membership: membership ? { role: membership.role, status: membership.status } : null };
  });

  app.post('/api/circles/:id/join', { preHandler: auth }, async (request, reply) => {
    const parsed = idParams.safeParse(request.params);
    if (!parsed.success) return bad(reply, 'Invalid Circle ID.');
    const circle = await prisma.socialGroup.findUnique({ where: { id: parsed.data.id } });
    if (!circle || circle.visibility === 'PRIVATE' || circle.visibility === 'INVITE_ONLY') {
      return reply.code(404).send({ error: 'This Circle is not open for applications.' });
    }
    const existing = await prisma.groupMember.findUnique({
      where: { groupId_userId: { groupId: circle.id, userId: request.user!.id } }
    });
    if (existing?.status === 'ACTIVE') return reply.code(409).send({ error: 'You are already a Circle member.' });
    if (existing?.status === 'PENDING') return reply.code(409).send({ error: 'Your Circle request is awaiting approval.' });
    const count = await prisma.groupMember.count({ where: { groupId: circle.id, status: 'ACTIVE' } });
    if (count >= circle.maxMembers) return reply.code(409).send({ error: 'This Circle has reached its member limit.' });
    const status = circle.joinPolicy === 'OPEN' ? 'ACTIVE' : 'PENDING';
    await prisma.groupMember.upsert({
      where: { groupId_userId: { groupId: circle.id, userId: request.user!.id } },
      create: { groupId: circle.id, userId: request.user!.id, role: 'MEMBER', status, joinedAt: status === 'ACTIVE' ? new Date() : undefined },
      update: { role: 'MEMBER', status, joinedAt: status === 'ACTIVE' ? new Date() : undefined }
    });
    await emitSync(request.user!.id, 'circle_membership', circle.id);
    return reply.code(status === 'ACTIVE' ? 200 : 202).send({ status, message: status === 'ACTIVE' ? 'You joined the Circle.' : 'Your request was sent to the Circle facilitators.' });
  });

  app.get('/api/circles/:id/members', { preHandler: auth }, async (request, reply) => {
    const parsed = idParams.safeParse(request.params);
    if (!parsed.success) return bad(reply, 'Invalid Circle ID.');
    if (!await activeMember(prisma, parsed.data.id, request.user!.id)) return reply.code(403).send({ error: 'Circle membership required.' });
    const members = await prisma.groupMember.findMany({
      where: { groupId: parsed.data.id, status: 'ACTIVE' },
      orderBy: { joinedAt: 'asc' },
      select: { id: true, role: true, joinedAt: true, user: { select: { id: true, handle: true, displayName: true, avatarUrl: true } } }
    });
    return { members };
  });

  app.post('/api/circles/:id/members/:userId/approve', { preHandler: auth }, async (request, reply) => {
    const params = z.object({ id: z.string().min(1).max(191), userId: z.string().min(1).max(191) }).safeParse(request.params);
    if (!params.success) return bad(reply, 'Invalid Circle or user ID.');
    if (!await canManage(prisma, params.data.id, request.user!.id)) return reply.code(403).send({ error: 'Only Circle owners or facilitators can approve members.' });
    const circle = await prisma.socialGroup.findUnique({ where: { id: params.data.id } });
    if (!circle) return reply.code(404).send({ error: 'Circle not found.' });
    const pending = await prisma.groupMember.findFirst({ where: { groupId: circle.id, userId: params.data.userId, status: 'PENDING' } });
    if (!pending) return reply.code(404).send({ error: 'Pending membership request not found.' });
    const count = await prisma.groupMember.count({ where: { groupId: circle.id, status: 'ACTIVE' } });
    if (count >= circle.maxMembers) return reply.code(409).send({ error: 'This Circle has reached its member limit.' });
    await prisma.groupMember.update({ where: { id: pending.id }, data: { status: 'ACTIVE', joinedAt: new Date() } });
    await emitSync(params.data.userId, 'circle_membership', circle.id);
    return { approved: true };
  });

  app.delete('/api/circles/:id/members/:userId', { preHandler: auth }, async (request, reply) => {
    const params = z.object({ id: z.string().min(1).max(191), userId: z.string().min(1).max(191) }).safeParse(request.params);
    if (!params.success) return bad(reply, 'Invalid Circle or user ID.');
    const actorId = request.user!.id;
    const targetId = params.data.userId;
    const actor = await activeMember(prisma, params.data.id, actorId);
    if (targetId !== actorId && (!actor || !['OWNER', 'FACILITATOR'].includes(actor.role))) {
      return reply.code(403).send({ error: 'You cannot remove this Circle member.' });
    }
    const target = await prisma.groupMember.findUnique({ where: { groupId_userId: { groupId: params.data.id, userId: targetId } } });
    if (!target) return reply.code(404).send({ error: 'Circle membership not found.' });
    if (target.role === 'OWNER') return reply.code(409).send({ error: 'Transfer Circle ownership before the owner can leave.' });
    await prisma.groupMember.delete({ where: { id: target.id } });
    await emitSync(targetId, 'circle_membership', params.data.id);
    return { removed: true };
  });

  app.get('/api/circles/:id/goals', { preHandler: auth }, async (request, reply) => {
    const parsed = idParams.safeParse(request.params);
    if (!parsed.success) return bad(reply, 'Invalid Circle ID.');
    if (!await activeMember(prisma, parsed.data.id, request.user!.id)) return reply.code(403).send({ error: 'Circle membership required.' });
    return { goals: await prisma.circleGoal.findMany({ where: { groupId: parsed.data.id }, orderBy: { createdAt: 'desc' } }) };
  });

  app.post('/api/circles/:id/goals', { preHandler: auth }, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    const parsed = goalInput.safeParse(request.body);
    if (!params.success) return bad(reply, 'Invalid Circle ID.');
    if (!parsed.success) return bad(reply, 'Invalid Circle goal details.');
    if (!await activeMember(prisma, params.data.id, request.user!.id)) return reply.code(403).send({ error: 'Circle membership required.' });
    const { dueAt, ...fields } = parsed.data;
    const goal = await prisma.circleGoal.create({
      data: { ...fields, dueAt: dueAt ? new Date(dueAt) : null, groupId: params.data.id, creatorId: request.user!.id }
    });
    await emitSync(request.user!.id, 'circle_goal', goal.id);
    return reply.code(201).send({ goal });
  });

  app.patch('/api/circles/:id/goals/:goalId', { preHandler: auth }, async (request, reply) => {
    const params = z.object({ id: z.string().min(1).max(191), goalId: z.string().min(1).max(191) }).safeParse(request.params);
    const parsed = goalPatch.safeParse(request.body);
    if (!params.success) return bad(reply, 'Invalid Circle or goal ID.');
    if (!parsed.success) return bad(reply, 'Invalid Circle goal update.');
    if (!await activeMember(prisma, params.data.id, request.user!.id)) return reply.code(403).send({ error: 'Circle membership required.' });
    const existing = await prisma.circleGoal.findFirst({ where: { id: params.data.goalId, groupId: params.data.id } });
    if (!existing) return reply.code(404).send({ error: 'Circle goal not found.' });
    if (existing.creatorId !== request.user!.id && !await canManage(prisma, params.data.id, request.user!.id)) {
      return reply.code(403).send({ error: 'Only the goal creator or Circle facilitators can edit this goal.' });
    }
    const { dueAt, ...fields } = parsed.data;
    const goal = await prisma.circleGoal.update({
      where: { id: existing.id },
      data: { ...fields, ...(dueAt !== undefined ? { dueAt: dueAt ? new Date(dueAt) : null } : {}) }
    });
    await emitSync(request.user!.id, 'circle_goal', goal.id);
    return { goal };
  });

  app.get('/api/circles/:id/updates', { preHandler: auth }, async (request, reply) => {
    const parsed = idParams.safeParse(request.params);
    if (!parsed.success) return bad(reply, 'Invalid Circle ID.');
    if (!await activeMember(prisma, parsed.data.id, request.user!.id)) return reply.code(403).send({ error: 'Circle membership required.' });
    return { updates: await prisma.circleUpdate.findMany({
      where: { groupId: parsed.data.id },
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: { author: { select: { id: true, handle: true, displayName: true, avatarUrl: true } } }
    }) };
  });

  app.post('/api/circles/:id/updates', { preHandler: auth }, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    const parsed = updateInput.safeParse(request.body);
    if (!params.success) return bad(reply, 'Invalid Circle ID.');
    if (!parsed.success) return bad(reply, 'Invalid Circle progress update.');
    if (!await activeMember(prisma, params.data.id, request.user!.id)) return reply.code(403).send({ error: 'Circle membership required.' });
    const update = await prisma.circleUpdate.create({ data: { groupId: params.data.id, authorId: request.user!.id, body: parsed.data.body } });
    await emitSync(request.user!.id, 'circle_update', update.id);
    return reply.code(201).send({ update });
  });

  app.get('/api/circles/:id/support', { preHandler: auth }, async (request, reply) => {
    const parsed = idParams.safeParse(request.params);
    if (!parsed.success) return bad(reply, 'Invalid Circle ID.');
    if (!await activeMember(prisma, parsed.data.id, request.user!.id)) return reply.code(403).send({ error: 'Circle membership required.' });
    return { requests: await prisma.circleSupportRequest.findMany({
      where: { groupId: parsed.data.id },
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: { requester: { select: { id: true, handle: true, displayName: true } } }
    }) };
  });

  app.post('/api/circles/:id/support', { preHandler: auth }, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    const parsed = supportInput.safeParse(request.body);
    if (!params.success) return bad(reply, 'Invalid Circle ID.');
    if (!parsed.success) return bad(reply, 'Invalid support request.');
    if (!await activeMember(prisma, params.data.id, request.user!.id)) return reply.code(403).send({ error: 'Circle membership required.' });
    const support = await prisma.circleSupportRequest.create({
      data: { ...parsed.data, groupId: params.data.id, requesterId: request.user!.id }
    });
    await emitSync(request.user!.id, 'circle_support_request', support.id);
    return reply.code(201).send({ request: support });
  });
}
