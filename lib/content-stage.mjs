import {isDeepStrictEqual} from 'node:util';
import {pageDesignStamp,pageDesignInputStamp,pageDesignState,checkDesignEdits,validatePageDesign,renderPageDesign} from './page-design.mjs';
import {syncPageDesignText} from './page-design-text.mjs';
import {initialElements,orderedElements} from './elements.mjs';
import {fullPageCurrent} from './visual-model.mjs';

// Missing AI prose is advisory. A confirmed content tree supplies the complete
// node contract needed by image planning without requiring another model call.
function prepareDesign(p,index,reason,at){
 const previous=p.pageDesigns?.[index]||{},nodes=orderedElements(initialElements(p.slides[index]));
 const usable=(value,fallback,max=2500)=>typeof value==='string'&&value.trim()&&value.length<=max?value.trim():fallback;
 const old=previous.plan||{},specs=new Map((Array.isArray(old.nodes)?old.nodes:[]).filter(n=>n&&typeof n.id==='string').map(n=>[n.id,n]));
 const plan=validatePageDesign({
  purpose:usable(old.purpose,'呈现本页主题与所选材料'),
  conclusion:usable(old.conclusion,'按当前内容树呈现，不新增结论'),
  logic:usable(old.logic,'沿用内容树的并列、从属与阅读顺序'),
  layoutIntent:usable(old.layoutIntent,'主标题统领全页，各内容组独立组织，局部排布由生图模型设计'),
  style:usable(old.style,'沿用所选视觉方向的配色、字体层级与承载语言'),
  differences:usable(old.differences,'依据当前内容树构建，未补充的设计说明仅作提示'),
  readingOrder:nodes.map(n=>n.id),
  nodes:nodes.map(n=>{const spec=specs.get(n.id)||{};return {
   id:n.id,position:usable(spec.position,n.role==='title'?'页顶标题区':n.role==='subtitle'?'主标题附近':n.type==='image'?'所属内容附近':'所属内容区域',800),
   relativeSize:usable(spec.relativeSize,n.role==='title'?'主标题层级突出':'根据内容体量与清晰度安排',800),
   alignment:usable(spec.alignment,'与所属内容组对齐',800),
   carrier:usable(spec.carrier,n.type==='table'?'保留表头及数据行列':n.type==='image'?'登记图片对应占位框':n.type==='text'?'独立文本':'内容分组',800),
   relation:usable(spec.relation,'保留当前内容树的并列、从属及顺序',800)
  };}),
  missingMaterials:(Array.isArray(old.missingMaterials)?old.missingMaterials:[]).filter(v=>typeof v==='string'&&v.trim()&&v.length<=500).slice(0,20)
 },nodes);
 p.pageDesigns||={};
 p.pageDesigns[index]={...previous,plan,markdown:renderPageDesign(p,index,plan)+(previous.manualDesignNotes?'\n\n## 补充设计说明\n'+previous.manualDesignNotes:''),origin:'content-tree-confirmed',
  confirmationAdvisory:{reason,at},...(previous.markdown?{previousDraft:{plan:previous.plan,markdown:previous.markdown,draftStamp:previous.draftStamp,contentSnapshot:previous.contentSnapshot}}:{})};
}

// Entering the next stage is the user's approval; publish the whole transition atomically.
export function enterVisualStage(p,{slides=p.slides,designDrafts=[]}={}, {contentChanged=()=>{}}={}){
 if(!p.approvals?.requirements)throw Error('请先完成需求与材料');
 if(!slides.length)throw Error('请先生成逐页内容与设计稿');
 if(!Array.isArray(designDrafts))throw Error('设计说明格式无效');
 const draft=structuredClone(p),before=structuredClone(p.slides),at=new Date().toISOString();
 const edits=new Map();
 for(const item of designDrafts){
  if(!Number.isInteger(item?.index)||!draft.slides[item.index]||edits.has(item.index))throw Error('设计说明页面无效或重复');
  const d=draft.pageDesigns?.[item.index];
  if(!d?.plan||!d.markdown){
   if(typeof item.markdown!=='string'||item.markdown.length>80000)throw Error('设计说明须为不超过80,000字的文字');
   if(item.markdown.trim()){draft.pageDesigns||={};draft.pageDesigns[item.index]={...d,manualDesignNotes:item.markdown};edits.set(item.index,true);}
   continue;
  }
  if(item.markdown!==d.markdown){
   const baseline=d.contentSnapshot||draft.reuseCheckpoint?.source.slides?.[item.index]||draft.slides[item.index];
   const source={...draft,slides:draft.slides.map((s,i)=>i===item.index?baseline:s)};
   d.markdown=checkDesignEdits(item.markdown,source,item.index,d.plan);edits.set(item.index,true);
  }
 }
 if(!isDeepStrictEqual(slides,draft.slides)){draft.slides=structuredClone(slides);contentChanged(draft);}
 const accepted=[],skipped=[],synced=[],prepared=[],advisories=[];
 for(let i=0;i<draft.slides.length;i++){
  const d=draft.pageDesigns?.[i];
  // Legacy projects may have confirmed previews but no saved structured plan.
  // Attach a usable plan without changing the design text signed by that preview.
  const preservePreview=!!d?.markdown&&(!d.plan||!d.markdown.includes('<!-- CONFIRMED-CONTENT:START -->'))&&fullPageCurrent(draft,i);
  let reason;
  if(preservePreview){prepareDesign(draft,i,'旧版设计已兼容补齐，现有预览继续保留',at);draft.pageDesigns[i].markdown=d.markdown;}
  else if(!d?.plan||!d.markdown)reason='AI设计稿待补齐，已按当前内容树准备基础设计，可继续生图';
  else if(!pageDesignState(draft,i)?.current){
   try{syncPageDesignText(draft,i,before[i]);synced.push(i);}
   catch{reason='设计稿依据已变化，已按当前内容树更新基础设计，可继续生图';}
  }
  if(!reason&&!preservePreview){
   const current=draft.pageDesigns[i];
   try{validatePageDesign(current.plan,initialElements(draft.slides[i]));checkDesignEdits(current.markdown,draft,i,current.plan);}
   catch{reason='设计稿说明待补齐，已保留可用设计并按当前内容树补齐，可继续生图';}
  }
  if(reason){prepareDesign(draft,i,reason,at);prepared.push(i);advisories.push({index:i,reason});}
  const current=draft.pageDesigns[i],stamp=pageDesignStamp(draft,i);
  if(!preservePreview)checkDesignEdits(current.markdown,draft,i,current.plan);
  draft.pageDesigns[i]={...current,contentInputStamp:pageDesignInputStamp(draft,i),draftStamp:stamp,layoutStamp:stamp,layoutApprovedAt:current.layoutApprovedAt||at,approvedAt:current.approvedAt||at,approvalMethod:{mode:'enter-next-stage',at},contentSnapshot:structuredClone(draft.slides[i])};
  accepted.push(i);
 }
 if(edits.size||synced.length||prepared.length){draft.approvals.preview=null;draft.output=null;draft.candidate=null;draft.reconstruction=null;}
 draft.approvals.content=draft.version;draft.stage=Math.max(3,draft.stage||0);
 draft.contentStageEntry={at,accepted,skipped,synced,prepared,advisories};
 for(const key of ['slides','version','pageDesigns','approvals','stage','concepts','selectedTheme','output','candidate','reconstruction','contentStageEntry'])if(Object.hasOwn(draft,key))p[key]=draft[key];
 return draft.contentStageEntry;
}
