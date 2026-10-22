// Validate the whole selection before changing the project, then unlink it once.
export function removeMaterials(p,ids){
  if(!Array.isArray(ids)||!ids.length||ids.some(id=>typeof id!=='string'||!id))throw Error('请选择要删除的材料');
  const selected=[...new Set(ids)],materials=new Map(p.materials.map(m=>[m.id,m]));
  if(selected.some(id=>!materials.has(id)))throw Error('部分材料已变化，请刷新后重新选择');
  const removed=new Set(selected);
  for(let changed=true;changed;){changed=false;for(const m of p.materials)if(removed.has(m.sourceMaterialId)&&!removed.has(m.id)){removed.add(m.id);changed=true;}}
  p.materials=p.materials.filter(m=>!removed.has(m.id));
  p.pendingImageUnderstanding=(p.pendingImageUnderstanding||[]).filter(id=>!removed.has(id));
  p.slides=p.slides.map(s=>({...s,sources:s.sources.filter(id=>!removed.has(id)),sourceLinks:(s.sourceLinks||[]).filter(l=>!removed.has(l.materialId)),imageId:removed.has(s.imageId)?null:s.imageId,...(s.elements?{elements:s.elements.map(n=>removed.has(n.materialId)?{...n,materialId:null}:n)}:{})}));
  return {selected:selected.length,total:removed.size,names:selected.map(id=>materials.get(id).name)};
}
