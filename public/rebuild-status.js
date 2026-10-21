export function rebuildPageStatus(p,index){
  const r=p.candidate?.review?.pages?.[index],asset=p.rebuildAssets?.find(page=>page.index===index),check=p.rebuildPageChecks?.[index];
  const partial=asset?.status==='partial',issues=[...new Set([...(r?.issues||[]),...(check?.issues||[]),...(asset?.issues||[])])];
  const failed=partial||issues.length>0||!!r&&!r.pending&&!r.passed;
  const label=partial?'审计未通过 · 部分元素已保留':r?.reviewUnavailable?'检验未完成':failed?'检验未通过':r?.pending?'正在验收':r?.passed?'自动验收通过':p.task?.status==='running'?'正在重建':'等待构建';
  return {state:failed?'failed':r?.passed?'passed':'pending',label,issues};
}
