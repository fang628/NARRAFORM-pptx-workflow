export const apiTypes=['text','image','elementImage','rebuild'];
export function apiPersistenceMessage(project){
  if(project.apiPersistenceWarning)return project.apiPersistenceWarning;
  return project.apiPersistence==='windows-dpapi'
    ? '填写完整后自动保存。密钥使用 Windows 当前用户加密保存在本机，重启服务自动恢复；清除密钥会同时删除保存的副本。'
    : '填写完整后自动保存。当前服务仅在内存保留密钥，重启后需要重新填写。';
}
const labels={text:'主模型',image:'生图模型',elementImage:'元素生图模型',rebuild:'高性能视觉模型'};
const readiness={text:'apiReady',image:'imageReady',elementImage:'elementImageReady',rebuild:'rebuildConfigured'};
export function apiConfigurationPlan(values,project){
  const payload={},pending=[];
  for(const type of apiTypes){
    const value=values[type],old=project.provider?.[type];
    if(!value.baseURL&&!value.model&&!value.key){if(type==='text')pending.push(labels[type]);else if(old)payload[type]=null;continue;}
    let validURL=false;try{validURL=['https:','http:'].includes(new URL(value.baseURL).protocol);}catch{}
    const same=old?.baseURL===value.baseURL&&old?.model===value.model;
    if(!validURL||!value.model||(!value.key&&!(same&&project[readiness[type]]))){pending.push(labels[type]);continue;}
    if(value.key||!same||!project[readiness[type]])payload[type]=value;
  }
  // The server requires a main channel; incomplete optional channels do not block it.
  if(!project.apiReady&&!payload.text)return {payload:{},pending:[...new Set(['主模型',...pending])]};
  return {payload,pending};
}

export function createAPIAutosave({read,save,applied,state,blocked},delay=700){
  let timer=null,inFlight=null,revision=0,generation=0;
  const show=(kind,message)=>state(kind,message);
  function reset(){clearTimeout(timer);timer=null;generation++;revision++;}
  function schedule(){revision++;clearTimeout(timer);show('editing','编辑中，停止输入后自动保存…');timer=setTimeout(()=>flush().catch(()=>{}),delay);}
  async function flush({strict=false}={}){
    clearTimeout(timer);timer=null;
    if(inFlight){await inFlight;return flush({strict});}
    const snapshot=read();if(!snapshot)return;
    const currentGeneration=generation,currentRevision=revision,plan=apiConfigurationPlan(snapshot.values,snapshot.project);
    if(blocked()){
      show('waiting','当前任务结束后自动保存');if(strict)throw Error('请等待当前任务完成后保存 API');
      timer=setTimeout(()=>flush().catch(()=>{}),1000);return;
    }
    if(Object.keys(plan.payload).length){
      show('saving','正在保存 API 配置…');
      const operation=save(snapshot.project.id,plan.payload);inFlight=operation;
      try{const result=await operation;applied(result,snapshot,plan);}
      catch(error){if(currentGeneration===generation)show('error','保存失败：'+error.message+'；可点击「立即保存」重试');throw error;}
      finally{inFlight=null;}
      if(currentGeneration!==generation)return;
      if(currentRevision!==revision)return flush({strict});
    }
    const latest=read();if(!latest||latest.project.id!==snapshot.project.id)return;
    const remaining=apiConfigurationPlan(latest.values,latest.project);
    if(remaining.pending.length){const message=(latest.project.apiReady&&!remaining.pending.includes('主模型')?'其余完整通道已保存；':'')+'请补齐'+remaining.pending.join('、')+'的地址、模型与密钥';show('incomplete',message);if(strict)throw Error(message);}
    else show('saved',latest.project.apiPersistence==='windows-dpapi'?'已自动保存 · 本机加密，重启自动恢复':'已自动保存 · 当前服务会话有效');
  }
  return {schedule,flush,reset,settled:()=>inFlight?.catch(()=>{})||Promise.resolve()};
}
