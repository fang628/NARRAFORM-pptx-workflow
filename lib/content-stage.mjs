import {isDeepStrictEqual} from 'node:util';
import {pageDesignStamp,pageDesignState,checkDesignEdits} from './page-design.mjs';
import {syncPageDesignText} from './page-design-text.mjs';

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
  if(!d?.plan||!d.markdown){if(item.markdown)throw Error('第 '+(item.index+1)+' 页设计稿尚未生成');continue;}
  if(item.markdown!==d.markdown){
   const baseline=d.contentSnapshot||draft.reuseCheckpoint?.source.slides?.[item.index]||draft.slides[item.index];
   const source={...draft,slides:draft.slides.map((s,i)=>i===item.index?baseline:s)};
   d.markdown=checkDesignEdits(item.markdown,source,item.index,d.plan);edits.set(item.index,true);
  }
 }
 if(!isDeepStrictEqual(slides,draft.slides)){draft.slides=structuredClone(slides);contentChanged(draft);}
 const accepted=[],skipped=[],synced=[];
 for(let i=0;i<draft.slides.length;i++){
  const d=draft.pageDesigns?.[i];
  if(!d?.plan||!d.markdown){skipped.push({index:i,reason:'设计稿尚未生成'});continue;}
  if(!pageDesignState(draft,i)?.current){
   try{syncPageDesignText(draft,i,before[i]);synced.push(i);}
   catch(error){skipped.push({index:i,reason:error.message});continue;}
  }
  const current=draft.pageDesigns[i],stamp=pageDesignStamp(draft,i);
  checkDesignEdits(current.markdown,draft,i,current.plan);
  draft.pageDesigns[i]={...current,layoutStamp:stamp,layoutApprovedAt:current.layoutApprovedAt||at,approvedAt:current.approvedAt||at,approvalMethod:{mode:'enter-next-stage',at},contentSnapshot:structuredClone(draft.slides[i])};
  accepted.push(i);
 }
 if(!accepted.length)throw Error('暂无可用设计稿，请先生成或更新设计稿：'+skipped.map(v=>'第 '+(v.index+1)+' 页 '+v.reason).join('；'));
 if(edits.size||synced.length){draft.approvals.preview=null;draft.output=null;draft.candidate=null;draft.reconstruction=null;}
 draft.approvals.content=draft.version;draft.stage=Math.max(3,draft.stage||0);
 draft.contentStageEntry={at,accepted,skipped,synced};
 for(const key of ['slides','version','pageDesigns','approvals','stage','concepts','selectedTheme','output','candidate','reconstruction','contentStageEntry'])if(Object.hasOwn(draft,key))p[key]=draft[key];
 return draft.contentStageEntry;
}
