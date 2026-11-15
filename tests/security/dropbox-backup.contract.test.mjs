import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [server, backup, scheduler, restore, schema, migration] = await Promise.all([
  readFile(new URL('../../src/server.ts', import.meta.url), 'utf8'),
  readFile(new URL('../../scripts/backup-mysql.mjs', import.meta.url), 'utf8'),
  readFile(new URL('../../src/backupScheduler.ts', import.meta.url), 'utf8'),
  readFile(new URL('../../scripts/restore-backup-smoke.mjs', import.meta.url), 'utf8'),
  readFile(new URL('../../prisma/schema.prisma', import.meta.url), 'utf8'),
  readFile(new URL('../../prisma/migrations/20261115000000_add_dropbox_credential/migration.sql', import.meta.url), 'utf8')
]);

test('Dropbox OAuth is offline, state-checked, admin-gated, and least-privilege', () => {
  assert.match(server, /DROPBOX_BACKUP_ADMIN_USER_ID/);
  assert.match(server, /token_access_type', 'offline'/);
  assert.match(server, /split\(\/\\s\+\/\)/);
  assert.match(server, /dropboxStateCookie/);
  assert.match(server, /maxAge: 600/);
  assert.match(server, /logLevel: 'silent'/);
  assert.match(server, /files\.content\.write.*files\.content\.read.*files\.metadata\.read.*account_info\.read/);
  assert.match(server, /createCipheriv\('aes-256-gcm'/);
});

test('Dropbox uploader is encrypted and confined to the production backup folder', () => {
  assert.match(backup, /BACKUP_ROOT = '\/I-EFEKT\/Production-Backups\/MySQL'/);
  assert.match(backup, /BACKUP_ENCRYPTION_KEY/);
  assert.match(backup, /createCipheriv\('aes-256-gcm'/);
  assert.match(backup, /upload_session\/start/);
  assert.match(backup, /upload_session\/append_v2/);
  assert.match(backup, /upload_session\/finish/);
  assert.match(backup, /metadata\.path_display !== remotePath/);
  assert.doesNotMatch(backup, /process\.argv\[[0-9]+\].*path/i);
});

test('daily scheduler uses a Redis atomic lock and waits for backup secrets', () => {
  assert.match(scheduler, /now\.getUTCHours\(\) < 3/);
  assert.match(scheduler, /redis\.set\(lockKey, lockToken, 'EX', 7200, 'NX'\)/);
  assert.match(scheduler, /iefekt:backup:daily:success:/);
  assert.match(scheduler, /redis\.eval\(RELEASE_LOCK, 1, lockKey, lockToken\)/);
  assert.match(scheduler, /child\.once\('close'/);
  assert.match(scheduler, /BACKUP_ENCRYPTION_KEY/);
});

test('restore smoke test uses a separate disposable database and removes it', () => {
  assert.match(restore, /iefekt_restore_smoke_/);
  assert.match(restore, /SAFE_DATABASE_NAME/);
  assert.match(restore, /NODE_ENV === 'production'/);
  assert.match(restore, /IEFEKT_ALLOW_RESTORE_SMOKE !== '1'/);
  assert.match(restore, /DROP DATABASE /);
  assert.match(restore, /could not remove temporary restore database/);
  assert.match(restore, /BackupSmokeCheck/);
});

test('encrypted Dropbox credential model and SQL migration agree', () => {
  for (const field of ['encryptedRefreshToken', 'iv', 'authTag', 'accountId', 'connectedAt', 'updatedAt']) {
    assert.match(schema, new RegExp('\\b' + field + '\\b'));
    assert.match(migration, new RegExp('`' + field + '`'));
  }
});
