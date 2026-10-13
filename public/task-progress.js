const h=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
// Result changes refresh the workspace; progress ticks only refresh the task UI.
export function projectResultKey(project){
  if(!project)return '';
  const {task,events,updatedAt,lastUsage,...results}=project;
  return JSON.stringify([results,task?.id,task?.status]);
}
function viewKey(element){
  const contexts=['data-slide','data-node','data-page-design','data-theme-review','data-release-page'].map(attr=>[attr,element.closest('['+attr+']')?.getAttribute(attr)??null]);
  const attributes=[...element.attributes].filter(a=>['id','name','type'].includes(a.name)||a.name.startsWith('data-')&&!['data-caption-node','data-single-saved'].includes(a.name)).map(a=>[a.name,a.value]);
  return JSON.stringify([element.tagName,contexts,attributes]);
}
function viewEntries(root,selector){
  const counts=new Map();return [...root.querySelectorAll(selector)].filter(el=>!el.closest('[data-live-recovery]')).map(el=>{
    const base=viewKey(el),ordinal=counts.get(base)||0;counts.set(base,ordinal+1);return {el,key:base+':'+ordinal};
  });
}
function fieldDefault(el){
  if(el.tagName==='SELECT')return [...el.options].find(o=>o.defaultSelected)?.value??el.options[0]?.value??'';
  return el.defaultValue;
}
export function captureLiveView(root){
  const active=root.ownerDocument.activeElement,fields=viewEntries(root,'input,textarea,select');
  return {drafts:fields.filter(({el})=>el.type!=='file'&&(['checkbox','radio'].includes(el.type)?el.checked!==el.defaultChecked:el.value!==fieldDefault(el))).map(({el,key})=>({key,value:el.value,checked:el.checked,check:['checkbox','radio'].includes(el.type),label:el.getAttribute('aria-label')||el.name||'未提交文字'})),
    details:viewEntries(root,'details').map(({el,key})=>({key,open:el.open})),
    focus:fields.find(({el})=>el===active)?.key,start:active?.selectionStart,end:active?.selectionEnd};
}
export function restoreLiveView(root,state){
  const fields=new Map(viewEntries(root,'input,textarea,select').map(({el,key})=>[key,el])),missing=[],restored=[];
  for(const draft of state.drafts){const el=fields.get(draft.key);if(!el||el.tagName==='SELECT'&&![...el.options].some(o=>o.value===draft.value)){missing.push(draft);continue;}if(draft.check)el.checked=draft.checked;else el.value=draft.value;restored.push(el);}
  const details=new Map(viewEntries(root,'details').map(({el,key})=>[key,el]));for(const d of state.details)if(details.has(d.key))details.get(d.key).open=d.open;
  return {missing,restored,focus(){const el=fields.get(state.focus);if(!el||el.disabled)return;el.focus({preventScroll:true});if(typeof state.start==='number')try{el.setSelectionRange(state.start,state.end);}catch{}}};
}
const names={'hero-image':'封面底图','toc-image':'目录底图','content-background':'正文底图'};
export function imageTaskChoices(p){
  if(!p?.imageTaskQueueEnabled)return [];
  const choices=[];
  if(p.designTaskQueueEnabled&&p.apiReady){
    if(p.approvals?.requirements)choices.push({key:'content',label:'逐页内容与设计 / AI 初稿',type:'design',input:null,request:{action:'content'}});
    if(p.slides?.length)choices.push({key:'design:missing',label:'逐页设计 / 补齐设计稿',type:'design',input:null,request:{action:'draftPageDesigns'}});
    for(const [index] of (p.slides||[]).entries()){
      choices.push({key:'design:'+index,label:'单页设计 / 第 '+(index+1)+' 页',type:'design',input:null,request:{action:'designPage',index}});
      const d=p.pageDesigns?.[index];
      if(d?.markdown)choices.push({key:'design:revise:'+index,label:'修改单页设计 / 第 '+(index+1)+' 页',type:'design',input:'instruction',required:true,request:{action:'revisePageDesign',index,markdown:d.markdown}});
    }
  }
  if(p.imageReady&&p.themeAssetsCurrent)for(const entry of p.themeAssetPrompts||[])choices.push({key:'theme:'+entry.theme+':'+entry.use,label:entry.theme.toUpperCase()+' / '+names[entry.use],prompt:entry.prompt,required:true,request:{action:'generateThemeAssets',confirmed:true,prompts:[{theme:entry.theme,use:entry.use,revision:entry.revision,prompt:entry.prompt}]}});
  if(p.imageReady)for(const index of p.confirmedVisualPages||[]){
    if(p.selectedTheme)choices.push({key:'full:'+index,label:'全篇预览 / 第 '+(index+1)+' 页',prompt:p.visualPages?.[index]?.promptDraft||p.visualPages?.[index]?.prompt||'',request:{action:'generateFullPreview',index,force:true}});
    for(const c of p.concepts||[])if(c.mode==='ai'){const page=c.representatives.find(r=>r.index===index);choices.push({key:'concept:'+c.id+':'+index,label:'方向 '+c.id.toUpperCase()+' / 第 '+(index+1)+' 页',prompt:page?.promptDraft||page?.prompt||'',request:{action:'generateConceptPage',theme:c.id,index,force:true}});}
  }
  for(const [index,s] of (p.slides||[]).entries()){
    if(p.imageReady)choices.push({key:'image:'+index,label:'补充插画 / 第 '+(index+1)+' 页',prompt:'',required:true,request:{action:'image',index,allowUpload:true}});
    if(p.elementImageReady)for(const node of s.elements||[])if(node.type==='image')choices.push({key:'element:'+index+':'+node.id,label:'元素图 / 第 '+(index+1)+' 页 · '+(node.label||'图片'),prompt:'',required:true,request:{action:'image',index,elementId:node.id,allowUpload:true}});
  }
  return choices;
}
export function imageQueueView(queue=[],enabled=false,sortEnabled=false){
  if(!enabled)return '';
  const states={queued:'等待中',running:'执行中',done:'已完成',failed:'失败',cancelled:'已取消',interrupted:'已中断'},pending=queue.filter(t=>t.status==='queued').length,visible=queue.filter((t,i)=>['running','queued'].includes(t.status)||i>=queue.length-40);
  return `<section class="image-task-list"><div class="execution-queue-heading"><strong>任务列表 <small>等待 ${pending}</small></strong></div><p class="subtle">当前批次完成后按${sortEnabled?'列表顺序':'顺序'}执行，批次内遵守并发上限。</p>${queue.length?`<div class="image-task-records" role="list" aria-label="任务顺序">${visible.map(t=>`<article role="listitem" data-image-task-id="${h(t.id)}" data-state="${h(t.status)}"><div>${sortEnabled&&t.status==='queued'?`<button type="button" class="image-task-sort-handle" data-queue-sort-handle aria-label="拖动排序：${h(t.label)}" title="拖动排序"><svg viewBox="0 0 16 20" aria-hidden="true"><path d="M3 3h3v3H3zM10 3h3v3h-3zM3 9h3v3H3zM10 9h3v3h-3zM3 15h3v3H3zM10 15h3v3h-3z"/></svg></button>`:''}<strong>${h(t.label)}</strong><span>${states[t.status]||h(t.status)}</span>${t.status==='queued'?`<button type="button" class="text-button" data-cancel-queued-image="${h(t.id)}">移除</button>`:''}</div>${t.message?`<p>${h(t.message)}</p>`:''}</article>`).join('')}</div>`:'<p class="subtle">可继续添加逐页设计、底图、单页预览或元素图任务。</p>'}</section>`;
}
export const imageTaskDialog=`<dialog id="addImageTaskDialog" class="visual-prompt-dialog"><form id="addImageTaskForm"><div class="panel-heading"><h3>添加任务</h3><button type="button" class="text-button" data-close="addImageTaskDialog">关闭 ×</button></div><label>生成目标<select id="imageTaskTarget"></select></label><label><span id="imageTaskPromptLabel">完整提示词</span><textarea id="imageTaskPrompt" rows="8" maxlength="30000" placeholder="整页预览留空时采用当前已确认设计稿；元素图请填写完整提示词。"></textarea></label><label class="checkbox"><input id="imageTaskConsent" type="checkbox" required><span id="imageTaskConsentLabel">确认按以上提示词调用已配置的生图 API</span></label><p id="imageTaskState" class="subtle" role="status"></p><div class="actions"><button type="submit" class="primary">加入任务列表 ↗</button></div></form></dialog>`;
export function imageTaskOptions(choices){return choices.map(c=>`<option value="${h(c.key)}">${h(c.label)}</option>`).join('');}
export function taskChoicePayload(choice,input=''){
  if(!choice)throw Error('请选择任务');
  if(choice.required&&!input.trim())throw Error(choice.input==='instruction'?'请填写设计修改意见':'请填写完整提示词');
  const body=structuredClone(choice.request);
  if(choice.input===null)return body;
  if(choice.input==='instruction'){body.instruction=input;return body;}
  if(body.prompts)body.prompts[0].prompt=input;else if(input.trim())body.prompt=input;
  return body;
}

const sortableLists=new WeakSet();
export function bindImageTaskSorting(root,{canSort,getTasks,onMove,onBusyChange=()=>{}}){
  if(sortableLists.has(root))return;sortableLists.add(root);
  let gesture=false;
  const busy=value=>{root.classList.toggle('image-queue-sorting',value);onBusyChange(value);};
  async function commit(id,targetId,position,restoreFocus=false){
    busy(true);
    try{await onMove({id,targetId,position});}
    finally{busy(false);if(restoreFocus)[...root.querySelectorAll('[data-image-task-id]')].find(el=>el.dataset.imageTaskId===id)?.querySelector('[data-queue-sort-handle]')?.focus();}
  }
  root.addEventListener('keydown',e=>{
    const handle=e.target.closest('[data-queue-sort-handle]');
    if(!handle||!canSort()||!['ArrowUp','ArrowDown'].includes(e.key))return;
    e.preventDefault();const row=handle.closest('[data-image-task-id]'),waiting=getTasks().filter(t=>t.status==='queued'),index=waiting.findIndex(t=>t.id===row.dataset.imageTaskId),target=waiting[index+(e.key==='ArrowUp'?-1:1)];
    if(index>=0&&target)void commit(waiting[index].id,target.id,e.key==='ArrowUp'?'before':'after',true);
  });
  root.addEventListener('pointerdown',e=>{
    const handle=e.target.closest('[data-queue-sort-handle]'),row=e.target.closest('[data-image-task-id]');
    if(gesture||!row||row.dataset.state!=='queued'||!canSort()||e.button!==0||!e.isPrimary||(!handle&&e.target.closest('button,input,textarea,select,a,details,summary')))return;
    const id=row.dataset.imageTaskId;if(!getTasks().some(t=>t.id===id&&t.status==='queued'))return;
    if(handle)e.preventDefault();gesture=true;busy(true);
    const capture=handle||row,start={x:e.clientX,y:e.clientY};let last={...start},active=false,candidate=null,marked=null,frameId=0;
    const clearMark=()=>{marked?.classList.remove('image-task-drop-before','image-task-drop-after');marked=null;};
    function update(){
      clearMark();candidate=null;
      const target=document.elementFromPoint(last.x,last.y)?.closest('[data-image-task-id]');
      if(!target||!root.contains(target)||target===row||target.dataset.state!=='queued')return;
      const box=target.getBoundingClientRect(),position=last.y<box.top+box.height/2?'before':'after';
      candidate={id,targetId:target.dataset.imageTaskId,position};marked=target;target.classList.add('image-task-drop-'+position);
    }
    function frame(){
      if(!active)return;const box=root.getBoundingClientRect(),edge=42,delta=last.y<box.top+edge?-10:last.y>box.bottom-edge?10:0;
      if(delta){root.scrollTop+=delta;update();}frameId=requestAnimationFrame(frame);
    }
    function move(ev){
      if(ev.pointerId!==e.pointerId)return;last={x:ev.clientX,y:ev.clientY};
      if(!active&&Math.hypot(last.x-start.x,last.y-start.y)>7){active=true;row.classList.add('image-task-drag-source');frameId=requestAnimationFrame(frame);}
      if(active){ev.preventDefault();update();}
    }
    function cleanup(){
      gesture=false;cancelAnimationFrame(frameId);clearMark();row.classList.remove('image-task-drag-source');
      document.removeEventListener('pointermove',move);document.removeEventListener('pointerup',up);document.removeEventListener('pointercancel',cancel);document.removeEventListener('keydown',key);window.removeEventListener('blur',cancel);
      if(capture.hasPointerCapture?.(e.pointerId))capture.releasePointerCapture(e.pointerId);
    }
    function up(ev){if(ev.pointerId!==e.pointerId)return;const drop=active&&candidate;cleanup();if(drop)void commit(drop.id,drop.targetId,drop.position);else busy(false);}
    function cancel(){cleanup();busy(false);}
    function key(ev){if(ev.key==='Escape'){ev.preventDefault();cancel();}}
    document.addEventListener('pointermove',move,{passive:false});document.addEventListener('pointerup',up);document.addEventListener('pointercancel',cancel);document.addEventListener('keydown',key);window.addEventListener('blur',cancel);
    capture.setPointerCapture?.(e.pointerId);
  });
}

const escape=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const states={queued:'等待中',running:'执行中',done:'已完成',failed:'失败',cancelled:'已取消',interrupted:'已中断'};
const seconds=ms=>Math.max(0,Math.round(ms/1000))+' 秒';
function queueView(task,entries,now){
  const jobs=task.jobs||[];if(!jobs.length)return '';
  const count=status=>jobs.filter(j=>j.status===status).length;
  return `<section class="execution-queue"><div class="execution-queue-heading"><strong>任务队列</strong><span>并发上限 ${task.concurrency||3}</span></div><div class="execution-counts"><span>执行中 <b>${count('running')}</b></span><span>等待 <b>${count('queued')}</b></span><span>完成 <b>${count('done')}</b> / ${jobs.length}</span>${count('failed')?`<span>失败 <b>${count('failed')}</b></span>`:''}</div><div class="execution-jobs">${jobs.map(job=>{
    const logs=job.entries||entries.filter(e=>e.jobId===job.id),latest=logs.at(-1),elapsed=job.status==='running'?seconds(now-Date.parse(job.at)):Number.isFinite(job.durationMs)?seconds(job.durationMs):'';
    return `<article class="execution-job" data-job-id="${escape(job.id)}" data-state="${escape(job.status)}"><div><strong>${escape(job.message)}</strong><span>${states[job.status]||escape(job.status)}</span><time>${elapsed}</time></div>${latest?`<p>${escape(latest.message)}</p>`:''}${logs.length?`<details ${job.status==='running'?'open':''}><summary>步骤与判断摘要 · ${logs.length}</summary>${logs.map(e=>`<p class="execution-job-log" data-state="${escape(e.status)}"><span>${e.kind==='summary'?'判断摘要':e.kind==='request'?'模型调用':'处理步骤'} · ${states[e.status]||escape(e.status)}</span>${escape(e.message)}</p>`).join('')}</details>`:''}</article>`;
  }).join('')}</div></section>`;
}
export function taskProgress(task,now=Date.now(),imageTasks=[],queueEnabled=false,sortEnabled=false){
  if(!task)return imageQueueView(imageTasks,queueEnabled,sortEnabled)+'<p>尚无执行记录</p>';
  const elapsed=(task.finishedAt?Date.parse(task.finishedAt):task.status==='running'?now:NaN)-Date.parse(task.startedAt);
  const entries=task.progress?.length?task.progress:[{kind:'result',status:task.status,message:task.message,at:task.startedAt}];
  return imageQueueView(imageTasks,queueEnabled,sortEnabled)+`<div class="execution-status" data-state="${escape(task.status)}"><span>${escape(states[task.status]||task.status)}</span><strong>${escape(task.label)}</strong><time>${Number.isFinite(elapsed)?seconds(elapsed):''}</time></div>${task.priorStage?.status==='done'?`<p class="execution-prior-stage">✓ ${escape(task.priorStage.label)}已完成，当前任务基于已保存的理解结果执行。</p>`:''}${queueView(task,entries,now)}<ol class="execution-timeline">${entries.filter(e=>e.kind!=='job'&&!e.jobId).map((entry,i)=>`<li data-state="${escape(entry.status)}" class="execution-${escape(entry.kind)}"><div class="execution-meta"><span>${entry.kind==='summary'?'判断摘要':entry.kind==='request'?'模型调用':entry.kind==='result'?'执行结果':'处理步骤'} / ${String(i+1).padStart(2,'0')}</span><time>${Number.isFinite(entry.durationMs)?seconds(entry.durationMs):escape(new Date(entry.at).toLocaleTimeString('zh-CN',{hour12:false}))}</time></div><p>${escape(entry.message)}</p>${entry.status==='running'?'<span class="execution-wait">等待模型返回…</span>':''}</li>`).join('')}</ol>`;
}
