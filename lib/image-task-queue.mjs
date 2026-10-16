import crypto from 'node:crypto';
import {supplementImageTypes} from '../public/material-images.js';

export const isImageTask=b=>['image','supplementImage','scientificImage','concepts','generateConceptPage','generateFullPreview','generateThemeAsset'].includes(b?.action)||(b?.action==='generateThemeAssets'&&Array.isArray(b.prompts));
export const isDesignTask=b=>['content','designPage','revisePageDesign','draftPageDesigns'].includes(b?.action);
export const isQueuedTask=b=>isImageTask(b)||isDesignTask(b);
const fields=['action','index','theme','use','prompt','prompts','confirmed','revision','force','sourceImageId','elementId','purpose','allowUpload','mode','instruction','markdown','imageEditMode','adjustmentRevision','sourceHash','figureType','figureName','imageType','imageName','academicStyle','crossStyleSource','crossStyleTargetStyleId','crossStyleTargetHash'];
const hash=v=>crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
const designInput=p=>{
  const referenced=new Set((p.slides||[]).flatMap(s=>[...(s.sources||[]),s.imageId,...(s.elements||[]).map(n=>n.materialId)]).filter(Boolean));
  return hash({slides:p.slides,materials:(p.materials||[]).filter(m=>!m.generated||referenced.has(m.id)),analysis:p.analysis});
};
export function imageTaskRequest(b){
  const request=structuredClone(Object.fromEntries(fields.filter(k=>b[k]!==undefined).map(k=>[k,b[k]])));
  if(request.prompts)request.prompts=request.prompts.map(r=>Object.fromEntries(['theme','use','prompt','revision'].filter(k=>r?.[k]!==undefined).map(k=>[k,r[k]])));
  return request;
}
export function imageTaskLabel(b){
  if(b.action==='supplementImage')return '补充图片 · '+(b.imageName?b.imageName+' / ':'')+(supplementImageTypes.find(t=>t.id===b.imageType)?.name||'图片');
  if(b.action==='scientificImage')return '科研图 · '+(b.figureName||({flowchart:'流程图',roadmap:'技术路线图',mechanism:'机理图',schematic:'结构示意图',other:'其他科研图'}[b.figureType]||'图示'));
  if(b.action==='content')return '逐页内容与设计 · AI 初稿';
  if(b.action==='draftPageDesigns')return '补齐逐页设计稿';
  if(['designPage','revisePageDesign'].includes(b.action))return (b.action==='revisePageDesign'?'修改单页设计':'单页设计')+' · 第 '+(Number(b.index)+1)+' 页';
  if(b.action==='concepts')return '三版视觉方案';
  if(b.action==='generateThemeAssets')return '主题底图 · '+b.prompts.map(r=>r.theme.toUpperCase()+' / '+({'hero-image':'封面','toc-image':'目录','content-background':'正文'}[r.use]||r.use)).join('、');
  if(b.action==='generateThemeAsset')return (b.crossStyleSource?'交叉修改 · '+String(b.crossStyleSource.theme).toUpperCase()+' → ':'主题底图 · ')+String(b.theme).toUpperCase()+' / '+b.use;
  if(b.action==='generateFullPreview')return b.index===undefined?'完整预览 · 已确认页面':'完整预览 · 第 '+(Number(b.index)+1)+' 页';
  if(b.action==='generateConceptPage')return '方向 '+String(b.theme).toUpperCase()+' · 第 '+(Number(b.index)+1)+' 页';
  return (b.elementId?'元素图':'补充插画')+(b.index===undefined||b.index===null?'':' · 第 '+(Number(b.index)+1)+' 页');
}
export function enqueueImageTask(p,b){
  if(!isQueuedTask(b))throw Error('仅支持添加设计或生图任务');
  if(isDesignTask(b)){
    if(b.action==='content'&&!p.approvals?.requirements)throw Error('请先确认需求与材料');
    if(b.action!=='content'&&!p.slides?.length)throw Error('请先生成逐页内容');
    if(['designPage','revisePageDesign'].includes(b.action)&&(!Number.isInteger(Number(b.index))||!p.slides[Number(b.index)]))throw Error('页面不存在');
    if(b.action==='revisePageDesign'&&(!String(b.instruction||'').trim()||b.instruction.length>3000))throw Error('修改意见须为 1–3,000 字');
    if(b.markdown!==undefined&&(typeof b.markdown!=='string'||b.markdown.length>80000))throw Error('设计稿过长或无效');
  }
  if(['image','supplementImage','scientificImage'].includes(b.action)&&b.allowUpload!==true)throw Error('请确认向配置的生图供应商发送提示词');
  if(['generateThemeAssets','generateThemeAsset'].includes(b.action)&&b.confirmed!==true)throw Error('请先核对并确认底图提示词');
  if(b.action==='generateThemeAssets'&&(!b.prompts.length||b.prompts.length>9||b.prompts.some(r=>!['a','b','c'].includes(r?.theme)||!['hero-image','toc-image','content-background'].includes(r?.use)||typeof r.prompt!=='string'||r.prompt.length>30000)))throw Error('底图任务提示词无效');
  const request=imageTaskRequest(b),fingerprint=hash(request),queue=p.imageTaskQueue||=[];
  if(queue.filter(t=>t.status==='queued').length>=20)throw Error('等待任务已达 20 个，请等待部分任务完成');
  if(queue.some(t=>['queued','running'].includes(t.status)&&t.fingerprint===fingerprint))throw Error((isDesignTask(b)?'相同设计任务':'相同生图任务')+'已在列表中，请勿重复添加');
  const record={id:crypto.randomUUID(),label:imageTaskLabel(request),request,fingerprint,status:'queued',createdAt:new Date().toISOString(),guard:{brief:hash(p.brief),...(['concepts','generateConceptPage','generateFullPreview'].includes(b.action)?{version:p.version}:{}),...(b.action==='generateFullPreview'?{selectedTheme:p.selectedTheme}:{}),...(['generateThemeAssets','generateThemeAsset'].includes(b.action)?{themeSet:p.themeAssets?.id}:{}),...(b.index!==undefined&&b.index!==null?{slideTitle:p.slides[Number(b.index)]?.title}:{})}};
  if(isDesignTask(b)){record.guard.version=p.version;record.guard.designInput=designInput(p);if(b.action==='revisePageDesign')record.guard.designDraft=hash(p.pageDesigns?.[Number(b.index)]?.markdown??null);}
  if(['supplementImage','scientificImage'].includes(b.action))record.guard.analysis=hash(p.analysis);
  queue.push(record);p.imageTaskQueue=queue.filter(t=>['queued','running'].includes(t.status)||queue.indexOf(t)>=queue.length-40);return record;
}
export function checkImageTaskGuard(p,record){
  const g=record.guard;
  if(g.brief!==hash(p.brief)||(g.version!==undefined&&g.version!==p.version)||('selectedTheme'in g&&g.selectedTheme!==p.selectedTheme)||('themeSet'in g&&g.themeSet!==p.themeAssets?.id)||('slideTitle'in g&&g.slideTitle!==p.slides[Number(record.request.index)]?.title))throw Error('需求、内容或方向已变化，请重新核对并添加任务');
  if(g.designInput&&g.designInput!==designInput(p))throw Error('材料或逐页内容已变化，请重新核对并添加设计任务');
  if(g.designDraft&&g.designDraft!==hash(p.pageDesigns?.[Number(record.request.index)]?.markdown??null))throw Error('本页设计稿已变化，请重新核对修改意见并添加任务');
  if(g.analysis&&g.analysis!==hash(p.analysis))throw Error('材料理解已变化，请重新核对补充图片任务');
}
export function publicImageTasks(p){return (p.imageTaskQueue||[]).map(({request,fingerprint,guard,...record})=>record);}
export function moveQueuedImageTask(p,{id,targetId,position}){
  const queue=p.imageTaskQueue||[],waiting=queue.filter(t=>t.status==='queued');
  if(!['before','after'].includes(position))throw Error('任务排序位置无效');
  if(id===targetId)throw Error('请选择其他等待任务作为排序位置');
  const source=waiting.find(t=>t.id===id),target=waiting.find(t=>t.id===targetId);
  if(!source||!target)throw Error('仅可调整等待中的任务；任务状态已变化，请刷新列表后重试');
  const ordered=waiting.filter(t=>t.id!==id),index=ordered.findIndex(t=>t.id===targetId);
  ordered.splice(index+(position==='after'?1:0),0,source);
  // Replace waiting slots only: active tasks and history keep their positions.
  let next=0;p.imageTaskQueue=queue.map(t=>t.status==='queued'?ordered[next++]:t);
}
export function interruptImageTasks(p){for(const job of p.imageTaskQueue||[])if(['queued','running'].includes(job.status)){job.status='interrupted';job.message='服务重启，请重新核对后添加任务';job.finishedAt=new Date().toISOString();}}
