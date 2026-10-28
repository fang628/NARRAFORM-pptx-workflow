// Keep already displayed page nodes and image decoders alive across polling.
export function deliveryPageKey(p,index){
  const value=JSON.stringify([p.slides[index].title,p.task?.status==='running',!!p.visualReconstructionCurrent,!!p.rebuildPageRepairEnabled,p.rebuildAssets?.find(s=>s.index===index),p.rebuildLive?.pages?.[index],p.candidate?.id,p.candidate?.review?.pages?.[index],p.rebuildPageChecks?.[index],p.rebuildUndo?.pages?.[index],p.rebuildAssetFeedback?.[index],p.releaseCurrent]);
  let hash=2166136261;for(let i=0;i<value.length;i++)hash=Math.imul(hash^value.charCodeAt(i),16777619);
  return (hash>>>0).toString(36);
}
export function patchDeliveryContent(root,html){
  const template=root.ownerDocument.createElement('template');template.innerHTML=html;
  const previous=new Map([...root.querySelectorAll('[data-release-page]')].map(el=>[el.dataset.releasePage,el]));
  for(const next of template.content.querySelectorAll('[data-release-page]')){
    const old=previous.get(next.dataset.releasePage);if(!old)continue;
    if(old.dataset.deliveryKey===next.dataset.deliveryKey){next.replaceWith(old);continue;}
    const images=new Map([...old.querySelectorAll('img[src]')].map(img=>[img.getAttribute('src'),img]));
    for(const img of next.querySelectorAll('img[src]')){const retained=images.get(img.getAttribute('src'));if(retained){img.replaceWith(retained);images.delete(img.getAttribute('src'));}}
  }
  root.replaceChildren(template.content);
}
