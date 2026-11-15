import { createDecipheriv } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import { createGunzip } from 'node:zlib';
import { pipeline } from 'node:stream';
import { promisify } from 'node:util';

const pipe = promisify(pipeline);
const SAFE_DATABASE_NAME = /^(?:iefekt_)?(?:ci|test|testing|staging)(?:_[a-z0-9]+)*$/i;

function key() {
  const value = Buffer.from(process.env.BACKUP_ENCRYPTION_KEY || '', 'base64');
  if (value.length !== 32) throw new Error('BACKUP_ENCRYPTION_KEY must be a base64-encoded 32-byte key');
  return value;
}

function dbConfig() {
  const url = new URL(process.env.DATABASE_URL || '');
  if (url.protocol !== 'mysql:') throw new Error('DATABASE_URL must use mysql://');
  const database = decodeURIComponent(url.pathname.slice(1));
  if (!SAFE_DATABASE_NAME.test(database)) {
    throw new Error('Restore smoke test is allowed only for iefekt_ci, iefekt_test, iefekt_testing, or iefekt_staging databases (optionally with a suffix).');
  }
  if (process.env.NODE_ENV === 'production') throw new Error('Restore smoke test is disabled when NODE_ENV=production.');
  if (process.env.IEFEKT_ALLOW_RESTORE_SMOKE !== '1') {
    throw new Error('Set IEFEKT_ALLOW_RESTORE_SMOKE=1 only in a disposable CI/test/staging environment to enable restore smoke testing.');
  }
  return {
    host: url.hostname,
    port: url.port || '3306',
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password)
  };
}

function runMaria(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn('mariadb', args, { env, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
    child.once('error', reject);
    child.once('close', code => resolve({ code, stderr }));
  });
}

async function main() {
  // Validate the destination before opening or processing a backup file.
  const db = dbConfig();
  const encryptionKey = key();
  const file = process.argv[2];
  if (!file) throw new Error('Usage: node scripts/restore-backup-smoke.mjs <encrypted-backup-file>');

  const handle = await fs.open(file, 'r');
  const prefix = Buffer.alloc(8192);
  const { bytesRead } = await handle.read(prefix, 0, prefix.length, 0);
  await handle.close();
  const newline = prefix.subarray(0, bytesRead).indexOf(10);
  if (newline < 0) throw new Error('Backup header is missing');
  const header = JSON.parse(prefix.subarray(0, newline).toString('utf8'));
  if (header.format !== 'IEFEKT-ENC-GZIP-V1' || header.algorithm !== 'aes-256-gcm') {
    throw new Error('Unsupported backup format');
  }
  const iv = Buffer.from(header.iv || '', 'base64');
  const authTag = Buffer.from(header.authTag || '', 'base64');
  if (iv.length !== 12 || authTag.length !== 16) throw new Error('Backup encryption header is invalid');

  const decipher = createDecipheriv('aes-256-gcm', encryptionKey, iv);
  decipher.setAuthTag(authTag);
  const target = 'iefekt_restore_smoke_' + Date.now();
  const env = { ...process.env, MYSQL_PWD: db.password };
  const common = ['--host', db.host, '--port', db.port, '--user', db.user];
  const created = await runMaria([...common, '--execute', 'CREATE DATABASE ' + target + ' CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci'], env);
  if (created.code !== 0) throw new Error('Could not create isolated restore database: ' + created.stderr);

  let restoreError;
  let restoreProcess;
  try {
    restoreProcess = spawn('mariadb', [...common, target], { env, stdio: ['pipe', 'ignore', 'pipe'] });
    let restoreErr = '';
    restoreProcess.stderr.on('data', chunk => { restoreErr = (restoreErr + chunk).slice(-4000); });
    await pipe(createReadStream(file, { start: newline + 1 }), decipher, createGunzip(), restoreProcess.stdin);
    const imported = await new Promise((resolve, reject) => {
      restoreProcess.once('error', reject);
      restoreProcess.once('close', resolve);
    });
    if (imported !== 0) throw new Error('Restore import failed: ' + restoreErr);

    const verifySql = "SELECT COUNT(*) FROM " + target + ".BackupSmokeCheck WHERE id=1 AND marker='restore-ok'";
    const verify = spawn('mariadb', [...common, '--batch', '--skip-column-names', '--execute', verifySql], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let verifyErr = '';
    verify.stdout.setEncoding('utf8');
    verify.stdout.on('data', chunk => { output += chunk; });
    verify.stderr.on('data', chunk => { verifyErr = (verifyErr + chunk).slice(-2000); });
    const verifyCode = await new Promise((resolve, reject) => {
      verify.once('error', reject);
      verify.once('close', resolve);
    });
    if (verifyCode !== 0 || output.trim() !== '1') throw new Error('Restored data verification failed: ' + verifyErr);
    process.stdout.write('Encrypted backup decrypted, imported, and verified in isolated database ' + target + '.\n');
  } catch (error) {
    restoreError = error;
    if (restoreProcess && restoreProcess.exitCode === null) {
      restoreProcess.stdin.destroy();
      await new Promise(resolve => restoreProcess.once('close', resolve));
    }
  }

  // Never silently ignore failed cleanup: a leftover restore database is a safety failure.
  const dropped = await runMaria([...common, '--execute', 'DROP DATABASE ' + target], env);
  if (dropped.code !== 0) {
    const cleanupMessage = 'CRITICAL: could not remove temporary restore database ' + target + ': ' + dropped.stderr;
    if (restoreError) throw new Error((restoreError instanceof Error ? restoreError.message : String(restoreError)) + '; ' + cleanupMessage);
    throw new Error(cleanupMessage);
  }
  if (restoreError) throw restoreError;
  process.stdout.write('Temporary restore database cleanup verified.\n');
}

main().catch(error => {
  process.stderr.write('Restore smoke test failed: ' + (error instanceof Error ? error.message : 'unknown error') + '\n');
  process.exitCode = 1;
});
