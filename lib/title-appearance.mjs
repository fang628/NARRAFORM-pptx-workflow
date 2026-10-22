import {pageTitleMatcher} from './title-identity.mjs';
import {nativeEffects} from './native-effects.mjs';
export const titleAppearancePrompt='各页主标题统一斜体状态和描边样式。';

const stable=value=>Array.isArray(value)?value.map(stable):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().filter(k=>value[k]!==undefined).map(k=>[k,stable(value[k])])):value;
const identity=value=>JSON.stringify(stable(value));
function appearance(e){
  try{
    const outline=nativeEffects({type:'text',key:e.key,outline:e.outline}).outline;
    return {italic:e.italic===true,outline:outline?.width>0&&outline.opacity>0?outline:null};
  }catch{return null;}
}

// Choose one complete reference style, rather than combining unrelated votes
// for italics, outline presence, color and width from different titles.
export function unifyTitleAppearance(p,elements){
  const isTitle=pageTitleMatcher(p);
  if(!elements.some(isTitle))return {elements,changes:[]};
  const theme=p.concepts?.find(c=>c.id===p.selectedTheme)||p.themeAssets?.directions?.find(d=>d.id===p.selectedTheme);
  const scope=identity([1,p.selectedTheme||null,theme?.styleRegistrationId||null,theme?.typography||null,p.visualTreatment||null,p.version,(p.slides||[]).map((_,i)=>p.visualPages?.[i]?.previewHash||null)]);
  let style=p.rebuildTitleAppearance?.scope===scope?p.rebuildTitleAppearance.style:null;
  if(!style){
    const preview=p.rebuildAssetPreview?.version===p.version?p.rebuildAssetPreview:null,live=preview&&['extracting','partial','cancelled'].includes(preview.status);
    const pages=(p.slides||[]).map((slide,i)=>{
      const page=live?(preview.pages?.[i]||p.reconstruction?.slides?.[i]):(p.reconstruction?.slides?.[i]||preview?.pages?.[i]);
      const titles=(page?.elements||[]).filter(isTitle),title=titles.find(e=>e.part!=='number')||titles[0];
      return {index:i,kind:slide.kind,style:title?appearance(title):null};
    }).filter(page=>page.style);
    const content=pages.filter(page=>!['cover','toc'].includes(page.kind));
    const candidates=content.length?content:pages.length?pages:elements.filter(isTitle).map(e=>({style:appearance(e)})).filter(page=>page.style);
    const votes=new Map();
    for(const candidate of candidates){const id=identity(candidate.style),entry=votes.get(id)||{style:candidate.style,count:0,index:candidate.index};entry.count++;votes.set(id,entry);}
    const selected=[...votes.values()].sort((a,b)=>b.count-a.count)[0];style=selected?.style;
    if(style)p.rebuildTitleAppearance={scope,style:structuredClone(style),source:'reference-title-appearance-consensus',...(selected.index===undefined?{}:{index:selected.index})};
  }
  const changes=[];
  return {style,elements:elements.map(e=>{
    if(!style||!isTitle(e)||identity(appearance(e))===identity(style))return e;
    changes.push({key:e.key,requested:appearance(e),used:structuredClone(style),reason:'统一全篇主标题斜体与描边'});
    const {outline,...rest}=e;
    return {...rest,italic:style.italic,...(style.outline?{outline:structuredClone(style.outline)}:{})};
  }),changes};
}
