import {auditFrameInventory} from './frame-inventory.mjs';
// Quality findings describe a draft; they must not prevent saving its PPTX.
export function rebuildPageIssues(p,index,structure){
  const page=p.reconstruction?.slides?.[index],issues=[...(page?.issues||[])];
  if(page?.auditValidation?.status&&page.auditValidation.status!=='passed')issues.unshift('元素审计未通过，当前页仅包含已成功重建的元素');
  if(page?.auditValidation?.frameInventory?.length)try{auditFrameInventory({elements:page.elements},page.auditValidation.frameInventory);}catch(error){issues.push(error.message);}
  for(const e of page?.failedElements||[])issues.push('元素未完成：'+e.key+' · '+e.error);
  for(const error of structure?.errors||[]){
    const match=String(error).match(/\bS(\d+):|第\s*(\d+)\s*页/);
    if(!match||Number(match[1]||match[2])===index+1)issues.push('结构检验：'+error);
  }
  if(structure?.passed===false&&!structure.errors?.length)issues.push('结构检验未通过');
  return [...new Set(issues)];
}

export function applyRebuildQuality(p,index,review,structure){
  const problems=rebuildPageIssues(p,index,structure);
  return {...review,issues:[...new Set([...(review.issues||[]),...problems])],passed:!!review.passed&&!problems.length};
}
