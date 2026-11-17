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

test('browser call peers attempt an ICE restart after a failed connection', () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /pc\.createOffer\(\{iceRestart:true\}\)/);
  assert.match(html, /state\.restarting=true/);
});

test('failed incoming call setup releases local media and restores the pending invitation', () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /if\(!joined\.ok\)\{callLocalStream\.getTracks\(\)\.forEach\(track=>track\.stop\(\)\);callLocalStream=null;const local=document\.getElementById\('call-local-video'\);if\(local\)local\.srcObject=null/);
  assert.match(html, /async function acceptCloudCall\(\)[\s\S]*?catch\(e\)\{if\(activeCall\)endCloudCall\(\);setCallStatus\(e\.message\);pendingIncomingCall=invite;startPendingIncomingCallTimer\(invite\);showCallModal\(\);\}/);
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
  assert.match(source, /joinedRooms\.get\(room\) !== raw\.roomId \|\| !socket\.rooms\.has\(room\) \|\| !\(await canJoinCall\(prisma, userId, raw\)\)/);
  assert.ok(source.includes('acknowledge?.({ ok: true, invited: invitedCount })'));
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

test('stale local room bookkeeping cannot emit duplicate participant-left events', () => {
  const source = readFileSync(new URL('../src/callSignaling.ts', import.meta.url), 'utf8');
  assert.match(source, /joinedRooms\.get\(room\) !== raw\.roomId \|\| !socket\.rooms\.has\(room\)/);
  assert.match(source, /for \(const room of joinedRooms\.keys\(\)\) \{\s*if \(!socket\.rooms\.has\(room\)\) continue;/);
});

test('a second device for the same user cannot create competing peer connections in one call session', () => {
  const source = readFileSync(new URL('../src/callSignaling.ts', import.meta.url), 'utf8');
  assert.match(source, /const participantAlreadyPresent = participantIds\.includes\(userId\)/);
  assert.match(source, /if \(participantAlreadyPresent && !socket\.rooms\.has\(room\)\)/);
  assert.match(source, /already connected to this call on another device/);
  assert.match(source, /if \(!participantAlreadyPresent\) socket\.to\(room\)\.emit\('call:participant-joined'/);
});

test('call signaling revalidates sender and recipient membership before relaying media negotiation', () => {
  const source = readFileSync(new URL('../src/callSignaling.ts', import.meta.url), 'utf8');
  assert.ok(source.includes('joinedRooms.get(room) !== raw.roomId || !socket.rooms.has(room)'));
  assert.ok(source.includes('if (!(await canJoinCall(prisma, userId, raw)))'));
  assert.ok(source.includes('if (await canJoinCall(prisma, targetUserId, raw)) recipients.push(peer)'));
  assert.ok(source.includes('await evictUserFromRoom(room, targetUserId)'));
});

test('revoked members are evicted from every active device and peers are notified', () => {
  const source = readFileSync(new URL('../src/callSignaling.ts', import.meta.url), 'utf8');
  assert.match(source, /const evictUserFromRoom = async \(room: string, targetUserId: string\)/);
  assert.match(source, /revokedSockets = roomSockets\.filter\(peer => \(peer\.data\.user as \{ id: string \}\)\.id === targetUserId\)/);
  assert.match(source, /if \(revokedSockets\.length\) io\.to\(room\)\.emit\('call:participant-left'/);
  assert.match(source, /await evictUserFromRoom\(room, userId\)/);
  assert.match(source, /else await evictUserFromRoom\(room, targetUserId\)/);
});

test('call participant capacity checks use a token-guarded shared Redis lock across replicas', () => {
  const source = readFileSync(new URL('../src/callSignaling.ts', import.meta.url), 'utf8');
  assert.match(source, /iefekt:call-join-lock:/);
  assert.match(source, /redis\.set\(lockKey, lockToken, 'PX', 30000, 'NX'\)/);
  assert.match(source, /if \(await redis\.get\(lockKey\) !== lockToken\)/);
  assert.match(source, /redis\.eval\("if redis\.call\('GET', KEYS\[1\]\) == ARGV\[1\] then return redis\.call\('DEL', KEYS\[1\]\) else return 0 end"/);
  assert.match(source, /attachCallSignaling\(io: Server, prisma: PrismaClient, redis: Redis\)/);
});


test('a transient Redis lock-release error cannot convert an already joined call into a failed join', () => {
  const source = readFileSync(new URL('../src/callSignaling.ts', import.meta.url), 'utf8');
  assert.match(source, /redis\.eval\([\s\S]*?\.catch\(\(\) => 0\)/);
  assert.match(source, /The lease has a TTL, so a transient Redis release error/);
});


test('a second incoming call cannot replace an invitation already awaiting a decision', () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /function showIncomingCloudCall\(invite\)\{if\(activeCall\|\|pendingIncomingCall\)\{cloudSocket\.emit\('call:decline',invite\);return;\}pendingIncomingCall=invite;/);
});


test('a pending incoming call invitation expires when the signaling socket disconnects', () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /else if\(pendingIncomingCall\)\{clearPendingIncomingCallTimer\(\);pendingIncomingCall=null;document\.getElementById\('call-incoming-controls'\)\.classList\.add\('hidden'\);showCallModal\(\);setCallStatus\('The incoming invitation expired because the secure connection was interrupted\./);
});


test('unanswered incoming call invitations expire after 30 seconds and notify the caller', () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /function startPendingIncomingCallTimer\(invite\).*setTimeout\(\(\)=>\{if\(pendingIncomingCall!==invite\)return;if\(cloudSocket\)cloudSocket\.emit\('call:decline',invite\);pendingIncomingCall=null;pendingIncomingCallTimer=null;/);
  assert.match(html, /\},30000\);/);
  assert.match(html, /function acceptCloudCall\(\)\{const invite=pendingIncomingCall;if\(!invite\)return;clearPendingIncomingCallTimer\(\);/);
  assert.match(html, /function declineCloudCall\(\)\{clearPendingIncomingCallTimer\(\);/);
});



test('call declines are accepted only for a live invitation issued to that recipient', () => {
  const source = readFileSync(new URL('../src/callSignaling.ts', import.meta.url), 'utf8');
  assert.match(source, /iefekt:call-invite:\$\{room\}:\$\{inviteeId\}/);
  assert.match(source, /redis\.set\(invitationKey, userId, 'EX', 30, 'NX'\)/);
  assert.match(source, /if \(await redis\.get\(invitationKey\) !== raw\.callerId\) return/);
  assert.match(source, /redis\.eval\([\s\S]*?invitationKey, raw\.callerId\)/);
});


test('successful call joins clear the recipient pending-invitation marker', () => {
  const source = readFileSync(new URL('../src/callSignaling.ts', import.meta.url), 'utf8');
  assert.match(source, /await socket\.join\(room\);\s*await redis\.del\(\`iefekt:call-invite:\$\{room\}:\$\{userId\}\`\)\.catch\(\(\) => 0\);/);
});


test('an active invitation cannot be overwritten by another caller before expiry', () => {
  const source = readFileSync(new URL('../src/callSignaling.ts', import.meta.url), 'utf8');
  assert.match(source, /redis\.set\(invitationKey, userId, 'EX', 30, 'NX'\)/);
  assert.match(source, /if \(invitationCreated === 'OK'\) \{\s*io\.to\(\`user:\$\{inviteeId\}\`\)\.emit\('call:incoming'/);
});


test('invitation cleanup failure does not undo a successful room join', () => {
  const source = readFileSync(new URL('../src/callSignaling.ts', import.meta.url), 'utf8');
  assert.match(source, /await redis\.del\(\`iefekt:call-invite:\$\{room\}:\$\{userId\}\`\)\.catch\(\(\) => 0\);\s*joinedRooms\.set\(room, payload\.roomId\)/);
});


test('incoming call invitations contain only server-approved fields', () => {
  const source = readFileSync(new URL('../src/callSignaling.ts', import.meta.url), 'utf8');
  assert.match(source, /emit\('call:incoming', \{ scope: raw\.scope, roomId: raw\.roomId, callId: raw\.callId, callerId: userId \}\)/);
  assert.doesNotMatch(source, /emit\('call:incoming', \{ \.\.\.raw/);
});
