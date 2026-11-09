import crypto from 'node:crypto';
import {reportTask,withTaskScope} from './task-progress.mjs';
import {withExecutionContext,executionContext,assertCurrentExecution} from './execution-context.mjs';
import {workerConcurrencyLimit,maxWorkerConcurrency} from './concurrency.mjs';
export async function runTaskGraph(nodes,{signal,limit=6,reportLimit=limit,settle=true}={}){
  // limit is a ready-worker window (1-12); null/auto takes the service window. The
  // resource scheduler still bounds real API requests by project/account/global ceilings.
  const currentLimit=()=>workerConcurrencyLimit(typeof limit==='function'?limit():limit);
  // Display limit stays the project setting: null means auto, so no fixed number is reported.
  const reportedLimit=()=>{
    const raw=typeof reportLimit==='function'?reportLimit():reportLimit;
    if(raw===null||raw===undefined)return null;
    const text=typeof raw==='string'?raw.trim():raw;
    if(text===''||String(text).toLowerCase()==='auto')return null;
    const n=Number(text);return Number.isInteger(n)?n:null;
  };
  const definitions=new Map(nodes.map(n=>[n.id,n])),states=new Map(),batch=crypto.randomUUID();let active=0,timer;
  if(definitions.size!==nodes.length||nodes.some(n=>(n.dependsOn||[]).some(id=>!definitions.has(id))))throw Error('任务依赖编号无效');
  const displayLimit=()=>{const value=reportedLimit();return value===null?{}:{limit:value};};
  const emit=(n,status,extra={})=>reportTask(signal,{id:batch+'-'+n.id,kind:'job',status,message:n.label||n.id,...displayLimit(),...extra});
  for(const n of nodes){states.set(n.id,{status:'queued'});emit(n,'queued');}
  return new Promise((resolve,reject)=>{
    let settled=false;
    const finish=(fn,value)=>{if(settled)return;settled=true;signal?.removeEventListener('abort',onAbort);fn(value);};
    const onAbort=()=>drain();
    signal?.addEventListener('abort',onAbort,{once:true});
    function drain(){
      clearTimeout(timer);
      let propagated;
      do{propagated=false;for(const n of nodes){const state=states.get(n.id);if(state.status!=='queued')continue;const deps=(n.dependsOn||[]).map(id=>states.get(id));if(signal?.aborted||deps.some(s=>['rejected','blocked','cancelled'].includes(s.status))){propagated=true;state.status=signal?.aborted?'cancelled':'blocked';state.reason=Error(signal?.aborted?'任务已取消':'前置任务未完成，已保留其他页面');reportTask(signal,{id:batch+'-'+n.id,kind:'job',status:signal?.aborted?'cancelled':'skipped',message:n.label||n.id,...displayLimit()});}}}while(propagated);
      const priority=n=>Number(typeof n.priority==='function'?n.priority():n.priority)||0;
      const ready=nodes.filter(n=>states.get(n.id).status==='queued'&&(n.dependsOn||[]).every(id=>states.get(id).status==='fulfilled')).sort((a,b)=>priority(b)-priority(a));
      while(active<currentLimit()&&ready.length){const n=ready.shift(),s=states.get(n.id),id=batch+'-'+n.id;s.status='running';active++;const started=Date.now();emit(n,'running');
        Promise.resolve().then(()=>withTaskScope(id,()=>withExecutionContext({priority:Math.max(executionContext().priority||0,priority(n))},()=>{if(signal?.aborted)throw Error('任务已取消');assertCurrentExecution();return n.run(Object.fromEntries((n.dependsOn||[]).map(id=>[id,states.get(id).value])));}))).then(value=>{s.status='fulfilled';s.value=value;reportTask(signal,{id,kind:'job',status:'done',message:n.label||n.id,...displayLimit(),durationMs:Date.now()-started});},reason=>{s.status='rejected';s.reason=reason;reportTask(signal,{id,kind:'job',status:signal?.aborted?'cancelled':'failed',message:n.label||n.id,...displayLimit(),durationMs:Date.now()-started});}).finally(()=>{active--;drain();});
      }
      if(!active){if([...states.values()].some(s=>s.status==='queued')){finish(reject,Error('任务依赖存在循环'));return;}if(signal?.aborted){finish(reject,Error('任务已取消'));return;}const result=nodes.map(n=>({id:n.id,...states.get(n.id)}));if(!settle&&result.some(r=>r.status==='rejected'))finish(reject,result.find(r=>r.status==='rejected').reason);else finish(resolve,result);}
      else if(typeof limit==='function'&&ready.length)timer=setTimeout(drain,100);
    }
    drain();
  });
}
export async function runPipelined(items,generate,review,{signal,limit=3,label=(_,i)=>'生成 '+(i+1),reviewLabel=(_,i)=>'检查 '+(i+1),priority=()=>10}={}){
  const nodes=items.flatMap((item,i)=>[{id:'generate-'+i,label:label(item,i),priority:()=>priority(item,i),run:()=>generate(item,i)},{id:'review-'+i,label:reviewLabel(item,i),priority:()=>Math.max(20,priority(item,i)),dependsOn:['generate-'+i],run:deps=>review(item,deps['generate-'+i],i)}]);
  // Generate and review overlap, so the ready-worker window is double the project setting
  // (auto: the whole service window). A manual 1-6 project cap still bounds real requests.
  const windowLimit=()=>{const base=workerConcurrencyLimit(typeof limit==='function'?limit():limit);return base>=maxWorkerConcurrency?maxWorkerConcurrency:Math.min(maxWorkerConcurrency,Math.max(2,base*2));};
  const results=await runTaskGraph(nodes,{signal,settle:true,limit:windowLimit,reportLimit:limit});
  const select=prefix=>items.map((_,i)=>results.find(r=>r.id===prefix+i));
  return {generated:select('generate-'),reviewed:select('review-')};
}
