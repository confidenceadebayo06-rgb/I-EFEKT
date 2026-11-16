import { createDecipheriv, createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const ROOT = '/I-EFEKT/Production-Backups/MySQL';

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(name + ' is required');
  return value;
}

function assertDisposableDatabase() {
  if (process.env.NODE_ENV === 'production' || process.env.IEFEKT_ENABLE_LIVE_DROPBOX_TEST !== '1') {
    throw new Error('Live Dropbox smoke test requires NODE_ENV!=production and IEFEKT_ENABLE_LIVE_DROPBOX_TEST=1');
  }
  const url = new URL(required('DATABASE_URL'));
  const name = decodeURIComponent(url.pathname.slice(1));
  if (url.protocol !== 'mysql:' || !/^(?:iefekt_)?(?:ci|test|testing|staging)(?:_[a-z0-9]+)*$/i.test(name)) {
    throw new Error('Live Dropbox smoke test only accepts a disposable iefekt_ci/test/testing/staging database');
  }
  return name;
}

async function accessToken() {
  const row = await prisma.dropboxCredential.findUnique({ where: { id: 1 } });
  if (!row) throw new Error('Dropbox OAuth is not connected in this disposable database');
  const key = Buffer.from(required('DROPBOX_TOKEN_ENCRYPTION_KEY'), 'base64');
  if (key.length !== 32) throw new Error('DROPBOX_TOKEN_ENCRYPTION_KEY must decode to 32 bytes');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(row.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(row.authTag, 'base64'));
  const refreshToken = Buffer.concat([
    decipher.update(Buffer.from(row.encryptedRefreshToken, 'base64')),
    decipher.final()
  ]).toString('utf8');
  const basic = Buffer.from(required('DROPBOX_APP_KEY') + ':' + required('DROPBOX_APP_SECRET')).toString('base64');
  const response = await fetch('https://api.dropboxapi.com/oauth2/token', {
    method: 'POST',
    headers: { Authorization: 'Basic ' + basic, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }),
    signal: AbortSignal.timeout(20000)
  });
  if (!response.ok) throw new Error('Dropbox token refresh failed with HTTP ' + response.status);
  const body = await response.json();
  if (!body.access_token) throw new Error('Dropbox did not return an access token');
  return body.access_token;
}

function run(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve(stdout) : reject(new Error(command + ' failed: ' + stderr)));
  });
}

async function main() {
  assertDisposableDatabase();
  required('BACKUP_ENCRYPTION_KEY');
  const token = await accessToken();
  let remotePath;
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'iefekt-dropbox-live-'));
  const downloaded = path.join(directory, 'roundtrip.sql.gz.enc');
  try {
    const output = await run(process.execPath, ['scripts/backup-mysql.mjs'], process.env);
    const resultLine = output.trim().split('\n').at(-1);
    const result = JSON.parse(resultLine);
    remotePath = result.remotePath;
    if (!remotePath || !remotePath.startsWith(ROOT + '/')) throw new Error('Backup did not upload into the approved Dropbox folder');

    const download = await fetch('https://content.dropboxapi.com/2/files/download', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Dropbox-API-Arg': JSON.stringify({ path: remotePath }) },
      signal: AbortSignal.timeout(120000)
    });
    if (!download.ok) throw new Error('Dropbox download verification failed with HTTP ' + download.status);
    const bytes = Buffer.from(await download.arrayBuffer());
    await fs.writeFile(downloaded, bytes);
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (bytes.length !== Number(result.bytes) || digest !== result.sha256) {
      throw new Error('Downloaded Dropbox backup did not match uploaded byte count and SHA-256');
    }

    await run(process.execPath, ['scripts/restore-backup-smoke.mjs', downloaded], process.env);
    process.stdout.write(JSON.stringify({
      status: 'passed',
      remotePath,
      bytes: bytes.length,
      sha256: digest,
      checks: ['real Dropbox upload', 'remote download', 'byte-count and SHA-256 verification', 'AES-GCM decrypt and gzip restore into disposable database', 'temporary restore database cleanup']
    }) + '\n');
  } finally {
    if (remotePath) {
      const response = await fetch('https://api.dropboxapi.com/2/files/delete_v2', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: remotePath }),
        signal: AbortSignal.timeout(20000)
      });
      if (!response.ok) process.stderr.write('WARNING: Could not remove Dropbox smoke-test object ' + remotePath + ' (HTTP ' + response.status + ').\n');
    }
    await fs.rm(directory, { recursive: true, force: true });
    await prisma.$disconnect();
  }
}

main().catch(error => {
  process.stderr.write('Dropbox live smoke test failed: ' + (error instanceof Error ? error.message : 'unknown error') + '\n');
  process.exitCode = 1;
});
