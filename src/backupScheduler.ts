import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import type { Redis } from 'ioredis';

const RELEASE_LOCK = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

export function startBackupScheduler(redis: Redis, log: { info: (...args: any[]) => void; error: (...args: any[]) => void }) {
  const check = async () => {
    const now = new Date();
    if (now.getUTCHours() < 3) return;
    if (!process.env.BACKUP_ENCRYPTION_KEY || !process.env.DROPBOX_APP_KEY || !process.env.DROPBOX_APP_SECRET || !process.env.DROPBOX_TOKEN_ENCRYPTION_KEY) return;

    const day = now.toISOString().slice(0, 10);
    const doneKey = 'iefekt:backup:daily:success:' + day;
    const lockKey = 'iefekt:backup:daily:lock:' + day;
    const lockToken = randomBytes(16).toString('hex');
    let lockAcquired = false;
    try {
      // A success marker survives app restarts. The short-lived lease recovers automatically
      // if the process is killed before it can release the lock.
      if (await redis.get(doneKey)) return;
      const acquired = await redis.set(lockKey, lockToken, 'EX', 7200, 'NX');
      if (acquired !== 'OK') return;
      lockAcquired = true;

      const script = path.resolve(process.cwd(), 'scripts/backup-mysql.mjs');
      const child = spawn(process.execPath, [script], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = '';
      let settled = false;
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
      child.stdout.on('data', chunk => log.info({ output: String(chunk).slice(0, 1000) }, 'Production backup output'));

      const finish = async (code: number | null, error?: Error) => {
        if (settled) return;
        settled = true;
        try {
          if (code === 0 && !error) {
            await redis.set(doneKey, 'success', 'EX', 172800);
            log.info({ day }, 'Scheduled production backup completed');
          } else {
            log.error({ code, stderr, error }, 'Scheduled production backup failed; it may retry after the lock lease expires');
          }
        } catch (stateError) {
          log.error({ error: stateError, day }, 'Could not record scheduled backup result');
        } finally {
          try { await redis.eval(RELEASE_LOCK, 1, lockKey, lockToken); }
          catch (releaseError) { log.error({ error: releaseError, day }, 'Could not release scheduled backup lock'); }
        }
      };
      child.once('error', error => { void finish(null, error); });
      child.once('close', code => { void finish(code); });
      lockAcquired = false; // child lifecycle now owns the lease release
    } catch (error) {
      log.error({ error }, 'Scheduled backup check failed');
    } finally {
      if (lockAcquired) {
        try { await redis.eval(RELEASE_LOCK, 1, lockKey, lockToken); }
        catch (error) { log.error({ error, day }, 'Could not release scheduled backup lock after startup failure'); }
      }
    }
  };

  void check();
  const timer = setInterval(() => { void check(); }, 60_000);
  return () => clearInterval(timer);
}
