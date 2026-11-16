import test from 'node:test';
import assert from 'node:assert/strict';

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
