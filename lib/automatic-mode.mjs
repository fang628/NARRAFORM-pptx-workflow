import crypto from 'node:crypto';
import {sourceMaterials,analysisCurrent} from './materials.mjs';
import {pageDesignState} from './page-design.mjs';
import {fullPageCurrent,pageStamp} from './visual-model.mjs';
import {themeAssetsCurrent,themePromptDrafts,themeAssetAvailable} from './theme-assets.mjs';
import {previewApprovalState} from './preview-approval.mjs';
import {draftDownloadState} from './rebuild-output.mjs';
import {speakerOptions,speakerScriptPublic} from './speaker-script.mjs';

const at=()=>new Date().toISOString();
const signature=request=>crypto.createHash('sha256').update(JSON.stringify(request)).digest('hex');
const command=(action,label,tab,extra={})=>({kind:'action',request:{action,...extra},label,tab});
export function nextAutomaticStep(p){
  const materials=sourceMaterials(p);
  const document=materials.find(m=>!m.extracted&&!m.imageExtraction&&/\.(pdf|docx|pptx)$/i.test(m.file||''));
  if(document)return command('extractMaterialImages','提取材料中的原始图片',0,{id:document.id});
  if(!p.approvals?.requirements)return command('requirements','自动确认需求',0,{brief:p.brief});
  if(materials.length&&(!analysisCurrent(p)||materials.some(m=>m.kind==='image'&&!p.analysis?.readings?.some(r=>r.id===m.id&&r.status==='read'))))return command('analyzeMaterials','理解全部材料与图片',0,{includeImages:true});
  if(materials.length&&!p.analysis.approvedAt)return command('approveAnalysis','自动确认材料理解',0,{reviewNotes:p.analysis.reviewNotes||''});
  if(!p.slides.length)return command('content','生成逐页内容与设计稿',1);
  if(p.approvals.content!==p.version)return command('approveContent','自动确认逐页内容',1);
  if(p.slides.some((s,i)=>!pageDesignState(p,i)?.current))return command('draftPageDesigns','补齐单页设计稿',1);
  const unapproved=p.slides.findIndex((s,i)=>!pageDesignState(p,i)?.approvedCurrent);
  if(unapproved>=0)return command('approvePageDesign','自动确认第 '+(unapproved+1)+' 页设计',1,{index:unapproved});
  const direction=p.concepts.find(c=>c.id===p.selectedTheme&&c.mode==='ai');
  if(!direction){
    if(p.concepts.some(c=>c.mode==='ai'&&c.expectedPages?.length&&c.expectedPages.every(i=>c.representatives?.some(r=>r.index===i&&r.file&&r.previewHash&&r.stamp===pageStamp(p,i,c.id)))))return {kind:'style',choice:'direction',tab:2,label:'请选择 A／B／C 视觉方向，选择后自动继续'};
    if(!p.visualTreatment)return {kind:'style',choice:'treatment',tab:2,label:'请选择简约平面或写实／立体，选择后自动继续'};
    if(!themeAssetsCurrent(p)||p.themeAssets.directions?.length!==3)return command('generateThemeAssets','规划三方向风格与底图提示词',2,{visualTreatment:p.visualTreatment});
    const pending=themePromptDrafts(p).filter(r=>r.status!=='generated'||!themeAssetAvailable(p.themeAssets.directions.find(d=>d.id===r.theme)?.assets?.[r.use]));
    if(pending.length)return command('generateThemeAssets','自动确认提示词并生成底图',2,{prompts:pending,confirmed:true});
    return command('concepts','生成三版视觉预览',2);
  }
  if(!p.slides.every((s,i)=>fullPageCurrent(p,i)))return command('generateFullPreview','生成其余页面的完整预览',3);
  if(p.approvals.preview!==p.version){const state=previewApprovalState(p);return command('approvePreview','自动确认完整预览并保留检查问题',3,{confirmAllPages:true,acceptIssues:true,approvalStamp:state.stamp});}
  if(!draftDownloadState(p).available||!p.candidate?.structure?.passed)return command('build','重建、实际渲染与有限修订',4);
  if(speakerOptions(p).enabled&&!speakerScriptPublic(p).speakerScriptCurrent)return command('generateSpeakerScript','生成讲稿 PDF',4);
  const warnings=p.candidate.review?.pages?.filter(r=>!r.passed).length||0;
  return {kind:'complete',tab:4,label:warnings?'自动制作完成，已保留 '+warnings+' 页检查问题与最后可下载结果':'自动制作完成，可下载 PPTX',warnings};
}

function record(p,entry){p.autoMode.history=[...(p.autoMode.history||[]),{at:at(),...entry}].slice(-120);}
export function startAutomaticMode(p){
  if(p.autoMode?.enabled)return;
  p.autoMode={enabled:true,id:crypto.randomUUID(),status:'running',tab:0,message:'自动模式已开启，风格选择由你完成',startedAt:at(),history:[],attempts:{}};
  record(p,{status:'started',message:p.autoMode.message});
}
export function stopAutomaticMode(p,message='已退出自动模式；当前任务继续完成，不再自动推进'){
  if(!p.autoMode?.enabled)return;
  Object.assign(p.autoMode,{enabled:false,status:'paused',message,finishedAt:at()});record(p,{status:'paused',message});
}
export function interruptAutomaticMode(p){
  if(p.autoMode?.enabled){stopAutomaticMode(p,'服务已重启，自动模式已暂停；可手动继续开启');p.autoMode.status='interrupted';}
}
export function automaticModePublic(p){
  const {attempts,...state}=p.autoMode||{enabled:false,status:'off',history:[]};
  return {automaticModeEnabled:true,autoMode:state};
}
// Manual style choices are the only workflow decisions that keep automatic execution active.
export function keepsAutomaticMode(request){
  return ['favoriteStyle','removeFavoriteStyle','selectTheme','changeThemeDirection','regenerateThemeDirection','regenerateThemePrompts','generateThemeAsset','rewriteThemeAssetPrompt','setThemeBackgroundUse','setConcurrency','configure','testAPI','moveQueuedImageTask','cancelQueuedImageTask'].includes(request.action)||request.action==='generateThemeAssets';
}
function approvalProvenance(p,request,id){
  const method={mode:'automatic',runId:id,at:at()};
  if(request.action==='approveAnalysis')p.analysis.approvalMethod=method;
  if(request.action==='approvePageDesign')p.pageDesigns[request.index].approvalMethod=method;
  if(['approveContent','enterVisualStage'].includes(request.action))for(const [index,d] of Object.entries(p.pageDesigns||{}))if(p.slides[index]&&pageDesignState(p,Number(index))?.approvedCurrent)d.approvalMethod=method;
  if(request.action==='approvePreview'){
    p.previewApproval.approvalMethod=method;
    for(const page of Object.values(p.visualPages||{}))if(page.manualReview)page.manualReview.confirmedVia='automatic-mode';
  }
}

export function createAutomaticRunner({execute,isBusy,save,isPresent=()=>true,verifyDelivery=()=>{},nextStep=nextAutomaticStep,delay=25}){
  const timers=new Map(),active=new Set();
  const wake=p=>{
    if(!p.autoMode?.enabled||timers.has(p.id)||active.has(p.id))return;
    const timer=setTimeout(()=>{timers.delete(p.id);void advance(p);},delay);timers.set(p.id,timer);
  };
  const fail=(p,message)=>{Object.assign(p.autoMode,{enabled:false,status:'failed',message,finishedAt:at()});record(p,{status:'failed',message});save(p);};
  async function advance(p){
    if(!p.autoMode?.enabled||!isPresent(p)||p.archivedAt||isBusy(p))return;
    active.add(p.id);const mode=p.autoMode,id=mode.id;
    try{
      if(p.task?.automaticRunId===id&&p.task.status==='cancelled'){stopAutomaticMode(p,'自动任务已取消，已退出自动模式');save(p);return;}
      const step=nextStep(p);
      if(p.task?.automaticRunId===id&&p.task.status==='failed'&&step.kind==='action'&&signature(step.request)===mode.lastRequest){fail(p,'自动模式已暂停，结果保留：'+p.task.message);return;}
      Object.assign(mode,{tab:step.tab,message:step.label,status:step.kind==='style'?'waiting_style':step.kind==='complete'?'completed':'running',choice:step.choice||null});
      if(step.kind==='complete'){await verifyDelivery(p);if(!mode.enabled||p.autoMode!==mode)return;mode.enabled=false;mode.finishedAt=at();mode.warnings=step.warnings;record(p,{status:'completed',message:step.label});save(p);return;}
      if(step.kind==='style'){save(p);return;}
      const key=signature(step.request),attempts=mode.attempts[key]||0;
      if(attempts>=2){fail(p,'自动步骤未能完成，已保留结果：'+step.label+'；可退出后修改或重试');return;}
      mode.attempts[key]=attempts+1;mode.lastRequest=key;
      record(p,{status:'started',action:step.request.action,index:step.request.index,message:step.label});save(p);
      // Recheck after yielding between every confirmation; stop must prevent the next request.
      if(!mode.enabled||p.autoMode!==mode)return;
      await execute(p,step.request,id);
      if(p.autoMode!==mode||!mode.enabled)return;
      approvalProvenance(p,step.request,id);
      record(p,{status:'submitted',action:step.request.action,index:step.request.index,message:step.label});save(p);
    }catch(error){if(p.autoMode===mode&&mode.enabled)fail(p,'自动模式已暂停，已有结果保留：'+String(error.message).slice(0,600));}
    finally{active.delete(p.id);if(p.autoMode?.enabled&&!isBusy(p)&&p.autoMode.status==='running')wake(p);}
  }
  return {wake,dispose(){for(const timer of timers.values())clearTimeout(timer);timers.clear();}};
}
