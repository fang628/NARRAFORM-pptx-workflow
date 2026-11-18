import {ensureChapterPages,isChapterPage,chapterDesign,chapterPreviewIndices,cloneChapterReconstruction,chapterOrder} from './chapter-pages.mjs';
import {pageDesignStamp,pageDesignInputStamp} from './page-design.mjs';
import {pageStamp} from './visual-model.mjs';
import {normalizeRebuildProgress} from './rebuild-progress.mjs';

export function prepareChapterPages(p){
  if(!Array.isArray(p.slides))return;
  if(!p.brief?.chapterPages){
    const removed=p.slides.flatMap((s,i)=>isChapterPage(s)?[i]:[]);
    if(removed.length){p.slides=p.slides.filter(s=>!isChapterPage(s));for(const i of removed){delete p.pageDesigns?.[i];delete p.visualPages?.[i];}for(const state of [p.reconstruction,p.rebuildAssetPreview])if(state?.slides)state.slides=state.slides.slice(0,p.slides.length);else if(state?.pages)state.pages=state.pages.slice(0,p.slides.length);}
    return;
  }
  if(p.approvals?.content!==p.version)return;
  const prior=p.slides.flatMap((s,i)=>isChapterPage(s)?[{index:i,sectionId:s.generatedChapter.sectionId,title:s.title}]:[]);
  ensureChapterPages(p);
  p.pageDesigns||={};
  for(const previous of prior){const next=p.slides[previous.index];if(!isChapterPage(next)||next.generatedChapter.sectionId!==previous.sectionId||next.title!==previous.title){delete p.pageDesigns[previous.index];delete p.visualPages?.[previous.index];for(const state of [p.reconstruction?.slides,p.rebuildAssetPreview?.pages])if(state)delete state[previous.index];}}
  for(const [i,s]of p.slides.entries())if(isChapterPage(s)){
    const stamp=pageDesignStamp(p,i),existing=p.pageDesigns[i];
    if(existing?.draftStamp===stamp&&existing.chapterPolicyVersion===2)continue;
    const {plan,markdown}=chapterDesign(s),at=new Date().toISOString();
    p.pageDesigns[i]={plan,markdown,draftStamp:stamp,contentInputStamp:pageDesignInputStamp(p,i),approvedAt:at,layoutApprovedAt:at,layoutStamp:stamp,generatedChapter:true,chapterPolicyVersion:2};
  }
}
export function syncChapterPreviews(p){
  const chapters=p.slides.flatMap((s,index)=>isChapterPage(s)?[index]:[]),first=chapters[0],base=p.visualPages?.[first];
  if(first===undefined||!base?.file||base.stamp!==pageStamp(p,first))return;
  for(const i of chapters.slice(1)){
    const prior=p.visualPages[i],stamp=pageStamp(p,i);
    if(prior?.stamp===stamp&&prior.previewHash===base.previewHash&&prior.chapterTemplateIndex===first)continue;
    p.visualPages[i]={...structuredClone(base),index:i,stamp,chapterTemplateIndex:first,reused:true,images:[]};
  }
}
export function syncChapterRebuilds(p,pages){
  const indices=p.slides.flatMap((s,i)=>isChapterPage(s)?[i]:[]),first=indices[0];
  const template=pages[first];if(!template?.elements?.length)return;
  for(const i of indices)if(i!==template.index){
    pages[i]=cloneChapterReconstruction(p,template,i);
    pages[i].elements=normalizeRebuildProgress(p,i,pages[i].elements);
    pages[i].audit=normalizeRebuildProgress(p,i,pages[i].audit);
  }
}
export {isChapterPage,chapterPreviewIndices,chapterOrder};
