import test from 'node:test';
import assert from 'node:assert/strict';

const baseUrl = (process.env.IEFEKT_TEST_BASE_URL || '').replace(/\/$/, '');
const email = process.env.IEFEKT_STAGING_TEST_EMAIL || '';
const password = process.env.IEFEKT_STAGING_TEST_PASSWORD || '';
const stagingReady = !!(baseUrl && email && password);

async function api(path, options = {}) {
  return fetch(`${baseUrl}${path}`, { redirect: 'manual', ...options });
}
function cookieFrom(response) {
  const raw = response.headers.get('set-cookie') || '';
  const match = raw.match(/iefekt_session=[^;]+/);
  assert.ok(match, 'expected the API to issue an opaque session cookie');
  return match[0];
}
async function login(deviceName) {
  const response = await api('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-device-name': deviceName },
    body: JSON.stringify({ email, password })
  });
  assert.equal(response.status, 200, `login failed for ${deviceName}: ${await response.text()}`);
  return cookieFrom(response);
}

test('staging: two independent desktop/mobile sessions can coexist and be revoked separately', { skip: !stagingReady }, async () => {
  const desktop = await login('Staging desktop browser');
  const mobile = await login('Staging mobile PWA');
  const sessionsResponse = await api('/api/me/sessions', { headers: { cookie: desktop } });
  assert.equal(sessionsResponse.status, 200);
  const sessions = (await sessionsResponse.json()).sessions;
  assert.ok(sessions.some(s => s.deviceName === 'Staging desktop browser' && s.isCurrent));
  const mobileSession = sessions.find(s => s.deviceName === 'Staging mobile PWA');
  assert.ok(mobileSession, 'second device session should be listed');

  const revoke = await api(`/api/me/sessions/${encodeURIComponent(mobileSession.id)}`, {
    method: 'DELETE', headers: { cookie: desktop }
  });
  assert.equal(revoke.status, 204);
  assert.equal((await api('/api/me', { headers: { cookie: mobile } })).status, 401);
  assert.equal((await api('/api/me', { headers: { cookie: desktop } })).status, 200);

  const logout = await api('/api/auth/logout', { method: 'POST', headers: { cookie: desktop } });
  assert.equal(logout.status, 200);
  assert.equal((await api('/api/me', { headers: { cookie: desktop } })).status, 401);
});

test('staging: password reset revokes every active session', { skip: !(stagingReady && process.env.IEFEKT_STAGING_RESET_TOKEN && process.env.IEFEKT_STAGING_RESET_PASSWORD) }, async () => {
  const desktop = await login('Password-reset desktop');
  const mobile = await login('Password-reset mobile');
  const reset = await api('/api/auth/reset-password', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: process.env.IEFEKT_STAGING_RESET_TOKEN, password: process.env.IEFEKT_STAGING_RESET_PASSWORD })
  });
  assert.equal(reset.status, 200, `password reset failed: ${await reset.text()}`);
  assert.equal((await api('/api/me', { headers: { cookie: desktop } })).status, 401);
  assert.equal((await api('/api/me', { headers: { cookie: mobile } })).status, 401);
});
