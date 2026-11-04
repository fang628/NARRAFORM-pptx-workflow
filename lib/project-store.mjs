import fs from 'node:fs';
import path from 'node:path';
export function createProjectStore(data,{interval=250,onChange=()=>{},onError=()=>{}}={}){
  const pending=new Map(),last=new Map();
  const boundary=p=>JSON.stringify([p.version,p.stage,p.task?.id,p.task?.status,p.archivedAt,p.candidate?.id,p.output?.file,p.approvals]);
  function flush(id){
    const entry=pending.get(id);if(!entry)return;clearTimeout(entry.timer);entry.timer=null;
    const dir=path.join(data,id);fs.mkdirSync(dir,{recursive:true});const file=path.join(dir,'project.json'),temp=path.join(dir,'project.tmp');fs.writeFileSync(temp,JSON.stringify(entry.p,null,2));
    for(let attempt=0;;attempt++)try{fs.renameSync(temp,file);break;}catch(e){if(process.platform!=='win32'||!['EPERM','EBUSY','EACCES'].includes(e.code)||attempt>=5)throw e;Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);}
    pending.delete(id);last.set(id,boundary(entry.p));
  }
  function schedule(id,entry){
    if(entry.timer)return;
    entry.timer=setTimeout(()=>{
      entry.timer=null;
      try{flush(id);}catch(error){onError(error,entry.p);if(pending.get(id)===entry)schedule(id,entry);}
    },interval);entry.timer.unref();
  }
  function save(p,{immediate=false,results=false}={}){
    p.updatedAt=new Date().toISOString();p.runtimeRevision=(p.runtimeRevision||0)+1;
    let entry=pending.get(p.id);if(!entry){entry={p};pending.set(p.id,entry);}entry.p=p;
    onChange(p,{results,critical:immediate||last.get(p.id)!==boundary(p)});
    if(immediate||p.task?.status!=='running'||last.get(p.id)!==boundary(p)){try{flush(p.id);}catch(error){schedule(p.id,entry);throw error;}return;}
    schedule(p.id,entry);
  }
  return {save,flush,flushAll(){for(const id of [...pending.keys()])flush(id);},pending:()=>pending.size};
}
