import {isDeepStrictEqual} from 'node:util';
import {initialElements,orderedElements} from './elements.mjs';
import {pageDesignState,pageDesignStamp,pageDesignInputStamp,canonicalDesignTree} from './page-design.mjs';
import {syncPageDesignText} from './page-design-text.mjs';

// Formula edits keep the existing prose/layout; new formula nodes receive a local slot.
export function syncFormulaDesign(p,index,nextSlide){
  const before=p.slides[index],d=p.pageDesigns?.[index];
  if(!before||!d?.plan||!pageDesignState(p,index)?.current)return null;
  const old=initialElements(before),nodes=initialElements(nextSlide),formulas=list=>list.filter(n=>n.type==='formula');
  if(isDeepStrictEqual(formulas(old),formulas(nodes)))return null;
  if(!isDeepStrictEqual(old.filter(n=>n.type!=='formula'),nodes.filter(n=>n.type!=='formula')))return null;
  const project={...p,slides:p.slides.map((s,i)=>i===index?nextSlide:s),pageDesigns:structuredClone(p.pageDesigns)};
  try{return syncPageDesignText(project,index,before);}catch{}
  const ordered=orderedElements(nodes),specs=new Map(d.plan.nodes.map(n=>[n.id,n]));
  const plan={...structuredClone(d.plan),readingOrder:ordered.map(n=>n.id),nodes:ordered.map(n=>specs.get(n.id)||{id:n.id,position:'所属内容区域',relativeSize:'完整展示公式',alignment:'与所属内容左对齐',carrier:'Office原生公式',relation:'从属于对应内容'})};
  const tree=canonicalDesignTree(project,index,plan);
  if(!/<!-- CONFIRMED-CONTENT:START -->[\s\S]*?<!-- CONFIRMED-CONTENT:END -->/.test(d.markdown))return null;
  const markdown=d.markdown.replace(/<!-- CONFIRMED-CONTENT:START -->[\s\S]*?<!-- CONFIRMED-CONTENT:END -->/,()=>tree),stamp=pageDesignStamp(project,index);
  return {...d,plan,markdown,contentInputStamp:pageDesignInputStamp(project,index),draftStamp:stamp,layoutStamp:stamp,approvedAt:null,textSyncedAt:new Date().toISOString(),contentSnapshot:structuredClone(nextSlide)};
}
