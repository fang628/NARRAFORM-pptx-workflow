import {visualStamp,rebuiltCurrent} from './visual-model.mjs';
const fields=['candidate','reconstruction','output','stage','rebuildLive','rebuildAssetPreview','rebuildAssetFeedback','rebuildElementFeedback','rebuildRegionFeedback'];
export function rememberRebuildEdit(p,label){
  if(!rebuiltCurrent(p))return;
  p.rebuildEditHistory=[...(p.rebuildEditHistory||[]),{version:p.version,stamp:visualStamp(p),label,at:new Date().toISOString(),state:Object.fromEntries(fields.map(k=>[k,structuredClone(p[k]??null)]))}].slice(-6);
}
export function rebuildUndoState(p){
  const last=p.rebuildEditHistory?.at(-1);return {available:!!last&&last.version===p.version&&last.stamp===visualStamp(p)&&p.task?.status!=='running',label:last?.label||'',count:p.rebuildEditHistory?.length||0};
}
export function undoRebuildEdit(p){
  if(!rebuildUndoState(p).available)throw Error('当前没有可撤回的重建修改，或内容版本已变化');
  const entry=p.rebuildEditHistory.pop();for(const key of fields)p[key]=structuredClone(entry.state[key]);return entry.label;
}
