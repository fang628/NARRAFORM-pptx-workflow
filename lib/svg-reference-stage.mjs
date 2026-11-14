import {isTextCarrier} from './native-carriers.mjs';
import {refinementTargets} from './rebuild-scene.mjs';
import {refineReferenceSVGs} from './svg-reference.mjs';

export const svgReferenceStageVersion=2;

export function isSVGReferenceElement(element){
  return element?.type==='image'&&element.implementation==='svg'&&!element.managed
    &&!element.artisticText&&!isTextCarrier(element)&&!element.tableId&&!element.tableRole
    &&!element.tablePlaced&&!element._tableStage;
}

// This enhancement owns only independent SVG assets. Native geometry, text,
// tables, original images and cutouts keep the staged pipeline's committed result.
export async function fitSVGReferenceStage({elements,diagnostics,quality,targetKeys,...context},{refine=refineReferenceSVGs}={}){
  context.signal?.throwIfAborted();
  if(diagnostics?.status!=='available')return {elements,changes:[],records:[],status:'skipped',reason:'no-reference-evidence'};
  const measured=refinementTargets(diagnostics,elements,{quality}).svg;
  const allowed=targetKeys==null?null:new Set(targetKeys);
  const keys=elements.filter(e=>isSVGReferenceElement(e)&&measured.has(e.key)&&(!allowed||allowed.has(e.key))).map(e=>e.key);
  if(!keys.length)return {elements,changes:[],records:[],status:'skipped',reason:'no-svg-differences'};
  const result=await refine({...context,elements,targetKeys:keys});
  context.signal?.throwIfAborted();
  const fitted=new Map(result.elements.map(e=>[e.key,e])),owned=new Set(keys);
  return {...result,elements:elements.map(e=>owned.has(e.key)?fitted.get(e.key)||e:e),targetKeys:keys};
}

// Text keeps one adjustment pass in the default path; if SVG verification
// deferred it, it can use the next round. The final round only renders/settles.
export const localRenderPolicy=staged=>({lastRound:staged?2:3,textAdjustmentPasses:staged?1:2});
