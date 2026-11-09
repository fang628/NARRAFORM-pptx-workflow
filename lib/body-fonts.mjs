import crypto from 'node:crypto';
import {nativeFontFace,fontCategory} from './native-fonts.mjs';
import {pageTitleMatcher} from './title-identity.mjs';
export const pageBodyFontRule='每页普通正文使用同一字体族，按该页预览的正文主字体统一；保留各段字号、粗体、斜体、字距和行距。主标题、副标题、小标题、导航、页码、公式及书法图片独立，不混入正文投票，不改其字体。';
export function pageBodyText(p,e){
 if(e.type!=='text'||e.managed||e.artisticText||pageTitleMatcher(p)(e)||['title','subtitle','heading','navigation','formula','visual-number'].includes(e.role)||e.role!=='body'&&['calligraphy','artistic'].includes(e.fontCategory||fontCategory(e.fontFace||'')))return false;
 return !e.part||e.part==='whole';
}
export function unifyPageBodyFonts(p,elements,index,{reselect=false,references=[]}={}){
 const scope=crypto.createHash('sha256').update(JSON.stringify([p.selectedTheme,p.visualPages?.[index]?.previewHash,p.slides?.[index]?.title])).digest('hex').slice(0,16),memo=p.rebuildBodyFonts?.[index];
 let family=!reselect&&memo?.scope===scope?memo.fontFace:null;
 if(!family){
  const votes=new Map(),evidence=new Map(references.map(r=>[r.key,Math.max(0,(r.afterScore||0)-(r.beforeScore||0))]));
  for(const e of elements.filter(e=>pageBodyText(p,e))){const face=nativeFontFace(e.fontFace||'Microsoft YaHei'),key=face.replace(/[\s_-]/g,'').toLowerCase(),entry=votes.get(key)||{face,score:0};entry.score+=Math.max(1,Math.min(180,(e.text||'').length))*(1+3*(evidence.get(e.key)||0));votes.set(key,entry);}
  family=[...votes.values()].sort((a,b)=>b.score-a.score)[0]?.face;
  if(family){p.rebuildBodyFonts||={};p.rebuildBodyFonts[index]={scope,fontFace:family,source:'page-body-reference-consensus'};}
 }
 const changes=[];return {fontFace:family,elements:elements.map(e=>{
  if(!family||!pageBodyText(p,e)||e.fontFace===family)return e;
  const {requestedFontFace,fontSubstitution,...rest}=e;changes.push({key:e.key,requested:e.fontFace,used:family,reason:'统一本页正文的字体族'});return {...rest,fontFace:family,fontCategory:fontCategory(family)};
 }),changes};
}
