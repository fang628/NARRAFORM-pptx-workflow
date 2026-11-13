import {visualColor} from './visual-color.mjs';
import {visualGradient} from './visual-gradient.mjs';
import {pageTitleMatcher} from './title-identity.mjs';
import {normalizeTextPaint} from './styled-text.mjs';
import {parameterConfidence,inheritedParameter} from './parameter-confidence.mjs';

export const contentTitleColorRule='各内容页主标题沿用同一文字配色（含已有字形渐变）；仅统一主标题，不将此配色套到副标题、小标题、正文、图注或进度条，封面与目录保留各自设计。';
export const contentTitleColorPrompt='各内容页主标题沿用同一文字配色。';
const contentPage=s=>s&&(!s.kind||s.kind==='content');
const stable=value=>Array.isArray(value)?value.map(stable):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,stable(value[k])])):value;
function titlePaint(e){
  try{
    e=normalizeTextPaint({...e,role:'title'});
    if(e.color===undefined&&!e.gradient)return null;
    const color=visualColor(e.color||e.gradient.stops[0].color).color;
    return {color,...(e.gradient?{gradient:visualGradient(e.gradient,{key:e.key})}:{})};
  }catch{return null;}
}

export function unifyContentTitleColors(p,elements,index){
  const isTitle=pageTitleMatcher(p,index),anyTitle=pageTitleMatcher(p);
  if(!contentPage(p.slides?.[index])||!elements.some(isTitle))return {elements,changes:[]};
  const preview=p.rebuildAssetPreview?.version===p.version?p.rebuildAssetPreview:null;
  const live=preview&&['extracting','partial','cancelled'].includes(preview.status);
  const candidates=(p.slides||[]).flatMap((slide,i)=>{
    if(!contentPage(slide))return [];
    const page=i===index?{elements}:live?(preview.pages?.[i]||p.reconstruction?.slides?.[i]):(p.reconstruction?.slides?.[i]||preview?.pages?.[i]);
    return (page?.elements||[]).filter(anyTitle).map(e=>({paint:titlePaint(e),element:{...e,key:'page-'+i+':'+e.key},weight:parameterConfidence(e,'textColor'),measured:e.textPaintMeasured===true}));
  }).filter(c=>c.paint);
  const measured=candidates.filter(c=>c.measured);
  const preferred=(measured.length?measured:candidates).filter(c=>c.weight>=.55);
  const scope=JSON.stringify(['vertical-title-v4-weighted',p.selectedTheme||null,p.visualTreatment||null,p.version,
    (p.slides||[]).map((_,i)=>p.visualPages?.[i]?.previewHash||null),preferred.map(c=>({paint:c.paint,weight:c.weight,key:c.element.key}))]);
  let paint=p.rebuildContentTitleColor?.scope===scope?p.rebuildContentTitleColor.paint:null;
  if(!paint){
    const votes=new Map();
    for(const candidate of preferred){
      const id=JSON.stringify(stable(candidate.paint)),entry=votes.get(id)||{paint:candidate.paint,count:0};entry.count+=candidate.weight;votes.set(id,entry);
    }
    // Majority paint wins; on a tie prefer the gradient variant so audit pages that
    // dropped the designed gradient to a solid colour do not erase it for everyone.
    paint=[...votes.values()].sort((a,b)=>b.count-a.count||((b.paint?.gradient?1:0)-(a.paint?.gradient?1:0)))[0]?.paint;
    if(paint)p.rebuildContentTitleColor={scope,paint:structuredClone(paint),source:'content-title-consensus'};
  }
  const changes=[];
  return {paint,elements:elements.map(e=>{
    if(!paint||!isTitle(e))return e;
    const sameGradient=JSON.stringify(stable(e.gradient))===JSON.stringify(stable(paint.gradient));
    if(e.color===paint.color&&sameGradient&&!e.textGradient)return e;
    const {textGradient,...rest}=e;
    const next={...rest,...structuredClone(paint)};
    // Keep/clear the envelope explicitly: replacing {color} must not silently drop a
    // designed gradient, and a solid reference must clear a stale gradient.
    if(paint.gradient)next.gradient=structuredClone(paint.gradient);else delete next.gradient;
    changes.push({key:e.key,requested:titlePaint(e),used:structuredClone(paint),reason:'统一内容页主标题文字配色'});
    return inheritedParameter(next,'textColor',preferred.map(c=>c.element),.85);
  }),changes};
}
