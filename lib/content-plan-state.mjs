import crypto from 'node:crypto';
import {materialStamp} from './materials.mjs';
import {contentGoalRule,contentSelectionRule,pageScopeRule,taskArrangementGuides} from './content-planning-policy.mjs';

const stable=value=>Array.isArray(value)?value.map(stable):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,stable(value[key])])):value;
const signature=slide=>crypto.createHash('sha256').update(JSON.stringify(stable({kind:slide.kind,title:slide.title,subtitle:slide.subtitle||'',body:slide.body||[],notes:slide.notes||'',elements:slide.elements,imageId:slide.imageId||null,sources:slide.sources||[]}))).digest('hex');
export const contentPlanningInputStamp=p=>crypto.createHash('sha256').update(JSON.stringify(stable({materialStamp:materialStamp(p),outline:p.analysis?.outline,reviewNotes:p.analysis?.reviewNotes,progressSections:p.progressSections}))).digest('hex');

// Planning metadata is separate from editable slide content and survives draft removal.
export function saveContentPlan(p,plan){
  p.contentPlan={version:1,inputStamp:contentPlanningInputStamp(p),intent:structuredClone(plan.intent),pages:plan.pages.map((spec,index)=>({spec:structuredClone(spec),signature:spec.scopeCurrent===false?null:signature(p.slides[index])}))};
}
export function currentContentPlan(p){
  const plan=p.contentPlan;
  return plan?.version===1&&plan.inputStamp===contentPlanningInputStamp(p)?plan:null;
}
export function contentRevisionContext(p,index){
  const plan=currentContentPlan(p),slide=p.slides[index],matched=plan&&slide&&plan.pages.find(page=>page.signature===signature(slide));
  const goal=plan?'本次已规划目标：'+JSON.stringify(plan.intent)+'\n本次任务编排依据：'+taskArrangementGuides[plan.intent.taskType]+'\n':'';
  const scope=matched?'本页已规划范围：'+JSON.stringify(matched.spec.scope)+'\n'+pageScopeRule+'\n':'';
  return [contentGoalRule,contentSelectionRule,goal+scope,'本轮用户明确修改要求优先；未要求改变的全篇目标和本页范围继续沿用。已编辑或重排后无法准确匹配的页面不套用旧页范围。'].join('\n');
}
