import os from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {executionContext} from './execution-context.mjs';
import {reportTask} from './task-progress.mjs';
export function createLocalExecutor({run=promisify(execFile),limit=Math.max(1,Math.min(2,os.availableParallelism()-1)),memoryBudget=512*1024*1024,freeMemory=os.freemem}={}){
  let active=0,memory=0,office=false,sequence=0;const queue=[];
  const snapshot=()=>({active,queued:queue.length,memoryReserved:memory,limit});
  function drain(){
    queue.sort((a,b)=>b.priority-a.priority||a.sequence-b.sequence);
    for(let i=0;i<queue.length;){const j=queue[i];
      if(j.options.signal?.aborted||j.context.isCurrent?.()===false){queue.splice(i,1);j.options.signal?.removeEventListener('abort',j.abort);j.reject(Error(j.options.signal?.aborted?'任务已取消':'任务输入版本已变化'));continue;}
      if(j.office?office:active>=limit||memory+j.memory>memoryBudget&&active>0||freeMemory()<j.memory+128*1024*1024&&active>0){i++;continue;}
      queue.splice(i,1);j.options.signal?.removeEventListener('abort',j.abort);if(j.office)office=true;else{active++;memory+=j.memory;}
      reportTask(j.options.signal,{kind:'local',status:'running',message:j.office?'PowerPoint 渲染通道执行':'本地图像处理执行'});
      Promise.resolve().then(()=>{if(j.options.signal?.aborted)throw Error('任务已取消');return run(j.command,j.args,j.options);}).then(j.resolve,j.reject).finally(()=>{if(j.office)office=false;else{active--;memory-=j.memory;}drain();});
    }
  }
  const execute=(command,args,options={})=>new Promise((resolve,reject)=>{
    const j={command,args,options,resolve,reject,context:executionContext(),sequence:sequence++,priority:executionContext().priority||0,memory:128*1024*1024,office:args.some(a=>/[/\\](?:render_deck|extract_pptx_object)\.ps1$/i.test(String(a)))};
    j.abort=()=>{const i=queue.indexOf(j);if(i>=0)queue.splice(i,1);reject(Error('任务已取消'));};
    if(options.signal?.aborted){reject(Error('任务已取消'));return;}options.signal?.addEventListener('abort',j.abort,{once:true});queue.push(j);drain();
  });
  execute.snapshot=snapshot;return execute;
}
