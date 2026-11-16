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

test('Human Potential Profile endpoints require an authenticated account', async () => {
  const paths = [
    '/api/me/profile',
    '/api/me/skills',
    '/api/me/goals',
    '/api/me/interests',
    '/api/me/intents',
    '/api/users/nonexistent-user/profile'
  ];
  const responses = await Promise.all(paths.map(path => request(path)));
  for (const response of responses) {
    assert.equal(response.status, 401, `expected 401 for ${response.url}`);
  }
});

test('Human Potential Profile write endpoints reject unauthenticated requests', async () => {
  const writes = [
    ['/api/me/skills', { name: 'Design' }],
    ['/api/me/goals', { title: 'Learn a skill' }],
    ['/api/me/interests', { name: 'Technology' }],
    ['/api/me/intents', { type: 'OFFER', title: 'Design support' }]
  ];
  const responses = await Promise.all(writes.map(([path, body]) => request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })));
  for (const response of responses) assert.equal(response.status, 401);
});

test('profile privacy and record ownership are enforced between two accounts', async () => {
  const suffix = randomUUID();
  let owner;
  let other;
  try {
    owner = await prisma.user.create({ data: {
      email: `profile-owner-${suffix}@example.invalid`,
      passwordHash: 'test-only-not-a-login-hash',
      handle: `owner_${suffix.replace(/-/g, '').slice(0, 16)}`,
      displayName: 'Profile Owner',
      emailVerifiedAt: new Date()
    } });
    other = await prisma.user.create({ data: {
      email: `profile-other-${suffix}@example.invalid`,
      passwordHash: 'test-only-not-a-login-hash',
      handle: `other_${suffix.replace(/-/g, '').slice(0, 16)}`,
      displayName: 'Other User',
      emailVerifiedAt: new Date()
    } });

    const ownerToken = randomBytes(32).toString('base64url');
    const otherToken = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
    await prisma.deviceSession.createMany({ data: [
      { userId: owner.id, tokenHash: createHash('sha256').update(ownerToken).digest('hex'), expiresAt },
      { userId: other.id, tokenHash: createHash('sha256').update(otherToken).digest('hex'), expiresAt }
    ] });

    const privateSkill = await prisma.userSkill.create({ data: { userId: owner.id, name: 'Private skill', visibility: 'PRIVATE' } });
    await prisma.userSkill.create({ data: { userId: owner.id, name: 'Public skill', visibility: 'PUBLIC' } });
    await prisma.userSkill.create({ data: { userId: owner.id, name: 'Circle skill', visibility: 'CIRCLES' } });
    await prisma.userGoal.create({ data: { userId: owner.id, title: 'Private goal', visibility: 'PRIVATE' } });
    await prisma.userGoal.create({ data: { userId: owner.id, title: 'Public goal', visibility: 'PUBLIC' } });

    const publicResponse = await request(`/api/users/${owner.id}/profile`, {
      headers: { cookie: `iefekt_session=${otherToken}` }
    });
    assert.equal(publicResponse.status, 200);
    const publicProfile = await publicResponse.json();
    assert.equal(publicProfile.user.id, owner.id);
    assert.equal('email' in publicProfile.user, false);
    assert.deepEqual(publicProfile.skills.map(skill => skill.name), ['Public skill']);
    assert.deepEqual(publicProfile.goals.map(goal => goal.title), ['Public goal']);

    const privateResponse = await request('/api/me/profile', {
      headers: { cookie: `iefekt_session=${ownerToken}` }
    });
    assert.equal(privateResponse.status, 200);
    const privateProfile = await privateResponse.json();
    assert.ok(privateProfile.skills.some(skill => skill.id === privateSkill.id));
    assert.ok(privateProfile.goals.some(goal => goal.title === 'Private goal'));

    const forbiddenUpdate = await request(`/api/me/skills/${privateSkill.id}`, {
      method: 'PATCH',
      headers: { cookie: `iefekt_session=${otherToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Hijacked skill' })
    });
    assert.equal(forbiddenUpdate.status, 404);

    const forbiddenDelete = await request(`/api/me/skills/${privateSkill.id}`, {
      method: 'DELETE',
      headers: { cookie: `iefekt_session=${otherToken}` }
    });
    assert.equal(forbiddenDelete.status, 404);

    const invalidVisibility = await request('/api/me/skills', {
      method: 'POST',
      headers: { cookie: `iefekt_session=${ownerToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Invalid visibility', visibility: 'EVERYONE' })
    });
    assert.equal(invalidVisibility.status, 400);
  } finally {
    if (owner?.id) await prisma.user.deleteMany({ where: { id: owner.id } });
    if (other?.id) await prisma.user.deleteMany({ where: { id: other.id } });
  }
});

test('disconnect profile API test database client', async () => {
  await prisma.$disconnect();
});
