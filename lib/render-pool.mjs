import {Worker} from 'node:worker_threads';
import os from 'node:os';
import {executionContext} from './execution-context.mjs';
export function createRenderPool({size=Math.max(1,Math.min(2,os.availableParallelism()-1)),timeoutMs=90000,workerFactory=()=>new Worker(new URL('./render-worker.mjs',import.meta.url))}={}){
  const workers=[],queue=[];let sequence=0,closed=false;
  function spawn(){
    const slot={worker:workerFactory(),job:null,dead:false};workers.push(slot);slot.worker.unref();
    slot.worker.on('message',value=>{const j=slot.job;if(!j||j.id!==value.id)return;slot.job=null;clearTimeout(j.timer);j.signal?.removeEventListener('abort',j.abort);slot.worker.unref();value.error?j.reject(Error(value.error)):j.resolve(value.measurement??Buffer.from(value.bytes));drain();});
    slot.worker.on('error',error=>retire(slot,error));
    slot.worker.on('exit',code=>retire(slot,Error('SVG 渲染线程意外退出（'+code+'），请重试本页')));
    return slot;
  }
  function retire(slot,error){
    if(slot.dead)return;slot.dead=true;const i=workers.indexOf(slot);if(i>=0)workers.splice(i,1);
    const j=slot.job;slot.job=null;if(j){clearTimeout(j.timer);j.signal?.removeEventListener('abort',j.abort);j.reject(error);}
    Promise.resolve(slot.worker.terminate()).catch(()=>{});drain();
  }
  function drain(){if(closed)return;queue.sort((a,b)=>b.priority-a.priority||a.id-b.id);while(queue.length){let slot=workers.find(w=>!w.job);if(!slot&&workers.length<size)slot=spawn();if(!slot)return;const j=queue.shift();if(j.signal?.aborted||j.context.isCurrent?.()===false){j.signal?.removeEventListener('abort',j.abort);j.reject(Error(j.signal?.aborted?'任务已取消':'任务输入版本已变化'));continue;}slot.job=j;j.slot=slot;slot.worker.ref();j.timer=setTimeout(()=>retire(slot,Error('SVG 渲染超过 '+timeoutMs/1000+' 秒，已保留现有结果')),timeoutMs);j.timer.unref();try{slot.worker.postMessage({id:j.id,source:j.source,options:j.options});}catch(error){retire(slot,error);}}}
  function render(source,options={},signal){return new Promise((resolve,reject)=>{
    if(closed||signal?.aborted){reject(Error(closed?'渲染池已关闭':'任务已取消'));return;}
    const context=executionContext(),j={id:++sequence,source:Buffer.isBuffer(source)?source.toString('utf8'):source,options,signal,resolve,reject,context,priority:context.priority||0};
    j.abort=()=>{const i=queue.indexOf(j);if(i>=0)queue.splice(i,1);if(j.slot){retire(j.slot,Error('任务已取消'));return;}reject(Error('任务已取消'));drain();};
    signal?.addEventListener('abort',j.abort,{once:true});queue.push(j);drain();
  });}
  render.close=async()=>{closed=true;for(const j of queue.splice(0)){j.signal?.removeEventListener('abort',j.abort);j.reject(Error('渲染池已关闭'));}await Promise.all(workers.splice(0).map(s=>{s.dead=true;if(s.job){clearTimeout(s.job.timer);s.job.signal?.removeEventListener('abort',s.job.abort);s.job.reject(Error('渲染池已关闭'));}return s.worker.terminate();}));};return render;
}
export const renderSVG=createRenderPool();
