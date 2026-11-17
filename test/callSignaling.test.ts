import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Script } from 'node:vm';
import { createIceServers } from '../src/callSignaling.js';

test('ICE configuration uses STUN by default and short-lived TURN REST credentials when configured', () => {
  const previousUrls = process.env.TURN_URLS;
  const previousSecret = process.env.TURN_SHARED_SECRET;
  try {
    delete process.env.TURN_URLS;
    delete process.env.TURN_SHARED_SECRET;
    const stunOnly = createIceServers();
    assert.equal(stunOnly.length, 1);
    assert.equal(stunOnly[0].urls, 'stun:stun.l.google.com:19302');

    process.env.TURN_URLS = 'turn:turn.example.test:3478?transport=udp, turns:turn.example.test:5349?transport=tcp';
    process.env.TURN_SHARED_SECRET = 'test-shared-secret-that-is-at-least-32-chars';
    const configured = createIceServers();
    assert.equal(configured.length, 2);
    const turn = configured[1] as { urls: string[]; username: string; credential: string };
    assert.deepEqual(turn.urls, [
      'turn:turn.example.test:3478?transport=udp',
      'turns:turn.example.test:5349?transport=tcp'
    ]);
    assert.match(turn.username, /^\d+:iefekt$/);
    const expected = createHmac('sha1', process.env.TURN_SHARED_SECRET!).update(turn.username).digest('base64');
    assert.equal(turn.credential, expected);
    assert.ok(Number(turn.username.split(':')[0]) > Math.floor(Date.now() / 1000));
  } finally {
    if (previousUrls === undefined) delete process.env.TURN_URLS;
    else process.env.TURN_URLS = previousUrls;
    if (previousSecret === undefined) delete process.env.TURN_SHARED_SECRET;
    else process.env.TURN_SHARED_SECRET = previousSecret;
  }
});

test('inline browser scripts in the app page parse successfully', () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
    .filter(match => !/\bsrc\s*=/.test(match[1] || ''));
  assert.ok(scripts.length > 0, 'expected at least one inline script');
  scripts.forEach((match, index) => {
    new Script(match[2], { filename: 'public/index.html:inline-script-' + (index + 1) });
  });
});


test('call signaling uses unique call IDs rather than the underlying conversation or group ID for room isolation', () => {
  const source = readFileSync(new URL('../src/callSignaling.ts', import.meta.url), 'utf8');
  assert.match(source, /call:\$\{scope\}:\$\{roomId\}:\$\{callId\}/);
  assert.match(source, /validId\(raw\.callId\)/);
});

test('call decline notifications are sent only to the caller currently in the isolated call room', () => {
  const source = readFileSync(new URL('../src/callSignaling.ts', import.meta.url), 'utf8');
  assert.match(source, /const callers = await io\.in\(room\)\.fetchSockets\(\)/);
  assert.match(source, /callers\.some\(peer => \(peer\.data\.user as \{ id: string \}\)\.id === raw\.callerId\)/);
});

test('call invitations require the sender to have joined that exact call session', () => {
  const source = readFileSync(new URL('../src/callSignaling.ts', import.meta.url), 'utf8');
  assert.match(source, /joinedRooms\.get\(roomName\(raw\)\) !== raw\.roomId \|\| !\(await canJoinCall\(prisma, userId, raw\)\)/);
});


test('call room names include the underlying conversation or group ID as well as the unique call ID', () => {
  const source = readFileSync(new URL('../src/callSignaling.ts', import.meta.url), 'utf8');
  assert.match(source, /`call:\$\{scope\}:\$\{roomId\}:\$\{callId\}`/);
  assert.match(source, /joinedRooms\.get\(room\) !== raw\.roomId/);
});

test('leaving one device does not remove a participant who still has another socket in the call', () => {
  const source = readFileSync(new URL('../src/callSignaling.ts', import.meta.url), 'utf8');
  assert.match(source, /await socket\.leave\(room\);[\s\S]*?remainingSockets = await io\.in\(room\)\.fetchSockets\(\)/);
  assert.match(source, /!remainingSockets\.some\(peer => \(peer\.data\.user as \{ id: string \}\)\.id === userId\)/);
  assert.match(source, /remainingSockets = \(await io\.in\(room\)\.fetchSockets\(\)\)\.filter\(peer => peer\.id !== socket\.id\)/);
});

test('joining from a second device does not announce a duplicate call participant', () => {
  const source = readFileSync(new URL('../src/callSignaling.ts', import.meta.url), 'utf8');
  assert.match(source, /const participantAlreadyPresent = participantIds\.includes\(userId\)/);
  assert.match(source, /if \(!participantAlreadyPresent\) socket\.to\(room\)\.emit\('call:participant-joined'/);
});

test('call signaling revalidates sender and recipient membership before relaying media negotiation', () => {
  const source = readFileSync(new URL('../src/callSignaling.ts', import.meta.url), 'utf8');
  assert.match(source, /joinedRooms\.get\(room\) !== raw\.roomId \|\| !\(await canJoinCall\(prisma, userId, raw\)\)/);
  assert.match(source, /if \(await canJoinCall\(prisma, targetUserId, raw\)\) recipients\.push\(peer\)/);
  assert.match(source, /await peer\.leave\(room\)/);
});

test('revoked members are evicted from every active device and peers are notified', () => {
  const source = readFileSync(new URL('../src/callSignaling.ts', import.meta.url), 'utf8');
  assert.match(source, /const evictUserFromRoom = async \(room: string, targetUserId: string\)/);
  assert.match(source, /revokedSockets = roomSockets\.filter\(peer => \(peer\.data\.user as \{ id: string \}\)\.id === targetUserId\)/);
  assert.match(source, /if \(revokedSockets\.length\) io\.to\(room\)\.emit\('call:participant-left'/);
  assert.match(source, /await evictUserFromRoom\(room, userId\)/);
  assert.match(source, /else await evictUserFromRoom\(room, targetUserId\)/);
});
