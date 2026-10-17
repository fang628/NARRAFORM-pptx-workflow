import {progressSectionFields,progressSectionsOf,validateProgressSections,pageProgressSelector} from './progress-sections.js';
import {optionalPageCount} from './page-count.js';
import {materialLimits,pageLimits,supplementInfo,supplementImageDialog,supplementImageRequests} from './material-images.js';
import {rebuildRegionDialog,initRebuildRegionEditor} from './visual-ui.js';
import {themeAssetDialogs,themeDirectionOptions,themePromptReview} from './theme-assets.js';
import {apiTypes,createAPIAutosave,apiPersistenceMessage} from './api-config.js';
import {taskProgress,imageTaskChoices,imageTaskDialog,imageTaskOptions,taskChoicePayload,bindImageTaskSorting,projectResultKey,captureLiveView,restoreLiveView} from './task-progress.js';
import {initMaterialCropEditor,originalMaterialCount,imageOrigin,materialImageDialog,imageLibrary,extractionButtons,extractionReport} from './material-images.js';
import {visualConcepts,visualPreview,visualDelivery,visualDialogs,previewApprovalDialogContent,previewImageURL,layoutPreviewGrid,bindRebuildMentions,rebuildFeedbackRequest} from './visual-ui.js';
import {initialElements,setImageCaption} from '/elements-model.js';
import {contentPageCountNotice,pageDesignPanel,rememberDesignFeedback,markPageDesignDirty,reconstructionPanel,rememberDesignExpansion,saveAndConfirmPageDesigns,batchDesignResult} from './page-design.js';
import {elementEditor,collectElementSlide,syncCaptionFields,mutateElements,bindTreeInteractions,moveElementBranch,syncLegacy} from './element-editor.js';
import {initAIImageEditor,setPromptInput,sourcePanel,slideImage,promptButton,conceptPrompts,targetLabel,provenanceDialogs,rememberSourceExpansion,sourceTextView} from './provenance.js';
import {materialPanel,receivedMaterials,materialReaderSelector,queueRows,selectMaterialFiles,droppedMaterialFiles,bindMaterialPickers,uploadMaterialFile,selectionReport,rememberMaterialReportExpansion,layoutMaterialReports} from './materials.js';
const $=s=>document.querySelector(s), $$=s=>[...document.querySelectorAll(s)];
const h=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let p=null,tab=0,renderedTab=-1,renderedProject=null,editMode='revise',editIndex=0,pollTimer=null,toastTimer=null;
let selectionSummary=null,collectingMaterials=false,titlePageOptionAvailable=false,materialStreamingAvailable=false;
let archivePending=false,designBatchPending=false;
let renderedResultKey='',projectRequestRevision=0,activeTaskOrigin=null,liveDraftRecovery=[];
let deleteArchiveTarget=null,deleteArchivePending=false;
let sendQueue=[],materialDraft='',sending=false,treeUndo=null,readerMaterialId=null;
const documentRequests=new Map();let readerRevision=0;
async function loadDocumentFormat(m){
  if(!p?.documentFormatEnabled||m.richText||m.documentView||!m.file?.match(/\.(docx|pdf|md)$/i))return false;
  const projectId=p.id,key=projectId+':'+m.id;
  if(!documentRequests.has(key))documentRequests.set(key,api('/api/projects/'+projectId+'/materials/'+m.id+'/document').finally(()=>documentRequests.delete(key)));
  const view=await documentRequests.get(key);
  if(p?.id!==projectId)return false;const current=p.materials.find(v=>v.id===m.id);if(!current)return false;current.documentView=view;return true;
}
const sameBrief=b=>!!p&&Object.keys(p.brief).every(k=>p.brief[k]===b[k])&&(p.brief.cover!==false)===(b.cover!==false);
let sourceEditor=null,promptEditor=null,promptEditMode='direct';
document.body.insertAdjacentHTML('beforeend',provenanceDialogs+visualDialogs+materialImageDialog+themeAssetDialogs+imageTaskDialog+rebuildRegionDialog+supplementImageDialog);
const rebuildRegionEditor=initRebuildRegionEditor({getProject:()=>p,busy:()=>p?.task?.status==='running',act,onError:toast});
document.addEventListener('toggle',e=>{rememberMaterialReportExpansion(e.target);rememberSourceExpansion(e.target);rememberDesignExpansion(e.target);},true);
document.addEventListener('change',e=>{if(e.target.name==='visualTreatment'){const button=$('[data-theme-assets-generate]');if(button)button.textContent=e.target.value!==(p.visualTreatment||'flat')?'按所选类型规划三种风格 ↗':'规划 / 核对三种风格与底图 ↗';}if(e.target.id==='materialReaderSelect')safe(()=>readMaterial(e.target.value));});
let previewApprovalContext=null;
let visualEdit=null,imageLibraryEditor=null,themeAssetEdit=null,themeDirectionEdit=null;
function syncImageLibrary(){const d=$('#materialImageDialog');if(!d.open)return;if(!p||imageLibraryEditor?.projectId!==p.id||!p.slides[imageLibraryEditor.page]){d.close();return;}$('#materialImageLibrary').innerHTML=imageLibrary(p,imageLibraryEditor,busy());}
const steps=['需求与材料','逐页内容','视觉方案','全篇预览','导出交付'];
const stepCodes=['BRIEF & INPUT','CONTENT STUDIO','VISUAL SYSTEM','FULL PREVIEW','EXPORT & DELIVER'];
const stepIcons=['folder','content','visual','preview','download'];
const icon=name=>`<svg class="ui-icon" aria-hidden="true" focusable="false" viewBox="0 0 24 24"><use href="#ui-${name}"/></svg>`;
async function api(url,body){const r=await fetch(url,body===undefined?{}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const j=await r.json();if(!r.ok)throw Error(j.error||'请求失败');return j;}
function toast(message){$('#toast').textContent=message;$('#toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('#toast').hidden=true,6500);}
const busy=()=>p?.task?.status==='running';
const aiImageEditor=initAIImageEditor({getProject:()=>p,act,busy,openAPI,onError:toast});
const materialCropEditor=initMaterialCropEditor({getProject:()=>p,act,busy,onError:toast});
let supplementSubmitting=false;
document.addEventListener('submit',e=>{
  if(e.target.id!=='supplementImageForm')return;e.preventDefault();
  safe(async()=>{
    const form=e.target,dialog=$('#supplementImageDialog');
    if(supplementSubmitting||!form.reportValidity())return;
    if(dialog.dataset.projectId!==p?.id)throw Error('项目已切换，请重新打开补充图片');
    if(!p.analysisCurrent)throw Error('请先完成当前材料的识别与理解');
    if(!p.apiReady||!p.elementImageReady){openAPI();return;}
    const requests=supplementImageRequests({imageTypes:[...form.querySelectorAll('[name=imageTypes]:checked')].map(el=>el.value),instruction:form.elements.instruction.value,imageName:form.elements.imageName?.value||'',academicStyle:form.elements.academicStyle.checked,allowUpload:form.elements.allowUpload.checked});
    if((p.imageTaskQueue||[]).filter(t=>t.status==='queued').length+requests.length>20)throw Error('任务列表空间不足，请等待部分任务完成后再添加');
    const projectId=p.id;let added=0;supplementSubmitting=true;form.querySelector('[type=submit]').disabled=true;
    try{
      for(const request of requests){
        if(p?.id!==projectId)throw Error('项目已切换，剩余图片未添加');
        const {action,...body}=request;await act(action,body);added++;
        if(dialog.dataset.projectId===projectId)form.querySelector('[name=imageTypes][value="'+request.imageType+'"]').checked=false;
      }
      if(p?.id===projectId){dialog.close();toast(added+' 个补充图片任务已加入列表，完成后可从素材库插入内容树');}
    }catch(error){if(dialog.dataset.projectId===projectId)$('#supplementImageState').textContent=(added?'已添加 '+added+' 个任务；剩余未提交。':'')+error.message;throw error;}
    finally{supplementSubmitting=false;form.querySelector('[type=submit]').disabled=false;}
  });
});

const hasQueuedImages=()=>p?.imageTaskQueue?.some(t=>t.status==='queued');
const imageActions=new Set(['image','supplementImage','scientificImage','concepts','generateConceptPage','generateFullPreview','generateThemeAsset']);
const designActions=new Set(['content','designPage','revisePageDesign','draftPageDesigns']);
const imageAction=(action,extra)=>imageActions.has(action)||(action==='generateThemeAssets'&&Array.isArray(extra?.prompts))||(p?.designTaskQueueEnabled&&designActions.has(action));
const canAddWhileBusy=e=>e.matches("[data-rebuild-asset-instruction],[data-suggest-remove-asset]")||p?.imageTaskQueueEnabled&&(e.matches('[data-open-supplement],[data-generate-page],[data-retry-concept],[data-visual-prompt],[data-image-prompt],[data-theme-asset-prompt],[data-theme-assets-batch],[data-action=concepts],[data-action=generateFullPreview]')||(p.designTaskQueueEnabled&&e.matches('[data-action=content],[data-action=draftPageDesigns],[data-page-design-action=designPage],[data-page-design-action=revisePageDesign],[data-design-feedback]')));
const preview=(i=0,theme='')=>previewImageURL(p,i,theme);
function empty(title,text){return `<div class="panel empty"><span class="eyebrow">ONE STEP AT A TIME</span><h2>${h(title)}</h2><p>${h(text)}</p><button class="secondary" data-nav="${Math.max(tab-1,0)}">返回上一步 ←</button></div>`;}
let progressSnapshot='',queueSorting=false;
bindImageTaskSorting($('#taskProgressBody'),{canSort:()=>!!p?.imageTaskReorderEnabled&&!queueSorting,getTasks:()=>p?.imageTaskQueue||[],onBusyChange:value=>{queueSorting=value;if(!value)syncTaskProgress();},onMove:move=>safe(async()=>{
  const projectId=p.id;try{await act('moveQueuedImageTask',move);toast('任务顺序已保存');}catch(error){const fresh=await api('/api/projects/'+projectId);if(p?.id===projectId)p=fresh;throw error;}
})});
function syncTaskProgress(){
  $('#taskProgressButton').hidden=!p?.task&&!p?.imageTaskQueueEnabled;$('#imageTaskAddButton').hidden=!p?.imageTaskQueueEnabled;
  if(!$('#taskProgressDialog').open||queueSorting)return;
  const body=$('#taskProgressBody'),snapshot=JSON.stringify([p?.task,p?.imageTaskQueue]),atBottom=body.scrollHeight-body.scrollTop-body.clientHeight<60;
  if(snapshot!==progressSnapshot||busy()){
    const position=progressSnapshot?body.scrollTop:0,follow=!!progressSnapshot&&atBottom,expanded=new Set([...body.querySelectorAll('[data-job-id]:has(details[open])')].map(el=>el.dataset.jobId));body.innerHTML=taskProgress(p?.task,Date.now(),p?.imageTaskQueue,p?.imageTaskQueueEnabled,p?.imageTaskReorderEnabled);progressSnapshot=snapshot;
    body.querySelectorAll('[data-job-id]').forEach(el=>{if(expanded.has(el.dataset.jobId)&&el.querySelector('details'))el.querySelector('details').open=true;});
    body.scrollTop=follow?body.scrollHeight:position;
  }
}
setInterval(()=>{if($('#taskProgressDialog').open)syncTaskProgress();},1000);
function nav(){syncArchiveButton();syncTaskProgress(); $('#steps').innerHTML=steps.map((s,i)=>`<button class="nav-step ${tab===i?'active':''}" data-nav="${i}"><span class="step-icon" aria-hidden="true">${icon(stepIcons[i])}</span><span class="number">${String(i+1).padStart(2,'0')}</span><span class="nav-label">${s}<small>${stepCodes[i]}</small></span>${p&&p.stage>=[1,3,5,6,7][i]?'<span class="check">'+icon('check')+'</span>':''}</button>`).join('');$('#projectName').textContent=p?.brief.title||'新的演示';$('#apiDot').classList.toggle('ready',!!p?.apiReady);$('#taskBar').hidden=!busy();if(busy())$('#taskLabel').textContent=(p.task.message||p.task.label)+(hasQueuedImages()?' · 等待 '+p.imageTaskQueue.filter(t=>t.status==='queued').length+' 个任务':'');}
function heading(eyebrow,title,subtitle,actions=''){
  const code=String(tab+1).padStart(2,'0');
  return `<section class="command-panel"><div class="surface-ornament" aria-hidden="true"><div class="ornament-contours"></div><div class="ornament-dots"></div><div class="ornament-lines"></div><div class="ornament-corner"></div></div><div class="command-top"><span><i></i> PRESENTATION MANAGEMENT</span><span>WORKFLOW ${code} / 05 <b>${icon('visual')}</b></span></div><div class="page-head"><div><span class="eyebrow">${eyebrow}</span><h1>${title}</h1><p>${subtitle}</p></div>${actions}<span class="phase-number" aria-hidden="true">${code}</span></div><div class="command-bottom"><span><b>${String(p?.slides.length||p?.brief.pages||0).padStart(2,'0')}</b> 演示页数</span><span><b>${String(p?.materials.length||0).padStart(2,'0')}</b> 登记材料</span><span><b>${String(p?.version||1).padStart(2,'0')}</b> 当前版本</span><span class="command-status">${p?.demo?'示例项目':'本地项目'} <i></i></span></div></section>`;
}
function intake(){const b=p?.brief||{pages:null,language:'中文',progress:true,toc:true};return `${!p?`<div class="hero hub-hero"><div class="archive-watermark" aria-hidden="true"><span>01</span><small>FORM FOLLOWS FUNCTION</small></div><div class="surface-ornament" aria-hidden="true"><div class="ornament-contours"></div><div class="ornament-dots"></div><div class="ornament-lines"></div><div class="ornament-corner"></div></div><div class="hero-copy"><span class="eyebrow">PPT 创作工作台</span><h1>把想法，<br>讲清楚。</h1><p>整理材料，打磨内容，生成可编辑的演示文稿。</p><div class="hero-bottom"><span class="hero-caution">◈</span> LOCAL WORKSPACE / READY</div></div><div class="hub-stats"><span>工作流阶段 <b>05</b></span><span>输出比例 <b>16:9</b></span><span>运行位置 <b>LOCAL</b></span></div></div>`:heading('01 / BRIEF & MATERIALS','定义演示任务。','确认需求和材料后，再开始生成内容。',`<span class="tag">${p.demo?'示例项目 · 无 API 调用':'本地项目 · 已自动保存'}</span>`)}
${p?materialPanel(p,icon,sendQueue,materialDraft,selectionSummary):''}<form id="briefForm"><section class="panel"><div class="panel-heading"><div><h3>这次，你想讲什么？</h3><p class="subtle">把目标说清楚，让内容与设计围绕它展开。</p></div><span class="tag">16:9 宽屏</span></div><label>演示文稿主题<input name="title" required maxlength="120" value="${h(b.title)}" placeholder="例如：2026 年产品战略与增长计划"></label><div class="form-grid"><label>面向的听众<input name="audience" value="${h(b.audience)}" placeholder="例如：管理团队、客户、研究评审"></label><label>目标页数<input name="pages" type="number" min="${pageLimits.min}" max="${pageLimits.max}" step="1" value="${b.pages??''}" placeholder="留空，理解材料后建议页数"></label></div><label>目标与补充说明<textarea name="purpose" rows="3" placeholder="希望听众理解什么？需要突出哪些结论？有哪些风格偏好？">${h(b.purpose)}</textarea></label><label>输出语言<select name="language">${['中文','English','中英双语'].map(x=>`<option ${x===b.language?'selected':''}>${x}</option>`).join('')}</select></label><div class="checkboxes">${[['cover','包含标题页'],['toc','包含目录'],['thanks','包含致谢'],['progress','页顶进度条'],['speaker','生成演讲备注']].map(([k,t])=>`<label class="checkbox"><input type="checkbox" name="${k}" ${(k==='cover'?b.cover!==false:b[k])?'checked':''} ${k==='cover'&&!titlePageOptionAvailable?'disabled title="服务更新后启用"':''}>${t}</label>`).join('')}</div><p id="singlePageHint" class="subtle" hidden>单页模式：可制作内容页或封面，不额外添加目录和致谢页。</p><div class="divider"></div><div class="actions">${!p?'<button type="button" class="text-button" id="demo">先体验示例项目 ↗</button>':''}<button class="primary" type="submit">${p?'保存需求，进入内容 →':'创建项目 →'}</button></div></section></form>${!p?materialPanel(null,icon,sendQueue,materialDraft,selectionSummary):''}`;}
function content(){if(!p?.approvals.requirements)return empty('先把需求准备好','回到第一步，确认主题、受众与材料。');return heading('02 / CONTENT STUDIO','构建内容结构。','AI 先完成文案、内容树与单页设计稿，你可以直接修改并逐页确认。',`<div class="actions content-studio-actions">${p.supplementImagesEnabled?'<button class="secondary" type="button" data-open-supplement>＋ 补充图片</button>':''}<button class="secondary" data-action="content">${p.contentDraftAvailable?'继续调整 AI 初稿':p.slides.length?'重新生成 AI 初稿':'AI 生成内容与设计'} ↗</button>${p.slides.length?'<button class="secondary" data-action="draftPageDesigns">补齐 AI 设计稿 ↗</button><button class="primary" id="saveApprove">保存并确认内容与设计 →</button>':''}</div>`)+`<div class="notice">${p.demo?'当前是固定示例内容，没有调用 AI。':(p.analysisCurrent&&p.analysis?.approvedAt?'已结合确认后的材料理解；请继续核对事实与配图。':'发送材料后，请回到第一步识别并确认材料理解。')} ${p.approvals.content===p.version?'当前版本内容已确认。':'当前版本等待确认。'}</div>`+contentPageCountNotice(p)+batchDesignResult(p)+(p.slides.length?`<form id="slidesForm">${p.slides.map((s,i)=>`<section class="panel slide-editor" data-slide="${i}"><div class="slide-summary"><div class="slide-number">SLIDE ${String(i+1).padStart(2,'0')} / ${p.slides.length}</div>${p.pageDesigns?.[i]?.layoutCurrent?'<span class="tag content-confirmed-state">✓ 本页内容已确认</span>':''}<p class="subtle">${s.sources.length?'来源：'+s.sources.map(id=>h(p.materials.find(m=>m.id===id)?.name||id)).join('、'):'来源：用户说明／待核实'}</p></div><div class="editor-fields">${elementEditor(p,s,i)}${pageDesignPanel(p,i)}<div class="form-grid"><label>页型<select data-field="kind">${[['cover','封面 / 标题页'],['toc','目录'],['content','内容'],['section','章节']].map(([k,n])=>`<option value="${k}" ${k==='toc'&&p.executionConcurrency===undefined?'disabled':''} ${s.kind===k?'selected':''}>${n}</option>`).join('')}</select></label>${pageProgressSelector(p,s)}<label>演讲备注<textarea data-field="notes" rows="2">${h(s.notes)}</textarea></label></div>${sourcePanel(p,s,i)}<div class="editor-toolbar"><button type="button" class="text-button" data-revise="${i}">${icon('spark')} 用 AI 修改此页</button><button type="button" class="text-button" data-move="${i},-1" ${i===0?'disabled':''}>↑ 上移</button><button type="button" class="text-button" data-move="${i},1" ${i===p.slides.length-1?'disabled':''}>↓ 下移</button><button type="button" class="text-button danger" data-delete="${i}">删除</button></div></div></section>`).join('')}<div class="actions"><button class="secondary" type="submit">保存内容</button><button class="secondary" type="button" id="addSlide">＋ 添加一页</button></div></form>`:`<div class="panel empty"><h2>内容工作台已经准备好了</h2><p>连接文字 API，让模型围绕你的目标生成逐页内容。</p><button class="primary" data-action="content">生成逐页内容 ↗</button></div>`);}
function concepts(){return visualConcepts(p,heading,empty);}
function fullPreview(){return visualPreview(p,heading,empty,sourcePanel);}
function delivery(){return visualDelivery(p,empty,icon,heading);}
function render({keepView=false}={}){
  const changed=renderedTab!==tab||renderedProject!==(p?.id||null),main=$('#main');
  const view=keepView&&!changed?captureLiveView(main):null,scroll=view?{x:window.scrollX,y:window.scrollY}:null;
  if(changed)liveDraftRecovery=[];
  if(view)view.drafts=[...new Map([...liveDraftRecovery,...view.drafts].map(d=>[d.key,d])).values()];
  nav();main.classList.remove('page-enter');
  main.innerHTML=[intake,content,concepts,fullPreview,delivery][tab]();
  const reuse=p?.downstreamReuse;if(reuse?.pending)main.insertAdjacentHTML('afterbegin',`<section class="downstream-update notice" role="status"><div><strong>前置内容已更新</strong><p>可以按新要求重新生成，也可以沿用原布局与图片，仅同步最新文案。</p></div><button class="secondary" data-action="reuseDownstream">跳过重生成 · 同步文案 →</button></section>`);else if(reuse?.last)main.insertAdjacentHTML('afterbegin',`<section class="downstream-update notice"><div><strong>已沿用原布局与图片</strong><p>新文案已同步到设计稿${reuse.last.nativeTextSynced?'和可编辑元素':''}。旧整页图仅作布局参考，最终以最新文字的 PPT 渲染为准。</p>${reuse.last.skipped.length?`<details><summary>部分页面需另行处理</summary><ul>${reuse.last.skipped.map(s=>`<li>${h(s)}</li>`).join('')}</ul></details>`:''}</div></section>`);
  $$('#main .panel').forEach((panel,i)=>{
    const label=['FORM / FIELD','LINE / SURFACE','GRID / STUDY','FRAME / SEQUENCE'][i%4];
    const strip=document.createElement('div');strip.className='dossier-strip';strip.setAttribute('aria-hidden','true');
    strip.innerHTML=`<span class="dossier-tab"><b>${String(i+1).padStart(2,'0')}</b>${label}</span><span class="dossier-rule" aria-hidden="true"></span><span class="dossier-code">DESIGN SERIES / ${String(i+1).padStart(2,'0')}</span>`;
    const watermark=document.createElement('span');watermark.className='dossier-watermark';watermark.setAttribute('aria-hidden','true');watermark.textContent=String(i+1).padStart(2,'0');
    panel.prepend(watermark);
    panel.prepend(strip);
  });
  $$('#main .panel,#main .concept-info,#main .preview-caption,#main .delivery').forEach(surface=>{
    const mark=document.createElement('div');mark.className='surface-footmark';mark.setAttribute('aria-hidden','true');
    surface.append(mark);
  });
  if(busy()||sending)$$('#main button,#main input,#main textarea,#main select').forEach(e=>{if(sending||!canAddWhileBusy(e))e.disabled=true;});
  $$('#themeAssetPromptDialog textarea,#themeAssetPromptDialog button:not([data-close]),#themePromptReviewDialog textarea,#themePromptReviewDialog button:not([data-close]),#themeDirectionDialog textarea,#themeDirectionDialog select,#themeDirectionDialog button:not([data-close])').forEach(el=>el.disabled=busy()&&!(p?.imageTaskQueueEnabled&&el.matches('#themeAssetPromptText,#themeAssetInstruction,#regenerateThemeAsset,#confirmThemePrompts,[data-theme-review-prompt],[data-theme-review-instruction]')));
  $('#themePromptReviewDialog [data-theme-prompts-regenerate]').disabled=busy()||!p?.themePromptRegeneration||!p?.themeAssetsCurrent;
  if(busy()&&p.task.label==='重新规划三种风格与提示词')$$('#themePromptReviewDialog textarea,#themePromptReviewDialog button:not([data-close])').forEach(el=>el.disabled=true);
  const restored=view?restoreLiveView(main,view):null;
  if(restored){liveDraftRecovery=restored.missing;for(const field of restored.restored){const slide=field.closest('[data-slide]');if(slide&&field.matches('[data-node-field],[data-field],[data-image-caption],[data-caption-role]')){markPageDesignDirty(slide);const state=slide.querySelector('.element-save-state');if(state)state.textContent='已保留未保存修改，点击「保存字段内容」应用。';}}
    if(liveDraftRecovery.length)main.insertAdjacentHTML('beforeend',`<details data-live-recovery class="notice"><summary>保留的未提交编辑 · ${liveDraftRecovery.length} 项</summary><p>AI 更新了原字段结构，以下修改保留供你复制使用。</p>${liveDraftRecovery.map(d=>`<label>${h(d.label)}<textarea readonly rows="2">${h(d.check?String(d.checked):d.value)}</textarea></label>`).join('')}</details>`);
  }
  layoutMaterialReports(main);
  layoutPreviewGrid(main);bindRebuildMentions(main,()=>p);
  bindForms();syncSinglePageOptions();aiImageEditor.refresh();syncPromptUI();syncTreeUndo();syncAPIStatus();syncImageLibrary();
  if(changed){window.scrollTo(0,0);void main.offsetWidth;main.classList.add('page-enter');}
  if(restored){restored.focus();window.scrollTo(scroll.x,scroll.y);}
  renderedTab=tab;renderedProject=p?.id||null;renderedResultKey=projectResultKey(p);
  schedulePoll();
}
async function refreshProjects(){const [list,archived]=await Promise.all([api('/api/projects'),api('/api/projects?archived=true')]);$('#projects').innerHTML='<option value="">选择项目</option>'+list.map(x=>`<option value="${x.id}" ${x.id===p?.id?'selected':''}>${h(x.demo?'[示例] '+x.title:x.title)}</option>`).join('');$('#archiveCount').textContent=archived.length;$('#projectArchiveList').innerHTML=archived.length?archived.map(x=>`<article class="archived-project"><div><h3>${h(x.demo?'[示例] '+x.title:x.title)}</h3><p>${x.pages} 页 · ${x.materials} 份材料 · ${h(new Date(x.archivedAt).toLocaleDateString('zh-CN'))} 归档</p></div><div class="archived-project-actions"><button type="button" class="secondary" data-restore-project="${h(x.id)}">恢复项目 ↗</button><button type="button" class="text-button archive-delete" data-delete-project="${h(x.id)}" data-project-title="${h(x.title)}" aria-label="删除归档项目：${h(x.title)}">删除</button></div></article>`).join(''):'<div class="archive-empty">暂无归档项目</div>';syncArchiveButton();}
function syncArchiveButton(){const button=$('#archiveProject');button.disabled=!p||busy()||sending||collectingMaterials||archivePending||designBatchPending;button.title=busy()?'任务执行中，请完成或取消后归档':'归档后可在「已归档」中恢复';}
async function load(id){$('#supplementImageDialog').close();$('#supplementImageForm').reset();delete $('#supplementImageDialog').dataset.projectId;rebuildRegionEditor.close();projectRequestRevision++;activeTaskOrigin=null;aiImageEditor.close();materialCropEditor.close();$('#addImageTaskDialog').close();$('#themePromptReviewDialog').close();$('#themeAssetPromptDialog').close();$('#themeDirectionDialog').close();themeAssetEdit=null;themeDirectionEdit=null;$('#materialImageDialog').close();$('#materialReader').close();$('#imagePromptDialog').close();$('#sourceDialog').close();sendQueue=[];selectionSummary=null;materialDraft='';p=await api('/api/projects/'+id);if(p.archivedAt){p=null;throw Error('此项目已归档，请在「已归档」中恢复');}localStorage.setItem('ppt-agent-project',id);tab=p.stage>=6?4:p.stage>=5?3:p.stage>=4?2:p.stage>=1?1:0;render();await refreshProjects();}
async function act(action,extra={},next){if(!p)throw Error('请先创建项目');const queued=busy()&&imageAction(action,extra);projectRequestRevision++;p=await api(`/api/projects/${p.id}/action`,{action,...extra});if(next!==undefined)tab=next;if(p.task?.status==='running'&&activeTaskOrigin?.id!==p.task.id)activeTaskOrigin={id:p.task.id,tab};render();if(queued)toast('已加入任务列表，等待当前批次完成');return p;}
async function safe(fn){try{await fn();}catch(e){toast(e.message);}}
function schedulePoll(){
  clearTimeout(pollTimer);if(!p)return;const id=p.id,revision=projectRequestRevision;
  pollTimer=setTimeout(async()=>{
    try{
      const fresh=await api('/api/projects/'+id);if(p?.id!==id||revision!==projectRequestRevision)return;
      const previous=p.task,ended=previous?.status==='running'&&fresh.task?.status!=='running',changed=projectResultKey(fresh)!==renderedResultKey;
      p=fresh;aiImageEditor.refresh();
      if(ended){
        finishPromptTask();
        if(visualEdit&&$('#visualPromptDialog').open&&p.task.label==='改写整页生图提示词'&&p.task.status==='done'){
          const page=visualEdit.kind==='concept'?p.concepts.find(c=>c.id===visualEdit.theme)?.representatives.find(r=>r.index===visualEdit.index):p.visualPages[visualEdit.index];
          if(page){setPromptInput($('#visualPromptText'),page.promptDraft);$('#visualPromptState').textContent='草稿已改写，请核对后重新生图。';}
        }
        if(themeAssetEdit&&p.task.label==='改写底图提示词')finishThemePromptRewrite();
        if(p.task.label==='重新规划三种风格与提示词'&&p.task.status!=='done'&&$('#themePromptReviewDialog').open)$('#themePromptReviewState').textContent='重生成未完成：'+p.task.message;
        if(readerMaterialId&&$('#materialReader').open&&p.task.resultMaterialId===readerMaterialId)readMaterial(readerMaterialId);
        toast(p.task.message);
        if(p.task.status==='done'&&activeTaskOrigin?.id===p.task.id&&tab===activeTaskOrigin.tab){
          if(p.task.label==='识别与理解材料')tab=0;
          else if(['生成三方向主题底图','改写底图提示词','更换方向底图风格','按当前风格重新生成底图','规划三方向底图提示词','准备底图重生提示词','重新规划三种风格与提示词'].includes(p.task.label))tab=2;
          else if(p.task.label==='提取元素并重组全篇')tab=3;
          else if(p.stage===2)tab=1;else if(p.stage===4)tab=2;else if(p.stage===7)tab=4;
        }
      }
      if(changed||ended)render({keepView:true});else{nav();syncImageLibrary();}
      if(ended&&p.task.label==='重新规划三种风格与提示词'&&p.task.status==='done'&&tab===2&&activeTaskOrigin?.id===p.task.id)openThemePromptReview();
    }catch(e){toast('同步结果暂时失败，将自动重试：'+e.message);}
    finally{if(p?.id===id)schedulePoll();}
  },busy()||hasQueuedImages()?1100:3000);
}
async function create(brief,demo=false,progressSections){if(!demo&&progressSections===undefined&&$('[data-progress-section-fields]'))progressSections=progressSectionsDraft();projectRequestRevision++;activeTaskOrigin=null;p=await api('/api/projects',{brief,demo,...(progressSections?{progressSections}:{})});localStorage.setItem('ppt-agent-project',p.id);tab=demo?2:0;render();await refreshProjects();}
function openThemePromptReview(){
  const pending=p.themeAssetPrompts.filter(e=>e.status!=='generated');
  $('#themePromptReviewBody').innerHTML=themePromptReview(p,pending.length?pending:p.themeAssetPrompts);
  $$('[data-theme-review-prompt]').forEach(input=>{const entry=p.themeAssetPrompts.find(e=>e.theme===input.dataset.theme&&e.use===input.dataset.use),value=input.value;setPromptInput(input,entry?.previousPrompt||value,{reset:true});if(entry?.previousPrompt)setPromptInput(input,value);});
  $('#themePromptReviewState').textContent='';$('#themePromptReviewDialog').showModal();
}
function finishThemePromptRewrite(){
  if(p.task.status!=='done'){const state=themeAssetEdit.batch?$$('[data-theme-review]').find(el=>el.dataset.themeReview===themeAssetEdit.theme+':'+themeAssetEdit.use)?.querySelector('[data-theme-review-state]'):$('#themeAssetPromptState');if(state)state.textContent='改写未完成：'+p.task.message;return;}
  const entry=p.themeAssetPrompts.find(e=>e.theme===themeAssetEdit.theme&&e.use===themeAssetEdit.use);if(!entry)return;
  themeAssetEdit.revision=entry.revision;
  if(themeAssetEdit.batch){
    const item=$$('[data-theme-review]').find(el=>el.dataset.themeReview===entry.theme+':'+entry.use);if(!item)return;
    const input=item.querySelector('[data-theme-review-prompt]');setPromptInput(input,entry.prompt);input.dataset.revision=entry.revision;
    item.querySelector('[data-theme-review-instruction]').value='';item.querySelector('[data-theme-review-state]').textContent='AI 已补充完整提示词，请核对后确认';
  }else if($('#themeAssetPromptDialog').open){
    setPromptInput($('#themeAssetPromptText'),entry.prompt);$('#themeAssetInstruction').value='';$('#themeAssetPromptState').textContent='AI 已补充完整提示词，请核对或直接编辑后确认';
  }
}
async function prepareThemeAssetGeneration(){
  if(sendQueue.length||materialDraft.trim())throw Error('请先发送待处理材料，再生成底图');
  const form=$('#briefForm');
  if(form){if(!form.reportValidity())throw Error('请先补全演示需求');const brief=readBrief(form);if(!sameBrief(brief))await act('requirements',{brief},0);}
}
function syncSinglePageOptions(){
  const form=$('#briefForm');if(!form)return;const single=Number(form.elements.pages.value)===1;
  for(const key of ['toc','thanks']){const input=form.elements[key];
    if(single){if(input.dataset.singleSaved===undefined)input.dataset.singleSaved=String(input.checked);input.checked=false;}
    else if(input.dataset.singleSaved!==undefined){input.checked=input.dataset.singleSaved==='true';delete input.dataset.singleSaved;}
    input.disabled=single||busy()||sending;
  }
  $('#singlePageHint').hidden=!single;
}
function readProgressSections(){const fields=$$('[data-progress-section]');return fields.length?validateProgressSections(fields.map(el=>el.value)):progressSectionsOf(p);}
function progressSectionsDraft(){const sections=readProgressSections();return JSON.stringify(sections)===JSON.stringify(progressSectionsOf(p))?undefined:sections;}
function readBrief(form){const f=new FormData(form);return {title:f.get('title'),audience:f.get('audience'),pages:optionalPageCount(f.get('pages')),purpose:f.get('purpose'),language:f.get('language'),toc:Number(f.get('pages'))!==1&&f.has('toc'),thanks:Number(f.get('pages'))!==1&&f.has('thanks'),progress:f.has('progress'),speaker:f.has('speaker'),cover:!titlePageOptionAvailable||f.has('cover')};}
function collectSlides(materializeIndex=-1){return $$('[data-slide]').map(el=>{
  const i=Number(el.dataset.slide);let s=collectElementSlide(el,p.slides[i]);
  if(!p.slides[i].elements&&i!==materializeIndex&&JSON.stringify(s.elements)===JSON.stringify(initialElements(p.slides[i])))s=structuredClone(p.slides[i]);
  el.querySelectorAll('[data-field]').forEach(f=>{
    const key=f.dataset.field;
    const original=key==='body'?s.body.join('\n'):String(s[key]??'');
    const displayed=f.tagName==='INPUT'?original.replace(/[\r\n]/g,''):original;
    if(f.value===displayed)return;
    s[key]=key==='body'?f.value.split('\n').map(t=>t.trim()).filter(Boolean):key==='imageId'?(f.value||null):f.value;
  });if(s.imageId!==p.slides[i].imageId){const removed=(s.sourceLinks||[]).filter(l=>l.target==='image');s.sourceLinks=(s.sourceLinks||[]).filter(l=>l.target!=='image');s.sources=s.sources.filter(id=>!removed.some(l=>l.materialId===id)||s.sourceLinks.some(l=>l.materialId===id));}return s;
});}
async function saveSlides(){const slides=collectSlides();if(JSON.stringify(slides)!==JSON.stringify(p.slides))await act('saveContent',{slides});toast('内容已保存');}
function syncTreeUndo(){for(const b of $$('[data-tree-undo]'))b.disabled=!(treeUndo&&treeUndo.projectId===p?.id&&treeUndo.version===p?.version&&treeUndo.page===Number(b.dataset.treeUndo));}
function bindForms(){
  const count=$('#progressSectionCount');if(count)count.onchange=()=>{const values=$$('[data-progress-section]').map(el=>el.value),n=Number(count.value);while(values.length<n)values.push(['后续安排','补充内容','拓展与展望'].find(title=>!values.includes(title))||'补充章节'+(values.length+1));$('[data-progress-section-fields]').innerHTML=progressSectionFields(values.slice(0,n).map((title,i)=>({id:'section-'+(i+1),title})));};
  const pages=$('#briefForm input[name="pages"]');if(pages)pages.oninput=syncSinglePageOptions;
  bindTreeInteractions($('#main'),{canDrag:()=>!busy()&&!sending,getNodes:i=>initialElements(collectSlides()[i]),onMove:(page,id,target,position)=>safe(async()=>{
    const previous=collectSlides(),slides=collectSlides(page);slides[page].elements=moveElementBranch(slides[page].elements,id,target,position);syncLegacy(slides[page]);
    await act('saveContent',{slides});treeUndo={projectId:p.id,version:p.version,slides:previous,page};syncTreeUndo();toast('分支已移动，关系与成品预览已更新');
  })});
  const form=$('#briefForm');if(form)form.onsubmit=e=>{e.preventDefault();safe(async()=>{
    if(sendQueue.length||materialDraft.trim())throw Error('还有待发送材料，请先点击“发送材料”');
    if($('#analysisNotes')&&($('#analysisNotes').value!==(p.analysis.reviewNotes||'')||$$('[data-analysis-title]').some((el,i)=>el.value.trim()!==p.analysis.outline[i].title)))throw Error('材料理解或内容主题有未保存修改，请先点击“保存修改并确认”');
    const b=readBrief(form),progressSections=progressSectionsDraft();if(!p)await create(b,false,progressSections);else{
      await act('requirements',{brief:b,...(progressSections?{progressSections}:{})});
      if(p.materials.some(m=>!m.generated)&&(!p.analysisCurrent||!p.analysis?.approvedAt)){tab=0;render();toast('需求已保存，请先识别并确认材料理解');$('#materialAnalysis')?.scrollIntoView({behavior:'smooth',block:'start'});}
      else{tab=1;render();}await refreshProjects();
    }
  });};
  const sf=$('#slidesForm');if(sf){sf.onsubmit=e=>{e.preventDefault();if(!designBatchPending)safe(()=>saveSlides());};sf.oninput=e=>{
    const el=e.target.closest('[data-slide]');if(e.target.matches('[data-design-feedback]')){rememberDesignFeedback(p.id,Number(e.target.dataset.designFeedback),e.target.value);return;}if(e.target.matches('[data-design-markdown]')){const panel=e.target.closest('[data-page-design]');panel.querySelector('[data-design-state]').textContent='设计说明有未保存修改';return;}if(!el||!e.target.matches('[data-field],[data-node-field],[data-image-caption],[data-caption-role]'))return;syncCaptionFields(el,e.target);treeUndo=null;syncTreeUndo();markPageDesignDirty(el);const status=el.querySelector('.element-save-state');if(status)status.textContent='有未保存修改，点击「保存字段内容」应用。';const i=Number(el.dataset.slide),s=collectSlides()[i];
    s.sourceLinks=(s.sourceLinks||[]).map(l=>({...l,stale:l.boundText!==undefined&&l.boundText!==slideTarget(s,l.target)}));
    el.querySelector('.source-relations').outerHTML=sourcePanel(p,s,i);
  };}
  const selectionProjectId=p?.id;
  bindMaterialPickers($('#main'),{enqueue:queueFiles,canSelect:()=>selectionProjectId===p?.id&&!busy()&&!sending&&!collectingMaterials});
  const draft=$('#pasteText');if(draft)draft.oninput=()=>materialDraft=draft.value;
  const analysis=$('#materialAnalysis');if(analysis)analysis.oninput=e=>{if(e.target.matches('[data-analysis-title],#analysisNotes'))$('#approveAnalysis').innerHTML=icon('check')+' 保存修改并确认';};
  const drop=$('.upload-zone');if(drop){drop.ondragover=e=>{e.preventDefault();if(!busy()&&!sending)drop.classList.add('drag-over');};drop.ondragleave=()=>drop.classList.remove('drag-over');drop.ondrop=e=>{e.preventDefault();drop.classList.remove('drag-over');if(busy()||sending||collectingMaterials)return;const projectId=p?.id;collectingMaterials=true;safe(async()=>{try{const files=await droppedMaterialFiles(e.dataTransfer);if(projectId!==p?.id)throw Error('项目已切换，请在当前项目重新选择文件夹');queueFiles(files);}finally{collectingMaterials=false;}});};}
}
function updateQueue(){const el=$('#sendQueue');if(el)el.innerHTML=queueRows(sendQueue);const status=$('#sendStatus');if(status&&!sending)status.textContent=sendQueue.length?`${sendQueue.length} 个文件待发送`:'材料先保存到本机；识别时才发送给你的模型。';}
function queueFiles(files){
  if(sending||busy())return;selectionSummary=selectMaterialFiles(files,sendQueue,originalMaterialCount(p));sendQueue.push(...selectionSummary.added);updateQueue();const report=$('#selectionReport');if(report)report.innerHTML=selectionReport(selectionSummary);
}
async function sendMaterials(){
  if(collectingMaterials)throw Error('正在读取文件夹，请稍候');
  if(sending||busy())return;
  materialDraft=$('#pasteText')?.value||materialDraft;
  if(!sendQueue.length&&!materialDraft.trim())throw Error('请选择文件或填写文字材料');
  const form=$('#briefForm');if(!form.reportValidity())return;
  const brief=readBrief(form);
  if(originalMaterialCount(p)+sendQueue.length+(materialDraft.trim()?1:0)>materialLimits.count)throw Error(`材料总数超过 ${materialLimits.count} 份，请先移除部分文件`);
  sending=true;$$('#main button,#main input,#main textarea,#main select').forEach(e=>e.disabled=true);
  let succeeded=0,failed=0;
  try{
  if(!p)await create(brief);else if(!sameBrief(brief))await act('requirements',{brief},0);
  if(materialDraft.trim()){
    sendQueue.push({id:crypto.randomUUID(),file:new File([materialDraft],'文字材料-'+new Date().toISOString().replace(/[:.]/g,'-')+'.txt',{type:'text/plain'}),status:'queued',fromText:true});
    materialDraft='';$('#pasteText').value='';
  }
  const projectId=p.id;
    for(const q of sendQueue){
      if(q.status==='sent')continue;q.status='sending';q.error='';updateQueue();$('#sendStatus').textContent='正在发送：'+q.file.name;
      try{
        p=await uploadMaterialFile(projectId,q,fetch,materialStreamingAvailable);q.status='sent';succeeded++;
      }catch(e){q.status='failed';q.error=e.message;failed++;}updateQueue();
    }
  }finally{sendQueue=sendQueue.filter(q=>q.status!=='sent');selectionSummary=null;sending=false;tab=0;render();await refreshProjects();}
  toast(`已发送 ${succeeded} 份材料${failed?`，${failed} 份失败，可重新发送`:'，可以开始识别与理解'}`);
  $('#materialInbox')?.scrollIntoView({behavior:'smooth',block:'start'});
}
function readMaterial(id,linkId,slideIndex,range){const m=p.materials.find(m=>m.id===id);if(!m)return;readerMaterialId=id;
  const revision=++readerRevision;
  loadDocumentFormat(m).then(loaded=>{if(loaded&&readerRevision===revision&&$('#materialReader').open)readMaterial(id,linkId,slideIndex,range);}).catch(error=>{if(readerRevision===revision&&$('#materialReader').open)$('#materialReaderBody').insertAdjacentHTML('afterbegin','<p class="subtle">格式补读失败：'+h(error.message)+'</p>');});
  const links=slideIndex===undefined?p.slides.flatMap(s=>s.sourceLinks||[]):p.slides[Number(slideIndex)]?.sourceLinks||[];
  let link=linkId?links.find(l=>l.id===linkId&&l.materialId===id):null;
  if(link&&range&&Number.isInteger(range.start)&&Number.isInteger(range.end)&&range.start>=0&&range.end>range.start&&range.end<=m.text?.length)link={...link,quote:m.text.slice(range.start,range.end),location:range};
  const view=sourceTextView(m,link),location=view.location;
  $('#materialReaderTitle').textContent=m.name;
  const position=location?(location.page?'第 '+location.page+' 页 · ':'')+'提取文字第 '+location.line+' 行 · 已定位引用':view.missing?'当前材料中未找到原摘录，请重新核对对应关系':'';
  const textBody='<p class="subtle">提取文字 '+(m.text?.length||0).toLocaleString()+' 字'+(m.truncated?' · 原文超长，已截取前 120,000 字':'')+'</p>'+(position?'<p class="source-reader-position" role="status">'+h(position)+'</p>':'')+'<div class="source-document">'+view.html+'</div>';
  $('#materialReaderBody').innerHTML=materialReaderSelector(p,id)+(m.kind==='image'?'<img src="/api/projects/'+p.id+'/assets/'+m.id+'" alt="'+h(m.name)+'">'+(m.generated?promptButton(m.id):'')+'<p class="subtle">'+(m.generated?supplementInfo(m)?'AI 补充图片 · 依据材料生成':'AI 概念插画':'原始图片')+'</p>'+(link?.quote?textBody:''):textBody);
  if(supplementInfo(m))$('#materialReaderBody').insertAdjacentHTML('beforeend',`<p>${h(supplementInfo(m).caption)}</p><p class="subtle">依据材料：${supplementInfo(m).sourceMaterialIds.map(id=>`<button type="button" class="text-button" data-read-material="${h(id)}">${h(p.materials.find(v=>v.id===id)?.name||id)} ↗</button>`).join('、')}</p>`);
  if(m.extracted)$('#materialReaderBody').insertAdjacentHTML('beforeend',`<p class="subtle">来源：${h(imageOrigin(m))} · ${m.extractionMethod==='manual-crop'?'手动裁片，原图完整保留':m.extractionMethod==='region-crop'?'原图裁片，请核对内容完整性':'文档嵌入原图'}</p>`);$('#materialReaderBody').insertAdjacentHTML('beforeend',extractionButtons(m,busy())+extractionReport(m));if(!$('#materialReader').open)$('#materialReader').showModal();requestAnimationFrame(()=>{const mark=$('#sourceQuoteMark');if(mark){mark.focus({preventScroll:true});mark.scrollIntoView({block:'center'});}else $('#materialReader').scrollTop=0;});
}
$('#previewApprovalConsent').addEventListener('change',()=>{$('#confirmPreviewApproval').disabled=!$('#previewApprovalConsent').checked;});
document.addEventListener('change',e=>{if(e.target.matches('[data-speaker-option]'))safe(async()=>{
  const enabled=e.target.checked;await act('setSpeakerScriptOption',{enabled,minutes:$('#speakerMinutes')?.value??p.speakerScriptOptions?.minutes,instruction:$('#speakerInstruction')?.value??p.speakerScriptOptions?.instruction},4);
});});

document.addEventListener('click',e=>safe(async()=>{
  const b=e.target.closest('button');if(!b||b.disabled)return;if(designBatchPending){toast('正在保存并确认内容与设计，请稍候');return;}if(sending){toast('正在发送材料，请等待完成');return;}
  if(b.dataset.close){$('#'+b.dataset.close).close();return;}
  if(b.hasAttribute('data-open-supplement')){
    if(!p.analysisCurrent)throw Error('请先在 01 完成当前材料的识别与理解');
    const dialog=$('#supplementImageDialog'),form=$('#supplementImageForm');
    if(dialog.dataset.projectId!==p.id){form.reset();dialog.dataset.projectId=p.id;}
    if(!form.querySelector('[name=imageTypes]:checked'))form.querySelector('[name=imageTypes][value=illustration]').checked=true;
    const extra=!!p.provider?.elementImage,model=(extra?p.provider.elementImage:p.provider?.image)?.model;
    $('#supplementImageModel').textContent='主模型先整理内容与构图，再交给'+(extra?'独立元素生图模型':'通用生图模型')+(model?' · '+model:' · 尚未配置')+'。';
    $('#supplementImageState').textContent='';form.querySelector('[type=submit]').textContent=busy()?'加入生成队列 ↗':'生成补充图片 ↗';dialog.showModal();return;
  }
  if(b.hasAttribute('data-generate-speaker-script')){
    if(busy())throw Error('请等待当前任务完成');if(!p.apiReady){openAPI();toast('请先配置主模型API');return;}
    const input=$('#speakerMinutes');if(input&&!input.reportValidity())return;
    await act('generateSpeakerScript',{minutes:input?.value||null,instruction:$('#speakerInstruction')?.value||''},4);return;
  }
  if(b.hasAttribute('data-open-preview-approval')){
    if(busy())throw Error('请等待当前任务完成');const state=p.previewApprovalState;
    if(!state?.ready||!state.contentConfirmed)throw Error('请先生成全部当前预览并确认内容');
    previewApprovalContext={projectId:p.id,stamp:state.stamp,acceptIssues:state.requiresAcceptance};
    $('#previewApprovalBody').innerHTML=previewApprovalDialogContent(state);$('#previewApprovalConsentText').textContent=state.requiresAcceptance?'我已查看全部预览，接受以上检查问题，继续进入05。':'我已查看全部预览，确认继续进入05。';
    $('#previewApprovalConsent').checked=false;$('#confirmPreviewApproval').disabled=true;$('#previewApprovalMessage').textContent='';$('#previewApprovalDialog').showModal();return;
  }
  if(b.id==='confirmPreviewApproval'){
    if(!previewApprovalContext||p.id!==previewApprovalContext.projectId)throw Error('项目已变化，请重新确认');
    if(!$('#previewApprovalConsent').checked)throw Error('请先确认已核对预览');
    try{await act('approvePreview',{confirmAllPages:true,acceptIssues:previewApprovalContext.acceptIssues,approvalStamp:previewApprovalContext.stamp},4);$('#previewApprovalDialog').close();}catch(error){$('#previewApprovalMessage').textContent=error.message;throw error;}return;
  }
  if(b.dataset.deleteStyle){await act('deleteRegisteredStyle',{styleId:b.dataset.deleteStyle});toast('风格已删除；已生成方案与历史记录保留');return;}
  if(b.hasAttribute('data-theme-assets-batch')){
    const selected=$('#themeAssets input[name=visualTreatment]:checked')?.value;
    if(selected&&selected!==p.visualTreatment){if(!p.apiReady){openAPI();return;}await prepareThemeAssetGeneration();await act('generateThemeAssets',{visualTreatment:selected,force:true},2);return;}
    if(!p.themeAssetsCurrent||!p.themeAssetPrompts?.length)throw Error('请先准备当前需求的底图提示词');
    if(sendQueue.length||materialDraft.trim())throw Error('请先发送待处理材料，再生成底图');
    const form=$('#briefForm');if(form&&!busy()&&!sameBrief(readBrief(form)))throw Error('需求已修改，请先保存并重新规划提示词');
    openThemePromptReview();return;
  }
  if(b.hasAttribute('data-theme-prompts-regenerate')){
    if(busy())throw Error('请等待当前任务完成');
    if(!p.apiReady){openAPI();return;}
    await prepareThemeAssetGeneration();$('#themePromptReviewState').textContent='AI 正在重选三种风格并生成对应提示词…';
    try{await act('regenerateThemePrompts',{},2);}catch(error){$('#themePromptReviewState').textContent=error.message;throw error;}return;
  }
  if(b.hasAttribute('data-theme-assets-generate')||b.hasAttribute('data-theme-treatment-replan')){
    if(!p.themePromptConfirmation)throw Error('请先重启服务启用提示词确认流程');
    const visualTreatment=$('#themeAssets input[name=visualTreatment]:checked')?.value||p.visualTreatment||'flat';
    const treatmentChanged=visualTreatment!==p.visualTreatment;
    const reselect=b.hasAttribute('data-theme-treatment-replan');
    if(!reselect&&!treatmentChanged&&p.themeAssetsCurrent&&p.themeAssets?.directions?.length&&p.themeAssets.status!=='ready'){openThemePromptReview();return;}
    if(!p.apiReady){openAPI();toast('请先连接主模型 API');return;}
    await prepareThemeAssetGeneration();await act(reselect&&p.themeAssetsCurrent?'regenerateThemePrompts':'generateThemeAssets',{visualTreatment,force:reselect||treatmentChanged||!!p.themeAssetsReady&&p.themeAssets?.status==='ready'},2);return;
  }
  if(b.dataset.themeDirectionChange){
    themeDirectionEdit=b.dataset.themeDirectionChange;const d=p.themeAssets.directions.find(d=>d.id===themeDirectionEdit);
    $('#themeDirectionTitle').textContent='方向 '+d.id.toUpperCase()+' · 更换风格';$('#themeDirectionSummary').textContent='当前风格：'+d.name;
    $('#themeDirectionReference').innerHTML=themeDirectionOptions(p);$('#themeDirectionInstruction').value='';$('#themeDirectionDialog').showModal();return;
  }
  if(b.dataset.themeDirectionRegenerate||b.id==='changeThemeDirection'){
    const change=b.id==='changeThemeDirection',theme=change?themeDirectionEdit:b.dataset.themeDirectionRegenerate;
    if(!p.apiReady){openAPI();return;}if(busy())throw Error('请等待当前任务完成');
    const extra={theme,...(change?{referenceStyleId:$('#themeDirectionReference').value||null,instruction:$('#themeDirectionInstruction').value}:{})};
    await prepareThemeAssetGeneration();await act(change?'changeThemeDirection':'regenerateThemeDirection',extra,2);if(change)$('#themeDirectionDialog').close();return;
  }
  if(b.dataset.themeCrossRestore){if(busy())throw Error('请等待当前任务完成');await act('restoreAIImage',{targetType:'theme',theme:b.dataset.theme,use:b.dataset.use,direction:b.dataset.themeCrossRestore,sourceHash:b.dataset.hash,sourceRevision:b.dataset.sourceRevision},2);return;}
  if(b.dataset.themeAssetPrompt){
    const theme=b.dataset.themeAssetPrompt,use=b.dataset.themeAssetUse;
    if(p.aiImageEditModes&&p.themeAssets?.directions.find(d=>d.id===theme)?.assets?.[use]){aiImageEditor.open({targetType:'theme',theme,use});return;}
    const entry=p.themeAssetPrompts.find(e=>e.theme===b.dataset.themeAssetPrompt&&e.use===b.dataset.themeAssetUse);
    if(!entry)throw Error('请先准备底图提示词');themeAssetEdit={theme:entry.theme,use:entry.use,revision:entry.revision};
    const d=p.themeAssets.directions.find(d=>d.id===entry.theme);
    $('#themeAssetPromptTitle').textContent=d.name+' · 底图提示词';setPromptInput($('#themeAssetPromptText'),entry.prompt,{reset:true});$('#themeAssetInstruction').value='';
    $('#themeAssetPromptState').textContent='确认后仅发送上方完整提示词，以文生图重新生成。';$('#themeAssetPromptDialog').showModal();return;
  }
  if(b.dataset.themeReviewRewrite!==undefined||b.id==='rewriteThemeAsset'){
    if(!p.apiReady){openAPI();return;}if(busy())throw Error('请等待当前任务完成');
    const item=b.closest('[data-theme-review]'),input=item?.querySelector('[data-theme-review-prompt]'),instruction=item?item.querySelector('[data-theme-review-instruction]').value:$('#themeAssetInstruction').value;
    if(input)themeAssetEdit={theme:input.dataset.theme,use:input.dataset.use,revision:Number(input.dataset.revision),batch:true};
    if(!themeAssetEdit)throw Error('请重新打开底图提示词');
    const prompt=input?input.value:$('#themeAssetPromptText').value;
    await act('rewriteThemeAssetPrompt',{theme:themeAssetEdit.theme,use:themeAssetEdit.use,revision:themeAssetEdit.revision,prompt,instruction},2);
    if(item)item.querySelector('[data-theme-review-state]').textContent='AI 正在补充完整提示词…';else $('#themeAssetPromptState').textContent='AI 正在补充完整提示词…';return;
  }
  if(b.id==='regenerateThemeAsset'||b.id==='confirmThemePrompts'){
    if(!p.apiReady||!p.imageReady){openAPI();return;}
    const batch=b.id==='confirmThemePrompts';
    const state=$(batch?'#themePromptReviewState':'#themeAssetPromptState');
    if(batch?$$('[data-theme-review-instruction]').some(el=>el.value.trim()):$('#themeAssetInstruction').value.trim()){state.textContent='修改意见尚未应用，请先点击“AI 补充完整提示词”，核对新稿后确认';return;}
    const entries=batch?$$('[data-theme-review-prompt]').map(el=>({theme:el.dataset.theme,use:el.dataset.use,revision:Number(el.dataset.revision),prompt:el.value})):[{theme:themeAssetEdit.theme,use:themeAssetEdit.use,revision:themeAssetEdit.revision,prompt:$('#themeAssetPromptText').value}];
    const form=$('#briefForm');if(form&&!busy()&&!sameBrief(readBrief(form)))throw Error('需求已修改，请先保存并重新规划提示词');
    try{await act('generateThemeAssets',{confirmed:true,prompts:entries},2);}catch(e){state.textContent=e.message;throw e;}
    $(batch?'#themePromptReviewDialog':'#themeAssetPromptDialog').close();return;
  }
  if(b.dataset.themeBackgroundUse){await act('setThemeBackgroundUse',{theme:b.dataset.themeBackgroundUse,enabled:b.dataset.enabled==='true'},2);return;}
  if(b.dataset.viewTreeImage){const m=p?.materials.find(m=>m.id===b.dataset.viewTreeImage&&m.kind==='image');if(!m)return;const src=`/api/projects/${p.id}/assets/${m.id}`;$('#treeImageViewerTitle').textContent=m.name;$('#treeImageViewerImage').src=src;$('#treeImageViewerImage').alt=m.name;$('#treeImageViewerOrigin').textContent=imageOrigin(m);$('#treeImageViewerOriginal').href=src;$('#treeImageViewer').showModal();return;}
  if(b.hasAttribute('data-add-image-task')){openImageTaskDialog();return;}
  if(b.dataset.cancelQueuedImage){await act('cancelQueuedImageTask',{id:b.dataset.cancelQueuedImage});return;}
  if(b.hasAttribute('data-open-progress')){$('#taskProgressDialog').showModal();progressSnapshot='';syncTaskProgress();return;}
  if(b.hasAttribute('data-open-api')){openAPI();return;}
  if(b.dataset.materialImagePicker!==undefined){await flushSlideEdits();imageLibraryEditor={projectId:p.id,page:Number(b.dataset.materialImagePicker),nodeId:b.dataset.imageNode||null};$('#materialImageDialog').showModal();syncImageLibrary();return;}
  if(b.dataset.cropMaterial){await flushSlideEdits();$('#materialReader').close();$('#materialImageDialog').close();materialCropEditor.open(b.dataset.cropMaterial);return;}
  if(b.hasAttribute('data-extract-all-images')){await flushSlideEdits();if(busy()||sending)throw Error('请等待当前任务完成');await act('extractAllMaterialImages');return;}
  if(b.dataset.extractImages||b.dataset.separateImages){await flushSlideEdits();if(busy())throw Error('请等待当前任务完成');if(b.dataset.separateImages&&!p.apiReady){openAPI();toast('请配置支持视觉输入的主模型');return;}await act(b.dataset.extractImages?'extractMaterialImages':'separateMaterialImages',{id:b.dataset.extractImages||b.dataset.separateImages});if(readerMaterialId&&$('#materialReader').open)readMaterial(readerMaterialId);return;}
  if(b.dataset.insertMaterialImage){if(imageLibraryEditor?.projectId!==p.id||tab!==1)throw Error('请从当前页重新打开素材库');if(busy())throw Error('请等待图片处理完成');const {page,nodeId}=imageLibraryEditor,slides=collectSlides(page),s=slides[page],m=p.materials.find(m=>m.id===b.dataset.insertMaterialImage&&m.kind==='image');if(!m||!s)throw Error('图片或页面已变化');const previous=collectSlides();let n;if(nodeId){n=s.elements.find(n=>n.id===nodeId&&n.type==='image');if(!n)throw Error('图片字段已变化');s.sourceLinks=(s.sourceLinks||[]).filter(l=>l.target!=='element:'+n.id);s.sources=s.sources.filter(id=>id!==n.materialId||s.sourceLinks.some(l=>l.materialId===id));}else{mutateElements(s,'add',null,'image');n=s.elements.at(-1);n.label=m.generated?(supplementInfo(m)?.name||'AI 补充配图'):m.extracted?'材料配图':'原始配图';}n.materialId=m.id;if(supplementInfo(m)?.caption&&!s.elements.some(c=>['imageTitle','caption'].includes(c.role)&&c.parentId===n.id))s.elements=setImageCaption(s.elements,n.id,'caption-'+crypto.randomUUID(),supplementInfo(m).caption);syncLegacy(s);await act('saveContent',{slides});treeUndo={projectId:p.id,version:p.version,slides:previous,page};syncTreeUndo();$('#materialImageDialog').close();toast('图片已插入内容树，来源对应已保存');return;}
  if(b.dataset.generatePage!==undefined){if(!p.imageReady){openAPI();return;}await act('generateFullPreview',{index:Number(b.dataset.generatePage),force:true},3);return;}
  if(b.dataset.checkVisualPage!==undefined){await act('checkVisualPage',{index:Number(b.dataset.checkVisualPage),kind:b.dataset.checkKind,theme:b.dataset.checkTheme});return;}
  if(b.dataset.retryConcept!==undefined){if(!p.imageReady){openAPI();return;}await act('generateConceptPage',{index:Number(b.dataset.retryConcept),theme:b.dataset.retryTheme},2);return;}
  if(b.dataset.reviewPreview!==undefined){await act('reviewPreviewPage',{index:Number(b.dataset.reviewPreview),checked:true},3);toast('本页预览已检查');return;}
  if(b.dataset.visualPrompt!==undefined){if(p.aiImageEditModes){aiImageEditor.open({targetType:'visual',index:Number(b.dataset.visualPrompt),kind:b.dataset.visualKind||'full',theme:b.dataset.visualTheme});return;}visualEdit={index:Number(b.dataset.visualPrompt),kind:b.dataset.visualKind,theme:b.dataset.visualTheme};const page=visualEdit.kind==='concept'?p.concepts.find(c=>c.id===visualEdit.theme).representatives.find(r=>r.index===visualEdit.index):p.visualPages[visualEdit.index];$('#visualPromptTitle').textContent='S'+String(visualEdit.index+1).padStart(2,'0')+' · 整页生图提示词';setPromptInput($('#visualPromptText'),page.promptDraft||page.redrawPrompt||page.prompt,{reset:true,onChange:()=>$('#visualPromptConsent').checked=false});$('#visualPromptInstruction').value='';$('#visualPromptConsent').checked=false;$('#visualPromptState').textContent='生成模型：'+page.model;$('#visualPromptDialog').showModal();return;}
  if(['saveVisualPrompt','rewriteVisualPrompt','generateVisualPrompt'].includes(b.id)){if(!visualEdit)throw Error('请重新打开提示词');const payload={...visualEdit,prompt:$('#visualPromptText').value,instruction:$('#visualPromptInstruction').value};if(b.id==='generateVisualPrompt'){if(!$('#visualPromptConsent').checked)throw Error('请确认发送提示词并重新生图');await act(visualEdit.kind==='concept'?'generateConceptPage':'generateFullPreview',{...payload,force:true});$('#visualPromptDialog').close();}else{await act(b.id==='saveVisualPrompt'?'saveVisualPrompt':'rewriteVisualPrompt',payload);$('#visualPromptState').textContent=b.id==='saveVisualPrompt'?'草稿已保存':'正在改写，完成后请核对草稿';}return;}

  if(b.dataset.testApi){if(!$('#apiForm').reportValidity())return;await persistAPIConfiguration();await act('testAPI',{type:b.dataset.testApi});syncAPIStatus();return;}


  if(b.id==='saveApprove'){
    if(busy())throw Error('请等待当前任务完成');
    const slides=collectSlides(),drafts=new Map($$('[data-design-markdown]').map(el=>[Number(el.dataset.designMarkdown),el.value]));
    const controls=$$('#main button,#main input,#main textarea,#main select').map(el=>({el,disabled:el.disabled}));let contentSaved=false;
    designBatchPending=true;$('#projects').disabled=true;syncArchiveButton();
    try{
      controls.forEach(({el})=>el.disabled=true);
      const result=await saveAndConfirmPageDesigns(p,slides,drafts,async(project,slides)=>{
        p=await api('/api/projects/'+project.id+'/action',{action:'saveContent',slides,...(project.atomicContentConfirmation?{confirm:true}:{})});
        contentSaved=true;
        if(!project.atomicContentConfirmation)p=await api('/api/projects/'+project.id+'/action',{action:'approveContent'});
        return p;
      },async(project,index,markdown)=>{p=await api('/api/projects/'+project.id+'/action',{action:'approvePageDesign',index,markdown});return p;});
      p=result.project;toast('内容已保存并确认；'+(result.skipped.length?(result.confirmed.length+result.already.length)+' 页设计已确认，'+result.skipped.length+' 页待处理，详见页面提示':'所有页设计已确认'));
    }finally{
      designBatchPending=false;$('#projects').disabled=false;
      if(contentSaved){render();for(const [index,markdown] of drafts){const input=$(`[data-design-markdown="${index}"]`);if(input&&markdown!==p.pageDesigns?.[index]?.markdown){input.value=markdown;input.closest('[data-page-design]').querySelector('[data-design-state]').textContent='设计说明有未保存修改';}}}
      else{controls.forEach(({el,disabled})=>el.disabled=disabled);syncArchiveButton();}
    }
    return;
  }
  if(b.dataset.pageDesignAction){const index=Number(b.dataset.page),action=b.dataset.pageDesignAction;
    if(action==='confirmPageLayout'){await flushSlideEdits();await act(action,{index});toast('本页内容树排版已确认，可以生成单页设计稿');}
    else if(['designPage','revisePageDesign'].includes(action)){
      const instruction=$(`[data-design-feedback="${index}"]`)?.value||'',markdown=$(`[data-design-markdown="${index}"]`)?.value;
      if(action==='revisePageDesign'&&!instruction.trim())throw Error('请填写设计修改意见');
      if(!p.apiReady){openAPI();return;}await flushSlideEdits();await act(action,{index,...(action==='revisePageDesign'?{instruction,markdown}:{})});
    }
    else{if(tab===1&&JSON.stringify(collectSlides())!==JSON.stringify(p.slides))throw Error('请先保存内容修改，再重新生成当前设计稿');await act(action,{index,markdown:$(`[data-design-markdown="${index}"]`).value});toast(action==='approvePageDesign'?'本页设计稿已确认，可以生成本页视觉预览':'设计稿修改已保存');}
    return;
  }
  if(b.id==='sendMaterials'){await sendMaterials();return;}
  if(b.dataset.unqueue){sendQueue=sendQueue.filter(q=>q.id!==b.dataset.unqueue);updateQueue();return;}
  if(b.hasAttribute('data-open-material-reader')){const materials=receivedMaterials(p),m=materials.find(m=>m.id===readerMaterialId)||materials[0];if(!m)throw Error('请先发送材料');readMaterial(m.id);return;}
  if(b.dataset.readMaterial){readMaterial(b.dataset.readMaterial,b.dataset.sourceQuote,b.dataset.sourceSlide,b.dataset.sourceStart!==undefined?{start:Number(b.dataset.sourceStart),end:Number(b.dataset.sourceEnd)}:null);return;}
  if(b.dataset.removeMaterial){await act('removeMaterial',{id:b.dataset.removeMaterial},0);toast('材料已移出，相关理解与确认已重置');return;}
  if(b.id==='analyzeMaterials'){
    if(sendQueue.length||materialDraft.trim())throw Error('请先发送待处理材料');
    if(!p.apiReady){openAPI();toast('连接模型后即可识别材料');return;}
    const form=$('#briefForm');if(!form.reportValidity())return;
    const brief=readBrief(form),progressSections=progressSectionsDraft(),includeImages=!!$('#includeImages')?.checked;
    if(!sameBrief(brief)||progressSections)await act('requirements',{brief,...(progressSections?{progressSections}:{})},0);
    await act('analyzeMaterials',{includeImages},0);return;
  }
  if(b.id==='approveAnalysis'){
    const form=$('#briefForm');if(form){const brief=readBrief(form);if(!sameBrief({...brief,pages:p.brief.pages,toc:brief.pages===1?p.brief.toc:brief.toc,thanks:brief.pages===1?p.brief.thanks:brief.thanks}))throw Error('需求已修改，请重新识别材料后确认');}
    if(form&&!form.reportValidity())return;
    const titles=$$('[data-analysis-title]');for(const input of titles)if(!input.reportValidity())return;
    await act('approveAnalysis',{...(progressSectionsDraft()?{progressSections:readProgressSections()}:{}),pages:optionalPageCount(form?.elements.pages.value),reviewNotes:$('#analysisNotes').value,outlineTitles:titles.map(el=>el.value.trim())},0);toast('材料理解已确认，保存需求后可生成逐页内容');return;
  }
  if(b.dataset.linkSource!==undefined){const page=Number(b.dataset.linkSource);if(b.dataset.sourceTarget?.startsWith('element:')&&!p.slides[page].elements)await act('saveContent',{slides:collectSlides(page)});else await flushSlideEdits();openSourceEditor(page,b.dataset.linkId,b.dataset.sourceTarget);return;}
  if(b.dataset.unlinkSource){const i=Number(b.dataset.sourceSlide),slides=collectSlides(),s=slides[i],removed=s.sourceLinks.find(l=>l.id===b.dataset.unlinkSource);s.sourceLinks=s.sourceLinks.filter(l=>l.id!==b.dataset.unlinkSource);s.sources=s.sources.filter(id=>id!==removed.materialId||s.sourceLinks.some(l=>l.materialId===id));await act('saveContent',{slides});return;}
  if(b.dataset.useEvidence!==undefined){const m=p.materials.find(m=>m.id===$('#sourceMaterial').value),fact=p.analysis?.readings.find(r=>r.id===m.id)?.facts[Number(b.dataset.useEvidence)];if(fact){$('#sourceQuote').value=fact.quote;$('#sourceForm').elements.note.value=fact.claim;}return;}
  if(b.dataset.treeUndo!==undefined){if(!treeUndo||treeUndo.projectId!==p.id||treeUndo.version!==p.version)throw Error('内容已变化，不能撤销先前移动');const previous=treeUndo.slides;treeUndo=null;await act('saveContent',{slides:previous});toast('已撤销上一次操作');return;}
  if(b.dataset.elementAction){const i=Number(b.dataset.page),action=b.dataset.elementAction;const includeImages=!!document.querySelector(`[data-relation-vision="${i}"]`)?.checked;const previous=collectSlides(),slides=collectSlides(i);if(action==='recognize'){if(!p.apiReady){openAPI();return;}await act('saveContent',{slides});await act('recognizeRelations',{index:i,includeImages});return;}if(action!=='save')mutateElements(slides[i],action,b.dataset.nodeId,b.dataset.elementType);await act('saveContent',{slides});if(action==='remove'){treeUndo={projectId:p.id,version:p.version,slides:previous,page:i};syncTreeUndo();}toast(action==='save'?'字段内容已保存':action==='remove'?'字段已删除，附属字段保留并提升一级；可撤销':'元素关系已保存');return;}
  if(b.dataset.elementGenerate){const page=Number(b.dataset.page);if(!p.slides[page].elements)await act('saveContent',{slides:collectSlides(page)});else await flushSlideEdits();const i=Number(b.dataset.page),id=b.dataset.elementGenerate,n=p.slides[i].elements.find(n=>n.id===id),m=p.materials.find(m=>m.id===n.materialId&&m.generated);openPromptEditor(i,m?.id||null,id);return;}
  if(b.dataset.imagePrompt||b.dataset.image!==undefined){await flushSlideEdits();$('#materialReader').close();openPromptEditor(b.dataset.promptIndex!==undefined?Number(b.dataset.promptIndex):b.dataset.image!==undefined?Number(b.dataset.image):null,b.dataset.imagePrompt||null,b.dataset.promptElement||null);return;}
  if(b.dataset.promptMode){setPromptMode(b.dataset.promptMode);return;}
  if(b.id==='saveImagePrompt'){assertPromptEditor();await act('saveImagePrompt',promptPayload());$('#imagePromptState').textContent='草稿已保存；当前图片使用的提示词保持在上方记录中。';return;}
  if(b.id==='rewriteImagePrompt'){assertPromptEditor();if(!p.apiReady){openAPI();toast('自然语言改写需要连接文字模型');return;}const body=promptPayload();if(!body.instruction.trim())throw Error('请填写自然语言修改要求');await act('rewriteImagePrompt',body);return;}
  if(b.id==='cancelPromptTask'){await act('cancel');return;}
  if(b.dataset.undoRebuildPage!==undefined){await act('undoRebuildEdit',{index:Number(b.dataset.undoRebuildPage)});return;}
  if(b.dataset.extractRebuildRegion!==undefined){rebuildRegionEditor.open(Number(b.dataset.extractRebuildRegion));return;}

  if(b.dataset.suggestRemoveAsset!==undefined){
    const field=$(`[data-rebuild-asset-instruction="${Number(b.dataset.assetPage)}"]`),line='删除非事实元素「'+b.dataset.suggestRemoveAsset+'」。';if(field){field.value=[field.value.trim(),line].filter(Boolean).join('\n');field.focus();field.dispatchEvent(new Event('input',{bubbles:true}));}return;
  }
  if(b.dataset.reviseRebuildAssets!==undefined){
    const index=Number(b.dataset.reviseRebuildAssets),request=rebuildFeedbackRequest(p,index,$(`[data-rebuild-asset-instruction="${index}"]`)?.value);await act(request.action,request.payload);return;
  }
  if(b.dataset.nav!==undefined){if(tab===1&&$('#slidesForm')&&JSON.stringify(collectSlides())!==JSON.stringify(p.slides))await saveSlides();tab=Number(b.dataset.nav);render();if(b.dataset.intakeSection)document.getElementById(b.dataset.intakeSection)?.scrollIntoView({behavior:'smooth',block:'start'});return;}
  if(b.dataset.action==='reuseDownstream'){
    if(sendQueue.length||materialDraft.trim())throw Error('请先发送待处理材料，再同步文案');
    await flushSlideEdits();const form=$('#briefForm');if(form&&!sameBrief(readBrief(form))){if(!form.reportValidity())return;await act('requirements',{brief:readBrief(form)});}
    await act('reuseDownstream');toast('已沿用原布局与图片，新文案已同步到后续设计');return;
  }
  if(b.dataset.action){if(['content','concepts','draftPageDesigns'].includes(b.dataset.action)&&!p.apiReady){openAPI();toast('先连接文字模型，再执行生成');return;}if(['concepts','generateFullPreview'].includes(b.dataset.action)&&!p.imageReady){openAPI();toast('请配置通用生图 API');return;}if(['build','reconstructPreview'].includes(b.dataset.action)&&!p.rebuildReady){openAPI();toast('请配置支持视觉输入的主模型，或选填独立高性能视觉模型');return;}if(b.dataset.action==='draftPageDesigns')await flushSlideEdits();const next={approvePreview:4,generateFullPreview:3}[b.dataset.action],extra={};await act(b.dataset.action,extra,next);return;}
  if(b.dataset.theme){await act('selectTheme',{id:b.dataset.theme},3);return;}
  if(b.id==='demo'){await create({title:'示例项目',pages:5,progress:true},true);return;}
  if(b.id==='addSlide'){const slides=collectSlides();slides.push({kind:'content',title:'新的页面',subtitle:'',body:[],notes:'',sources:[],imageId:null});await act('saveContent',{slides});return;}
  if(b.dataset.move){const [i,d]=b.dataset.move.split(',').map(Number),slides=collectSlides();[slides[i],slides[i+d]]=[slides[i+d],slides[i]];await act('saveContent',{slides});return;}
  if(b.dataset.delete!==undefined){const slides=collectSlides();if(slides.length===1)throw Error('至少保留一页');slides.splice(Number(b.dataset.delete),1);await act('saveContent',{slides});return;}

  if(b.dataset.revise!==undefined){editMode='revise';editIndex=Number(b.dataset.revise);if(!p.apiReady){openAPI();return;}await saveSlides();$('#editTitle').textContent='修改第 '+(editIndex+1)+' 页';$('#editForm').reset();$('#uploadConsent').hidden=true;$('#editHint').textContent='修改后需要重新确认内容、方案和预览。';$('#editDialog').showModal();}
}));

let apiFormProject=null,apiFormEpoch=0;
const acknowledgedAPIKeys=new Map();
function apiSaveState(kind,message){const el=$('#apiSaveState');el.dataset.state=kind;el.textContent=message;}
function apiSnapshot(){
  if(!p||apiFormProject!==p.id)return null;
  const form=$('#apiForm'),values={};
  for(const type of apiTypes){const raw=form.elements[type+'Key'].value.trim();values[type]={baseURL:form.elements[type+'Base'].value.trim().replace(/\/$/,''),model:form.elements[type+'Model'].value.trim(),key:raw===acknowledgedAPIKeys.get(type)?'':raw};}
  return {project:p,values,epoch:apiFormEpoch};
}
function clearAcknowledgedAPIKeys(){const form=$('#apiForm');for(const type of apiTypes){const field=form.elements[type+'Key'];if(field!==document.activeElement&&field.value.trim()===acknowledgedAPIKeys.get(type)){field.value='';acknowledgedAPIKeys.delete(type);}}}
const apiAutosave=createAPIAutosave({
  read:apiSnapshot,blocked:()=>busy()||sending,state:apiSaveState,
  save:(id,payload)=>api(`/api/projects/${id}/action`,{action:'configure',...payload}),
  applied:(result,snapshot,plan)=>{
    if(p?.id!==result.id)return;p=result;nav();
    if(apiFormProject===p.id&&apiFormEpoch===snapshot.epoch){
      for(const type of apiTypes){if(plan.payload[type]?.key)acknowledgedAPIKeys.set(type,plan.payload[type].key);$('#apiForm').elements[type+'Key'].placeholder=p.provider?.[type]?'留空保留当前会话密钥':'输入密钥';}
      clearAcknowledgedAPIKeys();syncAPIStatus();
    }
  }
});
function syncAPIStatus(){if(!$('#apiDialog').open)return;$('#apiPersistenceHint').textContent=apiPersistenceMessage(p);const f=$('#apiForm');f.elements.textKey.required=!p.apiReady;for(const type of apiTypes){const result=p.apiTests?.[type],el=$(`[data-api-result="${type}"]`);if(el)el.textContent=result?(result.ok?'✓ '+result.message+' · '+(result.ms||0)+'ms':'连接失败 · '+result.message):'尚未测试';}$('#apiForm').querySelectorAll('input,select,button:not(.close):not(#forgetKey)').forEach(e=>e.disabled=busy());f.elements.executionConcurrency.disabled=busy()||p.executionConcurrency===undefined;if(p.executionConcurrency===undefined)$('#concurrencySaveState').textContent='当前后台尚未加载更新；重启本地服务后可设置并发上限。';}
function openAPI(){
  if(sending){toast('正在发送材料，请等待完成');return;}if(!p){toast('请先创建一个项目');return;}
  const f=$('#apiForm');
  if(apiFormProject!==p.id){apiAutosave.reset();apiFormEpoch++;acknowledgedAPIKeys.clear();f.reset();apiFormProject=p.id;for(const type of apiTypes){f.elements[type+'Base'].value=p.provider?.[type]?.baseURL||(type==='text'?'https://api.openai.com/v1':'');f.elements[type+'Model'].value=p.provider?.[type]?.model||'';f.elements[type+'Key'].placeholder=p.provider?.[type]?'留空保留当前会话密钥':'输入密钥';}}
  f.elements.executionConcurrency.value=String(p.executionConcurrency||3);$('#apiDialog').showModal();syncAPIStatus();apiAutosave.flush().catch(()=>{});
}
async function persistAPIConfiguration(){await apiAutosave.flush({strict:true});}
async function flushSlideEdits(){if(tab===1&&$('#slidesForm')&&JSON.stringify(collectSlides())!==JSON.stringify(p.slides))await saveSlides();}
function slideTarget(s,target){if(target.startsWith('element:')){const n=s.elements?.find(n=>n.id===target.slice(8));return n?(n.type==='image'?n.materialId:n.text||n.label):'';}return target.startsWith('body:')?s.body[Number(target.split(':')[1])]||'':target==='image'?s.imageId:s[target]||'';}
function openSourceEditor(index,id,selectedTarget){
  const s=p.slides[index],link=(s.sourceLinks||[]).find(l=>l.id===id),materials=p.materials.filter(m=>!m.generated);if(!materials.length)throw Error('请先发送原始材料');
  sourceEditor={projectId:p.id,index,id};const f=$('#sourceForm');f.reset();
  const targets=[...(s.elements||[]).map(n=>'element:'+n.id),'title','subtitle',...s.body.map((_,i)=>'body:'+i),'notes',...(s.imageId&&p.materials.some(m=>m.id===s.imageId&&!m.generated)?['image']:[])].filter(t=>slideTarget(s,t));
  $('#sourceTarget').innerHTML=targets.map(t=>`<option value="${t}">${h(t.startsWith('element:')?s.elements.find(n=>n.id===t.slice(8))?.label||targetLabel(t):targetLabel(t))}</option>`).join('');$('#sourceTarget').value=link?.target||selectedTarget||targets.find(t=>t.startsWith('body:'))||targets[0];
  $('#sourceMaterial').innerHTML=materials.map(m=>`<option value="${m.id}">${h(m.name)}</option>`).join('');if(link)$('#sourceMaterial').value=link.materialId;
  $('#sourceQuote').value=link?.quote||'';f.elements.note.value=link?.note||'';refreshSourceEditor();$('#sourceDialog').showModal();$('#sourceDialog').scrollTop=0;
}
function refreshSourceEditor(){
  if(!sourceEditor||sourceEditor.projectId!==p.id)return;const m=p.materials.find(m=>m.id===$('#sourceMaterial').value),target=$('#sourceTarget').value,image=m.kind==='image'&&!((m.ocrTextApprovedAt||m.ocr?.approvedAt)&&target!=='image'&&!(target.startsWith('element:')&&p.slides[sourceEditor.index].elements?.find(n=>n.id===target.slice(8))?.type==='image'));
  $('#sourceCurrentText').textContent=targetLabel($('#sourceTarget').value)+'：'+slideTarget(p.slides[sourceEditor.index],$('#sourceTarget').value);
  $('#sourceQuoteLabel').hidden=image;$('#sourceQuote').required=!image;$('#sourceForm').elements.note.required=image;
  $('#sourceOriginal').innerHTML=image?`<img src="/api/projects/${p.id}/assets/${m.id}" alt="${h(m.name)}">`:`<div class="source-document">${sourceTextView(m).html}</div>`;
  if(!image)loadDocumentFormat(m).then(loaded=>{if(loaded&&$('#sourceDialog').open&&$('#sourceMaterial').value===m.id)refreshSourceEditor();}).catch(error=>toast('格式补读失败：'+error.message));
  const facts=p.analysisCurrent?p.analysis?.readings.find(r=>r.id===m.id)?.facts||[]:[];
  $('#sourceEvidenceChoices').innerHTML=!image&&facts.length?'<small>从已识别证据中选取</small>'+facts.map((f,i)=>`<button type="button" class="text-button" data-use-evidence="${i}">${h(f.claim)} ＋</button>`).join(''):'';
}
$('#sourceTarget').onchange=refreshSourceEditor;
$('#sourceMaterial').onchange=()=>{$('#sourceQuote').value='';$('#sourceForm').elements.note.value='';refreshSourceEditor();};
$('#sourceForm').onsubmit=e=>{e.preventDefault();safe(async()=>{
  if(sourceEditor?.projectId!==p.id)throw Error('项目已变化，请重新打开材料对应');
  const f=new FormData(e.target),slides=p.slides.map(s=>({...s,sourceLinks:[...(s.sourceLinks||[])]})),s=slides[sourceEditor.index];
  const m=p.materials.find(m=>m.id===f.get('materialId')),target=f.get('target'),image=m.kind==='image'&&!((m.ocrTextApprovedAt||m.ocr?.approvedAt)&&target!=='image'&&!(target.startsWith('element:')&&s.elements?.find(n=>n.id===target.slice(8))?.type==='image')),link={id:sourceEditor.id,materialId:f.get('materialId'),target:f.get('target'),quote:image?'':String(f.get('quote')).trim(),note:String(f.get('note')).trim()};
  const pos=s.sourceLinks.findIndex(l=>l.id===sourceEditor.id),old=s.sourceLinks[pos];if(pos>=0)s.sourceLinks[pos]=link;else s.sourceLinks.push(link);
  if(old)s.sources=s.sources.filter(id=>id!==old.materialId||s.sourceLinks.some(l=>l.materialId===id));
  await act('saveContent',{slides});$('#sourceDialog').close();toast('对应关系已保存，可点击材料名定位原文');
});};
const promptSuffix='。仅作概念插画，不伪造实际事件、数据或证据，不含文字。';
const promptKey=e=>`${e.index===null?'library':e.index}:${e.sourceImageId||'new'}${e.elementId?':'+e.elementId:''}`;
function assertPromptEditor(){if(!promptEditor||promptEditor.projectId!==p.id)throw Error('项目已变化，请重新打开图片提示词');}
function openPromptEditor(index,sourceImageId,elementId=null){
  if(index!==null&&!sourceImageId&&!elementId){const m=p.materials.find(m=>m.id===p.slides[index].imageId&&m.generated);sourceImageId=m?.id||null;}
  if(p.aiImageEditModes&&sourceImageId){const m=p.materials.find(m=>m.id===sourceImageId),d=p.themeAssets?.directions.find(d=>d.assets?.[m?.intendedUse]?.materialId===m?.id);aiImageEditor.open(d?{targetType:'theme',theme:d.id,use:m.intendedUse}:{targetType:'image',index,sourceImageId,elementId});return;}
  promptEditor={projectId:p.id,index,sourceImageId,elementId};const m=p.materials.find(m=>m.id===sourceImageId),draft=p.imagePromptDrafts?.[promptKey(promptEditor)];
  $('#imagePromptForm').reset();setPromptInput($('#imagePromptText'),draft?.prompt||m?.prompt||'',{reset:true,onChange:()=>$('#imagePromptConsent').checked=false});$('#imageInstruction').value=draft?.instruction||'';setPromptMode(draft?.mode||'direct');
  refreshPromptContext();$('#imagePromptState').textContent=draft?'已载入保存的提示词草稿。':'编辑草稿后，可保存或重新生成图片。';syncPromptUI();$('#imagePromptDialog').showModal();$('#imagePromptDialog').scrollTop=0;
}
function refreshPromptContext(){
  const m=p.materials.find(m=>m.id===promptEditor.sourceImageId),history=[];let prev=m?.parentImageId;const seen=new Set();
  while(prev&&!seen.has(prev)){seen.add(prev);const old=p.materials.find(m=>m.id===prev);if(!old)break;history.push(old);prev=old.parentImageId;}
  $('#imagePromptTitle').textContent=m?'查看 / 修改图片提示词':promptEditor.elementId?'生成元素图':'生成 AI 插画';
  $('#promptImageContext').innerHTML=m?`<div class="prompt-image-context"><img src="/api/projects/${p.id}/assets/${m.id}" alt="当前 AI 图片"><div><span class="tag">当前图片 · AI 生成</span><small>${h(m.model||'历史模型信息未记录')}</small><details open><summary>当前图片生成时发送的提示词</summary><pre>${h(m.effectivePrompt||m.prompt+promptSuffix)}</pre></details></div></div>${history.length?`<details class="prompt-history"><summary>历史提示词 · ${history.length} 版</summary>${history.map((m,i)=>`<article><strong>上一版 ${i+1}${m.model?' · '+h(m.model):''}</strong><pre>${h(m.effectivePrompt||m.prompt+promptSuffix)}</pre></article>`).join('')}</details>`:''}`:`<p class="subtle">${promptEditor.elementId?'生成独立元素图，将插入当前图片节点。':'为当前页准备概念插画。'}先编写或改写提示词。</p>`;
  const elementPurpose=promptEditor.elementId||['element','supplement','scientific'].includes(m?.purpose);const provider=elementPurpose&&p.provider?.elementImage?p.provider.elementImage:p.provider?.image;$('#promptImageContext').insertAdjacentHTML('beforeend',`<p class="subtle prompt-provider">本次生图通道：${elementPurpose&&p.provider?.elementImage?'独立元素 API':'通用生图 API'}${provider?' · '+h(provider.model):' · 尚未配置'}</p>`);
  $('#imagePromptDestination').textContent=promptEditor.index===null?'生成结果保存为新素材。':`生成结果将用于第 ${promptEditor.index+1} 页${promptEditor.elementId?'的「'+p.slides[promptEditor.index].elements.find(n=>n.id===promptEditor.elementId).label+'」元素':''}，并重置该页所在演示的预览批准。`;
}
function setPromptMode(mode){promptEditMode=mode==='natural'?'natural':'direct';$('#naturalPromptFields').hidden=promptEditMode!=='natural';$$('[data-prompt-mode]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.promptMode===promptEditMode)));}
function promptPayload(){assertPromptEditor();return {index:promptEditor.index,sourceImageId:promptEditor.sourceImageId,elementId:promptEditor.elementId,prompt:$('#imagePromptText').value,instruction:$('#imageInstruction').value,mode:promptEditMode};}
function syncPromptUI(){
  if(!$('#imagePromptDialog'))return;const running=busy();$$('#imagePromptDialog textarea,#imagePromptDialog input,#imagePromptDialog button:not(.close):not(#cancelPromptTask)').forEach(e=>e.disabled=running&&(!p?.imageTaskQueueEnabled||e.matches('#rewriteImagePrompt,#saveImagePrompt')));
  $('#cancelPromptTask').hidden=!running;if(running&&$('#imagePromptDialog').open)$('#imagePromptState').textContent=p.task.message||p.task.label;
}
function finishPromptTask(){
  if(!promptEditor||promptEditor.projectId!==p.id||!$('#imagePromptDialog').open)return;
  if(p.task.status!=='done'){$('#imagePromptState').textContent=p.task.message;return;}
  if(p.task.label==='改写图片提示词'&&p.task.promptDraftKey===promptKey(promptEditor)){
    const draft=p.imagePromptDrafts[promptKey(promptEditor)];setPromptInput($('#imagePromptText'),draft.prompt);$('#imagePromptState').textContent='提示词已改写并保存为草稿。核对后可继续编辑或生成图片。';
  }else if(p.task.resultImageId){
    promptEditor.sourceImageId=p.task.resultImageId;refreshPromptContext();$('#imagePromptConsent').checked=false;$('#imagePromptState').textContent='新图片已生成，原图与历史提示词已保留。';
  }
}
$('#imagePromptForm').onsubmit=e=>{e.preventDefault();safe(async()=>{
  assertPromptEditor();if(!((promptEditor.elementId||['element','supplement','scientific'].includes(p.materials.find(m=>m.id===promptEditor.sourceImageId)?.purpose))?p.elementImageReady:p.imageReady)){openAPI();toast('生成图片需要连接生图 API');return;}
  if(!$('#imagePromptConsent').checked)throw Error('请确认向生图供应商发送提示词');
  await act('image',{...promptPayload(),allowUpload:true});$('#imagePromptDialog').close();
});};
$('#apiButton').onclick=openAPI;
$('#apiForm').elements.executionConcurrency.onchange=()=>safe(async()=>{await act('setConcurrency',{limit:Number($('#apiForm').elements.executionConcurrency.value)});$('#concurrencySaveState').textContent='已保存 · 并发上限 '+p.executionConcurrency+'，下次任务生效；执行过程可查看队列和判断摘要。';});
$('#apiForm').onsubmit=e=>{e.preventDefault();const submit=e.submitter?.value;safe(async()=>{await persistAPIConfiguration();if(submit==='test'){await act('testAPI',{type:'text'});syncAPIStatus();}else{$('#apiDialog').close();toast(p.apiPersistence==='windows-dpapi'?'API 已在本机加密保存，重启自动恢复':'API 已保存到当前服务会话');}});};
$('#forgetKey').onclick=()=>safe(async()=>{apiAutosave.reset();await apiAutosave.settled();apiAutosave.reset();await act('forgetKey');apiFormProject=null;apiFormEpoch++;acknowledgedAPIKeys.clear();$('#apiForm').reset();$('#apiDialog').close();toast('当前项目密钥已清除');});
$('#apiForm').addEventListener('input',e=>{if(e.target.matches('input'))apiAutosave.schedule();});
$('#apiForm').addEventListener('change',e=>{if(e.target.matches('input'))apiAutosave.schedule();});
$('#apiForm').addEventListener('focusout',e=>{if(e.target.matches('input')){clearAcknowledgedAPIKeys();apiAutosave.flush().catch(()=>{});}});
$('#apiDialog').addEventListener('close',()=>{clearAcknowledgedAPIKeys();apiAutosave.flush().catch(()=>{});});
$('#editForm').onsubmit=e=>{e.preventDefault();const f=new FormData(e.target);safe(async()=>{await act(editMode,{index:editIndex,instruction:f.get('instruction'),prompt:f.get('instruction'),allowUpload:f.has('consent')});$('#editDialog').close();});};
$('#cancelTask').onclick=()=>safe(()=>act('cancel'));
$('#openArchives').onclick=()=>safe(async()=>{await refreshProjects();$('#projectArchiveDialog').showModal();});
$('#archiveProject').onclick=()=>safe(async()=>{
  if(!p||archivePending)return;if(busy()||sending||collectingMaterials||designBatchPending)throw Error('请等待任务或材料选择、发送完成后归档');
  if(sendQueue.length||materialDraft.trim())throw Error('还有待发送材料，请先发送或移除后再归档');
  archivePending=true;syncArchiveButton();
  try{
    const projectId=p.id,form=$('#briefForm'),drafts=$$('[data-design-markdown]').map(el=>({index:Number(el.dataset.designMarkdown),markdown:el.value})).filter(d=>d.markdown!==p.pageDesigns?.[d.index]?.markdown);
    if(drafts.length&&tab===1&&JSON.stringify(collectSlides())!==JSON.stringify(p.slides))throw Error('内容树与设计稿均有修改，请先保存内容并更新设计稿后归档');
    if(form&&!sameBrief(readBrief(form)))await act('requirements',{brief:readBrief(form)});
    await flushSlideEdits();
    for(const d of drafts)p=await api(`/api/projects/${projectId}/action`,{action:'savePageDesign',...d});
    await apiAutosave.flush();await apiAutosave.settled();apiAutosave.reset();
    p=await api(`/api/projects/${projectId}/archive`,{archived:true});
    p=null;tab=0;sendQueue=[];selectionSummary=null;materialDraft='';clearTimeout(pollTimer);localStorage.removeItem('ppt-agent-project');render();await refreshProjects();toast('项目已归档，可在「已归档」中恢复');
  }finally{archivePending=false;syncArchiveButton();}
});
$('#projectArchiveList').onclick=e=>safe(async()=>{
  const deleteButton=e.target.closest('[data-delete-project]');
  if(deleteButton){
    deleteArchiveTarget={id:deleteButton.dataset.deleteProject,title:deleteButton.dataset.projectTitle};
    $('#deleteArchiveName').textContent=deleteArchiveTarget.title;
    $('#deleteArchiveDialog').showModal();return;
  }
  const button=e.target.closest('[data-restore-project]');if(!button)return;
  if(sending||busy()||collectingMaterials)throw Error('请等待当前任务或材料选择完成后恢复并切换项目');
  if(sendQueue.length||materialDraft.trim())throw Error('还有待发送材料，请先发送或移除后再切换项目');
  const briefForm=$('#briefForm');if(p&&briefForm&&!sameBrief(readBrief(briefForm)))throw Error('需求有未保存修改，请先保存后再切换项目');
  if(p&&$$('[data-design-markdown]').some(el=>el.value!==p.pageDesigns?.[Number(el.dataset.designMarkdown)]?.markdown))throw Error('设计稿有未保存修改，请先保存后再切换项目');
  await flushSlideEdits();button.disabled=true;
  try{await api(`/api/projects/${button.dataset.restoreProject}/archive`,{archived:false});$('#projectArchiveDialog').close();await load(button.dataset.restoreProject);toast('项目已恢复');}finally{button.disabled=false;}
});
$('#deleteArchiveForm').onsubmit=e=>{e.preventDefault();safe(async()=>{
  if(!deleteArchiveTarget||deleteArchivePending)return;
  const target=deleteArchiveTarget;deleteArchivePending=true;
  const cancelButton=$('#deleteArchiveDialog [data-close]');cancelButton.disabled=true;
  const button=$('#confirmDeleteArchive');button.disabled=true;button.textContent='正在删除…';
  try{
    await api(`/api/projects/${target.id}/delete`,{confirmTitle:target.title});
    deleteArchiveTarget=null;$('#deleteArchiveDialog').close();
    await refreshProjects();toast('归档项目及其材料、生成文件已永久删除');
  }finally{deleteArchivePending=false;button.disabled=false;cancelButton.disabled=false;button.textContent='永久删除';}
});};
$('#deleteArchiveDialog').addEventListener('cancel',e=>{if(deleteArchivePending)e.preventDefault();});
$('#newProject').onclick=()=>safe(async()=>{$('#supplementImageDialog').close();$('#supplementImageForm').reset();delete $('#supplementImageDialog').dataset.projectId;rebuildRegionEditor.close();aiImageEditor.close();materialCropEditor.close();if(designBatchPending)throw Error('正在确认所有页设计，请稍候');if(sending)throw Error('正在发送材料，请等待完成');$('#imagePromptDialog').close();$('#sourceDialog').close();sendQueue=[];selectionSummary=null;materialDraft='';if(tab===1&&$('#slidesForm')&&JSON.stringify(collectSlides())!==JSON.stringify(p.slides))await saveSlides();$('#materialImageDialog').close();$('#materialReader').close();p=null;tab=0;localStorage.removeItem('ppt-agent-project');render();await refreshProjects();});
$('#projects').onchange=e=>safe(async()=>{if(sending){e.target.value=p?.id||'';throw Error('正在发送材料，请等待完成');}if(e.target.value)await load(e.target.value);});
await safe(async()=>{const health=await api('/api/health');titlePageOptionAvailable=!!health.titlePageOption;materialStreamingAvailable=!!health.materialStreaming;const id=localStorage.getItem('ppt-agent-project');if(id){try{await load(id);return;}catch{localStorage.removeItem('ppt-agent-project');}}render();await refreshProjects();});

let pendingImageChoices=[];
function openImageTaskDialog(){
  pendingImageChoices=imageTaskChoices(p);if(!pendingImageChoices.length)throw Error('暂无可添加的任务，请先连接主模型或生图 API，并准备相应内容');
  $('#taskProgressDialog').close();$('#imageTaskTarget').innerHTML=imageTaskOptions(pendingImageChoices);updateImageTaskChoice();$('#addImageTaskDialog').showModal();
}
function updateImageTaskChoice(){
  const choice=pendingImageChoices.find(c=>c.key===$('#imageTaskTarget').value),input=$('#imageTaskPrompt');
  input.value=choice?.prompt||'';input.required=!!choice?.required;input.closest('label').hidden=choice?.input===null;
  input.maxLength=choice?.input==='instruction'?3000:30000;
  $('#imageTaskPromptLabel').textContent=choice?.input==='instruction'?'设计修改意见':'完整提示词';
  input.placeholder=choice?.input==='instruction'?'填写本页布局、层次或风格的修改意见。':'整页预览留空时采用当前已确认设计稿；元素图请填写完整提示词。';
  $('#imageTaskConsentLabel').textContent=choice?.type==='design'?'确认调用已配置的主模型 API 生成或修改设计稿':'确认按以上提示词调用已配置的生图 API';
  $('#imageTaskConsent').checked=false;$('#imageTaskState').textContent='提交后加入列表；当前内容与修改意见会在此刻锁定，等待时仍可继续添加其他任务。';
}
$('#imageTaskTarget').onchange=updateImageTaskChoice;
$('#addImageTaskForm').onsubmit=e=>{e.preventDefault();safe(async()=>{
  const state=$('#imageTaskState'),button=e.target.querySelector('[type=submit]');button.disabled=true;
  try{
    const choice=pendingImageChoices.find(c=>c.key===$('#imageTaskTarget').value);if(!choice||!$('#imageTaskConsent').checked)throw Error('请选择任务并确认调用 API');
    const body=taskChoicePayload(choice,$('#imageTaskPrompt').value);
    const {action,...extra}=body;await act(action,extra);$('#addImageTaskDialog').close();$('#taskProgressDialog').showModal();progressSnapshot='';syncTaskProgress();
  }catch(error){state.textContent=error.message;throw error;}finally{button.disabled=false;}
});};
