import crypto from 'node:crypto';
import {executionContext,assertCurrentExecution} from './execution-context.mjs';
import {reportTask} from './task-progress.mjs';
const abortError=()=>Object.assign(Error('任务已取消'),{name:'AbortError'});
export function retryAfterMs(value,now=Date.now()){
  if(value==null)return 0;const n=Number(value);return Math.min(300000,Math.max(0,Number.isFinite(n)?n*1000:Date.parse(value)-now)||0);
}
export function createResourceScheduler({globalLimit=12,accountLimit=6,now=Date.now,notify=()=>{}}={}){
  const pools=new Map(),accounts=new Map(),projects=new Map(),queue=[];let active=0,timer;
  const projectLimit=c=>Math.max(1,Math.min(6,Number(typeof c.limit==='function'?c.limit():c.limit)||3));
  function state(config,kind){
    let origin;try{origin=new URL(config?.baseURL).origin;}catch{origin=String(config?.baseURL||'');}
    const account=crypto.createHash('sha256').update(JSON.stringify([origin,config?.key])).digest('hex');
    const key=crypto.createHash('sha256').update(JSON.stringify([account,kind,config?.model])).digest('hex').slice(0,16);
    if(!accounts.has(account))accounts.set(account,{active:0,cooldown:0});
    if(!pools.has(key))pools.set(key,{id:key,kind,limit:kind==='image'?2:3,active:0,successes:0,baseline:0,ema:0,completed:0,failed:0,account});
    return pools.get(key);
  }
  const snapshot=()=>({active,queued:queue.length,pools:[...pools.values()].map(({account,...p})=>({...p,cooldownMs:Math.max(0,accounts.get(account).cooldown-now())}))});
  const publish=()=>notify(snapshot());
  function drain(){
    clearTimeout(timer);let soon=Infinity;
    queue.sort((a,b)=>(b.priority+(now()-b.queuedAt)/30000)-(a.priority+(now()-a.queuedAt)/30000));
    for(let i=0;i<queue.length&&active<globalLimit;){
      const j=queue[i],a=accounts.get(j.pool.account),pActive=projects.get(j.project)||0;
      if(j.signal?.aborted){queue.splice(i,1);j.signal.removeEventListener('abort',j.abort);j.reject(abortError());continue;}
      if(j.context.isCurrent?.()===false){queue.splice(i,1);j.signal?.removeEventListener('abort',j.abort);j.reject(Object.assign(Error('任务输入版本已变化，取消未发送请求'),{code:'STALE_TASK'}));continue;}
      if(a.cooldown>now()){soon=Math.min(soon,a.cooldown-now());i++;continue;}
      if(j.pool.active>=Math.min(j.pool.limit,projectLimit(j.context))||a.active>=accountLimit||pActive>=projectLimit(j.context)){i++;continue;}
      queue.splice(i,1);j.signal?.removeEventListener('abort',j.abort);active++;a.active++;j.pool.active++;projects.set(j.project,pActive+1);
      const started=now();let released=false;
      j.resolve((error)=>{
        if(released)return;released=true;active--;a.active--;j.pool.active--;projects.set(j.project,Math.max(0,(projects.get(j.project)||1)-1));
        const elapsed=Math.max(1,now()-started),pool=j.pool;
        if(error){pool.failed++;pool.successes=0;if(error.httpStatus===429){pool.limit=Math.max(1,Math.floor(pool.limit/2));a.cooldown=Math.max(a.cooldown,now()+Math.max(1000,error.retryAfterMs||2000));}else if(['API_TIMEOUT','API_CONNECTION_TERMINATED'].includes(error.code)||error.name==='TimeoutError')pool.limit=Math.max(1,pool.limit-1);}
        else{
          pool.completed++;pool.ema=pool.ema?pool.ema*.8+elapsed*.2:elapsed;pool.baseline=pool.baseline?Math.min(pool.baseline*1.02,pool.ema):pool.ema;
          if(pool.ema>pool.baseline*1.8){pool.limit=Math.max(1,pool.limit-1);pool.successes=0;}
          else if(++pool.successes>=4){pool.limit=Math.min(accountLimit,pool.limit+1);pool.successes=0;}
        }
        publish();drain();
      });
    }
    if(Number.isFinite(soon)){timer=setTimeout(drain,Math.max(1,soon));}
    publish();
  }
  function acquire(config,kind,signal,context=executionContext()){
    const pool=state(config,kind),project=context.projectId||'standalone';
    return new Promise((resolve,reject)=>{
      if(signal?.aborted){reject(abortError());return;}
      const j={pool,project,context,signal,resolve,reject,priority:Number(context.priority)||0,queuedAt:now(),abort:()=>{const i=queue.indexOf(j);if(i>=0)queue.splice(i,1);reject(abortError());drain();}};
      signal?.addEventListener('abort',j.abort,{once:true});queue.push(j);drain();
    });
  }
  return {acquire,snapshot,wake:drain,close(){clearTimeout(timer);for(const j of queue.splice(0)){j.signal?.removeEventListener('abort',j.abort);j.reject(abortError());}}};
}

// Only in-flight work is shared. Fresh regeneration after completion always runs.
export function createSingleFlight(){
  const flights=new Map();
  return function singleFlight(key,run,signal){
    if(signal?.aborted)return Promise.reject(abortError());
    let f=flights.get(key);
    if(!f){f={controller:new AbortController(),subscribers:0};flights.set(key,f);f.promise=Promise.resolve().then(()=>run(f.controller.signal)).finally(()=>{if(flights.get(key)===f)flights.delete(key);});f.promise.catch(()=>{});}
    else reportTask(signal,{kind:'scheduler',status:'shared',message:'已合并相同的在途模型请求，复用本次结果'});
    f.subscribers++;
    return new Promise((resolve,reject)=>{
      let done=false;
      const finish=(fn,value)=>{if(done)return;done=true;signal?.removeEventListener('abort',cancel);f.subscribers--;fn(value);};
      const cancel=()=>{finish(reject,abortError());if(!f.subscribers){if(flights.get(key)===f)flights.delete(key);f.controller.abort();}};
      signal?.addEventListener('abort',cancel,{once:true});f.promise.then(v=>finish(resolve,structuredClone(v)),e=>finish(reject,e));
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
