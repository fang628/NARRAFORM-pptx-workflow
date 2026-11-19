import {auditFrameInventory} from './frame-inventory.mjs';
export function pageStructureErrors(structure,index){
  return (structure?.errors||[]).filter(error=>{
    const match=String(error).match(/\bS(\d+):|第\s*(\d+)\s*页/);
    return match&&Number(match[1]||match[2])===index+1;
  });
}
// Quality findings describe a draft; they must not prevent saving its PPTX.
export function rebuildPageIssues(p,index,structure){
  const page=p.reconstruction?.slides?.[index],issues=[...(page?.issues||[])];
  if(page?.auditValidation?.status&&page.auditValidation.status!=='passed')issues.unshift('元素审计未通过，当前页仅包含已成功重建的元素');
  if(page?.auditValidation?.frameInventory?.length)try{auditFrameInventory({elements:page.elements},page.auditValidation.frameInventory);}catch(error){issues.push(error.message);}
  for(const e of page?.failedElements||[])issues.push('元素未完成：'+e.key+' · '+e.error);
  for(const error of pageStructureErrors(structure,index))issues.push('结构检验：'+error);
  return [...new Set(issues)];
}

export function applyRebuildQuality(p,index,review,structure){
  const problems=rebuildPageIssues(p,index,structure);
  return {...review,issues:[...new Set([...(review.issues||[]),...problems])],passed:!!review.passed&&!problems.length};
}

export function reusedPageReview(p,index,review,previous,structure){
  const prior=structuredClone(review);
  if(prior.checks?.editability===false&&previous?.passed===false&&!prior.pending&&!prior.reviewUnavailable){
    const oldIssues=new Set((previous.errors||[]).map(error=>'结构检验：'+error));
    prior.issues=(prior.issues||[]).filter(issue=>!oldIssues.has(issue)&&issue!=='结构检验未通过');
    prior.checks.editability=pageStructureErrors(structure,index).length===0;
    const assessment=prior.visualAssessment;
    const visualPassed=assessment?['aesthetics','layout','previewSimilarity'].every(key=>assessment[key]===true)&&prior.checks.visual!==false&&prior.checks.preview_match!==false:
      prior.checks.visual===true&&prior.checks.preview_match===true;
    prior.passed=visualPassed&&['content','photos','editability'].every(key=>prior.checks[key]===true)&&!prior.issues.length;
  }
  return applyRebuildQuality(p,index,prior,structure);
}
