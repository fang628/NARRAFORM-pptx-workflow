import {progressSectionsOf} from '../public/progress-sections.js';

export const isChapterPage=slide=>!!slide?.generatedChapter;
export function chapterSpecs(p){
  if(!p.brief.chapterPages)return [];
  return progressSectionsOf(p).flatMap((section,i)=>{
    const beforeIndex=p.slides.findIndex(s=>!isChapterPage(s)&&['content','section'].includes(s.kind)&&s.progressSectionId===section.id);
    return beforeIndex<0?[]:[{sectionId:section.id,title:section.title,number:String(i+1).padStart(2,'0'),beforeIndex}];
  }).sort((a,b)=>a.beforeIndex-b.beforeIndex);
}
export function ensureChapterPages(p){
  const ordinary=p.slides.filter(s=>!isChapterPage(s)),previous=new Map(p.slides.filter(isChapterPage).map(s=>[s.generatedChapter.sectionId,s]));
  p.slides=ordinary;
  const specs=chapterSpecs(p),templateIndex=ordinary.length;
  for(const spec of specs){
    const elements=[{id:'chapter-title',type:'text',role:'title',text:spec.title,parentId:null},{id:'chapter-number',type:'text',role:'body',text:spec.number,parentId:'chapter-title'}];
    const next={kind:'section',title:spec.title,subtitle:'',body:[],notes:'',sources:[],sourceLinks:[],imageId:null,elements,progressSectionId:spec.sectionId,generatedChapter:{sectionId:spec.sectionId,number:spec.number,beforeIndex:spec.beforeIndex,templateIndex}};
    const prior=previous.get(spec.sectionId),same=prior&&prior.title===next.title&&prior.generatedChapter.number===next.generatedChapter.number&&prior.generatedChapter.beforeIndex===next.generatedChapter.beforeIndex&&prior.generatedChapter.templateIndex===templateIndex;
    p.slides.push(same?{...prior,progressSectionId:spec.sectionId}:next);
  }
  return specs;
}
export function chapterPreviewIndices(p,indices){return indices.filter(i=>!isChapterPage(p.slides[i])||p.slides[i].generatedChapter.templateIndex===i);}
export function chapterOrder(p){
  const result=[];
  for(const [i,s]of p.slides.entries())if(!isChapterPage(s)){
    for(const [j,chapter]of p.slides.entries())if(isChapterPage(chapter)&&chapter.generatedChapter.beforeIndex===i)result.push(j);
    result.push(i);
  }
  return result;
}
export function chapterDesign(slide){
  const nodes=slide.elements.map(n=>({id:n.id,position:n.id==='chapter-title'?'页面主要阅读区':'章节名附近',relativeSize:n.id==='chapter-title'?'大标题':'突出序号',alignment:'与章节名协调',carrier:'独立原生文字',relation:'章节序号与章节名共同构成阅读中心'}));
  return {plan:{compactVersion:2,purpose:'章节过渡',conclusion:'',logic:'主体仅章节名和序号，页顶导航突出本章',layoutIntent:'目录底图上排章节序号与名称，为统一页顶进度条留空',style:'沿用全篇标题归并与目录底图风格',differences:'',missingMaterials:[],readingOrder:slide.elements.map(n=>n.id),nodes},markdown:'# 章节页\n\n'+slide.generatedChapter.number+' '+slide.title+'\n\n主体仅上述序号与名称，保留目录底图，页顶显示统一进度条并突出本章。章节标题参与全篇标题归并与标题动画。'};
}
export function cloneChapterReconstruction(p,template,index){
  const slide=p.slides[index],texts=new Map(slide.elements.map(n=>[n.id,n.text]));
  const clone=structuredClone(template);
  const replace=list=>(list||[]).filter(e=>!e.managed&&e.role!=='navigation'&&!e.key?.startsWith('nf-progress-')&&!e.nodeId?.startsWith('navigation-')&&!e.key?.startsWith('nf-footer-')).map(e=>{
    if(e.type==='text'){
      if(!texts.has(e.nodeId))throw Error('章节页仅允许章节序号与章节名称');
      const next={...e,text:texts.get(e.nodeId)};
      for(const field of ['sourceText','textColorRuns','boldRuns'])delete next[field];
      return next;
    }
    if(e.type==='formula')throw Error('章节页不允许公式或其他内容');
    return e;
  });
  const elements=replace(clone.elements),audit=replace(clone.audit),byKey=new Map(elements.filter(e=>e.type==='text').map(e=>[e.key,e.text]));
  if(clone.auditValidation?.numberInventory)clone.auditValidation.numberInventory=clone.auditValidation.numberInventory.map(item=>({...item,text:byKey.get(item.key)||item.text}));
  return {...clone,index,elements,audit,sourceTemplateIndex:slide.generatedChapter.templateIndex,previewTexts:[],textMeasurements:[],notes:''};
}
