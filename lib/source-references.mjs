import {orderedElements} from './elements.mjs';
import {bindSources} from './sources.mjs';

function imageNote(m){
  if(!m.extracted)return '本页使用的原始图片元素';
  const locations=(m.sourceLocations||[]).map(l=>l.page?'第 '+l.page+(l.unit==='slide'?' 张':' 页'):l.part==='word/document.xml'?'Word 正文':l.part?.includes('/header')?'Word 页眉':l.part?.includes('/footer')?'Word 页脚':'文档嵌入图');
  return '从 '+(m.sourceMaterialName||'原材料')+' 分离的原图；'+[...new Set(locations)].join('、');
}

export function validateSourceReferences(p,slides,requireLinks=false){
  const materials=new Map(p.materials.map(m=>[m.id,m]));
  for(const s of slides){
    if(s.sources.some(id=>!materials.has(id)))throw Error('模型引用了不存在的材料编号，请重试');
    if(s.elements){
      const ordered=orderedElements(s.elements),body=ordered.filter(n=>n.type==='text'&&n.role==='body');
      s.sourceLinks=s.sourceLinks.map(l=>{
        const n=l.target.startsWith('body:')?body[Number(l.target.slice(5))]
          :['title','subtitle'].includes(l.target)?ordered.find(n=>n.type==='text'&&n.role===l.target)
          :l.target==='image'?(ordered.find(n=>n.type==='image'&&n.materialId===l.materialId)||ordered.find(n=>n.type==='image'&&n.materialId===s.imageId)):null;
        return n?{...l,target:'element:'+n.id}:l;
      });
    }
    const image=materials.get(s.imageId);if(s.imageId&&image?.kind!=='image')throw Error('无效的配图编号');
    const images=s.elements?s.elements.filter(n=>n.type==='image'&&n.materialId).map(n=>({target:'element:'+n.id,materialId:n.materialId})):(s.imageId?[{target:'image',materialId:s.imageId}]:[]);
    for(const n of images)if(materials.get(n.materialId)?.kind!=='image')throw Error('元素引用的图片不存在');

    if(requireLinks){
      // The actual inserted image is authoritative. AI does not need to duplicate
      // its identity in a separate, potentially conflicting provenance record.
      const targets=new Map(images.map(n=>[n.target,n.materialId])),seen=new Set();
      s.sourceLinks=s.sourceLinks.flatMap(l=>{
        if(!targets.has(l.target))return [l];
        const id=targets.get(l.target),m=materials.get(id);
        if(m.generated||seen.has(l.target))return [];
        seen.add(l.target);
        return [{id:l.id,materialId:id,target:l.target,quote:'',note:l.materialId===id&&l.note?l.note:imageNote(m)}];
      });
      // Discard unused image declarations, while preserving document evidence
      // and any original image cited by a text/OCR link.
      const linked=new Set(s.sourceLinks.map(l=>l.materialId)),used=new Set(images.filter(n=>!materials.get(n.materialId).generated).map(n=>n.materialId));
      s.sources=s.sources.filter(id=>materials.get(id).kind!=='image'||linked.has(id)||used.has(id));
    }
    for(const n of images){
      const m=materials.get(n.materialId);
      if(!m.generated&&!s.sourceLinks.some(l=>l.target===n.target))s.sourceLinks.push({materialId:m.id,target:n.target,quote:'',note:imageNote(m)});
    }
    if(requireLinks)s.sourceLinks.forEach(l=>delete l.boundText);
  }
  try{bindSources(p,slides,{requireLinks});}
  catch(error){
    // Image normalization may change link positions. Evidence repair must patch
    // the normalized draft rather than indexing the model's original array.
    if(error.code==='SOURCE_EVIDENCE_MISMATCH')error.referenceSlides=structuredClone(slides);
    throw error;
  }
}
