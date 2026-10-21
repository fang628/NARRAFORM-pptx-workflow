import {visualColor} from './visual-color.mjs';
import {visualGradient} from './visual-gradient.mjs';
import {pageTitleMatcher} from './title-identity.mjs';

export const contentTitleColorRule='各内容页主标题沿用同一文字配色（含已有字形渐变）；仅统一主标题，不将此配色套到副标题、小标题、正文、图注或进度条，封面与目录保留各自设计。';
export const contentTitleColorPrompt='各内容页主标题沿用同一文字配色。';
const contentPage=s=>s&&(!s.kind||s.kind==='content');
const stable=value=>Array.isArray(value)?value.map(stable):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,stable(value[k])])):value;
function titlePaint(e){
  try{
    if(e.color===undefined&&!e.gradient)return null;
    const color=visualColor(e.color||e.gradient.stops[0].color).color;
    return {color,...(e.gradient?{gradient:visualGradient(e.gradient,{key:e.key})}:{})};
  }catch{return null;}
}

export function unifyContentTitleColors(p,elements,index){
  const isTitle=pageTitleMatcher(p,index),anyTitle=pageTitleMatcher(p);
  if(!contentPage(p.slides?.[index])||!elements.some(isTitle))return {elements,changes:[]};
  const scope=JSON.stringify([p.selectedTheme||null,p.visualTreatment||null,p.version,(p.slides||[]).map((_,i)=>p.visualPages?.[i]?.previewHash||null)]);
  let paint=p.rebuildContentTitleColor?.scope===scope?p.rebuildContentTitleColor.paint:null;
  if(!paint){
    const preview=p.rebuildAssetPreview?.version===p.version?p.rebuildAssetPreview:null;
    const live=preview&&['extracting','partial','cancelled'].includes(preview.status);
    const candidates=(p.slides||[]).flatMap((slide,i)=>{
      if(!contentPage(slide))return [];
      const page=live?(preview.pages?.[i]||p.reconstruction?.slides?.[i]):(p.reconstruction?.slides?.[i]||preview?.pages?.[i]);
      return (page?.elements||[]).filter(anyTitle).map(titlePaint).filter(Boolean);
    });
    const votes=new Map();
    for(const candidate of candidates.length?candidates:elements.filter(isTitle).map(titlePaint).filter(Boolean)){
      const id=JSON.stringify(stable(candidate)),entry=votes.get(id)||{paint:candidate,count:0};entry.count++;votes.set(id,entry);
    }
    paint=[...votes.values()].sort((a,b)=>b.count-a.count)[0]?.paint;
    if(paint)p.rebuildContentTitleColor={scope,paint:structuredClone(paint),source:'content-title-consensus'};
  }
  const changes=[];
  return {paint,elements:elements.map(e=>{
    if(!paint||!isTitle(e))return e;
    if(e.color===paint.color&&JSON.stringify(stable(e.gradient))===JSON.stringify(stable(paint.gradient)))return e;
    const {gradient,...rest}=e;
    changes.push({key:e.key,requested:titlePaint(e),used:structuredClone(paint),reason:'统一内容页主标题文字配色'});
    return {...rest,...structuredClone(paint)};
  }),changes};
}
