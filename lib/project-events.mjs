const terminal=s=>['done','failed','cancelled','interrupted'].includes(s);
export function createProjectEvents({interval=250}={}){
  const clients=new Map(),pending=new Map();
  const queueView=p=>(p.imageTaskQueue||[]).map(({request,guard,fingerprint,...v})=>v);
  function send(client,p,force=false,results=false){
    const task=p.task||null,reset=client.taskId!==task?.id;client.taskId=task?.id;
    const delta=(rows,known)=>{const changed=[];for(const row of rows||[]){const value=JSON.stringify(row);if(force||known.get(row.id)!==value){known.set(row.id,value);changed.push(row);}}const ids=(rows||[]).map(r=>r.id);for(const id of known.keys())if(!ids.includes(id))known.delete(id);return {changed,ids};};
    if(reset){client.progress.clear();client.jobs.clear();}
    const marker=JSON.stringify([p.version,p.stage,p.candidate?.id,p.rebuildLive?.revision,p.rebuildAssetPreview?.revision]),changed=client.resultMarker!==marker;client.resultMarker=marker;
    const {progress,jobs,...summary}=task||{},payload={revision:p.runtimeRevision||0,version:p.version,updatedAt:p.updatedAt,reset,task:task?summary:null,progress:delta(progress,client.progress),jobs:delta(jobs,client.jobs),imageTaskQueue:queueView(p),scheduler:task?.scheduler,results:results||changed||reset||terminal(task?.status)};
    if(client.response.writableLength>1024*1024){client.response.end();return;}
    client.response.write('event: progress\ndata: '+JSON.stringify(payload)+'\n\n');
  }
  function publish(p,{results=false,critical=false}={}){
    const group=clients.get(p.id);if(!group?.size)return;
    const previous=pending.get(p.id);if(previous){previous.p=p;previous.results||=results;return;}
    const entry={p,results};pending.set(p.id,entry);entry.timer=setTimeout(()=>{pending.delete(p.id);for(const client of group)send(client,entry.p,false,entry.results);},critical?0:interval);entry.timer.unref();
  }
  function subscribe(p,request,response){
    response.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache, no-transform',connection:'keep-alive','x-accel-buffering':'no'});response.flushHeaders?.();
    const group=clients.get(p.id)||new Set();clients.set(p.id,group);const client={response,progress:new Map(),jobs:new Map()};group.add(client);send(client,p,true);
    const heartbeat=setInterval(()=>response.write(': heartbeat\n\n'),15000);heartbeat.unref();
    request.on('close',()=>{clearInterval(heartbeat);group.delete(client);if(!group.size)clients.delete(p.id);});
  }
  return {publish,subscribe,close(){for(const entry of pending.values())clearTimeout(entry.timer);pending.clear();for(const group of clients.values())for(const c of group)c.response.end();clients.clear();}};
}
