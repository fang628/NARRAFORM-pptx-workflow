import {runTaskGraph} from './task-graph.mjs';
import {workerConcurrencyLimit,projectWorkerLimit} from './concurrency.mjs';

// 03/04/05 visual work mixes model requests with local image processing in one
// worker: plan text -> check prompt -> generate picture -> composite/cut locally.
// A worker waiting on local work holds its batch slot while the project's request
// budget stays unused. The helpers below only bound how many ready workers may
// exist; the resource scheduler is still the only hard cap on concurrent API
// requests, on PowerPoint rendering and on local processes.
export const visualJobOverSubscription=2;
const abortError=()=>Object.assign(Error('任务已取消'),{name:'AbortError'});
const clampProject=value=>Math.max(1,Math.min(6,Math.floor(Number(value)||1)));
const clampCount=value=>Math.max(1,Math.min(6,Math.floor(Number(value)||1)));

// Pages already run at the project cap. Independent elements inside one page may
// overlap, but the extra ready work is shared across the pages that run together:
// a one-page retry can use the whole budget, many pages stay near the cap, and no
// page multiplies local CPU work without a scheduler slot to consume it.
export function assetWorkerLimit(projectLimit,pages=1){
  const project=clampProject(projectLimit),pageWorkers=Math.max(1,Math.min(project,Math.floor(Number(pages)||project)));
  return clampCount(Math.max(project>=2?2:1,Math.ceil(project/pageWorkers)));
}

// 03 theme assets are independent jobs that each mix a text prompt check with an
// image request and a local normalize. Keep twice the project worker window of ready
// workers so a text check can occupy a project slot while the separately capped
// image pool runs its own requests. Auto mode (no fixed project quota) uses the whole
// 12-worker service window instead of collapsing to one worker; the scheduler still
// enforces account/global request ceilings. Progress reports the project setting.
export function visualJobLimit(projectLimit){const project=projectWorkerLimit(projectLimit);return Math.min(12,Math.max(2,project*visualJobOverSubscription));}

// The render pool feeds at most two SVG worker threads; feed it fully without
// growing it, and never touch the serial PowerPoint channel.
export function svgRenderLimit(){return 2;}

// Failed elements must be visible in audit order without waiting for the whole
// page: record(index, outcome) flushes every contiguous settled prefix. An earlier
// element still in flight holds later records back so order and issue text stay
// identical to the serial loop.
export function createOrderedFailureFlush(size,flush){
  const outcomes=new Array(size);let next=0;
  return {
    record(index,outcome){
      outcomes[index]=outcome||false;
      while(next<size&&outcomes[next]!==undefined){const value=outcomes[next++];if(value?.issues?.length)flush(value);}
    },
    get pending(){return next<size;}
  };
}

// Bounded map whose settled outcomes keep the input order, so callers can rebuild
// issues, failed-element records and element order exactly as a serial loop did.
// `limit` may be a function and is re-read on every drain, so raising the project
// concurrency during a batch starts the waiting elements; the scheduler remains the
// hard API cap. Cancellation may arrive before a worker reaches its microtask: the
// worker is then never executed, and already started work is awaited so no write
// lands after the caller continues.
export async function runBoundedTasks(items,worker,{limit=2,signal,onSettled}={}){
  const list=Array.from(items||[]),results=new Array(list.length);
  if(!list.length)return results;
  const currentLimit=()=>Math.min(list.length,workerConcurrencyLimit(typeof limit==='function'?limit():limit));
  let next=0,active=0,timer;
  await new Promise(resolve=>{
    function drain(){
      clearTimeout(timer);timer=null;
      if(signal?.aborted)for(let index=next;index<list.length;index++)if(results[index]===undefined)results[index]={status:'cancelled',reason:abortError()};
      if(signal?.aborted)next=list.length;
      while(next<list.length&&active<currentLimit()){
        const index=next++;
        if(signal?.aborted){results[index]={status:'cancelled',reason:abortError()};continue;}
        active++;
        Promise.resolve().then(()=>{if(signal?.aborted)throw abortError();return worker(list[index],index);}).then(
          value=>{
            const outcome={status:'fulfilled',value};results[index]=outcome;
            if(onSettled)try{onSettled(outcome,index);}catch(error){results[index]={status:'rejected',reason:error};}
          },
          reason=>{
            if(signal?.aborted){results[index]={status:'cancelled',reason:abortError()};return;}
            const outcome={status:'rejected',reason:reason||abortError()};results[index]=outcome;
            if(onSettled)try{onSettled(outcome,index);}catch(error){results[index]={status:'rejected',reason:error};}
          }
        ).finally(()=>{active--;drain();});
      }
      if(!active&&next>=list.length)resolve();
      else if(typeof limit==='function'&&next<list.length)timer=setTimeout(drain,100);
    }
    drain();
  });
  return results;
}

// Runs independent preparations together (for example the progress-bar and footer
// reference requests, which touch different project fields). A task that has not
// reached its microtask when cancellation arrives never starts. Every task settles
// before the first failure is rethrown, so cancellation never leaves a task writing
// after the caller continues.
export async function runSettled(tasks,{signal}={}){
  const pending=(tasks||[]).map(task=>Promise.resolve().then(()=>{if(signal?.aborted)throw abortError();return task();})),settled=await Promise.allSettled(pending);
  if(signal?.aborted)throw abortError();
  const failed=settled.find(entry=>entry.status==='rejected');
  if(failed)throw failed.reason;
  return settled.map(entry=>entry.value);
}

// Over-subscribed ready-work graph for independent visual jobs. One job record per
// item keeps the existing progress and cancellation shape, while `reportLimit`
// keeps the displayed concurrency at the project limit instead of the internal
// ready-worker count.
export async function runVisualJobs(items,worker,{signal,limit=1,reportLimit=limit,label=(_,index)=>'任务 '+(index+1)}={}){
  const list=Array.from(items||[]);
  if(!list.length)return [];
  const nodes=list.map((item,index)=>({id:'visual-job-'+index,label:label(item,index),priority:0,run:()=>worker(item,index)}));
  const results=await runTaskGraph(nodes,{signal,limit,reportLimit});
  const byId=new Map(results.map(result=>[result.id,result]));
  return list.map((_,index)=>{
    const result=byId.get('visual-job-'+index);
    return result?.status==='fulfilled'?{status:'fulfilled',value:result.value}:{status:'rejected',reason:result?.reason||abortError()};
  });
}
