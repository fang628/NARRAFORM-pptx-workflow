import {refineReferenceSVGs} from './svg-reference.mjs';

export const svgReferenceStageVersion=6;

export function isSVGReferenceElement(element){
  return element?.type==='image'&&element.implementation==='svg'&&!element.managed
    &&!element.artisticText&&!element.tableId&&!element.tableRole
    &&!element.tablePlaced&&!element._tableStage;
}

// This enhancement owns only independent SVG assets. Native geometry, text,
// tables, original images and cutouts keep the staged pipeline's committed result.
export async function fitSVGReferenceStage({elements,diagnostics,quality,...context},{refine=refineReferenceSVGs}={}){
  context.signal?.throwIfAborted();
  if(diagnostics?.status!=='available')return {elements,changes:[],records:[],status:'skipped',reason:'no-reference-evidence'};
  const regions=new Map((diagnostics.regions||[]).map(region=>[region.key,region]));
  const issues=new Set((quality?.objects||[]).filter(object=>object.issues?.length).map(object=>object.key));
  const keys=elements.filter(element=>{
    // Older audits used table keys without the current table markers.
    if(!isSVGReferenceElement(element)||element.role==='background'||/^table|vline|hline|row-?\d|cell-/i.test(String(element.key||'')))return false;
    const region=regions.get(element.key);
    return issues.has(element.key)||Boolean(region?.samples&&(
      (Number.isFinite(region.ssim)&&region.ssim<.97)||(Number.isFinite(region.edgeDistance)&&region.edgeDistance>1.4)
    ));
  }).map(element=>element.key);
  if(!keys.length)return {elements,changes:[],records:[],status:'skipped',reason:'no-svg-differences'};
  const result=await refine({...context,elements,targetKeys:keys});
  context.signal?.throwIfAborted();
  const fitted=new Map(result.elements.map(e=>[e.key,e])),owned=new Set(keys);
  return {...result,elements:elements.map(e=>owned.has(e.key)?fitted.get(e.key)||e:e),targetKeys:keys};
}

// Text keeps one adjustment pass in the default path; if SVG verification
// deferred it, it can use the next round. The final round only renders/settles.
export const localRenderPolicy=()=>({lastRound:2,textAdjustmentPasses:1});
