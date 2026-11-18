import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');

test('Circle approval claims a pending request before granting membership', () => {
  const start = source.indexOf("app.post('/api/circles/owner/requests/:id/approve'");
  const end = source.indexOf("app.post('/api/circles/owner/requests/:id/reject'", start);
  assert.ok(start >= 0 && end > start, 'expected Circle approval route');
  const route = source.slice(start, end);
  const claim = route.indexOf("updateMany({where:{id,status:'PENDING'},data:{status:'APPROVED'");
  const membership = route.indexOf('tx.circleMember.upsert(');
  assert.ok(claim >= 0, 'approval must atomically claim only a pending request');
  assert.ok(membership > claim, 'membership must be granted only after the approval claim succeeds');
  assert.match(route, /if\(!claimed\.count\) return \{error:'This request has already been reviewed\.',code:409\}/);
});

test('Circle rejection uses a conditional pending-state update and reports review conflicts', () => {
  const start = source.indexOf("app.post('/api/circles/owner/requests/:id/reject'");
  const end = source.indexOf("app.delete('/api/circles/:id/membership'", start);
  assert.ok(start >= 0 && end > start, 'expected Circle rejection route');
  const route = source.slice(start, end);
  assert.match(route, /updateMany\(\{where:\{id,status:'PENDING'\},data:\{status:'REJECTED'/);
  assert.match(route, /if\(!result\.count\) return reply\.code\(409\)/);
});
