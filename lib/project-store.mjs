import fs from 'node:fs';
import path from 'node:path';

// Frequent task progress (messages, request/job log entries) only rewrites a small overlay file.
// The full project record is still written for stage/structure changes, forced flushes, task
// completion and shutdown. After a crash a newer overlay is merged back into the full record at
// startup only when it belongs to the same running task, so the last progress survives a restart
// without rewriting the heavy record.
const overlayDirectory='.progress',overlayFormat='NARRAFORM-PROGRESS',overlayVersion=1,overlayLimit=64*1024*1024;
const overlayId=id=>typeof id==='string'&&/^[a-zA-Z0-9._-]{1,80}$/.test(id)&&id!=='.'&&id!=='..';
const overlayFile=(data,id)=>path.join(data,overlayDirectory,id+'.json');
function removeQuietly(file){try{fs.unlinkSync(file);}catch{}}
function renameWithRetry(temp,file){
  for(let attempt=0;;attempt++)try{fs.renameSync(temp,file);return;}catch(error){
    if(process.platform!=='win32'||!['EPERM','EBUSY','EACCES'].includes(error.code)||attempt>=5)throw error;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);
  }
}
function overlayRecord(p){
  return {format:overlayFormat,version:overlayVersion,id:p.id,runtimeRevision:Number.isInteger(p.runtimeRevision)?p.runtimeRevision:0,updatedAt:p.updatedAt,task:p.task};
}
// The overlay only carries task progress. It is read defensively: an oversized, foreign or
// malformed file is discarded, never merged over the full project record.
export function readProgressState(data,id){
  if(!overlayId(id))return null;
  const file=overlayFile(data,id);let stat;
  try{stat=fs.statSync(file);}catch{return null;}
  if(!stat.isFile()||stat.size>overlayLimit){removeQuietly(file);return null;}
  let text;try{text=fs.readFileSync(file,'utf8');}catch{return null;}
  let record;try{record=JSON.parse(text);}catch{removeQuietly(file);return null;}
  if(!record||record.format!==overlayFormat||record.version!==overlayVersion||record.id!==id||!Number.isInteger(record.runtimeRevision)||record.runtimeRevision<0||!record.task||typeof record.task!=='object'||Array.isArray(record.task)){
    removeQuietly(file);return null;
  }
  return record;
}
export function applyProgressState(p,record){
  if(!p||!record||record.id!==p.id||!record.task||typeof record.task!=='object'||Array.isArray(record.task))return false;
  // Recovery may only extend the same in-flight task. A finished, replaced or missing task in the
  // full record means the overlay belongs to another run and must never replace the loaded state.
  const task=p.task;
  if(!task||typeof task!=='object'||task.status!=='running'||record.task.status!=='running')return false;
  if(typeof task.id!=='string'||!task.id||record.task.id!==task.id)return false;
  // Historical records without runtimeRevision are treated as revision 0.
  if(record.runtimeRevision<=(Number.isInteger(p.runtimeRevision)?p.runtimeRevision:0))return false;
  p.task=record.task;
  if(typeof record.updatedAt==='string')p.updatedAt=record.updatedAt;
  p.runtimeRevision=record.runtimeRevision;
  return true;
}
export function recoverProgressState(p,data){
  if(!p||typeof p.id!=='string')return false;
  const record=readProgressState(data,p.id);
  if(!record)return false;
  if(applyProgressState(p,record))return true;
  // The full record is at least as new as the overlay, or the overlay belongs to another task.
  // Either way the overlay is stale and is dropped instead of overwriting the loaded task.
  removeQuietly(overlayFile(data,p.id));
  return false;
}
export function cleanupProgressStates(data,keep=new Set()){
  const dir=path.join(data,overlayDirectory);let names;
  try{names=fs.readdirSync(dir);}catch{return;}
  for(const name of names){
    const id=name.endsWith('.json')?name.slice(0,-5):null;
    if(!id||!overlayId(id)||!keep.has(id))removeQuietly(path.join(dir,name));
  }
}
export function createProjectStore(data,{interval=250,onChange=()=>{},onError=()=>{}}={}){
  const pending=new Map(),last=new Map(),lastGuard=new Map(),progressPending=new Map();
  const boundary=p=>JSON.stringify([p.version,p.stage,p.task?.id,p.task?.status,p.archivedAt,p.candidate?.id,p.output?.file,p.approvals]);
  // Structural markers not covered by boundary; they only decide whether a save explicitly marked
  // as pure progress may skip the full record. Any change falls back to the normal full-save path.
  const progressGuard=p=>JSON.stringify([p.slides?.length,p.materials?.length,(p.imageTaskQueue||[]).map(job=>job.id+':'+job.status),p.rebuildLive?.id,p.rebuildLive?.revision,p.rebuildAssetPreview?.revision,p.contentPipelineDraft?.status,p.contentGenerationDraft?.status,p.themeAssets?.status,p.analysis?.approvedAt,p.progressSections?.length,p.selectedTheme,p.visualMode]);
  // A full write supersedes any not-yet-written overlay: the pending full object already carries
  // the newest progress. The overlay file on disk is removed only after a successful full write.
  function withdrawOverlay(id){const entry=progressPending.get(id);if(entry){if(entry.timer)clearTimeout(entry.timer);progressPending.delete(id);}}
  function clearOverlay(id){withdrawOverlay(id);if(overlayId(id))removeQuietly(overlayFile(data,id));}
  function writeFull(id,entry){
    const dir=path.join(data,id);fs.mkdirSync(dir,{recursive:true});const file=path.join(dir,'project.json'),temp=path.join(dir,'project.tmp');
    fs.writeFileSync(temp,JSON.stringify(entry.p,null,2));renameWithRetry(temp,file);
    pending.delete(id);last.set(id,boundary(entry.p));lastGuard.set(id,progressGuard(entry.p));clearOverlay(id);
  }
  function flush(id){
    const entry=pending.get(id);if(!entry)return;
    withdrawOverlay(id);if(entry.timer){clearTimeout(entry.timer);entry.timer=null;}
    writeFull(id,entry);
  }
  function schedule(id,entry){
    withdrawOverlay(id);if(entry.timer)return;
    entry.timer=setTimeout(()=>{
      entry.timer=null;
      try{flush(id);}catch(error){onError(error,entry.p);if(pending.get(id)===entry)schedule(id,entry);}
    },interval);entry.timer.unref();
  }
  function writeOverlay(id,entry){
    const text=JSON.stringify(overlayRecord(entry.p)),dir=path.join(data,overlayDirectory);
    fs.mkdirSync(dir,{recursive:true});const file=overlayFile(data,id),temp=file+'.tmp';
    fs.writeFileSync(temp,text);renameWithRetry(temp,file);progressPending.delete(id);
  }
  function scheduleOverlay(id,entry){
    if(entry.timer)return;
    entry.timer=setTimeout(()=>{
      entry.timer=null;
      try{writeOverlay(id,entry);}catch(error){onError(error,entry.p);if(progressPending.get(id)===entry)scheduleOverlay(id,entry);}
    },interval);entry.timer.unref();
  }
  // progressOnly is opt-in and only honoured while the task is running, no structure is waiting for
  // a debounced full write, and the cheap structural guard is unchanged. At most one of the full
  // timer and the overlay timer is pending for a project, so newer progress can never reach disk
  // ahead of structure that has not been flushed yet.
  function save(p,{immediate=false,results=false,progressOnly=false}={}){
    p.updatedAt=new Date().toISOString();p.runtimeRevision=(p.runtimeRevision||0)+1;
    let entry=pending.get(p.id);if(!entry){entry={p};pending.set(p.id,entry);}entry.p=p;
    const changed=last.get(p.id)!==boundary(p);
    onChange(p,{results,critical:immediate||changed});
    const pureProgress=progressOnly&&!immediate&&!changed&&p.task?.status==='running';
    if(pureProgress){
      // A debounced full write already owns the newest object: only refresh it, never let an
      // overlay overtake the structure it is about to flush.
      if(entry.timer){withdrawOverlay(p.id);return;}
      if(overlayId(p.id)&&last.has(p.id)&&lastGuard.get(p.id)===progressGuard(p)){
        let progress=progressPending.get(p.id);if(!progress){progress={p};progressPending.set(p.id,progress);}progress.p=p;
        scheduleOverlay(p.id,progress);return;
      }
    }
    // Full-record path: withdraw the not-yet-written overlay first; the pending full object carries
    // the newest progress, so dropping the overlay payload loses nothing.
    withdrawOverlay(p.id);
    if(immediate||p.task?.status!=='running'||changed){try{flush(p.id);}catch(error){schedule(p.id,entry);throw error;}return;}
    schedule(p.id,entry);
  }
  return {save,flush,flushAll(){for(const id of [...pending.keys()])flush(id);},pending:()=>pending.size,progressPending:()=>progressPending.size};
}
