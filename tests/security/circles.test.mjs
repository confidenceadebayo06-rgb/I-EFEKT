import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const baseUrl = (process.env.IEFEKT_TEST_BASE_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');

async function request(path, options = {}) {
  return fetch(`${baseUrl}${path}`, {
    redirect: 'manual',
    ...options,
    headers: { ...(options.headers || {}) }
  });
}
function json(body) {
  return { 'content-type': 'application/json', body: JSON.stringify(body) };
}

test('Circle discovery and collaboration endpoints require authentication', async () => {
  const paths = [
    '/api/circles',
    '/api/circles/not-a-real-circle',
    '/api/circles/not-a-real-circle/members',
    '/api/circles/not-a-real-circle/goals',
    '/api/circles/not-a-real-circle/updates',
    '/api/circles/not-a-real-circle/support'
  ];
  const responses = await Promise.all(paths.map(path => request(path)));
  for (const response of responses) assert.equal(response.status, 401);
});

test('Circle membership, approval, collaboration and privacy are enforced', async () => {
  const suffix = randomUUID();
  const users = [];
  try {
    for (const role of ['owner', 'member', 'stranger']) {
      const user = await prisma.user.create({ data: {
        email: `circle-${role}-${suffix}@example.invalid`,
        passwordHash: 'test-only-not-a-login-hash',
        handle: `circle_${role}_${suffix.replace(/-/g, '').slice(0, 12)}`,
        displayName: `Circle ${role}`,
        emailVerifiedAt: new Date()
      } });
      const token = randomBytes(32).toString('base64url');
      await prisma.deviceSession.create({
        data: {
          userId: user.id,
          tokenHash: createHash('sha256').update(token).digest('hex'),
          expiresAt: new Date(Date.now() + 60 * 60 * 1000)
        }
      });
      users.push({ ...user, token });
    }
    const [owner, member, stranger] = users;
    const auth = user => ({ cookie: `iefekt_session=${user.token}` });

    const created = await request('/api/circles', {
      method: 'POST',
      headers: auth(owner),
      ...json({
        name: 'Purposeful Circle',
        description: 'A small group for shared progress.',
        purpose: 'Help members complete a practical project.',
        category: 'LEARNING',
        visibility: 'DISCOVERABLE',
        joinPolicy: 'APPROVAL',
        maxMembers: 3
      })
    });
    assert.equal(created.status, 201);
    const { circle } = await created.json();
    assert.equal(circle.visibility, 'DISCOVERABLE');

    const join = await request(`/api/circles/${circle.id}/join`, {
      method: 'POST', headers: auth(member), ...json({})
    });
    assert.equal(join.status, 202);
    assert.equal((await join.json()).status, 'PENDING');

    const pendingMembers = await prisma.groupMember.findMany({ where: { groupId: circle.id } });
    assert.equal(pendingMembers.length, 2);
    assert.equal(pendingMembers.find(x => x.userId === member.id).status, 'PENDING');

    const approve = await request(`/api/circles/${circle.id}/members/${member.id}/approve`, {
      method: 'POST', headers: auth(owner), ...json({})
    });
    assert.equal(approve.status, 200);

    const members = await request(`/api/circles/${circle.id}/members`, { headers: auth(member) });
    assert.equal(members.status, 200);
    assert.equal((await members.json()).members.length, 2);

    const privateMembers = await request(`/api/circles/${circle.id}/members`, { headers: auth(stranger) });
    assert.equal(privateMembers.status, 403);

    const goalResponse = await request(`/api/circles/${circle.id}/goals`, {
      method: 'POST', headers: auth(member),
      ...json({ title: 'Finish the prototype', description: 'Complete the first working version.' })
    });
    assert.equal(goalResponse.status, 201);
    const { goal } = await goalResponse.json();

    const forbiddenGoalEdit = await request(`/api/circles/${circle.id}/goals/${goal.id}`, {
      method: 'PATCH', headers: auth(stranger),
      ...json({ status: 'COMPLETED' })
    });
    assert.equal(forbiddenGoalEdit.status, 403);

    const updateResponse = await request(`/api/circles/${circle.id}/updates`, {
      method: 'POST', headers: auth(member),
      ...json({ body: 'I completed the first milestone.' })
    });
    assert.equal(updateResponse.status, 201);

    const supportResponse = await request(`/api/circles/${circle.id}/support`, {
      method: 'POST', headers: auth(member),
      ...json({ title: 'Need feedback', description: 'Could someone review the onboarding flow?' })
    });
    assert.equal(supportResponse.status, 201);

    const ownerLeave = await request(`/api/circles/${circle.id}/members/${owner.id}`, {
      method: 'DELETE', headers: auth(owner)
    });
    assert.equal(ownerLeave.status, 409);

    const removed = await request(`/api/circles/${circle.id}/members/${member.id}`, {
      method: 'DELETE', headers: auth(owner)
    });
    assert.equal(removed.status, 200);
  } finally {
    for (const user of users) {
      if (user?.id) await prisma.user.deleteMany({ where: { id: user.id } });
    }
  }
});

test('disconnect Circle API test database client', async () => {
  await prisma.$disconnect();
});
