import {Resvg} from '@resvg/resvg-js';
import {DOMParser,XMLSerializer} from '@xmldom/xmldom';
import {defaultProgressTitles,validateProgressSections,progressSectionsOf} from '../public/progress-sections.js';
import {isTOCPage,isThanksPage} from './page-options.mjs';
import {progressShadowStroke} from './progress-effects.mjs';
import {escapeXML} from './svg-tree.mjs';
export {validateProgressSections,progressSectionsOf};
export const progressPlanningRule='先根据内容主题跨度、论述层次与真实章节关系选择4、5或6段，不默认固定段数；只生成选定段数的一组章节，不同时给出多套数量，也不截断或补占位章节凑数。全篇页顶进度条采用所选语义章节段，按各页或规划提纲的具体主题，将相邻且主题相关的页面归并为篇章，用实际讨论内容命名，多页共享一段；不按页数均分、不机械复制逐页标题，也不套用通用流程标签。当前章节突出，已经过与未经过章节使用清晰可辨的不同填充色；封面、目录、致谢不显示进度条。不为凑章节数增加PPT页数，章节名不是必须新增的正文或小标题。每个章节名按含义自然使用4–8个汉字、最多10字；适合6–8字时直接保留，不为避免文字较长而一律压成2–4字或删掉限定，使用简短主题短语，不写完整结论、实验条件或长副标题；已有用户编辑名称保留。';
export function suggestProgressSections(raw,outline=[]){
  try{const sections=validateProgressSections(raw);if(sections.every(s=>[...s.title].length<=10))return sections;}catch{}
  const titles=[...new Set(outline.map(o=>o.title?.trim()).filter(t=>t&&[...t].length<=10))].slice(0,6);
  const count=[4,6].includes(titles.length)?titles.length:5;
  for(const title of defaultProgressTitles)if(titles.length<count&&!titles.includes(title))titles.push(title);
  return validateProgressSections(titles);
}
const eligible=(p,i)=>p.slides[i]?.kind!=='cover'&&!isTOCPage(p.slides[i],i,p.brief)&&!isThanksPage(p.slides[i]);
export function navigationTexts(p,index){
  if(!p.slides[index]||p.brief.progress===false&&!p.slides[index].generatedChapter||!eligible(p,index))return [];
  const sections=progressSectionsOf(p),slide=p.slides[index],explicit=sections.findIndex(s=>s.id===(slide.generatedChapter?.sectionId||slide.progressSectionId));
  const pages=p.slides.map((_,i)=>i).filter(i=>eligible(p,i)&&!p.slides[i].generatedChapter);
  let current=explicit;
  if(current<0){
    const match=sections.findIndex(s=>s.title===slide.title||s.title===slide.subtitle);
    const heading=p.slides.slice(0,index+1).findLast(s=>!s.generatedChapter&&s.kind==='section'&&sections.some(c=>c.title===s.title));
    current=match>=0?match:heading?sections.findIndex(s=>s.title===heading.title):Math.min(sections.length-1,Math.floor(pages.indexOf(index)*sections.length/Math.max(1,pages.length)));
  }
  return sections.map((s,i)=>({nodeId:'navigation-'+s.id,text:progressText(s.title),parentId:null,role:'navigation',current:i===current}));
}
export function assignProgressSections(p){
  for(const [i,slide] of p.slides.entries()){
    const current=navigationTexts(p.brief.chapterPages&&p.brief.progress===false?{...p,brief:{...p.brief,progress:true}}:p,i).find(n=>n.current);
    if(current)slide.progressSectionId=current.nodeId.slice('navigation-'.length);
  }
}
export const progressSceneBrief=(p,index)=>({...p.brief,progressNavigation:navigationTexts(p,index)});
export function progressLabelSize(text,width,{size=16,activeScale=1.25,current=false}={}){
  const [units]=progressLabelWidths([text],progressFontFace,activeScale);
  const normal=Math.min(size,width/units);
  return normal*(current?activeScale:1);
}
const progressFontFace='Microsoft YaHei';
export const defaultProgressHeight=50;
const progressText=text=>String(text).replace(/\s*[\r\n]+\s*/g,' ');
const labelWidthCache=new Map();
const svgRoot='<svg xmlns="http://www.w3.org/2000/svg" width="20000" height="200">';
const labelWeights=[400,700];

function estimatedLabelWidth(text){
  let width=0;
  for(const char of text){
    if(/\p{Mark}/u.test(char))continue;
    if(/[\s.,:;ilI!|']/.test(char))width+=.37;
    else if(/[MW@%]/.test(char))width+=1.05;
    else width+=char.codePointAt(0)<128 ? .75 : 1.12;
  }
  return width;
}

function measureLabelWidths(texts,fontFace){
  const escapedFont=escapeXML(fontFace);
  const textNodes=texts.flatMap((text,index)=>labelWeights.map(weight=>`<text id="label-${index}-${weight}" y="130" font-family="${escapedFont}, sans-serif" font-size="100" font-weight="${weight}">${escapeXML(text)}</text>`));
  let document;
  try{
    // Outline all labels in a single font load, then measure each outline.
    const outlines=new Resvg(svgRoot+textNodes.join('')+'</svg>').toString();
    document=new DOMParser().parseFromString(outlines,'image/svg+xml');
  }catch{
    // Fonts or glyphs can be missing on a preview-only host.
  }
  const serializer=new XMLSerializer();
  return texts.map((text,index)=>{
    const wideGlyphs=[...text].filter(char=>/[\p{Script=Han}\p{Script=Hangul}\p{Extended_Pictographic}]/u.test(char)).length;
    return labelWeights.map(weight=>{
      const node=document?.getElementById(`label-${index}-${weight}`);
      const bounds=node&&new Resvg(svgRoot+serializer.serializeToString(node)+'</svg>',{font:{loadSystemFonts:false}}).getBBox();
      const units=bounds?.width>0?Math.max((bounds.x+bounds.width)/100,wideGlyphs):estimatedLabelWidth(text);
      return Math.max(1,units*1.06+.08);
    });
  });
}

function progressLabelWidths(labels,fontFace,activeScale){
  const texts=labels.map(progressText),key=JSON.stringify([fontFace,texts]);
  let widths=labelWidthCache.get(key);
  if(!widths){
    widths=measureLabelWidths(texts,fontFace);
    if(labelWidthCache.size>=128)labelWidthCache.delete(labelWidthCache.keys().next().value);
    labelWidthCache.set(key,widths);
  }
  return widths.map(([normal,bold])=>Math.max(normal,bold*activeScale));
}
const bounded=(v,lo,hi)=>Math.max(lo,Math.min(hi,v));
const tint=(color,t)=>color.match(/../g).map(c=>Math.round(parseInt(c,16)*(1-Math.abs(t))+(t>0?255:0)*Math.abs(t)).toString(16).padStart(2,'0')).join('').toUpperCase();
const hex=(value,fallback)=>/^#?[\da-f]{6}$/i.test(value||'')?value.replace('#','').toUpperCase():fallback;
const rgb=color=>color.match(/../g).map(v=>parseInt(v,16));
const luminance=color=>rgb(color).map(v=>{const s=v/255;return s<=.04045?s/12.92:((s+.055)/1.055)**2.4;}).reduce((n,v,i)=>n+v*[.2126,.7152,.0722][i],0);
const contrast=(a,b)=>(Math.max(luminance(a),luminance(b))+.05)/(Math.min(luminance(a),luminance(b))+.05);
const mixRGB=(a,b,t)=>a.map((v,i)=>Math.round(v*(1-t)+b[i]*t));
const rgbHex=values=>values.map(v=>v.toString(16).padStart(2,'0')).join('').toUpperCase();
function gradientPaintSamples(fill,gradient,positions){
  const stops=gradient?.stops?.map(s=>({position:s.position??s.offset,color:hex(s.color,fill),opacity:bounded(Number(s.opacity??1),0,1)}));
  if(!stops?.length)return [rgb(fill)];
  const ordered=stops.map((s,i)=>({...s,position:Number.isFinite(s.position)?s.position:i/(stops.length-1)})).sort((a,b)=>a.position-b.position);
  return positions(ordered).map(at=>{
    const right=ordered.findIndex(s=>s.position>=at),b=ordered[right<0?ordered.length-1:right],a=ordered[Math.max(0,right-1)];
    if(right<=0)return mixRGB(rgb(fill),rgb(b.color),b.opacity);
    const t=bounded((at-a.position)/Math.max(.001,b.position-a.position),0,1);
    return mixRGB(mixRGB(rgb(fill),rgb(a.color),a.opacity),mixRGB(rgb(fill),rgb(b.color),b.opacity),t);
  });
}
function progressSurface(fill,gradient){
  const samples=gradientPaintSamples(fill,gradient,()=>[0,.25,.5,.75,1]);
  return rgbHex([0,1,2].map(i=>Math.round(samples.reduce((sum,c)=>sum+c[i],0)/samples.length)));
}
export const PROGRESS_STATE_MIN_CONTRAST=1.35;
export function progressStateContrast(track,completed,trackGradient,completedGradient){
  return contrast(progressSurface(track,trackGradient),progressSurface(completed,completedGradient));
}
function distinctCompletedPaint(track,completedFill,trackGradient,completedGradient){
  if(progressStateContrast(track,completedFill,trackGradient,completedGradient)>=PROGRESS_STATE_MIN_CONTRAST)return {completedFill,completedGradient};
  // Adjust the completed state at the source, before choosing readable label ink.
  // Keep track/current paint and every gradient position/alpha/effect unchanged.
  const options=[];
  for(const direction of [-1,1])for(let step=1;step<=50;step++){
    const amount=direction*step/50,fill=tint(completedFill,amount),gradient=completedGradient?{...completedGradient,stops:completedGradient.stops.map(stop=>({...stop,color:tint(hex(stop.color,completedFill),amount)}))}:undefined;
    const score=progressStateContrast(track,fill,trackGradient,gradient);
    if(score>=PROGRESS_STATE_MIN_CONTRAST){options.push({completedFill:fill,completedGradient:gradient,amount:Math.abs(amount),score});break;}
  }
  return options.sort((a,b)=>a.amount-b.amount||b.score-a.score)[0]||{completedFill,completedGradient};
}
const MEASURED_INK_MIN_CONTRAST=2.25;
function progressInk(preferred,fill,gradient,alternatives=[],measured=false){
  const observed=hex(preferred,null);
  if(measured&&observed){
    // Compare the measured ink with the label band, away from edge highlights.
    const band=gradientPaintSamples(fill,gradient,stops=>[.2,.35,.5,.65,.8,...stops.map(s=>s.position).filter(p=>p>.2&&p<.8)]);
    if(band.every(bg=>contrast(observed,rgbHex(bg))>=MEASURED_INK_MIN_CONTRAST))return observed;
  }
  const stops=(gradient?.stops||[]).map(s=>{
    const color=hex(s.color,fill),alpha=bounded(Number(s.opacity??1),0,1);
    return rgb(color).map((v,i)=>Math.round(v*alpha+rgb(fill)[i]*(1-alpha)).toString(16).padStart(2,'0')).join('').toUpperCase();
  });
  const surfaces=[fill,...stops];
  // Judge the whole gradient, including transitions between its stops.
  for(let i=1;i<stops.length;i++)for(const t of [.25,.5,.75])surfaces.push(rgb(stops[i-1]).map((v,k)=>Math.round(v*(1-t)+rgb(stops[i])[k]*t).toString(16).padStart(2,'0')).join(''));
  const candidates=[...new Set([preferred,...alternatives,'272727','F4F4EF','000000','FFFFFF'].map(c=>hex(c,null)).filter(c=>c&&c!==fill))];
  const score=c=>Math.min(...surfaces.map(bg=>contrast(c,bg)));
  return candidates.find(c=>score(c)>=4.5)||candidates.sort((a,b)=>score(b)-score(a))[0];
}
// Shared by scenes and delivery: separate semantic states while retaining observed effects.
export function progressRowAppearance(style){
  const accent=hex(style.accent,'697887'),track=hex(style.track,'D9DCDF');
  const gradient=value=>value?.stops?.length>=2?{...structuredClone(value),type:'linear',angle:90}:undefined;
  const trackGradient=gradient(style.trackGradient),activeGradient=gradient(style.activeGradient);
  const {completedFill,completedGradient}=distinctCompletedPaint(track,hex(style.completedFill,tint(accent,.45)),trackGradient,gradient(style.completedGradient));
  const shadow=style.shadow?{type:'outer',color:hex(style.shadow.color,'000000'),opacity:bounded(Number(style.shadow.opacity??.14),0,1),blur:bounded(Number(style.shadow.blur??3),0,12),offset:bounded(Number(style.shadow.offset??1.5),0,8),angle:Number.isFinite(style.shadow.angle)?style.shadow.angle:90}:null;
  const {glow,trackGlow,completedGlow,activeGlow,...baseStyle}=style;
  const effects={};
  for(const state of ['track','completed','active']){
    // Undefined inherits a legacy shared effect; explicit null means absent.
    const value=style[state+'Shadow']===undefined?shadow:style[state+'Shadow'];
    effects[state+'Shadow']=value?{type:'outer',color:hex(value.color,'000000'),opacity:bounded(Number(value.opacity??.14),0,1),blur:bounded(Number(value.blur??3),0,12),offset:bounded(Number(value.offset??1.5),0,8),angle:Number.isFinite(value.angle)?value.angle:90}:null;
    const pair=progressShadowStroke(effects[state+'Shadow'],bounded(Number(style[state+'StrokeWidth']??style.strokeWidth)||0,0,3));
    effects[state+'Shadow']=pair.shadow;
    effects[state+'StrokeWidth']=pair.strokeWidth;
  }
  const muted=progressInk(style.muted,track,trackGradient,[style.ink],style.inkMeasured?.track);
  const completedInk=progressInk(style.completedInk||style.muted,completedFill,completedGradient,[style.ink],style.inkMeasured?.completed);
  const indicatorInk=progressInk(style.indicatorInk,accent,activeGradient,[style.ink],style.inkMeasured?.active);
  return {...baseStyle,...effects,accent,track,completedFill,muted,completedInk,indicatorInk,strokeWidth:bounded(Number(style.strokeWidth)||0,0,3),border:hex(style.border,tint(track,-.25)),completedBorder:hex(style.completedBorder,tint(completedFill,-.2)),activeBorder:hex(style.activeBorder,tint(accent,-.25)),trackGradient,completedGradient,activeGradient,shadow};
}

// The outer box determines the available space. Every segment reserves the
// enlarged label, so selecting a different chapter never moves its neighbors.
export function progressRowMetrics(items,style){
  if(!items.length)return {segments:[],head:0,pad:0,normalSize:24,activeScale:1.25,h:0,gap:0};
  const h=style.h??defaultProgressHeight,count=items.length,bubble=style.layout==='bubble-row';
  const activeScale=style.activeScale??1.25;
  const head=bubble?0:Math.min(h*.2,style.w/(6*count));
  const gap=bubble&&style.sharedFrame?0:Math.min(bounded(Number(style.gap??3),2,6),style.w/(4*count));
  const bodyWidth=style.w-2*head-gap*(count-1),mean=bodyWidth/count;
  const padding=Math.min(h*(bubble ? .24 : .2),mean/6),pad=head+padding;
  const reserve=Math.max(2*padding,bubble?Math.min(h,mean/2):2*head);
  const labelBudget=bodyWidth-count*reserve;
  const widths=progressLabelWidths(items.map(n=>n.text),style.fontFace||progressFontFace,activeScale);
  const totalUnits=widths.reduce((sum,width)=>sum+width,0);
  const verticalPadding=Math.min(6,h*.12);
  const heightSize=(h-2*verticalPadding)/(activeScale*1.25);
  const normalSize=Math.min(Math.floor(heightSize*2)/2||heightSize,labelBudget/totalUnits);
  const extra=Math.max(0,labelBudget-totalUnits*normalSize)/count;
  let offset=0;
  const segments=widths.map(width=>{
    const body=reserve+width*normalSize+extra,w=body+2*head;
    const segment={offset,w,labelPad:pad,labelW:w-2*pad};
    offset+=body+gap;
    return segment;
  });
  return {segments,head,pad,normalSize,activeScale,gap,verticalPadding,h};
}
export function progressArrowRow(items,style){
  if(!items.length)return [];
  style=progressRowAppearance(style);
  const {segments,head,normalSize,activeScale,h,verticalPadding}=progressRowMetrics(items,style);
  const active=Math.max(0,items.findIndex(n=>n.current));
  const bubble=style.layout==='bubble-row',shared=bubble&&style.sharedFrame;
  const shape=(key,i,fill)=>{const current=key==='nf-progress-indicator',completed=!current&&i<active,state=current?'active':completed?'completed':'track';
    const covered=!current&&(i===active||shared&&!completed);
    const {offset,w}=segments[i];
    const inset=shared&&!current?style.sharedStrokeWidth??0:0;
    const width=w-2*inset,height=h-2*inset;
    const closedBubble=bubble&&(!shared||current||i===0);
    return {key,type:'shape',shape:closedBubble?'roundRect':bubble?'rect':i===0?'hexagon':'chevron',x:style.x+offset+inset,y:style.y+inset,w:width,h:height,fill:completed?style.completedFill:fill,
      ...(covered&&shared?{fillOpacity:0}:{}),color:current?style.activeBorder:completed?style.completedBorder:style.border,
      strokeWidth:covered?0:style[state+'StrokeWidth'],...(closedBubble?{adjustments:{adj:50000}}:bubble?{}:{progressGeometry:{head,leftTip:i===0?0:head*2}}),
      shadow:covered?null:structuredClone(style[state+'Shadow']),gradient:covered&&shared?undefined:structuredClone(style[state+'Gradient']),managed:'progress',progressState:current?'current':completed?'completed':'upcoming'};};
  const frame=shared?[{key:'nf-progress-track-frame',type:'shape',shape:'roundRect',managed:'progress',x:style.x,y:style.y,w:style.w,h,
    fill:style.track,gradient:structuredClone(style.trackGradient),color:style.sharedBorder??style.track,strokeWidth:style.sharedStrokeWidth??0,adjustments:{adj:50000}}]:[];
  const tracks=items.map((n,i)=>shape('nf-progress-track-'+i,i,style.track));
  const indicator=shape('nf-progress-indicator',active,style.accent);
  const dividers=shared?(style.sharedDividers||[]).map(({index,color,width,top,height})=>({
    key:'nf-progress-divider-'+index,type:'rect',managed:'progress',x:style.x+segments[index+1].offset-width/2,y:style.y+top*h,w:width,h:height*h,
    fill:color,strokeWidth:0,fillOpacity:index===active||index+1===active?0:1})):[];
  const labels=items.map((n,i)=>{
    // Match geometric scaling to font scaling. Morph can then interpolate the
    // whole native text object around its fixed center, with stable line breaks.
    const {offset,labelW,labelPad}=segments[i],factor=n.current?1:1/activeScale,w=labelW*factor,labelH=(h-2*verticalPadding)*factor;
    return {key:'nf-progress-label-'+i,type:'text',nodeId:n.nodeId,role:'navigation',text:progressText(n.text),x:style.x+offset+labelPad+(labelW-w)/2,y:style.y+(h-labelH)/2,w,h:labelH,size:normalSize*(n.current?activeScale:1),fontFace:style.fontFace||progressFontFace,color:n.current?style.indicatorInk:i<active?style.completedInk:style.muted,bold:!!n.current,italic:false,align:'center',valign:'mid',noWrap:true,managed:'progress'};
  });
  return [...frame,...tracks,...dividers,indicator,...labels];
}
export function progressSceneElements(brief,index,total,slide,theme){
  if(brief.progress===false&&!slide.generatedChapter||slide.kind==='cover'||isTOCPage(slide,index,brief)||isThanksPage(slide))return [];
  const sections=progressSectionsOf({progressSections:brief.progressSections});
  const items=brief.progressNavigation||sections.map((s,i)=>({nodeId:'navigation-'+s.id,text:s.title,current:slide.generatedChapter?s.id===slide.generatedChapter.sectionId:i===Math.min(sections.length-1,Math.floor(index*sections.length/Math.max(total,1)))}));
  const c=(theme.accent||'808080').replace('#',''),brightness=[0,2,4].reduce((sum,k,i)=>sum+parseInt(c.slice(k,k+2),16)*[.2126,.7152,.0722][i],0);
  return progressArrowRow(items,{x:28,y:10,w:1544,gap:3,accent:theme.accent,track:theme.panel||theme.muted,muted:theme.fg||'272727',indicatorInk:brightness>150?'272727':'F4F4EF'});
}
