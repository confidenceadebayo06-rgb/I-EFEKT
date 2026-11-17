import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { registerCircleRoutes } from '../src/circleRoutes.js';

function setup(joinPolicy: 'OPEN' | 'APPROVAL') {
  const group = { id: 'circle-1', ownerId: 'owner', visibility: 'DISCOVERABLE', joinPolicy, maxMembers: 2, updatedAt: new Date() };
  const members = new Map<string, any>([['circle-1:owner', { id: 'm-owner', groupId: 'circle-1', userId: 'owner', role: 'OWNER', status: 'ACTIVE' }]]);
  if (joinPolicy === 'APPROVAL') {
    members.set('circle-1:a', { id: 'm-a', groupId: 'circle-1', userId: 'a', role: 'MEMBER', status: 'PENDING' });
    members.set('circle-1:b', { id: 'm-b', groupId: 'circle-1', userId: 'b', role: 'MEMBER', status: 'PENDING' });
  }

  // Model the database's per-Circle row lock: interactive transactions that
  // update the same parent row run their capacity checks serially.
  let tail = Promise.resolve();
  const tx: any = {
    socialGroup: {
      update: async () => group,
      findUnique: async () => group
    },
    groupMember: {
      findUnique: async ({ where }: any) => members.get(`${where.groupId_userId.groupId}:${where.groupId_userId.userId}`) ?? null,
      findFirst: async ({ where }: any) => [...members.values()].find(m => m.groupId === where.groupId && m.userId === where.userId && m.status === where.status) ?? null,
      count: async ({ where }: any) => [...members.values()].filter(m => m.groupId === where.groupId && m.status === where.status).length,
      upsert: async ({ where, create, update }: any) => {
        const key = `${where.groupId_userId.groupId}:${where.groupId_userId.userId}`;
        const old = members.get(key);
        const value = old ? { ...old, ...update } : { id: `m-${create.userId}`, ...create };
        members.set(key, value);
        return value;
      },
      update: async ({ where, data }: any) => {
        const old = [...members.values()].find(m => m.id === where.id)!;
        const value = { ...old, ...data };
        members.set(`${value.groupId}:${value.userId}`, value);
        return value;
      }
    }
  };
  const prisma: any = {
    socialGroup: { findUnique: async () => group },
    groupMember: {
      findFirst: async ({ where }: any) => [...members.values()].find(m => m.groupId === where.groupId && m.userId === where.userId && m.status === where.status) ?? null
    },
    $transaction: async (work: (client: any) => Promise<any>) => {
      const previous = tail;
      let release!: () => void;
      tail = new Promise<void>(resolve => { release = resolve; });
      await previous;
      try { return await work(tx); } finally { release(); }
    }
  };

  const app = Fastify();
  app.decorateRequest('user', null as any);
  const auth = async (request: any) => { request.user = { id: String(request.headers['x-user'] || 'guest') }; };
  registerCircleRoutes(app, prisma, auth as any, async () => undefined);
  return { app, members };
}

test('simultaneous approvals cannot exceed Circle capacity', async () => {
  const { app, members } = setup('APPROVAL');
  try {
    const [a, b] = await Promise.all([
      app.inject({ method: 'POST', url: '/api/circles/circle-1/members/a/approve', headers: { 'x-user': 'owner' } }),
      app.inject({ method: 'POST', url: '/api/circles/circle-1/members/b/approve', headers: { 'x-user': 'owner' } })
    ]);
    assert.deepEqual([a.statusCode, b.statusCode].sort(), [200, 409]);
    assert.equal([...members.values()].filter(m => m.status === 'ACTIVE').length, 2);
  } finally { await app.close(); }
});

test('simultaneous OPEN joins cannot exceed Circle capacity', async () => {
  const { app, members } = setup('OPEN');
  try {
    const [a, b] = await Promise.all([
      app.inject({ method: 'POST', url: '/api/circles/circle-1/join', headers: { 'x-user': 'a' } }),
      app.inject({ method: 'POST', url: '/api/circles/circle-1/join', headers: { 'x-user': 'b' } })
    ]);
    assert.deepEqual([a.statusCode, b.statusCode].sort(), [200, 409]);
    assert.equal([...members.values()].filter(m => m.status === 'ACTIVE').length, 2);
  } finally { await app.close(); }
});
