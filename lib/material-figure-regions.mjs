import path from 'node:path';
import {overlapFraction,panelLabelsInFigure,planPanelSplit,mergePanelLabels,parsePanelLabel} from './document-figure-boundaries.mjs';

// The image-separation button uses the same boundary checks as document intake. A model
// supplies whole figures and optional small panel-label boxes; it never supplies final cuts.
// If the same model response also contains local boxes that duplicate a reliably split parent's
// panels, those locals are dropped only with whole+panel split evidence; two independent figures
// whose boxes merely overlap are never removed by containment alone.
export async function completeMaterialFigureRegions(regions,{file,root,python,run,signal,page=1}){
  const warnings=[],groups=[];
  const inspect=async(op,box)=>{
    const result=await run(python,[path.join(root,'tools/document_panels.py'),op,file,JSON.stringify(box),'null','[]'],{windowsHide:true,signal,timeout:60000,maxBuffer:2e6});
    const value=JSON.parse(result.stdout);if(value.error)throw Error(value.error);return value;
  };
  for(const region of regions){
    signal?.throwIfAborted();
    try{
      const completed=await inspect('complete',region.box),box=completed.box;
      const labels=panelLabelsInFigure(box,region.panelLabels||[]).map(label=>({...label,token:label.token||parsePanelLabel(label.text)?.token})).filter(label=>label.token);
      const existing=groups.find(group=>overlapFraction(group.box,box)>.97&&overlapFraction(box,group.box)>.97);
      if(existing){existing.labels=mergePanelLabels(existing.labels,labels);continue;}
      groups.push({...region,box,labels});
    }catch(error){
      if(signal?.aborted)throw error;
      // Boundary completion failed (e.g. a framed single upload covers the whole input). Keep the
      // model's complete-figure box as a conservative fallback instead of silently dropping the
      // only image; it is not split without reliable completion evidence.
      warnings.push(region.label+'：无法确认完整边界，已保留原候选完整图');
      const fallbackLabels=panelLabelsInFigure(region.box,region.panelLabels||[]).map(label=>({...label,token:label.token||parsePanelLabel(label.text)?.token})).filter(label=>label.token);
      groups.push({...region,box:region.box,labels:fallbackLabels,completionFallback:true});
    }
  }
  const planned=[];
  for(const group of groups){
    let plan={split:false};
    if(group.labels.length>=2&&!group.completionFallback){
      try{plan=planPanelSplit({figure:{box:group.box},labels:group.labels},await inspect('analyze',group.box));}
      catch(error){if(signal?.aborted)throw error;}
      if(!plan.split)warnings.push(group.label+'：子图分隔不可靠，已保留完整图形');
    }
    planned.push({...group,plan});
  }
  // Whole+local duplicates from one response: drop a local group only when a reliably split
  // sibling contains it AND the local box matches one of that sibling's verified panels.
  const discard=new Set();
  for(const [index,group] of planned.entries()){
    if(!group.plan?.split)continue;
    for(const [otherIndex,other] of planned.entries()){
      if(index===otherIndex||discard.has(otherIndex))continue;
      const matchesPanel=group.plan.panels.some(panel=>overlapFraction(other.box,panel.box)>=.85&&overlapFraction(panel.box,other.box)>=.85);
      const inside=overlapFraction(other.box,group.box)>=.9;
      if(matchesPanel&&inside)discard.add(otherIndex);
    }
  }
  const output=[],composites=[];
  for(const [index,group] of planned.entries()){
    if(discard.has(index))continue;
    signal?.throwIfAborted();
    if(group.plan?.split){
      const expected=group.plan.panels.length;
      composites.push({label:group.label,box:group.box,panelCount:expected,generated:expected,splitEvidence:group.plan.evidence});
      for(const panel of group.plan.panels)output.push({label:(group.label+' · '+panel.label).slice(0,120),box:panel.box,page,split:true,parentLabel:group.label,parentBox:group.box,parentPanelCount:expected,panelIndex:panel.index,panelLabel:panel.label,splitEvidence:group.plan.evidence});
    }else output.push({label:group.label,box:group.box,page,split:false});
  }
  // Repeating the same response must be idempotent at this boundary too.
  const deduped=[],seen=new Set();
  for(const item of output){
    const key=JSON.stringify([item.label,item.box,item.parentLabel||null,item.panelIndex??null]);
    if(seen.has(key))continue;seen.add(key);deduped.push(item);
  }
  return {regions:deduped,warnings,composites,split:deduped.some(item=>item.split),splitCount:deduped.filter(item=>item.split).length};
}
