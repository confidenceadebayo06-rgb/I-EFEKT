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

test('unauthenticated account endpoint rejects access', async () => {
  const response = await request('/api/me');
  assert.equal(response.status, 401);
});

test('security headers are present on API responses', async () => {
  const response = await request('/api/health');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  assert.ok(response.headers.get('referrer-policy'));
});

test('invalid login does not issue an authentication cookie', async () => {
  const response = await request('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'invalid-user@example.invalid', password: 'not-a-real-password' })
  });
  assert.ok([401, 429, 503].includes(response.status), `unexpected status ${response.status}`);
  const cookie = response.headers.get('set-cookie') || '';
  assert.ok(!cookie.includes('iefekt_session='), 'failed login must not issue a session cookie');
});

test('health endpoint reports a structured service response', async () => {
  const response = await request('/api/health');
  assert.ok([200, 503].includes(response.status));
  const payload = await response.json();
  assert.equal(typeof payload.ok, 'boolean');
  assert.equal(payload.service, 'iefekt-api');
});
