// A preview's immutable image references are the authority when its background
// directory was lost during an older downstream-reuse operation. Never select
// the newest material by name/date or mistake a repaired full page for a base.
export function previewFoundationReference(p,index,theme=p.selectedTheme,page=p.visualPages?.[index]){
  if(!page||page.theme!==theme)return null;
  const use=p.slides[index]?.kind==='cover'?'hero-image':p.slides[index]?.kind==='toc'?'toc-image':'content-background';
  const groups=[page.foundation?[page.foundation]:[],[...(page.references||[]),page.reference].filter(Boolean),...(page.generationAttempts||[]).map(a=>a.references||[])];
  for(const references of groups){
    const candidates=references.filter(r=>r?.purpose===use&&r.materialId);
    if(!candidates.length)continue;
    if(new Set(candidates.map(r=>r.materialId+':'+r.sha256)).size!==1)throw Error('预览图登记了多个不同底图，请核对本页底图来源');
    const ref=candidates[0],material=p.materials.find(m=>m.id===ref.materialId);
    if(!material||material.purpose!=='workflow-background'||material.kind!=='image'||!ref.sha256||material.sha256!==ref.sha256||material.styleId&&material.styleId!==theme||material.intendedUse&&material.intendedUse!==use)throw Error('预览图的底图引用与登记原件不一致，请核对本页底图来源');
    return {materialId:material.id,sha256:ref.sha256,purpose:use};
  }
  return null;
}
