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
