export function mergeProgressEvent(project,delta){
  if(delta.version!==project.version||delta.revision<(project.runtimeRevision||0))return false;
  if(project.task?.status==='running'&&delta.task?.status!=='running'||project.task?.id!==delta.task?.id)return false;
  const merge=(old,patch)=>{const values=new Map((old||[]).map(v=>[v.id,v]));for(const v of patch.changed)values.set(v.id,v);return patch.ids.map(id=>values.get(id)).filter(Boolean);};
  project.task=delta.task?{...delta.task,progress:merge(delta.reset?[]:project.task?.progress,delta.progress),jobs:merge(delta.reset?[]:project.task?.jobs,delta.jobs)}:null;
  project.imageTaskQueue=delta.imageTaskQueue;project.runtimeRevision=delta.revision;project.updatedAt=delta.updatedAt;return true;
}
export function createProjectEventStream({getProject,onProgress,onInvalidate,EventSourceClass=globalThis.EventSource}){
  let source,id,connected=false;
  return {get connected(){return connected;},sync(){
    const p=getProject(),next=p?.progressEventsEnabled?p.id:null;
    if(next===id)return;source?.close();source=null;id=next;connected=false;if(!next||!EventSourceClass)return;
    source=new EventSourceClass('/api/projects/'+encodeURIComponent(id)+'/events');const current=source;
    source.onopen=()=>{if(source===current)connected=true;};source.onerror=()=>{if(source===current)connected=false;};
    source.addEventListener('progress',event=>{if(source!==current||getProject()?.id!==id)return;try{const delta=JSON.parse(event.data),applied=mergeProgressEvent(getProject(),delta);if(applied)onProgress(delta);if(delta.results||!applied)onInvalidate();}catch{connected=false;onInvalidate();}});
  },close(){source?.close();source=null;id=null;connected=false;}};
}
