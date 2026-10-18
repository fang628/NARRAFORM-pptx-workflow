import {visualStamp,rebuiltCurrent} from './visual-model.mjs';
import {isDeepStrictEqual} from 'node:util';
import {rebuildPresentationStamp} from './rebuild-progress.mjs';
const fields=['candidate','reconstruction','output','stage','rebuildLive','rebuildAssetPreview','rebuildAssetFeedback','rebuildElementFeedback','rebuildRegionFeedback'];
const entryIndex=entry=>Number.isInteger(entry.index)?entry.index:Number(entry.label?.match(/^第\s*(\d+)\s*页/)?.[1])-1;
const belongs=(key,record,index)=>record?.index===index||key.startsWith(index+':');
function validEntries(p,index,stamp=visualStamp(p)){return (p.rebuildEditHistory||[]).filter(e=>entryIndex(e)===index&&e.version===p.version&&e.stamp===stamp&&e.state?.reconstruction?.slides?.[index]);}
export function rememberRebuildEdit(p,label,index){
  if(!rebuiltCurrent(p))return;if(!Number.isInteger(index)||!p.slides[index])throw Error('请指定需要记录修改的页面');
  const history=[...(p.rebuildEditHistory||[]),{index,version:p.version,stamp:visualStamp(p),label,at:new Date().toISOString(),state:Object.fromEntries(fields.map(k=>[k,structuredClone(p[k]??null)]))}],counts=new Map();
  p.rebuildEditHistory=history.reverse().filter(e=>{const i=entryIndex(e),count=(counts.get(i)||0)+1;counts.set(i,count);return count<=6;}).slice(0,30).reverse();
}
export function rebuildUndoState(p,index){
  const stamp=visualStamp(p),current=rebuiltCurrent(p);
  const page=i=>{const entries=validEntries(p,i,stamp),last=entries.at(-1);return {available:!!last&&current&&p.task?.status!=='running',label:last?.label||'',count:entries.length};};
  return Number.isInteger(index)?page(index):{pages:Object.fromEntries(p.slides.map((_,i)=>[i,page(i)]))};
}
export function undoRebuildEdit(p,index){
  if(!Number.isInteger(index)||!p.slides[index])throw Error('请指定需要撤回的页面');
  if(!rebuildUndoState(p,index).available)throw Error('本页没有可撤回的重建修改，或内容版本已变化');
  const entry=validEntries(p,index).at(-1),snapshot=entry.state,otherPagesMatch=p.reconstruction.slides.every((page,i)=>i===index||isDeepStrictEqual(page,snapshot.reconstruction.slides[i]));
  p.rebuildEditHistory.splice(p.rebuildEditHistory.indexOf(entry),1);
  p.reconstruction.slides[index]=structuredClone(snapshot.reconstruction.slides[index]);
  const canReuseCandidate=otherPagesMatch&&!!snapshot.candidate&&(!p.rebuildPresentation||snapshot.candidate.presentationStamp===rebuildPresentationStamp(p));
  if(canReuseCandidate){
    p.reconstruction=structuredClone(snapshot.reconstruction);for(const key of ['candidate','output','stage','rebuildLive'])p[key]=structuredClone(snapshot[key]);
  }else{
    const used=new Set(p.reconstruction.slides.flatMap(page=>page.elements.filter(e=>e.type==='image'&&e.implementation).map(e=>e.id)));p.reconstruction.assets=[...used];p.candidate=null;p.output=null;p.stage=6;
    if(p.rebuildLive?.pages&&snapshot.rebuildLive?.pages?.[index]){p.rebuildLive.pages[index]=structuredClone(snapshot.rebuildLive.pages[index]);p.rebuildLive.revision++;}
  }
  if(p.rebuildAssetPreview?.pages){const old=snapshot.rebuildAssetPreview?.pages?.[index];if(old)p.rebuildAssetPreview.pages[index]=structuredClone(old);else delete p.rebuildAssetPreview.pages[index];}
  for(const key of ['rebuildAssetFeedback','rebuildRegionFeedback']){if(snapshot[key]?.[index]!==undefined){p[key]??={};p[key][index]=structuredClone(snapshot[key][index]);}else if(p[key])delete p[key][index];}
  p.rebuildElementFeedback=Object.fromEntries([...Object.entries(p.rebuildElementFeedback||{}).filter(([key,record])=>!belongs(key,record,index)),...Object.entries(snapshot.rebuildElementFeedback||{}).filter(([key,record])=>belongs(key,record,index)).map(([key,record])=>[key,structuredClone(record)])]);
  return {label:entry.label,index,requiresRender:!canReuseCandidate};
}
