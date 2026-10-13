import crypto from 'node:crypto';
import {AsyncLocalStorage} from 'node:async_hooks';
// Task-scoped, public execution records. Never collect prompts or private reasoning.
const listeners=new WeakMap();
const scopes=new AsyncLocalStorage();
export const withTaskScope=(jobId,fn)=>scopes.run({jobId},fn);
export function observeTask(signal,listener){listeners.set(signal,listener);return ()=>listeners.delete(signal);}
export function reportTask(signal,entry){listeners.get(signal)?.({...scopes.getStore(),...entry});}
export function recordProgress(task,entry){
  const safe={id:entry.id||crypto.randomUUID(),at:new Date().toISOString(),kind:String(entry.kind||'step').slice(0,30),status:String(entry.status||'done').slice(0,30),message:String(entry.message||'').slice(0,600)};
  if(entry.jobId)safe.jobId=String(entry.jobId).slice(0,100);
  if(Number.isInteger(entry.limit))safe.limit=entry.limit;
  if(Number.isFinite(entry.durationMs))safe.durationMs=Math.max(0,entry.durationMs);
  const entries=task.progress||[],index=entries.findIndex(item=>item.id===safe.id);
  if(index>=0){safe.at=entries[index].at;entries[index]=safe;}else entries.push(safe);
  task.progress=entries.slice(-100);
  if(safe.kind==='job'){
    const jobs=task.jobs||[],index=jobs.findIndex(j=>j.id===safe.id);
    if(index>=0)jobs[index]={...jobs[index],...safe};else jobs.push(safe);
    task.jobs=jobs.slice(-180);task.concurrency=safe.limit||task.concurrency;
  }else if(safe.jobId){
    const job=task.jobs?.find(j=>j.id===safe.jobId);if(job){
      const logs=job.entries||[],index=logs.findIndex(e=>e.id===safe.id);
      if(index>=0)logs[index]=safe;else logs.push(safe);job.entries=logs.slice(-12);
    }
  }
  return safe;
}
