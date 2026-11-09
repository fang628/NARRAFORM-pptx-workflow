import crypto from 'node:crypto';
import {reportTask,withTaskScope} from './task-progress.mjs';
// Project execution setting defaults to auto: no fixed per-project quota, so a lone
// project may borrow idle account/global request capacity. A manual 1-6 value still
// acts as that project's hard request cap.
export const defaultConcurrency=null;
// Service-wide ready-worker window. Auto mode may prepare this many stage workers, which
// is only a local in-flight bound: real API requests are still capped by the scheduler
// account (6) and global (12) ceilings, PowerPoint rendering stays serial and local
// processes keep their own executor limits.
export const maxWorkerConcurrency=12;
// Project configuration parser: null/undefined/'auto' mean auto, 1-6 (numeric strings
// included) mean a manual project cap; 0/false/empty/7/fractions/invalid are rejected.
// Only a real number or string is coerced: arrays/objects/booleans must not slip through,
// because Number([2]) and Number(new Number(2)) both look like 2.
export function concurrencyLimit(value=defaultConcurrency){
  if(value===null||value===undefined)return null;
  if(typeof value==='number'){
    if(!Number.isInteger(value)||value<1||value>6)throw Error('并发上限须为 1–6 或留空自动');
    return value;
  }
  if(typeof value==='string'){
    const text=value.trim();
    if(text.toLowerCase()==='auto')return null;
    const n=Number(text);
    if(!text||!Number.isInteger(n)||n<1||n>6)throw Error('并发上限须为 1–6 或留空自动');
    return n;
  }
  throw Error('并发上限须为 1–6 或留空自动');
}
// Stage preparation worker count for one project: its manual cap, or the whole service
// window in auto mode. This is a worker window, not a request quota.
export function projectWorkerLimit(value){return concurrencyLimit(value)??maxWorkerConcurrency;}
// In-flight worker window accepted by runConcurrent/runTaskGraph: 1-12, auto takes the
// service window. Run loops must not reject the 12 returned by projectWorkerLimit.
// It accepts the same value domains as concurrencyLimit (no array/object coercion).
export function workerConcurrencyLimit(value=maxWorkerConcurrency){
  if(value===null||value===undefined)return maxWorkerConcurrency;
  if(typeof value==='number'){
    if(!Number.isInteger(value)||value<1||value>maxWorkerConcurrency)throw Error('并发窗口须为 1–12');
    return value;
  }
  if(typeof value==='string'){
    const text=value.trim();
    if(text.toLowerCase()==='auto')return maxWorkerConcurrency;
    const n=Number(text);
    if(!text||!Number.isInteger(n)||n<1||n>maxWorkerConcurrency)throw Error('并发窗口须为 1–12');
    return n;
  }
  throw Error('并发窗口须为 1–12');
}
// Workers settle before the batch releases its project lock, even after failure/cancellation.
export async function runConcurrent(items,worker,{signal,limit=defaultConcurrency,label=(_,i)=>'任务 '+(i+1),settle=false}={}){
  const currentLimit=()=>workerConcurrencyLimit(typeof limit==='function'?limit():limit);
  currentLimit();const results=new Array(items.length),batch=crypto.randomUUID();let next=0;
  const jobs=items.map((item,i)=>({id:batch+'-'+i,message:String(label(item,i))}));
  const emit=(job,status,extra={})=>reportTask(signal,{...job,kind:'job',status,limit:currentLimit(),...extra});
  jobs.forEach(j=>emit(j,'queued'));
  await new Promise(resolve=>{
    let active=0,timer;
    function drain(){
      clearTimeout(timer);
      while(next<items.length&&active<currentLimit()){
        const i=next++,job=jobs[i];if(signal?.aborted){results[i]={status:'rejected',reason:Error('任务已取消')};emit(job,'cancelled');continue;}
        const start=Date.now();active++;emit(job,'running');
        Promise.resolve().then(()=>withTaskScope(job.id,()=>{if(signal?.aborted)throw Error('任务已取消');return worker(items[i],i);})).then(value=>{
          if(signal?.aborted)throw Error('任务已取消');results[i]={status:'fulfilled',value};emit(job,'done',{durationMs:Date.now()-start});
        }).catch(reason=>{results[i]={status:'rejected',reason};emit(job,signal?.aborted?'cancelled':'failed',{durationMs:Date.now()-start});reportTask(signal,{jobId:job.id,kind:'step',status:signal?.aborted?'cancelled':'failed',message:reason.message});}).finally(()=>{active--;drain();});
      }
      if(!active&&next>=items.length){resolve();return;}
      if(typeof limit==='function'&&next<items.length)timer=setTimeout(drain,100);
    }
    drain();
  });
  if(signal?.aborted)throw Error('任务已取消');
  const failures=results.flatMap((r,i)=>r.status==='rejected'?[jobs[i].message+'：'+r.reason.message]:[]);
  if(failures.length&&!settle)throw Error(`${failures.length} 个子任务失败；${failures.slice(0,3).join('；')}`);
  return settle?results:results.map(r=>r.value);
}
// Server-wide API ceiling also applies when several projects run at once.
export function createRequestGate(limit){
  let active=0;const queue=[];
  function drain(){while(active<limit&&queue.length){const job=queue.shift();job.signal?.removeEventListener('abort',job.abort);if(job.signal?.aborted){job.reject(Error('任务已取消'));continue;}active++;let freed=false;job.resolve(()=>{if(freed)return;freed=true;active--;drain();});}}
  return signal=>new Promise((resolve,reject)=>{
    if(signal?.aborted){reject(Error('任务已取消'));return;}
    const job={signal,resolve,reject,abort:()=>{const i=queue.indexOf(job);if(i>=0)queue.splice(i,1);reject(Error('任务已取消'));}};
    signal?.addEventListener('abort',job.abort,{once:true});queue.push(job);drain();
  });
}
