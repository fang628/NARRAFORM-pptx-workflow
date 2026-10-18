import {navigationTexts,progressArrowRow,progressRowMetrics,progressSectionsOf} from './progress-navigation.mjs';
import crypto from 'node:crypto';
import {initialElements} from './elements.mjs';

const rgb=hex=>hex.match(/../g).map(v=>parseInt(v,16));
const luminance=hex=>rgb(hex).map(v=>{const s=v/255;return s<=.04045?s/12.92:((s+.055)/1.055)**2.4;}).reduce((n,v,i)=>n+v*[.2126,.7152,.0722][i],0);
const contrast=(a,b)=>(Math.max(luminance(a),luminance(b))+.05)/(Math.min(luminance(a),luminance(b))+.05);
const blend=(a,b,t)=>rgb(a).map((v,i)=>Math.round(v*(1-t)+rgb(b)[i]*t).toString(16).padStart(2,'0')).join('').toUpperCase();
const validHex=v=>typeof v==='string'&&/^#?[0-9a-f]{6}$/i.test(v)?v.replace('#','').toUpperCase():null;
export const unifiedProgressRule='05页顶进度条由程序统一生成原生箭形横列或气泡横列，首段用横向扁六边形，后续箭形段首尾咬合且不留空隙，段内独立章节文字始终可见；两种横列都必须带原生渐变、轻阴影与细描边，沿用所选PPT配色。当前章节高亮，文字放大25%并加粗。字体以可读性优先，字号根据全套章节文字量在22–28逻辑单位之间选择，长名称分配较长单框，短名称收窄；仍放不下时换行并增高横列，不强缩字号。全篇共用按文字计算的宽度、字号与高度；内容区须避开程序给出的实际导航高度。不要拆解或重复生成导航文字及其色块、线条、装饰；准确文案中的navigation节点由程序补齐。封面和目录不显示。换页时立即开始原生平滑切换：高亮标记沿横列滑动，字号、字重、文字色与已过/未到章节底色同步平滑过渡，不添加延迟或转场后的页内运动路径。已过章节用主题色调承载，未到章节用低对比中性色，当前章节高亮；箭形始终保留清晰细描边。底图变化也交叉淡化，保持底图原构图和位置；除进度条以外的所有文字、图片和色块仅渐显渐隐，不自动位移、缩放或变形；同一章节保持不动，不给其他元素添加动画。';

export function prepareRebuildPresentation(p){
  const d=p.concepts?.find(c=>c.id===p.selectedTheme)||{},background=validHex(d.coreColor)||'F5F5F2';
  const layout=deliveryMotionSettings(p.deliveryMotion).progressLayout,sections=progressSectionsOf(p);
  const paletteText=JSON.stringify([d.style,d.typography,d.frames,d.decoration,d.paletteSource?.palette,d.presetDesign?.source?.palette]);
  const signature=JSON.stringify([10,p.selectedTheme,background,paletteText,layout,sections]);
  if(p.rebuildPresentation?.version===1&&p.rebuildPresentation.signature===signature)return p.rebuildPresentation;
  const ink=contrast(background,'272727')>=contrast(background,'F4F4EF')?'272727':'F4F4EF';
  const colors=[...paletteText.matchAll(/#([0-9a-f]{6})\b|"([0-9a-f]{6})"/gi)].map(m=>(m[1]||m[2]).toUpperCase());
  const accent=colors.filter(c=>c!==background&&contrast(c,background)>=3).sort((a,b)=>{
    const saturation=c=>Math.max(...rgb(c))-Math.min(...rgb(c));return saturation(b)-saturation(a);
  })[0]||ink;
  const indicatorInk=contrast(accent,'272727')>=contrast(accent,'F4F4EF')?'272727':'F4F4EF';
  const gradient=(a,b)=>({type:'linear',angle:90,stops:[{position:0,color:a,opacity:1},{position:1,color:b,opacity:1}]});
  const style={layout:layout==='bubble'?'bubble-row':'chevron-row',x:86,y:12,w:1420,gap:layout==='bubble'?8:0,size:28,minSize:22,activeScale:1.25,fontFace:'Microsoft YaHei',accent,ink,indicatorInk,muted:blend(background,ink,.9),track:blend(background,ink,.12),completedFill:blend(background,accent,.34),completedBorder:blend(background,accent,.62),border:blend(background,ink,.5),activeBorder:blend(accent,ink,.5),strokeWidth:layout==='bubble'?1:1.2,trackGradient:gradient(blend(background,ink,.18),blend(background,ink,.09)),completedGradient:gradient(blend(background,accent,.4),blend(background,accent,.28)),activeGradient:gradient(blend(accent,'FFFFFF',.1),blend(accent,'000000',.06)),shadow:{type:'outer',color:'000000',opacity:.16,blur:3,offset:2,angle:90}};
  style.h=progressRowMetrics(sections.map(s=>({text:s.title})),style).h;
  p.rebuildPresentation={version:1,signature,theme:p.selectedTheme,progress:style,preparedAt:new Date().toISOString()};
  return p.rebuildPresentation;
}

export function rebuildProgressRegion(p,index){
  if(p?.rebuildPresentation?.version!==1||!navigationTexts(p,index).length)return null;
  const style=p.rebuildPresentation.progress;
  return {x:0,y:0,w:1600,h:Math.max(68,style.y+style.h+12)};
}

export const rebuildProgressAuditRule='预览图中的页顶进度条不在拆解范围内：导航文字、箭形、气泡、轨道、端点和导航装饰均不输出、不抠图、不重绘。程序直接插入已选的原生动画横列并补齐章节文字；仅审计正文、主副标题、登记图片和内容视觉元素，不得因忽略导航而遗漏同名正文。';

// Old audits may contain anonymous header shapes or OCR labels. Remove these
// before validation/asset creation, but preserve canonical content and originals.
export function stripRebuildProgress(p,index,elements){
  if(p?.rebuildPresentation?.version!==1)return elements;
  const region=rebuildProgressRegion(p,index);
  const contentIds=new Set(initialElements(p.slides[index]).map(n=>n.id));
  return elements.filter(e=>{
    if(!e)return true;
    if(e.key?.startsWith('nf-progress-')||e.nodeId?.startsWith('navigation-')||e.role==='navigation'||e.managed==='progress')return false;
    if(!region||e.type==='image'&&!e.implementation||e.type==='text'&&contentIds.has(e.nodeId))return true;
    return !(Number.isFinite(e.y)&&Number.isFinite(e.h)&&e.y>=0&&e.y+e.h<=region.h);
  });
}

export function normalizeRebuildProgress(p,index,elements){
  if(p?.rebuildPresentation?.version!==1)return elements;
  const texts=navigationTexts(p,index),style=p.rebuildPresentation.progress;
  const clean=stripRebuildProgress(p,index,elements);
  if(!texts.length)return clean;
  return [...clean,...progressArrowRow(texts,style)];
}

export function deliveryMotionSettings(raw={}){
  if(raw.enabled!==undefined&&typeof raw.enabled!=='boolean')throw Error('动画开关无效');
  const fadeSeconds=Number(raw.fadeSeconds??.55),progressSeconds=Number(raw.progressSeconds??.55);
  if(![fadeSeconds,progressSeconds].every(n=>Number.isFinite(n)&&n>=.2&&n<=1.5))throw Error('动画时长须为 0.2–1.5 秒');
  const progressLayout=raw.progressLayout??'chevron';if(!['chevron','bubble'].includes(progressLayout))throw Error('进度条版式无效');
  return {enabled:raw.enabled!==false,fadeSeconds,progressSeconds,progressLayout};
}

export const rebuildPresentationStamp=p=>crypto.createHash('sha256').update(JSON.stringify({version:10,progress:p.rebuildPresentation?.progress,motion:deliveryMotionSettings(p.deliveryMotion)})).digest('hex');

export function deliveryMotionPlan(p){
  const settings=deliveryMotionSettings(p.deliveryMotion),pages=[];let previous=null;
  for(const [index,page]of p.reconstruction.slides.entries()){
    const indicator=page.elements.find(e=>e.key==='nf-progress-indicator');
    const slide={index,fade:settings.enabled,duration:settings.fadeSeconds};
    const canMorph=!!(settings.enabled&&indicator&&previous);
    slide.transition={type:canMorph?'morph':settings.enabled?'fade':'none',duration:canMorph?Math.max(settings.fadeSeconds,settings.progressSeconds):settings.fadeSeconds,startDelay:0};
    if(canMorph){
      const labels=page.elements.filter(e=>e.key?.startsWith('nf-progress-label-'));
      slide.labelChanges=labels.flatMap(label=>{const old=previous.labels.find(e=>e.key===label.key);return old&&(old.size!==label.size||old.bold!==label.bold||old.color!==label.color)?[{key:label.key,fromSize:old.size,toSize:label.size,fromBold:!!old.bold,toBold:!!label.bold,fromColor:old.color,toColor:label.color}]:[];});
      if(Math.abs(indicator.x-previous.indicator.x)>.1)slide.progress={key:indicator.key,fromX:previous.indicator.x,toX:indicator.x,offset:(previous.indicator.x-indicator.x)/1600,duration:slide.transition.duration,startDelay:0};
    }
    pages.push(slide);previous=indicator?{indicator,labels:page.elements.filter(e=>e.key?.startsWith('nf-progress-label-'))}:null;
  }
  return {version:2,settings,pages};
}
