import {defaultProgressTitles,validateProgressSections,progressSectionsOf} from '../public/progress-sections.js';
import {isTOCPage} from './page-options.mjs';
import {nativeTextLines} from './native-text-lines.mjs';
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
export function progressLabelSize(text,width,{size=16,activeScale=1.25,current=false}={}){
  const units=[...text].reduce((sum,c)=>sum+(c.codePointAt(0)>255?1:.57),0);
  // Reserve the enlarged width even on inactive pages so the same label never shifts or wraps.
  const normal=Math.min(size,width/Math.max(units,1)/activeScale/1.2);
  return normal*(current?activeScale:1);
}
const bounded=(v,lo,hi)=>Math.max(lo,Math.min(hi,v));
const tint=(color,t)=>color.match(/../g).map(c=>Math.round(parseInt(c,16)*(1-Math.abs(t))+(t>0?255:0)*Math.abs(t)).toString(16).padStart(2,'0')).join('').toUpperCase();
const hex=(value,fallback)=>/^#?[\da-f]{6}$/i.test(value||'')?value.replace('#','').toUpperCase():fallback;
const rowGradient=color=>({type:'linear',angle:90,stops:[{position:0,color:tint(color,.09),opacity:1},{position:1,color:tint(color,-.06),opacity:1}]});
// Shared by local scenes and delivery: the three native effects are mandatory.
export function progressRowAppearance(style){
  const accent=hex(style.accent,'697887'),track=hex(style.track,'D9DCDF'),completedFill=hex(style.completedFill,tint(accent,.45));
  const gradient=(value,fill)=>value?.stops?.length>=2&&new Set(value.stops.map(s=>s.color+':'+s.opacity)).size>1?structuredClone(value):rowGradient(fill);
  return {...style,accent,track,completedFill,strokeWidth:bounded(Number(style.strokeWidth)||1.2,.8,1.5),border:hex(style.border,tint(track,-.25)),completedBorder:hex(style.completedBorder,tint(completedFill,-.2)),activeBorder:hex(style.activeBorder,tint(accent,-.25)),trackGradient:gradient(style.trackGradient,track),completedGradient:gradient(style.completedGradient,completedFill),activeGradient:gradient(style.activeGradient,accent),shadow:{type:'outer',color:hex(style.shadow?.color,'000000'),opacity:bounded(Number(style.shadow?.opacity)||.14,.08,.2),blur:bounded(Number(style.shadow?.blur)||3,2,5),offset:bounded(Number(style.shadow?.offset)||1.5,1,3),angle:90}};
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
  if(!items.length)return {segments:[],head:0,pad:0,normalSize:28,activeScale:1.25,h:0};
  const bubble=style.layout==='bubble-row',head=bubble?0:18,gap=bubble?(style.gap??8):0;
  const total=style.w-(bubble?gap*(items.length-1):head),mean=total/items.length,pad=bubble?18:28,activeScale=style.activeScale??1.25;
  const units=text=>Math.max(1,...String(text).split('\n').map(line=>[...line].reduce((s,c)=>s+(c.codePointAt(0)>255?1:.57),0)));
  const widths=sectionWidths(items.map(n=>units(n.text)**.65),total,Math.min(mean,112),mean*2);
  let offset=0;
  const segments=widths.map(width=>{const w=width+head,segment={offset,w,labelW:w-pad*2};offset+=width+gap;return segment;});
  const minSize=Math.max(22,style.minSize??22),maxSize=Math.max(minSize,Math.min(32,style.size??28));
  // Reserve bold/active scale and font-metric variation before PowerPoint wraps.
  const lineCount=size=>Math.max(...items.map((n,i)=>nativeTextLines(n.text,segments[i].labelW/1.12,size*activeScale).length));
  const targetLines=lineCount(minSize);let normalSize=maxSize;
  while(normalSize>minSize&&lineCount(normalSize)>targetLines)normalSize=Math.max(minSize,normalSize-.5);
  return {segments,head,pad,normalSize,activeScale,h:Math.max(52,Math.ceil(lineCount(normalSize)*normalSize*activeScale*1.2+12))};
}
export function progressArrowRow(items,style){
  if(!items.length)return [];
  style=progressRowAppearance(style);
  const {segments,head,pad,normalSize,activeScale,h}=progressRowMetrics(items,style);
  const active=Math.max(0,items.findIndex(n=>n.current));
  const shape=(key,i,fill)=>{const current=key==='nf-progress-indicator',completed=!current&&i<active,gradient=current?style.activeGradient:completed?(style.completedGradient||style.trackGradient):style.trackGradient;
    const {offset,w}=segments[i];
    // A tall full capsule would cut into the first/last text lines. Keep pill
    // ends on compact rows and gentler rounded corners on multiline bubbles.
    const radius=h<=64?h/2:24;
    return {key,type:'shape',shape:style.layout==='bubble-row'?'roundRect':i===0?'hexagon':'chevron',x:style.x+offset,y:style.y,w,h,fill:completed?style.completedFill:fill,color:current?style.activeBorder:completed?style.completedBorder:style.border,strokeWidth:style.strokeWidth,adjustments:{adj:(style.layout==='bubble-row'?radius:head)/Math.min(w,h)*100000},shadow:structuredClone(style.shadow),gradient:structuredClone(gradient),managed:'progress',progressState:current?'current':completed?'completed':'upcoming'};};
  const tracks=items.map((n,i)=>shape('nf-progress-track-'+i,i,style.track));
  const indicator=shape('nf-progress-indicator',active,style.accent);
  const labels=items.map((n,i)=>{
    // Match geometric scaling to font scaling. Morph can then interpolate the
    // whole native text object around its fixed center, with stable line breaks.
    const {offset,labelW}=segments[i],factor=n.current?1:1/activeScale,w=labelW*factor,labelH=(h-8)*factor;
    return {key:'nf-progress-label-'+i,type:'text',nodeId:n.nodeId,role:'navigation',text:n.text,x:style.x+offset+pad+(labelW-w)/2,y:style.y+(h-labelH)/2,w,h:labelH,size:normalSize*(n.current?activeScale:1),fontFace:style.fontFace||'Microsoft YaHei',color:n.current?style.indicatorInk:style.muted,bold:!!n.current,italic:false,align:'center',valign:'mid',managed:'progress'};
  });
  return [...tracks,indicator,...labels];
}
export function progressSceneElements(brief,index,total,slide,theme){
  if(brief.progress===false||slide.kind==='cover'||isTOCPage(slide,index,brief))return [];
  const sections=progressSectionsOf({progressSections:brief.progressSections});
  const items=brief.progressNavigation||sections.map((s,i)=>({nodeId:'navigation-'+s.id,text:s.title,current:i===Math.min(sections.length-1,Math.floor(index*sections.length/Math.max(total,1)))}));
  const c=(theme.accent||'808080').replace('#',''),brightness=[0,2,4].reduce((sum,k,i)=>sum+parseInt(c.slice(k,k+2),16)*[.2126,.7152,.0722][i],0);
  return progressArrowRow(items,{x:86,y:12,w:1420,gap:8,size:28,minSize:22,activeScale:1.25,fontFace:'Microsoft YaHei',accent:theme.accent,track:theme.panel||theme.muted,muted:theme.fg||'272727',indicatorInk:brightness>150?'272727':'F4F4EF'});
}
