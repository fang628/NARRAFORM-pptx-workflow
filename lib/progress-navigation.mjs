import {defaultProgressTitles,validateProgressSections,progressSectionsOf} from '../public/progress-sections.js';
import {isTOCPage} from './page-options.mjs';
export {validateProgressSections,progressSectionsOf};
export const progressPlanningRule='先根据内容主题跨度、论述层次与真实章节关系选择4、5或6段，不默认固定段数；只生成选定段数的一组章节，不同时给出多套数量，也不截断或补占位章节凑数。全篇页顶进度条采用所选语义章节段，按各页或规划提纲的具体主题，将相邻且主题相关的页面归并为篇章，用实际讨论内容命名，多页共享一段；不按页数均分、不机械复制逐页标题，也不套用通用流程标签。仅突出本页所属章节；封面、目录不显示进度条。不为凑章节数增加PPT页数，章节名不是必须新增的正文或小标题。每个章节名按含义自然使用4–8个汉字、最多10字；适合6–8字时直接保留，不为避免文字较长而一律压成2–4字或删掉限定，使用简短主题短语，不写完整结论、实验条件或长副标题；已有用户编辑名称保留。';
export function suggestProgressSections(raw,outline=[]){
  try{const sections=validateProgressSections(raw);if(sections.every(s=>[...s.title].length<=10))return sections;}catch{}
  const titles=[...new Set(outline.map(o=>o.title?.trim()).filter(t=>t&&[...t].length<=10))].slice(0,6);
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
  return sections.map((s,i)=>({nodeId:'navigation-'+s.id,text:s.title.replace(/\s*\n\s*/g,' '),parentId:null,role:'navigation',current:i===current}));
}
export function assignProgressSections(p){
  for(const [i,slide] of p.slides.entries()){
    const current=navigationTexts(p,i).find(n=>n.current);
    if(current)slide.progressSectionId=current.nodeId.slice('navigation-'.length);
  }
}
export const progressSceneBrief=(p,index)=>({...p.brief,progressNavigation:navigationTexts(p,index)});
export function progressLabelSize(text,width,{size=16,activeScale=1.25,current=false}={}){
  const units=[...text].reduce((sum,c)=>sum+(c.codePointAt(0)>255?1:.57),0);
  // Reserve the enlarged width even on inactive pages so the same label never shifts or wraps.
  const normal=Math.min(size,width/Math.max(units,1)/activeScale/1.2);
  return normal*(current?activeScale:1);
}
const bounded=(v,lo,hi)=>Math.max(lo,Math.min(hi,v));
const tint=(color,t)=>color.match(/../g).map(c=>Math.round(parseInt(c,16)*(1-Math.abs(t))+(t>0?255:0)*Math.abs(t)).toString(16).padStart(2,'0')).join('').toUpperCase();
const hex=(value,fallback)=>/^#?[\da-f]{6}$/i.test(value||'')?value.replace('#','').toUpperCase():fallback;
const rgb=color=>color.match(/../g).map(v=>parseInt(v,16));
const luminance=color=>rgb(color).map(v=>{const s=v/255;return s<=.04045?s/12.92:((s+.055)/1.055)**2.4;}).reduce((n,v,i)=>n+v*[.2126,.7152,.0722][i],0);
const contrast=(a,b)=>(Math.max(luminance(a),luminance(b))+.05)/(Math.min(luminance(a),luminance(b))+.05);
function progressInk(preferred,fill,gradient,alternatives=[]){
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
// Shared by local scenes and delivery: preserve observed effects, including none.
export function progressRowAppearance(style){
  const accent=hex(style.accent,'697887'),track=hex(style.track,'D9DCDF'),completedFill=hex(style.completedFill,tint(accent,.45));
  const gradient=value=>value?.stops?.length>=2?structuredClone(value):undefined;
  const trackGradient=gradient(style.trackGradient,track),completedGradient=gradient(style.completedGradient,completedFill),activeGradient=gradient(style.activeGradient,accent);
  return {...style,accent,track,completedFill,muted:progressInk(style.muted,track,trackGradient,[style.ink]),completedInk:progressInk(style.completedInk||style.muted,completedFill,completedGradient,[style.ink]),indicatorInk:progressInk(style.indicatorInk,accent,activeGradient,[style.ink]),strokeWidth:bounded(Number(style.strokeWidth)||0,0,3),border:hex(style.border,tint(track,-.25)),completedBorder:hex(style.completedBorder,tint(completedFill,-.2)),activeBorder:hex(style.activeBorder,tint(accent,-.25)),trackGradient,completedGradient,activeGradient,shadow:{type:'outer',color:hex(style.shadow?.color,'000000'),opacity:bounded(Number(style.shadow?.opacity)||.14,.08,.2),blur:bounded(Number(style.shadow?.blur)||3,2,5),offset:bounded(Number(style.shadow?.offset)||1.5,1,3),angle:Number.isFinite(style.shadow?.angle)?style.shadow.angle:90}};
}

// Bound the longest name's share while keeping short names comfortably readable.
function sectionWidths(weights,total,min,max){
  let lo=0,hi=total/Math.min(...weights);
  for(let n=0;n<60;n++){
    const mid=(lo+hi)/2,sum=weights.reduce((s,w)=>s+bounded(w*mid,min,max),0);
    if(sum>total)hi=mid;else lo=mid;
  }
  const widths=weights.map(w=>bounded(w*(lo+hi)/2,min,max));
  widths[widths.length-1]+=total-widths.reduce((sum,w)=>sum+w,0);
  return widths;
}

// One geometry source for previews and 05: widths depend only on chapter text,
// never the active chapter, so Morph keeps stable track and label identities.
export function progressRowMetrics(items,style){
  if(!items.length)return {segments:[],head:0,pad:0,normalSize:24,activeScale:1.25,h:0,gap:0};
  const bubble=style.layout==='bubble-row',head=bubble?0:10,gap=bounded(Number(style.gap??3),2,6);
  const total=style.w-2*head-gap*(items.length-1),mean=total/items.length,pad=bubble?12:head+10,activeScale=style.activeScale??1.25;
  const units=text=>Math.max(1,[...String(text).replace(/\s*\n\s*/g,' ')].reduce((s,c)=>s+(c.codePointAt(0)>255?1:.57),0));
  const widths=sectionWidths(items.map(n=>units(n.text)**.8),total,Math.min(mean,100),mean*2.5);
  let offset=0;
  const segments=widths.map(width=>{const w=width+2*head,segment={offset,w,labelW:w-pad*2};offset+=width+gap;return segment;});
  // Navigation is a single line. Reserve enlarged/bold metrics and reduce type,
  // including legacy long labels. Reserve vertical space for the enlarged font.
  const fitting=Math.min(...items.map((n,i)=>segments[i].labelW/(units(n.text)*activeScale*1.22)));
  const verticalPadding=6,lineHeight=1.25,maxHeight=52;
  const normalSize=Math.max(.5,Math.min(24,style.size??24,fitting,(maxHeight-2*verticalPadding)/(activeScale*lineHeight)));
  return {segments,head,pad,normalSize,activeScale,gap,verticalPadding,h:Math.max(34,Math.ceil(normalSize*activeScale*lineHeight+2*verticalPadding))};
}
export function progressArrowRow(items,style){
  if(!items.length)return [];
  style=progressRowAppearance(style);
  const {segments,head,pad,normalSize,activeScale,h,verticalPadding}=progressRowMetrics(items,style);
  const active=Math.max(0,items.findIndex(n=>n.current));
    const shape=(key,i,fill)=>{const current=key==='nf-progress-indicator',completed=!current&&i<active,gradient=current?style.activeGradient:completed?style.completedGradient:style.trackGradient;
    const {offset,w}=segments[i];
    // A tall full capsule would cut into the first/last text lines. Keep pill
    // ends on compact rows and gentler rounded corners on multiline bubbles.
    const radius=h<=64?h/2:24;
    return {key,type:'shape',shape:style.layout==='bubble-row'?'roundRect':i===0?'hexagon':'chevron',x:style.x+offset,y:style.y,w,h,fill:completed?style.completedFill:fill,color:current?style.activeBorder:completed?style.completedBorder:style.border,strokeWidth:style.strokeWidth,adjustments:{adj:(style.layout==='bubble-row'?radius:head)/Math.min(w,h)*100000},...(style.layout==='bubble-row'?{}:{progressGeometry:{head,leftTip:i===0?0:head*2}}),shadow:structuredClone(style.shadow),gradient:structuredClone(gradient),managed:'progress',progressState:current?'current':completed?'completed':'upcoming'};};
  const tracks=items.map((n,i)=>shape('nf-progress-track-'+i,i,style.track));
  const indicator=shape('nf-progress-indicator',active,style.accent);
  const labels=items.map((n,i)=>{
    // Match geometric scaling to font scaling. Morph can then interpolate the
    // whole native text object around its fixed center, with stable line breaks.
    const {offset,labelW}=segments[i],factor=n.current?1:1/activeScale,w=labelW*factor,labelH=(h-2*verticalPadding)*factor;
    return {key:'nf-progress-label-'+i,type:'text',nodeId:n.nodeId,role:'navigation',text:String(n.text).replace(/\s*\n\s*/g,' '),x:style.x+offset+pad+(labelW-w)/2,y:style.y+(h-labelH)/2,w,h:labelH,size:normalSize*(n.current?activeScale:1),fontFace:style.fontFace||'Microsoft YaHei',color:n.current?style.indicatorInk:i<active?style.completedInk:style.muted,bold:!!n.current,italic:false,align:'center',valign:'mid',noWrap:true,managed:'progress'};
  });
  return [...tracks,indicator,...labels];
}
export function progressSceneElements(brief,index,total,slide,theme){
  if(brief.progress===false||slide.kind==='cover'||isTOCPage(slide,index,brief))return [];
  const sections=progressSectionsOf({progressSections:brief.progressSections});
  const items=brief.progressNavigation||sections.map((s,i)=>({nodeId:'navigation-'+s.id,text:s.title,current:i===Math.min(sections.length-1,Math.floor(index*sections.length/Math.max(total,1)))}));
  const c=(theme.accent||'808080').replace('#',''),brightness=[0,2,4].reduce((sum,k,i)=>sum+parseInt(c.slice(k,k+2),16)*[.2126,.7152,.0722][i],0);
  return progressArrowRow(items,{x:28,y:10,w:1544,gap:3,size:24,minSize:.5,activeScale:1.25,fontFace:'Microsoft YaHei',accent:theme.accent,track:theme.panel||theme.muted,muted:theme.fg||'272727',indicatorInk:brightness>150?'272727':'F4F4EF'});
}
