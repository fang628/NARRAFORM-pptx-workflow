const stable=value=>Array.isArray(value)?value.map(stable):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().filter(k=>value[k]!==undefined).map(k=>[k,stable(value[k])])):value;
const appearance=(element,geometry)=>stable(Object.fromEntries([...['type','shape','fill','color','strokeWidth','opacity','fillOpacity','colorOpacity','gradient','outline','shadow','rotate','flipH','flipV','beginArrowType','endArrowType','dashType','adjustments','imageFit','colorAdjustment'],...(geometry?['w','h']:[])].filter(k=>element[k]!==undefined).map(k=>[k,element[k]])));

// Presentation grouping only: the original instances, coordinates and editing
// targets remain intact. Unknown appearance is never inferred from the name.
export function groupRebuildAssets(project,page){
  const preview=project.rebuildAssetPreview;
  const saved=preview?.version===project.version?preview.pages?.[page.index]:null;
  const rebuilt=project.reconstruction?.slides?.[page.index];
  const sources=['extracting','partial','cancelled'].includes(preview?.status)||!project.visualReconstructionCurrent?[saved,rebuilt]:[rebuilt,saved];
  const materials=new Map([...(project.materials||[]),...(preview?.materials||[])].map(m=>[m.id,m]));
  const groups=new Map();
  for(const item of page.elements||[]){
    const source=sources.flatMap(s=>s?.elements||[]).find(e=>e.key===item.key&&e.type===item.type&&(e.id||null)===(item.id||null));
    let identity;
    if(item.type==='image'&&item.id){
      const material=materials.get(item.id);
      const hash=item.assetAppearanceHash||material?.sha256;
      identity=['image',hash?'hash:'+hash:'id:'+item.id,appearance(source||{type:'image'},false),!!item.needsAttention,!!item.materialOriginal];
    }else if(source&&['rect','ellipse','shape','line'].includes(source.type)){
      identity=['native',appearance(source,true),!!item.needsAttention];
    }else identity=['instance',item.key];
    const signature=JSON.stringify(identity);
    if(!groups.has(signature))groups.set(signature,{...item,instances:[],count:0});
    const group=groups.get(signature);
    group.instances.push({key:item.key,description:item.description,targetStamp:item.targetStamp});group.count++;
  }
  return [...groups.values()];
}
