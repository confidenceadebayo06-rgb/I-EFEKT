import { PrismaClient } from '@prisma/client';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream, promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createGzip } from 'node:zlib';
import { pipeline, Transform } from 'node:stream';
import { promisify } from 'node:util';

const pipe = promisify(pipeline);
const prisma = new PrismaClient();
const BACKUP_ROOT = '/I-EFEKT/Production-Backups/MySQL';
const CHUNK = 8 * 1024 * 1024;

function keyFromEnv(name) {
  const key = Buffer.from(process.env[name] || '', 'base64');
  if (key.length !== 32) throw new Error(name + ' must be base64-encoded 32-byte key');
  return key;
}
function databaseConfig() {
  const url = new URL(process.env.DATABASE_URL || '');
  if (url.protocol !== 'mysql:') throw new Error('DATABASE_URL must use mysql://');
  return { host: url.hostname, port: url.port || '3306', user: decodeURIComponent(url.username), password: decodeURIComponent(url.password), database: decodeURIComponent(url.pathname.slice(1)) };
}
function safeDropboxPath(fileName) {
  if (!/^[A-Za-z0-9._-]+$/.test(fileName) || fileName.includes('..')) throw new Error('Invalid backup filename');
  const full = BACKUP_ROOT + '/' + fileName;
  if (!full.startsWith(BACKUP_ROOT + '/')) throw new Error('Backup path is outside the permitted folder');
  return full;
}
function runDump(outputPath) {
  const db = databaseConfig();
  return new Promise((resolve, reject) => {
    const child = spawn('mariadb-dump', ['--host', db.host, '--port', String(db.port), '--user', db.user, '--single-transaction', '--quick', '--routines', '--triggers', '--events', '--hex-blob', '--default-character-set=utf8mb4', '--skip-lock-tables', db.database], {
      env: { ...process.env, MYSQL_PWD: db.password }, stdio: ['ignore', 'pipe', 'pipe']
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { stderr += chunk.slice(0, 2000); });
    const gzip = createGzip({ level: 6 });
    const key = keyFromEnv('BACKUP_ENCRYPTION_KEY');
    const iv = randomBytes(12);
    const encryptor = createCipheriv('aes-256-gcm', key, iv);
    const exited = new Promise((res, rej) => { child.once('error', rej); child.once('close', code => code === 0 ? res() : rej(new Error('Database dump failed: ' + stderr))); });
    Promise.all([pipe(child.stdout, gzip, encryptor, createWriteStream(outputPath)), exited])
      .then(() => resolve({ iv, authTag: encryptor.getAuthTag() })).catch(reject);
  });
}
async function getDropboxAccessToken() {
  const credential = await prisma.dropboxCredential.findUnique({ where: { id: 1 } });
  if (!credential) throw new Error('Dropbox has not been connected');
  const decipher = createDecipheriv('aes-256-gcm', keyFromEnv('DROPBOX_TOKEN_ENCRYPTION_KEY'), Buffer.from(credential.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(credential.authTag, 'base64'));
  const refreshToken = Buffer.concat([decipher.update(Buffer.from(credential.encryptedRefreshToken, 'base64')), decipher.final()]).toString('utf8');
  const basic = Buffer.from(process.env.DROPBOX_APP_KEY + ':' + process.env.DROPBOX_APP_SECRET).toString('base64');
  const response = await fetch('https://api.dropboxapi.com/oauth2/token', {
    method: 'POST', headers: { Authorization: 'Basic ' + basic, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }), signal: AbortSignal.timeout(20000)
  });
  if (!response.ok) throw new Error('Dropbox token refresh failed with HTTP ' + response.status);
  const data = await response.json();
  if (!data.access_token) throw new Error('Dropbox did not return an access token');
  return data.access_token;
}
async function dropboxRequest(endpoint, token, args, bytes) {
  const response = await fetch('https://content.dropboxapi.com/2/files/' + endpoint, {
    method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Dropbox-API-Arg': JSON.stringify(args), 'Content-Type': 'application/octet-stream' },
    body: bytes, signal: AbortSignal.timeout(120000)
  });
  if (!response.ok) throw new Error('Dropbox upload failed with HTTP ' + response.status);
  return response.status === 200 ? response.json().catch(() => ({})) : {};
}
async function uploadFile(filePath, fileName) {
  const token = await getDropboxAccessToken();
  const remotePath = safeDropboxPath(fileName);
  const stat = await fs.stat(filePath);
  const fd = await fs.open(filePath, 'r');
  try {
    const readChunk = async (offset, length) => { const b = Buffer.alloc(length); const r = await fd.read(b, 0, length, offset); return b.subarray(0, r.bytesRead); };
    const firstLength = Math.min(CHUNK, stat.size);
    const first = await readChunk(0, firstLength);
    const started = await dropboxRequest('upload_session/start', token, { close: false }, first);
    const sessionId = started.session_id;
    if (!sessionId) throw new Error('Dropbox did not create an upload session');
    let offset = first.length;
    while (stat.size - offset > CHUNK) {
      const part = await readChunk(offset, CHUNK);
      await dropboxRequest('upload_session/append_v2', token, { cursor: { session_id: sessionId, offset }, close: false }, part);
      offset += part.length;
    }
    const last = await readChunk(offset, stat.size - offset);
    const metadata = await dropboxRequest('upload_session/finish', token, { cursor: { session_id: sessionId, offset }, commit: { path: remotePath, mode: 'add', autorename: false, mute: true, strict_conflict: true } }, last);
    if (metadata.path_display !== remotePath || Number(metadata.size) !== stat.size) throw new Error('Dropbox upload metadata did not match the encrypted backup.');
    return remotePath;
  } finally { await fd.close(); }
}
async function main() {
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'iefekt-backup-'));
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const cipherPath = path.join(dir, 'payload.enc');
  const outputDir = process.env.BACKUP_OUTPUT_DIR || path.resolve('tmp-backups');
  await fs.mkdir(outputDir, { recursive: true });
  const finalPath = path.join(outputDir, 'iefekt-mysql-' + timestamp + '.sql.gz.enc');
  try {
    const { iv, authTag } = await runDump(cipherPath);
    const header = Buffer.from(JSON.stringify({ format: 'IEFEKT-ENC-GZIP-V1', algorithm: 'aes-256-gcm', iv: iv.toString('base64'), authTag: authTag.toString('base64'), createdAt: new Date().toISOString() }) + '\n');
    await fs.writeFile(finalPath, header);
    const hash = createHash('sha256');
    hash.update(header);
    let bytes = header.length;
    const meter = new Transform({ transform(chunk, _enc, cb) { hash.update(chunk); bytes += chunk.length; cb(null, chunk); } });
    await pipe(createReadStream(cipherPath), meter, createWriteStream(finalPath, { flags: 'a' }));
    const digest = hash.digest('hex');
    if (process.argv.includes('--local-only')) {
      process.stdout.write(JSON.stringify({ file: finalPath, sha256: digest, bytes }) + '\n');
      return;
    }
    const remotePath = await uploadFile(finalPath, path.basename(finalPath));
    process.stdout.write(JSON.stringify({ remotePath, sha256: digest, bytes }) + '\n');
    await fs.rm(finalPath, { force: true });
  } finally {
    if (!process.argv.includes('--local-only')) await fs.rm(finalPath, { force: true });
    await fs.rm(dir, { recursive: true, force: true });
    await prisma.$disconnect();
  }
}
main().catch(error => { process.stderr.write('Backup failed: ' + (error instanceof Error ? error.message : 'unknown error') + '\n'); process.exitCode = 1; });
