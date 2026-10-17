import {defaultProgressTitles,validateProgressSections,progressSectionsOf} from '../public/progress-sections.js';
import {isTOCPage} from './page-options.mjs';
export {validateProgressSections,progressSectionsOf};
export const progressPlanningRule='全篇页顶进度条可选4、5或6个语义章节段，多页共享一段，不按页数或逐页标题生成节点。仅突出本页所属章节；封面、目录不显示进度条。不为凑章节数增加PPT页数，章节名不是必须新增的正文或小标题。';
export function suggestProgressSections(raw,outline=[]){
  try{return validateProgressSections(raw);}catch{}
  const titles=[...new Set(outline.map(o=>o.title?.trim()).filter(t=>t&&t.length<=24))].slice(0,6);
  const count=[4,6].includes(titles.length)?titles.length:5;
  for(const title of defaultProgressTitles)if(titles.length<count&&!titles.includes(title))titles.push(title);
  return validateProgressSections(titles);
}
const eligible=(p,i)=>p.slides[i]?.kind!=='cover'&&!isTOCPage(p.slides[i],i,p.brief);
export function navigationTexts(p,index){
  if(p.brief.progress===false||!p.slides[index]||!eligible(p,index))return [];
  const sections=progressSectionsOf(p),slide=p.slides[index],explicit=sections.findIndex(s=>s.id===slide.progressSectionId);
  const pages=p.slides.map((_,i)=>i).filter(i=>eligible(p,i));
  let current=explicit;
  if(current<0){
    const match=sections.findIndex(s=>s.title===slide.title||s.title===slide.subtitle);
    const heading=p.slides.slice(0,index+1).findLast(s=>s.kind==='section'&&sections.some(c=>c.title===s.title));
    current=match>=0?match:heading?sections.findIndex(s=>s.title===heading.title):Math.min(sections.length-1,Math.floor(pages.indexOf(index)*sections.length/Math.max(1,pages.length)));
  }
  return sections.map((s,i)=>({nodeId:'navigation-'+s.id,text:s.title,parentId:null,role:'navigation',current:i===current}));
}
export function assignProgressSections(p){
  for(const [i,slide] of p.slides.entries()){
    const current=navigationTexts(p,i).find(n=>n.current);
    if(current)slide.progressSectionId=current.nodeId.slice('navigation-'.length);
  }
}
export const progressSceneBrief=(p,index)=>({...p.brief,progressNavigation:navigationTexts(p,index)});
export function progressSceneElements(brief,index,total,slide,theme){
  if(brief.progress===false||slide.kind==='cover'||isTOCPage(slide,index,brief))return [];
  const sections=progressSectionsOf({progressSections:brief.progressSections});
  const items=brief.progressNavigation||sections.map((s,i)=>({nodeId:'navigation-'+s.id,text:s.title,current:i===Math.min(sections.length-1,Math.floor(index*sections.length/Math.max(total,1)))}));
  return items.flatMap((item,i)=>{
    const width=1420/items.length,x=86+i*width;
    const units=[...item.text].reduce((sum,c)=>sum+(c.codePointAt(0)>255?1:.57),0),size=Math.min(14,(width-12)/Math.max(units,1));
    return [{type:'rect',x,y:16,w:width-10,h:4,fill:item.current?theme.accent:theme.muted},
      {type:'text',nodeId:item.nodeId,role:'navigation',text:item.text,x,y:28,w:width-12,h:28,size,color:item.current?theme.accent:theme.muted,bold:item.current}];
  });
}
