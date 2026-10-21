import {nativeFontFace} from './native-fonts.mjs';
import {contentTitleColorRule} from './title-colors.mjs';
import {pageTitleMatcher} from './title-identity.mjs';

export const deckTitleFontRule='全篇页标题使用同一字体族，封面、目录和内容页共同沿用本方向的标题字体；字号、字重、斜体、描边与阴影可按页面需要变化。小标题、正文、图注和页顶章节不参与主标题字体统一。'+contentTitleColorRule;
const key=face=>nativeFontFace(face).replace(/[\s_-]/g,'').toLowerCase();
export function unifyTitleFonts(p,elements,fonts){
  const title=pageTitleMatcher(p);
  const theme=p.concepts?.find(c=>c.id===p.selectedTheme)||p.themeAssets?.directions?.find(d=>d.id===p.selectedTheme);
  const scope=JSON.stringify([p.selectedTheme||null,theme?.styleRegistrationId||null,theme?.typography||null,p.visualTreatment||null]);
  const installed=fonts?.length?new Map(fonts.map(f=>[key(f),f])):null;
  let family=p.rebuildTitleFont?.scope===scope?p.rebuildTitleFont.fontFace:null;
  if(family&&installed&&!installed.has(key(family)))family=null;
  if(!family){
    const pages=(p.slides||[]).map((s,i)=>({kind:s.kind,elements:p.reconstruction?.slides?.[i]?.elements||p.rebuildAssetPreview?.pages?.[i]?.elements||[]}));
    const bodyPages=pages.filter(s=>!['cover','toc'].includes(s.kind)&&s.elements.some(title));
    const candidates=(bodyPages.length?bodyPages:pages).flatMap(s=>s.elements.filter(title));
    const votes=new Map();
    for(const group of [candidates,elements.filter(title)]){
      for(const e of group){
        if(!e.fontFace)continue;
        const face=installed?installed.get(key(e.fontFace)):nativeFontFace(e.fontFace);if(!face)continue;
        const id=key(face),entry=votes.get(id)||{face,count:0};entry.count++;votes.set(id,entry);
      }
      if(votes.size)break;
    }
    family=[...votes.values()].sort((a,b)=>b.count-a.count)[0]?.face;
    if(family)p.rebuildTitleFont={scope,fontFace:family,source:'reference-title-consensus'};
  }
  const changes=[];
  return {fontFace:family,elements:elements.map(e=>{
    if(!family||!title(e))return e;
    if(e.fontFace===family&&!e.requestedFontFace)return e;
    changes.push({key:e.key,requested:e.fontFace,used:family,reason:'统一全篇页标题字体族'});
    const {requestedFontFace,fontSubstitution,...rest}=e;
    return {...rest,fontFace:family};
  }),changes};
}
