import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const binary=path.join(root,'build',process.platform==='win32'?'iefekt-engine.exe':'iefekt-engine');
if(!existsSync(binary))throw new Error('C++ engine not built. Run npm run engine:build first.');
const child=spawn(binary,[],{stdio:['pipe','pipe','inherit']});let buffer='';let sequence=0;const pending=new Map();
child.stdout.setEncoding('utf8');child.stdout.on('data',chunk=>{buffer+=chunk;let newline;while((newline=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,newline);buffer=buffer.slice(newline+1);const tab=line.indexOf('\t');const id=line.slice(0,tab);const done=pending.get(id);if(done){pending.delete(id);done();}}});
const features=Array.from({length:250},(_,i)=>`${(i%4)/3},${(i%100)/100},${(i%25)/25},0.5,0`).join('\t');
const iterations=1000;const start=process.hrtime.bigint();
for(let i=0;i<iterations;i++){const id=String(++sequence);const result=new Promise(resolve=>pending.set(id,resolve));child.stdin.write(`${id}\t250\t${features}\n`);await result;}
const elapsedMs=Number(process.hrtime.bigint()-start)/1e6;
console.log(JSON.stringify({engine:'C++20',candidatesPerBatch:250,batches:iterations,totalCandidates:250*iterations,elapsedMs:Number(elapsedMs.toFixed(2)),averageMsPerBatch:Number((elapsedMs/iterations).toFixed(4))},null,2));child.kill();