import crypto from 'node:crypto';
import {initialElements,orderedElements} from './elements.mjs';
import {materialStamp} from './materials.mjs';
import {pageDesignStamp,pageDesignInputStamp,pageDesignState,renderPageDesign,validatePageDesign} from './page-design.mjs';
import {themeAssetsStamp,themeAssetsInputStamp,themeAssetsCurrent} from './theme-assets.mjs';
import {pageStamp,visualStamp,canonicalTexts,validateImagePlan,validateAudit,rebuiltCurrent} from './visual-model.mjs';
import {workflowLibraryVersion} from './workflow-library.mjs';
import {designPolicyVersion} from './design-rules.mjs';
import {isDeepStrictEqual} from 'node:util';
import {fullPageCurrent} from './visual-model.mjs';

const hash=v=>crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
const policyVersion=()=>designPolicyVersion+':'+workflowLibraryVersion;
const inputs=p=>hash({themeAssets:p.themeAssets&&{id:p.themeAssets.id,directions:p.themeAssets.directions?.map(d=>({id:d.id,styleRegistrationId:d.styleRegistrationId,useContentBackground:d.useContentBackground,assets:Object.entries(d.assets||{}).map(([use,r])=>[use,r.materialId,r.previewHash])}))},brief:p.brief,materials:p.materials.filter(m=>!m.generated).map(m=>({id:m.id,sha256:m.sha256,text:m.text})),slides:p.slides,designs:Object.entries(p.pageDesigns||{}).map(([i,d])=>[i,d.markdown]),analysis:p.analysis&&{summary:p.analysis.summary,outline:p.analysis.outline,reviewNotes:p.analysis.reviewNotes}});
const fields=['brief','slides','analysis','pageDesigns','themeAssets','concepts','selectedTheme','visualMode','visualPages','reconstruction','styleRegistry','approvals'];
export function captureReusableResults(p){
  if(downstreamReuseState(p).pending)return;
  if(!Object.values(p.pageDesigns||{}).some(d=>d.plan)&&!p.themeAssets?.directions?.length)return;
  const source=Object.fromEntries(fields.filter(k=>p[k]!==undefined).map(k=>[k,structuredClone(p[k])]));
  if(!source.themeAssets?.directions?.length&&p.reuseCheckpoint?.source.themeAssets?.directions?.length)source.themeAssets=structuredClone(p.reuseCheckpoint.source.themeAssets);
  const buildFields=['candidate','output','rebuildLive','rebuildAssetPreview','previewApproval'];
  p.reuseCheckpoint={inputs:inputs(p),version:p.version,at:new Date().toISOString(),source,buildResults:Object.fromEntries(buildFields.map(k=>[k,structuredClone(p[k]??null)])),materialHashes:Object.fromEntries(p.materials.map(m=>[m.id,m.sha256]))};
}
function restoredContentDraft(p){
  const c=p.reuseCheckpoint,base=c?.source;
  if(!base?.slides?.length||!base.reconstruction||!base.approvals?.preview||isDeepStrictEqual(p.slides,base.slides)||!isDeepStrictEqual(p.brief,base.brief))return null;
  // This restores an accidental content edit, never approves changed materials.
  const required=new Set(base.slides.flatMap(s=>[...(s.sources||[]),...initialElements(s).map(n=>n.materialId).filter(Boolean)]));
  for(const page of base.reconstruction.slides||[]){if(page.background?.id)required.add(page.background.id);for(const e of page.elements||[])if(e.type==='image')required.add(e.id);}
  for(const direction of base.themeAssets?.directions||[])for(const asset of Object.values(direction.assets||{}))if(asset?.materialId)required.add(asset.materialId);
  if([...required].some(id=>!c.materialHashes?.[id]||!p.materials.some(m=>m.id===id&&m.sha256===c.materialHashes[id])))return null;
  const draft={...p,version:p.version+1};
  for(const key of ['slides','pageDesigns','themeAssets','concepts','selectedTheme','visualMode','visualPages','reconstruction'])draft[key]=structuredClone(base[key]);
  if(!draft.slides.every((_,i)=>fullPageCurrent(draft,i))||!rebuiltCurrent(draft))return null;
  return draft;
}
export function contentRestoreState(p){
  return {available:p.task?.status!=='running'&&!!restoredContentDraft(p),fromVersion:p.reuseCheckpoint?.version||null};
}
export function restoreContentCheckpoint(p){
  const draft=restoredContentDraft(p);if(p.task?.status==='running'||!draft)throw Error('没有可安全恢复的误改前内容与重建结果');
  const c=p.reuseCheckpoint,stamp=visualStamp(draft),at=new Date().toISOString();
  draft.approvals={...p.approvals,content:draft.version,preview:draft.version};
  for(const key of ['rebuildLive','rebuildAssetPreview']){
    const saved=c.buildResults?.[key]||p[key];
    draft[key]=saved?.stamp===stamp?{...structuredClone(saved),version:draft.version}:null;
  }
  const candidate=c.buildResults?.candidate;
  draft.candidate=candidate?.stamp===stamp?{...structuredClone(candidate),version:draft.version}:null;
  draft.output=null; // Existing checks are retained; restoration does not grant release status.
  const approval=c.buildResults?.previewApproval||(p.previewApproval?.stamp===stamp?p.previewApproval:null);
  draft.previewApproval={...structuredClone(approval||{acceptedIssues:[]}),version:draft.version,stamp,restoredAt:at};
  draft.stage=6;draft.contentRestoredAt=at;draft.rebuildPageChanges=null;
  Object.assign(p,draft);
  return {fromVersion:c.version,pages:p.slides.length};
}
export function downstreamReuseState(p){
  const c=p.reuseCheckpoint,base=c?.source;
  const stale=!!base&&(Object.entries(base.pageDesigns||{}).some(([i,d])=>d.plan&&!pageDesignState(p,Number(i))?.current)||
    (base.themeAssets&&!themeAssetsCurrent(p))||
    (base.concepts||[]).some(old=>(old.representatives||[]).some(r=>{const next=p.concepts.find(d=>d.id===old.id)?.representatives?.find(n=>n.index===r.index);return !p.slides[r.index]||!next||next.stamp!==pageStamp(p,r.index,old.id);}))||
    Object.entries(base.visualPages||{}).some(([i,page])=>page?.file&&(!p.slides[i]||p.visualPages?.[i]?.stamp!==pageStamp(p,Number(i))))||
    (base.reconstruction?.mode==='free'&&!rebuiltCurrent(p)));
  // Rule/library updates must offer reuse even when actual project inputs did not change.
  const pending=!!(c&&stale&&(inputs(p)!==(c.acceptedInputs||c.inputs)||c.acceptedPolicyVersion!==policyVersion()));
  return {enabled:true,pending,fromVersion:c?.version,pages:c?.source.slides.length||0,last:p.downstreamReuseRecord||null};
}
export function reuseDownstream(p){
  const checkpoint=p.reuseCheckpoint;if(!checkpoint||!downstreamReuseState(p).pending)throw Error('暂无需要跳过更新的已有设计结果');
  const draft=structuredClone(p),base=checkpoint.source,at=new Date().toISOString(),skipped=[];
  if(!draft.slides.length)draft.slides=structuredClone(base.slides);
  if(draft.slides.some(s=>(s.sourceLinks||[]).some(l=>l.stale)))throw Error('请先核对标记为待核对的材料对应，再同步新文案');
  if(!draft.analysis&&base.analysis){draft.analysis=structuredClone(base.analysis);draft.analysis.stamp=materialStamp(draft);draft.analysis.reusedAt=at;draft.analysis.reuseNote='沿用此前材料理解；新增或变更材料尚未重新分析';}
  if(!themeAssetsCurrent(draft)||!draft.themeAssets?.directions?.length){
    const saved=draft.themeAssets?.directions?.length?draft.themeAssets:base.themeAssets;
    if(saved?.directions?.length){draft.themeAssets=structuredClone(saved);draft.themeAssets.stamp=themeAssetsStamp(draft);draft.themeAssets.inputStamp=themeAssetsInputStamp(draft);draft.themeAssets.reusedAt=at;}
  }
  draft.concepts=structuredClone(draft.concepts?.length?draft.concepts:base.concepts||[]);draft.selectedTheme=draft.selectedTheme||base.selectedTheme||null;draft.visualMode=draft.visualMode||base.visualMode;
  const removedStyles=new Map((p.styleRegistry||[]).filter(r=>r.deletedAt).map(r=>[r.id,r.deletedAt]));
  draft.styleRegistry=[...new Map([...(base.styleRegistry||[]),...(draft.styleRegistry||[])].map(r=>[r.id,removedStyles.has(r.id)?{...r,deletedAt:removedStyles.get(r.id)}:r])).values()];
  const used=new Set(),matches=draft.slides.map((s,i)=>{
    let index=base.slides.findIndex((old,n)=>!used.has(n)&&JSON.stringify(old)===JSON.stringify(s));
    if(index<0)index=base.slides.findIndex((old,n)=>!used.has(n)&&old.title===s.title);
    if(index<0&&draft.slides.length===base.slides.length&&!used.has(i))index=i;
    if(index>=0)used.add(index);return index;
  });
  draft.pageDesigns={...draft.pageDesigns};draft.visualPages={};let designs=0,previews=0;
  for(let i=0;i<draft.slides.length;i++){
    if(pageDesignState(draft,i)?.current&&draft.pageDesigns[i].plan){designs++;continue;}
    const previous=matches[i],old=base.pageDesigns?.[previous];if(!old?.plan){skipped.push(`第 ${i+1} 页没有可沿用的设计稿`);continue;}
    const nodes=orderedElements(initialElements(draft.slides[i])),plan=structuredClone(old.plan);
    plan.readingOrder=nodes.map(n=>n.id);plan.conclusion=draft.slides[i].title;
    plan.nodes=nodes.map(n=>({...plan.nodes.find(o=>o.id===n.id)||{position:'沿用本页对应内容区，按当前层级安排',relativeSize:'随内容适配',alignment:'沿用原对齐',carrier:'沿用原承载',relation:'以当前内容树为准'},id:n.id}));
    validatePageDesign(plan,initialElements(draft.slides[i]));const stamp=pageDesignStamp(draft,i);
    draft.pageDesigns[i]={...old,contentInputStamp:pageDesignInputStamp(draft,i),contentSnapshot:structuredClone(draft.slides[i]),plan,markdown:renderPageDesign(draft,i,plan),draftStamp:stamp,layoutStamp:stamp,layoutApprovedAt:at,approvedAt:at,reusedAt:at,reusedFrom:old.draftStamp};designs++;
  }
  const adapt=(page,i,theme)=>{
    if(!page||!pageDesignState(draft,i)?.current)return null;
    try{
      validateImagePlan(page.images||[],draft.slides[i]);
      for(const e of page.images||[]){const m=draft.materials.find(m=>m.id===e.id);if(!m||m.sha256!==checkpoint.materialHashes[e.id])throw Error('原图已变更');}
      const stamp=pageStamp(draft,i,theme);
      if(page.index===i&&page.stamp===stamp)return structuredClone(page);
      return {...structuredClone(page),index:i,stamp,manualReview:null,reused:{at,fromStamp:page.stamp,mode:'layout-reference',textSource:'current-content-tree'}};
    }catch{skipped.push(`第 ${i+1} 页图片身份或内容已变化，保留设计稿，配图需另行核对`);return null;}
  };
  draft.concepts=draft.concepts.map(c=>({...c,expectedPages:(c.expectedPages||c.representatives?.map(r=>r.index)||[]).flatMap(old=>{const i=matches.indexOf(old);return i<0?[]:[i];}),representatives:(c.representatives||[]).flatMap(r=>{const i=matches.indexOf(r.index),next=i<0?null:adapt(r,i,c.id);return next?[next]:[];})}));
  for(let i=0;i<draft.slides.length;i++){const current=p.visualPages?.[i],fresh=current?.stamp===pageStamp(draft,i,draft.selectedTheme);const saved=p.visualPages?.[matches[i]]||base.visualPages?.[matches[i]];const next=adapt(fresh?current:saved,i,draft.selectedTheme);if(next){draft.visualPages[i]=next;previews++;}}
  draft.reconstruction=null;
  const nativeSource=rebuiltCurrent(p)?p.reconstruction:base.reconstruction;
  const nativePages=rebuiltCurrent(p)?draft.slides.map((_,i)=>i):matches;
  const nativeMatches=rebuiltCurrent(p)||draft.slides.every((_,i)=>draft.visualPages[i]?.file===base.visualPages?.[matches[i]]?.file);
  if(nativeSource?.mode==='free'&&nativeMatches&&previews===draft.slides.length){
    try{
      const slides=draft.slides.map((s,i)=>{const old=nativeSource.slides[nativePages[i]],texts=new Map(canonicalTexts(s,draft,i).map(n=>[n.nodeId,n.text]));
        const update=list=>list.map(e=>e.type==='text'?{...e,text:texts.get(e.nodeId)??e.text}:structuredClone(e));
        validateAudit(update(old.audit),s,draft.visualPages[i].images,draft,i);
        const elements=update(old.elements);if(elements.filter(e=>e.type==='image').some(e=>!draft.materials.some(m=>m.id===e.id&&m.sha256===checkpoint.materialHashes[e.id])))throw Error('重建素材已变化');
        return {...old,index:i,audit:update(old.audit),elements};
      });draft.reconstruction={...structuredClone(nativeSource),slides,stamp:visualStamp(draft),reusedAt:at};
    }catch{skipped.push('元素增删或素材变化，导出时将按新内容重新拆解；无需重生整页图');}
  }
  draft.approvals={...draft.approvals,requirements:base.approvals?.requirements?draft.version:draft.approvals.requirements,preview:null};
  draft.candidate=null;draft.output=null;draft.stage=draft.selectedTheme?5:draft.concepts.length?4:draft.slides.length?2:1;
  draft.downstreamReuseRecord={at,fromVersion:checkpoint.version,toVersion:draft.version,designs,previews,nativeTextSynced:!!draft.reconstruction,skipped:[...new Set(skipped)]};
  draft.reuseCheckpoint.acceptedInputs=inputs(draft);
  draft.reuseCheckpoint.acceptedPolicyVersion=policyVersion();
  for(const key of [...fields,'candidate','output','stage','downstreamReuseRecord','reuseCheckpoint'])if(key!=='brief')p[key]=draft[key];
  return p.downstreamReuseRecord;
}
