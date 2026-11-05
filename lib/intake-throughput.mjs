// 01 material intake throughput: one bounded budget per project, shared in-flight document
// work, and extracted-image reservations so concurrent page workers keep the 1-6 ceiling
// without racing each other or duplicating local extraction of the same document.
import {concurrencyLimit} from './concurrency.mjs';

const abortError=()=>Object.assign(Error('任务已取消'),{name:'AbortError'});
const fallbackLimit=()=>concurrencyLimit();
// A raised project limit must fill while old requests are still running. Waiters only poll
// on a short timer, so a blocked budget is re-checked even without a release or new run.
export const intakeWakeIntervalMs=100;

// FIFO semaphore whose ceiling follows the project's 1-6 execution setting while tasks run.
export function createIntakeBudget(limitOf=fallbackLimit){
  const limit=()=>{try{return concurrencyLimit(typeof limitOf==='function'?limitOf():limitOf);}catch{return fallbackLimit();}};
  let active=0,timer=null;const waiting=[];
  const snapshot=()=>({active,queued:waiting.length,limit:limit()});
  function schedule(){
    if(timer)return;
    timer=setTimeout(()=>{timer=null;drain();},intakeWakeIntervalMs);
    timer.unref?.();
  }
  function drain(){
    while(waiting.length&&active<limit()){
      const job=waiting.shift();job.signal?.removeEventListener('abort',job.abort);
      if(job.signal?.aborted){job.reject(abortError());continue;}
      active++;job.grant();
    }
    if(waiting.length)schedule();else if(timer){clearTimeout(timer);timer=null;}
  }
  return {
    snapshot,limit,
    // Explicit wake is optional; the timer above already fills a raised limit.
    wake:drain,
    run(task,signal){
      if(signal?.aborted)return Promise.reject(abortError());
      const slot=new Promise((grant,reject)=>{
        const job={signal,grant,reject,abort(){const i=waiting.indexOf(job);if(i>=0)waiting.splice(i,1);reject(abortError());}};
        signal?.addEventListener('abort',job.abort,{once:true});waiting.push(job);drain();
      });
      // The granted slot is released in finally, including a cancellation that lands between
      // the grant and this continuation microtask (the task itself must not start then).
      return slot.then(async()=>{
        try{
          if(signal?.aborted)throw abortError();
          return await task();
        }finally{active=Math.max(0,active-1);drain();}
      });
    }
  };
}

// Budgets are keyed by the live project object, not by id: deleting a project removes the
// only strong reference, while every entry point holding the same p shares the same budget.
const sharedKey={};
let budgets=new WeakMap();
const budgetKey=p=>p!==null&&typeof p==='object'?p:sharedKey;
export function projectIntakeBudget(p){
  const key=budgetKey(p);
  let budget=budgets.get(key);
  if(!budget){budget=createIntakeBudget(()=>p?.executionConcurrency);budgets.set(key,budget);}
  return budget;
}

// Only one in-flight pass per project/material/fingerprint. Later callers wait for it and
// reuse its persisted page records instead of starting a second extraction of the same document.
const documents=new Map();
export function intakeDocumentKey(p,m,stamp){return [String(p?.id||'project'),String(m?.id||''),String(stamp||'')].join('\u0000');}
function settleWithSignal(promise,signal){
  if(!signal)return promise;
  if(signal.aborted)return Promise.reject(abortError());
  return new Promise((resolve,reject)=>{
    const abort=()=>{cleanup();reject(abortError());};
    const cleanup=()=>signal.removeEventListener('abort',abort);
    signal.addEventListener('abort',abort,{once:true});
    promise.then(()=>{cleanup();resolve();},()=>{cleanup();resolve();});
  });
}
export async function shareDocumentIntake(key,task,signal){
  const existing=documents.get(key);
  if(existing){await settleWithSignal(existing,signal);return false;}
  let release;const promise=new Promise(resolve=>{release=resolve;});
  documents.set(key,promise);
  try{await task();return true;}
  finally{if(documents.get(key)===promise)documents.delete(key);release();}
}

// Reserve slots under materialLimits.extractedImages so parallel page workers cannot overshoot.
// The per-project reservation record is dropped at zero so it cannot retain a deleted project.
const reservations=new Map();
export function reserveExtractedImage(p,limit){
  const id=String(p?.id||'project');
  let state=reservations.get(id);
  if(!state){state={reserved:0};reservations.set(id,state);}
  if((p?.materials||[]).filter(item=>item.extracted).length+state.reserved>=limit)return null;
  state.reserved++;let released=false;
  return ()=>{
    if(released)return;released=true;
    state.reserved=Math.max(0,state.reserved-1);
    if(!state.reserved&&reservations.get(id)===state)reservations.delete(id);
  };
}

export function intakeThroughputSnapshot(p){
  const id=String(p?.id||'project'),budget=budgets.get(budgetKey(p));
  return {budget:budget?budget.snapshot():{active:0,queued:0,limit:limitOfProject(p)},inFlightDocuments:[...documents.keys()].filter(key=>key.startsWith(id+'\u0000')).length,reservedImages:reservations.get(id)?.reserved||0};
}
function limitOfProject(p){try{return concurrencyLimit(p?.executionConcurrency);}catch{return concurrencyLimit();}}
// Tests own long-lived objects; the registry is process-wide like the resource scheduler.
export function resetIntakeThroughput(){budgets=new WeakMap();documents.clear();reservations.clear();}
