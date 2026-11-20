import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const server = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
const schema = readFileSync(new URL('../prisma/schema.prisma', import.meta.url), 'utf8');
const ui = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

test('notifications are persisted and scoped to the authenticated recipient', () => {
  assert.match(schema, /model UserNotification \{/);
  assert.match(schema, /notifications UserNotification\[\]/);
  const routeStart = server.indexOf("app.get('/api/notifications'");
  const routeEnd = server.indexOf("app.post('/api/notifications/:id/read'", routeStart);
  assert.ok(routeStart >= 0 && routeEnd > routeStart);
  assert.match(server.slice(routeStart, routeEnd), /where: \{ userId: req\.user!\.id \}/);
});

test('notification read actions cannot modify another user’s notifications', () => {
  const start = server.indexOf("app.post('/api/notifications/:id/read'");
  const end = server.indexOf("app.post('/api/notifications/read-all'", start);
  assert.ok(start >= 0 && end > start);
  assert.match(server.slice(start, end), /where: \{ id, userId: req\.user!\.id, readAt: null \}/);
  assert.match(server.slice(end), /where: \{ userId: req\.user!\.id, readAt: null \}/);
});

test('Circle request and review actions create recipient notifications', () => {
  assert.match(server, /userId:circle\.ownerId,type:'CIRCLE_JOIN_REQUEST'/);
  assert.match(server, /userId:request\.userId,type:'CIRCLE_REQUEST_APPROVED'/);
  assert.match(server, /userId:request\.userId,type:'CIRCLE_REQUEST_REJECTED'/);
  assert.match(ui, /apiRequest\('\/notifications'\)/);
  assert.match(ui, /markCircleNotificationRead/);
  assert.match(ui, /markAllCircleNotificationsRead/);
});
