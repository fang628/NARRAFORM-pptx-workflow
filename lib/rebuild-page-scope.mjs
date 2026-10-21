import {visualStamp} from './visual-model.mjs';

export function rebuildPageScope(p){
  const state=p.rebuildPageChanges;
  return state?.version===p.version&&state.stamp===visualStamp(p)?state:null;
}
export function markRebuildPages(p,indices){
  const stamp=visualStamp(p),old=rebuildPageScope(p);
  const history=[...(p.rebuildEditHistory||[])].reverse().find(e=>e.version===p.version&&e.stamp===stamp&&e.state?.candidate);
  const candidate=p.candidate||old?.candidate||history?.state.candidate;
  p.rebuildPageChanges={version:p.version,stamp,indices:[...new Set([...(old?.indices||[]),...indices])].filter(i=>Number.isInteger(i)&&p.slides[i]),...(candidate?{candidate:structuredClone(candidate)}:{})};
  return p.rebuildPageChanges;
}
