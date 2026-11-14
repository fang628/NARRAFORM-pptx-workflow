import {reconstructionCorrespondence} from './object-correspondence.mjs';
import {revokeRecognitionParameters} from './recognition-groups.mjs';
import {changedSharedParameters} from './group-fit-evidence.mjs';
export {reconstructionCorrespondence};

// Compare the same padded union before and after a move/resize; a smaller crop
// must not hide an error and incorrectly appear to improve reconstruction.
export function referenceTrialRegions(elements,next){
  return elements.map((e,i)=>{
    const n=next[i];if(!n||e.key!==n.key||JSON.stringify(e)===JSON.stringify(n))return e;
    const x=Math.max(0,Math.min(e.x,n.x)-8),y=Math.max(0,Math.min(e.y,n.y)-8);
    return {...e,x,y,w:Math.min(1600,Math.max(e.x+e.w,n.x+n.w)+8)-x,h:Math.min(900,Math.max(e.y+e.h,n.y+n.h)+8)-y};
  });
}

// One tentative local candidate per page. Keep the original scene until an
// actual PowerPoint render demonstrates improvement; worsening trials rollback.
export function settleReferenceTrial(elements,report,state){
  if(!state.pending)return {elements,changed:false,status:'idle'};
  const pending=state.pending;state.pending=null;
  const scores=new Map((report?.regions||[]).map(r=>[r.key,r]));
  let better=0,worse=0,observed=0;const revert=new Set(),contradictions=[];
  const originals=new Map(pending.before.map(e=>[e.key,e])),currentElements=new Map(elements.map(e=>[e.key,e]));
  for(const key of pending.keys){const a=pending.baseline.get(key),b=scores.get(key);if(!a||!b||!a.samples||!b.samples||![a.ssim,b.ssim,a.edgeDistance??0,b.edgeDistance??0].every(Number.isFinite)){revert.add(key);continue;}observed++;
    const score=r=>r.ssim-Math.min(20,r.edgeDistance||0)*.01;
    const diff=score(b)-score(a);if(diff>.003)better++;else revert.add(key);if(diff<-.006)worse++;
    const previous=(pending.objectQuality?.objects||[]).find(e=>e.key===key),current=(report.objectQuality?.objects||[]).find(e=>e.key===key);
    const paintGain=pending.paintKeys?.includes(key)&&previous?.status==='available'&&current?.status==='available'&&Number.isFinite(previous.appearanceMAE)&&Number.isFinite(current.appearanceMAE)&&previous.appearanceMAE-current.appearanceMAE>2&&Number.isFinite(previous.boundaryP95)&&Number.isFinite(current.boundaryP95)&&current.boundaryP95<=Math.max(2,previous.boundaryP95+.75);
    if(paintGain&&diff>=-.015){revert.delete(key);if(diff<=.003)better++;}
    if(previous?.status==='available'&&current?.status==='available'&&((Number.isFinite(previous.boundaryP95)&&current.boundaryP95>Math.max(5,previous.boundaryP95+1.5))||(Number.isFinite(previous.appearanceMAE)&&current.appearanceMAE>previous.appearanceMAE+3)))revert.add(key);
    const measuredWorse=previous?.status==='available'&&current?.status==='available'&&(Number.isFinite(previous.appearanceMAE)&&Number.isFinite(current.appearanceMAE)&&current.appearanceMAE>previous.appearanceMAE+3||Number.isFinite(previous.boundaryP95)&&Number.isFinite(current.boundaryP95)&&current.boundaryP95>previous.boundaryP95+2);
    if(revert.has(key)&&(diff<-.015||measuredWorse))for(const parameter of changedSharedParameters(originals.get(key),currentElements.get(key)))contradictions.push({key,parameter,contradicts:true,confidence:.95,reason:`实际PowerPoint渲染反对该共享参数调整：参考对照分差${diff.toFixed(4)}${measuredWorse?'，局部颜色或边界误差明显增大':''}`});
  }
  const familyReverted=(pending.fontFamilyKeys||[]).some(key=>revert.has(key));
  if(familyReverted)for(const key of pending.fontFamilyKeys)revert.add(key);
  for(const group of pending.geometryGroups||[])if(group.some(key=>revert.has(key)))for(const key of group)revert.add(key);
  if(revert.size){
    state.blocked=true;
    // Rolling back a visual trial must not roll back independently measured
    // contrary evidence. Keep it even if this particular candidate was poor.
    const fittedEvidence=elements.flatMap(e=>(e.recognitionRejections||[]).map(r=>({...r,key:e.key,contradicts:true})));
    const rolledBack=elements.map(e=>revert.has(e.key)?originals.get(e.key):e),revoked=revokeRecognitionParameters(rolledBack,[...fittedEvidence,...contradictions]);
    return {elements:revoked.elements,groupingRejections:revoked.decisions,changed:true,status:better?'partially-accepted':'reverted',better,worse,observed,familyReverted};
  }
  return {elements,changed:false,status:'accepted',better,worse,observed};
}
export function beginReferenceTrial(elements,next,report,state){
  if(state.blocked||state.pending)return false;
  const keys=next.filter((e,i)=>JSON.stringify(e)!==JSON.stringify(elements[i])).map(e=>e.key);if(!keys.length||elements.length!==next.length)return false;
  const groups=new Map();for(const e of next){const group=e.carrierGroup||e.effectOf;if(group){if(!groups.has(group))groups.set(group,[]);groups.get(group).push(e.key);}}
  const paintKeys=next.filter((e,i)=>['fill','color','gradient','strokeGradient','fillOpacity','colorOpacity'].some(k=>JSON.stringify(e[k])!==JSON.stringify(elements[i]?.[k]))).map(e=>e.key);
  state.pending={before:structuredClone(elements),keys,paintKeys,geometryGroups:[...groups.values()].map(group=>group.filter(key=>keys.includes(key))).filter(group=>group.length>1),fontFamilyKeys:next.filter((e,i)=>e.type==='text'&&e.fontFace!==elements[i]?.fontFace).map(e=>e.key),regions:referenceTrialRegions(elements,next),baseline:new Map((report?.regions||[]).map(r=>[r.key,r])),objectQuality:report.objectQuality};return true;
}
