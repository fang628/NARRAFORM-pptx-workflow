import crypto from 'node:crypto';
import {reportTask,withTaskScope} from './task-progress.mjs';
export const defaultConcurrency=3;
export function concurrencyLimit(value=defaultConcurrency){
  const n=Number(value);if(!Number.isInteger(n)||n<1||n>6)throw Error('并发上限须为 1–6');return n;
}
// Workers settle before the batch releases its project lock, even after failure/cancellation.
export async function runConcurrent(items,worker,{signal,limit=defaultConcurrency,label=(_,i)=>'任务 '+(i+1),settle=false}={}){
  limit=concurrencyLimit(limit);const results=new Array(items.length),batch=crypto.randomUUID();let next=0;
  const jobs=items.map((item,i)=>({id:batch+'-'+i,message:String(label(item,i))}));
  const emit=(job,status,extra={})=>reportTask(signal,{...job,kind:'job',status,limit,...extra});
  jobs.forEach(j=>emit(j,'queued'));
  await Promise.all(Array.from({length:Math.min(limit,items.length)},async()=>{
    while(next<items.length){
      const i=next++,job=jobs[i];if(signal?.aborted){results[i]={status:'rejected',reason:Error('任务已取消')};emit(job,'cancelled');continue;}
      const start=Date.now();emit(job,'running');
      try{
        const value=await withTaskScope(job.id,()=>worker(items[i],i));
        if(signal?.aborted)throw Error('任务已取消');results[i]={status:'fulfilled',value};emit(job,'done',{durationMs:Date.now()-start});
      }catch(reason){results[i]={status:'rejected',reason};emit(job,signal?.aborted?'cancelled':'failed',{durationMs:Date.now()-start});reportTask(signal,{jobId:job.id,kind:'step',status:signal?.aborted?'cancelled':'failed',message:reason.message});}
    }
  }));
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
