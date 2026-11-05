import crypto from 'node:crypto';
import {executionContext,assertCurrentExecution} from './execution-context.mjs';
import {reportTask} from './task-progress.mjs';
const abortError=()=>Object.assign(Error('任务已取消'),{name:'AbortError'});
export function retryAfterMs(value,now=Date.now()){
  if(value==null)return 0;const n=Number(value);return Math.min(300000,Math.max(0,Number.isFinite(n)?n*1000:Date.parse(value)-now)||0);
}
export function createResourceScheduler({globalLimit=12,accountLimit=6,now=Date.now,notify=()=>{}}={}){
  const pools=new Map(),accounts=new Map(),projects=new Map(),queue=[];let active=0,timer,dispatched=0;
  const projectLimit=c=>Math.max(1,Math.min(6,Number(typeof c.limit==='function'?c.limit():c.limit)||3));
  const projectState=id=>{let state=projects.get(id);if(!state)projects.set(id,state={active:0,served:0});return state;};
  function state(config,kind){
    let origin;try{origin=new URL(config?.baseURL).origin;}catch{origin=String(config?.baseURL||'');}
    const account=crypto.createHash('sha256').update(JSON.stringify([origin,config?.key])).digest('hex');
    const key=crypto.createHash('sha256').update(JSON.stringify([account,kind,config?.model])).digest('hex').slice(0,16);
    if(!accounts.has(account))accounts.set(account,{active:0,cooldown:0});
    // The pool starts at the account ceiling so the first requests can use the whole
    // configured project allowance (1–6). The project cap stays authoritative per request,
    // and adaptive shrinking below still reduces real concurrency.
    if(!pools.has(key))pools.set(key,{id:key,kind,limit:accountLimit,active:0,successes:0,baseline:0,ema:0,completed:0,failed:0,account});
    return pools.get(key);
  }
  const snapshot=()=>({active,queued:queue.length,pools:[...pools.values()].map(({account,...p})=>({...p,cooldownMs:Math.max(0,accounts.get(account).cooldown-now())}))});
  const publish=()=>notify(snapshot());
  // Explicit priority wins (interactive work first). Within one priority level the
  // project served least recently goes first, so one busy project cannot consume every
  // slot while another project's first request waits indefinitely.
  function order(a,b){
    if(a.priority!==b.priority)return b.priority-a.priority;
    const sa=projects.get(a.project)?.served||0,sb=projects.get(b.project)?.served||0;
    if(sa!==sb)return sa-sb;
    return a.queuedAt-b.queuedAt;
  }
  function dispatch(job){
    const account=accounts.get(job.pool.account),project=projectState(job.project),started=now();
    active++;account.active++;job.pool.active++;project.active++;project.served=++dispatched;
    let released=false;
    job.resolve(error=>{
      if(released)return;released=true;active--;account.active--;job.pool.active--;project.active=Math.max(0,project.active-1);
      const pool=job.pool,elapsed=Math.max(1,now()-started);
      // Adapt against the allowance this request actually observed: a project cap below
      // the pool ceiling must still shrink, otherwise 429/timeout feedback never lowers
      // real concurrency for the common default project limit.
      const observed=Math.max(1,Math.min(pool.limit,projectLimit(job.context)));
      if(error){
        pool.failed++;pool.successes=0;
        if(error.httpStatus===429){pool.limit=Math.max(1,Math.floor(observed/2));account.cooldown=Math.max(account.cooldown,now()+Math.max(1000,error.retryAfterMs||2000));}
        else if(['API_TIMEOUT','API_CONNECTION_TERMINATED'].includes(error.code)||error.name==='TimeoutError')pool.limit=Math.max(1,observed-1);
      }else{
        pool.completed++;pool.ema=pool.ema?pool.ema*.8+elapsed*.2:elapsed;pool.baseline=pool.baseline?Math.min(pool.baseline*1.02,pool.ema):pool.ema;
        if(pool.ema>pool.baseline*1.8){pool.limit=Math.max(1,observed-1);pool.successes=0;}
        else if(++pool.successes>=4){pool.limit=Math.min(accountLimit,pool.limit+1);pool.successes=0;}
      }
      publish();drain();
    });
  }
  function drain(){
    clearTimeout(timer);let soon=Infinity;
    // Cancelled or stale requests never leave the queue, and never hold an abort listener.
    for(let i=0;i<queue.length;){
      const job=queue[i];
      if(job.signal?.aborted){queue.splice(i,1);job.signal.removeEventListener('abort',job.abort);job.reject(abortError());continue;}
      if(job.context.isCurrent?.()===false){queue.splice(i,1);job.signal?.removeEventListener('abort',job.abort);job.reject(Object.assign(Error('任务输入版本已变化，取消未发送请求'),{code:'STALE_TASK'}));continue;}
      i++;
    }
    while(active<globalLimit&&queue.length){
      const current=now();let best=null;
      for(const job of queue){
        const account=accounts.get(job.pool.account);
        if(account.cooldown>current){soon=Math.min(soon,account.cooldown-current);continue;}
        const limit=projectLimit(job.context),project=projectState(job.project);
        if(job.pool.active>=Math.min(job.pool.limit,limit)||account.active>=accountLimit||project.active>=limit)continue;
        if(!best||order(job,best)<0)best=job;
      }
      if(!best)break;
      queue.splice(queue.indexOf(best),1);
      best.signal?.removeEventListener('abort',best.abort);
      dispatch(best);
    }
    if(Number.isFinite(soon)){timer=setTimeout(drain,Math.max(1,soon));}
    publish();
  }
  function acquire(config,kind,signal,context=executionContext()){
    const pool=state(config,kind),project=context.projectId||'standalone';
    projectState(project);
    return new Promise((resolve,reject)=>{
      if(signal?.aborted){reject(abortError());return;}
      const job={pool,project,context,signal,resolve,reject,priority:Number(context.priority)||0,queuedAt:now(),abort:null};
      job.abort=()=>{const index=queue.indexOf(job);if(index>=0)queue.splice(index,1);reject(abortError());drain();};
      signal?.addEventListener('abort',job.abort,{once:true});queue.push(job);drain();
    });
  }
  return {acquire,snapshot,wake:drain,close(){clearTimeout(timer);for(const job of queue.splice(0)){job.signal?.removeEventListener('abort',job.abort);job.reject(abortError());}}};
}

// Only in-flight work is shared. Fresh regeneration after completion always runs.
export function createSingleFlight(){
  const flights=new Map();
  return function singleFlight(key,run,signal){
    if(signal?.aborted)return Promise.reject(abortError());
    let flight=flights.get(key);
    if(!flight){flight={controller:new AbortController(),subscribers:0};flights.set(key,flight);flight.promise=Promise.resolve().then(()=>run(flight.controller.signal)).finally(()=>{if(flights.get(key)===flight)flights.delete(key);});flight.promise.catch(()=>{});}
    else reportTask(signal,{kind:'scheduler',status:'shared',message:'已合并相同的在途模型请求，复用本次结果'});
    flight.subscribers++;
    return new Promise((resolve,reject)=>{
      let done=false;
      const finish=(fn,value)=>{if(done)return;done=true;signal?.removeEventListener('abort',cancel);flight.subscribers--;fn(value);};
      const cancel=()=>{finish(reject,abortError());if(!flight.subscribers){if(flights.get(key)===flight)flights.delete(key);flight.controller.abort();}};
      signal?.addEventListener('abort',cancel,{once:true});
      flight.promise.then(value=>{
        // A non-cloneable result must still settle every subscriber instead of hanging it.
        let copy=value;try{copy=structuredClone(value);}catch{}
        finish(resolve,copy);
      },error=>finish(reject,error));
    });
  };
}
export async function requestFingerprint(config,endpoint,body){
  assertCurrentExecution();const h=crypto.createHash('sha256'),context=executionContext();h.update(JSON.stringify([context.projectId,context.revision?.version??context.version,config?.baseURL,config?.key,config?.model,endpoint]));
  if(body instanceof FormData){for(const [key,value]of body){h.update(key);if(typeof value==='string')h.update(value);else{h.update(value.type);h.update(Buffer.from(await value.arrayBuffer()));}}}
  else h.update(JSON.stringify(body));return h.digest('hex');
}
export const requestScheduler=createResourceScheduler();
export const singleFlight=createSingleFlight();
