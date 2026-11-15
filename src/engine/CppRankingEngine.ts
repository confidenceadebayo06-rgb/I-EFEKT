import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
export type RankingFeatures = { affinity:number; freshness:number; engagement:number; completion:number; negative:number };
export class CppRankingEngine {
 private child:ChildProcessWithoutNullStreams|null=null;
 private pending=new Map<string,{resolve:(value:number[])=>void;reject:(error:Error)=>void}>();
 private sequence=0; private ready=false; private lastError:string|null=null;
 constructor(){
  const here=path.dirname(fileURLToPath(import.meta.url));
  const binaryName=process.platform==='win32'?'iefekt-engine.exe':'iefekt-engine';
  const candidates=[path.resolve(here,'../../build',binaryName),path.resolve(here,'../build',binaryName)];
  const executable=process.env.IEFEKT_ENGINE_PATH||candidates.find(existsSync);
  if(!executable||!existsSync(executable)){this.lastError='C++ engine binary not found. Run npm run engine:build.';return;}
  try{
   this.child=spawn(executable,[],{stdio:['pipe','pipe','pipe']});this.ready=true;
   const lines=createInterface({input:this.child.stdout});lines.on('line',line=>this.handleLine(line));
   this.child.stderr.on('data',(chunk:Buffer)=>{this.lastError=chunk.toString().slice(0,500);});
   this.child.on('error',error=>{this.ready=false;this.lastError=error.message;this.rejectAll(error);});
   this.child.on('exit',code=>{const message=`C++ worker exited (${code??'unknown'}).`;this.ready=false;this.lastError=message;this.rejectAll(new Error(message));});
  }catch(error){this.ready=false;this.lastError=error instanceof Error?error.message:'Unable to start C++ engine.';}
 }
 status(){return {available:this.ready&&!!this.child&&!this.child.killed,engine:'C++20 persistent worker',lastError:this.lastError};}
 rank(features:RankingFeatures[]):Promise<number[]>{
  if(!this.ready||!this.child||this.child.killed)return Promise.reject(new Error(this.lastError||'C++ ranking engine unavailable.'));
  if(features.length>500)return Promise.reject(new Error('The C++ ranking batch is limited to 500 candidates.'));
  const id=String(++this.sequence);
  const tuples=features.map(f=>[f.affinity,f.freshness,f.engagement,f.completion,f.negative].map(v=>Number.isFinite(v)?Math.max(0,Math.min(1,v)).toFixed(6):'0.000000').join(','));
  const line=`${id}\t${tuples.length}${tuples.length?`\t${tuples.join('\t')}`:''}\n`;
  return new Promise((resolve,reject)=>{this.pending.set(id,{resolve,reject});this.child!.stdin.write(line,error=>{if(error){this.pending.delete(id);reject(error);}});});
 }
 close(){this.child?.kill();this.ready=false;}
 private handleLine(line:string){const tab=line.indexOf('\t');if(tab<0)return;const id=line.slice(0,tab);const entry=this.pending.get(id);if(!entry)return;this.pending.delete(id);const result=line.slice(tab+1);if(result.startsWith('ERROR:')){entry.reject(new Error(result));return;}const indexes=result?result.split(',').map(Number):[];if(indexes.some(v=>!Number.isInteger(v)||v<0))entry.reject(new Error('Invalid C++ ranking response.'));else entry.resolve(indexes);}
 private rejectAll(error:Error){for(const entry of this.pending.values())entry.reject(error);this.pending.clear();}
}