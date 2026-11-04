import {AsyncLocalStorage} from 'node:async_hooks';
const storage=new AsyncLocalStorage();
export const executionContext=()=>storage.getStore()||{};
export const withExecutionContext=(value,fn)=>storage.run({...executionContext(),...value},fn);
export function assertCurrentExecution(){if(executionContext().isCurrent?.()===false){const e=Error('任务输入版本已变化，旧任务不再提交结果');e.code='STALE_TASK';throw e;}}
// Only an authorized mutation executing inside this task may advance its token.
// Edits from another HTTP request have no task context and cannot advance it.
export function advanceExecutionVersion(projectId,before,after){
  const context=executionContext();
  if(context.projectId===projectId&&context.revision?.version===before){context.revision.version=after;context.version=after;}
}
