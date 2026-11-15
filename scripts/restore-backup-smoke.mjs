import { createDecipheriv } from 'node:crypto';
import { createReadStream, createWriteStream, promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import { createGunzip } from 'node:zlib';
import { pipeline } from 'node:stream';
import { promisify } from 'node:util';
const pipe = promisify(pipeline);

function key() { const k = Buffer.from(process.env.BACKUP_ENCRYPTION_KEY || '', 'base64'); if (k.length !== 32) throw new Error('BACKUP_ENCRYPTION_KEY must be a base64-encoded 32-byte key'); return k; }
function dbConfig() { const u = new URL(process.env.DATABASE_URL || ''); if (u.protocol !== 'mysql:') throw new Error('DATABASE_URL must use mysql://'); return { host:u.hostname, port:u.port||'3306', user:decodeURIComponent(u.username), password:decodeURIComponent(u.password) }; }
async function main() {
  const file = process.argv[2]; if (!file) throw new Error('Usage: node scripts/restore-backup-smoke.mjs <encrypted-backup-file>');
  const handle = await fs.open(file, 'r'); const prefix = Buffer.alloc(8192); const { bytesRead } = await handle.read(prefix,0,prefix.length,0); await handle.close();
  const newline = prefix.subarray(0,bytesRead).indexOf(10); if (newline < 0) throw new Error('Backup header is missing');
  const header = JSON.parse(prefix.subarray(0,newline).toString('utf8')); if (header.format !== 'IEFEKT-ENC-GZIP-V1' || header.algorithm !== 'aes-256-gcm') throw new Error('Unsupported backup format');
  const decipher = (await import('node:crypto')).createDecipheriv('aes-256-gcm',key(),Buffer.from(header.iv,'base64')); decipher.setAuthTag(Buffer.from(header.authTag,'base64'));
  const db = dbConfig(); const target = 'iefekt_restore_smoke_' + Date.now();
  const env = { ...process.env, MYSQL_PWD: db.password };
  const create = spawn('mariadb',['--host',db.host,'--port',db.port,'--user',db.user,'--execute', 'CREATE DATABASE \`'+target+'\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci'],{env,stdio:['ignore','ignore','pipe']});
  let err=''; create.stderr.on('data',c=>err+=c); const created=await new Promise((resolve,reject)=>{create.once('error',reject);create.once('close',resolve);}); if(created!==0) throw new Error('Could not create isolated restore database: '+err.slice(0,1000));
  const restore = spawn('mariadb',['--host',db.host,'--port',db.port,'--user',db.user,target],{env,stdio:['pipe','ignore','pipe']});
  let restoreErr=''; restore.stderr.on('data',c=>restoreErr+=c);
  try {
    await pipe(createReadStream(file,{start:newline+1}),decipher,createGunzip(),restore.stdin);
    const code=await new Promise((resolve,reject)=>{restore.once('error',reject);restore.once('close',resolve);});
    if(code!==0) throw new Error('Restore import failed: '+restoreErr.slice(0,1000));
    const verifySql = 'SELECT COUNT(*) FROM `'+target+'`.BackupSmokeCheck WHERE id=1 AND marker=\'restore-ok\'';
    const verify = spawn('mariadb',['--batch','--skip-column-names','--host',db.host,'--port',db.port,'--user',db.user,'--execute',verifySql],{env,stdio:['ignore','pipe','pipe']});
    let verified=''; let verifyErr=''; verify.stdout.setEncoding('utf8'); verify.stdout.on('data',c=>verified+=c); verify.stderr.on('data',c=>verifyErr+=c);
    const verifyCode=await new Promise((resolve,reject)=>{verify.once('error',reject);verify.once('close',resolve);});
    if(verifyCode!==0 || verified.trim()!=='1') throw new Error('Restored data verification failed: '+verifyErr.slice(0,1000));
    process.stdout.write('Encrypted backup decrypted, imported, and verified in isolated database '+target+'.\n');
  } finally {
    await new Promise(resolve=>{const drop=spawn('mariadb',['--host',db.host,'--port',db.port,'--user',db.user,'--execute','DROP DATABASE IF EXISTS \`'+target+'\`'],{env,stdio:'ignore'});drop.once('close',resolve);drop.once('error',resolve);});
  }
}
main().catch(e=>{process.stderr.write('Restore smoke test failed: '+(e instanceof Error?e.message:'unknown error')+'\n');process.exitCode=1;});
