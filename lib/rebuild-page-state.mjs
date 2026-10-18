import {rebuildAssetPages} from './rebuild-output.mjs';
import {slideBackground} from './slide-background.mjs';

export function rebuildPageComplete(page){
  return !!page&&Array.isArray(page.elements)&&page.elements.length>0&&!!page.background?.id&&!!page.background?.sha256&&page.auditValidation?.status==='passed'&&!['partial','extracting','cancelled'].includes(page.status)&&!page.issues?.length&&!page.failedElements?.length&&!page.elements.some(e=>e.needsAttention);
}

export function savedRebuildPages(p){
  return structuredClone(rebuildAssetPages(p)).map((page,index)=>{
    if(!page)return page;
    // Older completed snapshots did not store the fixed background or audit metadata.
    if(page.status==='done'&&!page.issues?.length&&!page.failedElements?.length&&page.elements?.length){
      try{return {...page,background:page.background||slideBackground(p,index),auditValidation:page.auditValidation||{status:'passed',restoredSnapshot:true}};}catch{}
    }
    return page;
  });
}

export function incompleteRebuildPages(p,pages=savedRebuildPages(p)){
  return p.slides.map((_,index)=>index).filter(index=>!rebuildPageComplete(pages[index]));
}

export function preservePartialElements(previous,current){
  const currentKeys=new Set(current.map(e=>e.key));
  const nodeIdentity=e=>['text','image'].includes(e.type)&&e.nodeId?e.type+':'+e.nodeId+':'+(e.part||'whole'):null;
  const nodes=new Set(current.map(nodeIdentity).filter(Boolean));
  return [...previous.filter(e=>!currentKeys.has(e.key)&&!nodes.has(nodeIdentity(e))),...current];
}
