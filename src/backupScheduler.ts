import { spawn } from 'node:child_process';
import path from 'node:path';
import type { Redis } from 'ioredis';

export function startBackupScheduler(redis: Redis, log: { info: (obj: unknown, msg?: string) => void; error: (obj: unknown, msg?: string) => void }) {
  const check = async () => {
    const now = new Date();
    if (now.getUTCHours() < 3) return;
    const day = now.toISOString().slice(0, 10);
    const lockKey = 'iefekt:backup:daily:' + day;
    try {
      const acquired = await redis.set(lockKey, 'running', 'EX', 86400, 'NX');
      if (acquired !== 'OK') return;
      const script = path.resolve(process.cwd(), 'scripts/backup-mysql.mjs');
      const child = spawn(process.execPath, [script], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = '';
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
      child.stdout.on('data', chunk => log.info({ output: String(chunk).slice(0, 1000) }, 'Production backup output'));
      child.once('error', async error => {
        await redis.set(lockKey, 'failed', 'EX', 3600);
        log.error({ error }, 'Scheduled production backup could not start');
      });
      child.once('close', async code => {
        if (code === 0) await redis.set(lockKey, 'success', 'EX', 172800);
        else {
          await redis.set(lockKey, 'failed', 'EX', 3600);
          log.error({ code, stderr }, 'Scheduled production backup failed');
        }
      });
    } catch (error) { log.error({ error }, 'Scheduled backup check failed'); }
  };
  void check();
  const timer = setInterval(() => { void check(); }, 60_000);
  return () => clearInterval(timer);
}
