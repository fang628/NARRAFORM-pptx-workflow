import {navigationTexts,progressArrowRow,progressRowMetrics,progressSectionsOf} from './progress-navigation.mjs';
import crypto from 'node:crypto';
import {initialElements} from './elements.mjs';
import {pageTitleMatcher} from './title-identity.mjs';
import {footerStyle,footerPageElements,isFooterElement,footerPageRule,footerPageVersion} from './footer-page-number.mjs';

const rgb=hex=>hex.match(/../g).map(v=>parseInt(v,16));
const luminance=hex=>rgb(hex).map(v=>{const s=v/255;return s<=.04045?s/12.92:((s+.055)/1.055)**2.4;}).reduce((n,v,i)=>n+v*[.2126,.7152,.0722][i],0);
const contrast=(a,b)=>(Math.max(luminance(a),luminance(b))+.05)/(Math.min(luminance(a),luminance(b))+.05);
const blend=(a,b,t)=>rgb(a).map((v,i)=>Math.round(v*(1-t)+rgb(b)[i]*t).toString(16).padStart(2,'0')).join('').toUpperCase();
const validHex=v=>typeof v==='string'&&/^#?[0-9a-f]{6}$/i.test(v)?v.replace('#','').toUpperCase():null;
export const unifiedProgressRule='05页顶进度条由程序统一生成原生箭形横列或气泡横列。章节标题规划优先4–8字、最多10字；横列位置优先对齐参考图，无可靠位置参考时再贴近左右页边；段间保留细微间距，整体保持低矮。所有章节文字保持单行，不换行，不因长名称增高；当前章节字号放大25%并加粗，放不下时同步减小全篇横列字号，预留放大后的空间，文字上下保留余量、不贴边。两种横列均保留原生渐变、轻阴影与细描边，左右边界与垂直中心对齐一张最接近所选横列的已确认预览图，实际颜色、阴影和描边也取自同一张图，不拼凑多页风格。首段为扁六边形，滑块转为后续箭形时保持同一六点路径，仅左侧中点缓慢内凹，右端与上下边不参与形变。全篇共用稳定的文字宽度、字号和横列高度；内容区避开实际导航区域。不要拆解或重复生成导航对象，封面与目录不显示。换页立即开始原生平滑切换，高亮沿横列滑动，字号、字重、文字色与已过/未到章节底色同步平滑过渡；同一章节保持不动。跨页原生文字主标题的位置、字号与样式同步平滑过渡，文字内容切换自然淡化；书法图片标题不参与主标题匹配，按普通图片渐显渐隐。底图和其他内容仅交叉淡化，不位移、缩放或变形。'+footerPageRule;

export function prepareRebuildPresentation(p){
  const d=p.concepts?.find(c=>c.id===p.selectedTheme)||{},background=validHex(d.coreColor)||'F5F5F2';
  const layout=deliveryMotionSettings(p.deliveryMotion).progressLayout,sections=progressSectionsOf(p);
  const paletteText=JSON.stringify([d.style,d.typography,d.frames,d.decoration,d.paletteSource?.palette,d.presetDesign?.source?.palette]);
  const signature=JSON.stringify([13,p.selectedTheme,background,paletteText,layout,sections,p.progressStyleReference?.layout===layout?p.progressStyleReference:null,p.pageNumbers===true?footerPageVersion:false,p.footerStyleReference,p.rebuildTitleFont?.fontFace]);
  if(p.rebuildPresentation?.version===1&&p.rebuildPresentation.signature===signature)return p.rebuildPresentation;
  const ink=contrast(background,'272727')>=contrast(background,'F4F4EF')?'272727':'F4F4EF';
  const colors=[...paletteText.matchAll(/#([0-9a-f]{6})\b|"([0-9a-f]{6})"/gi)].map(m=>(m[1]||m[2]).toUpperCase());
  const accent=colors.filter(c=>c!==background&&contrast(c,background)>=3).sort((a,b)=>{
    const saturation=c=>Math.max(...rgb(c))-Math.min(...rgb(c));return saturation(b)-saturation(a);
  })[0]||ink;
  const indicatorInk=contrast(accent,'272727')>=contrast(accent,'F4F4EF')?'272727':'F4F4EF';
  const gradient=(a,b)=>({type:'linear',angle:90,stops:[{position:0,color:a,opacity:1},{position:1,color:b,opacity:1}]});
  const style={layout:layout==='bubble'?'bubble-row':'chevron-row',x:28,y:10,w:1544,gap:3,size:24,minSize:.5,activeScale:1.25,fontFace:'Microsoft YaHei',accent,ink,indicatorInk,muted:blend(background,ink,.9),track:blend(background,ink,.12),completedFill:blend(background,accent,.34),completedBorder:blend(background,accent,.62),border:blend(background,ink,.5),activeBorder:blend(accent,ink,.5),strokeWidth:layout==='bubble'?1:1.2,trackGradient:gradient(blend(background,ink,.18),blend(background,ink,.09)),completedGradient:gradient(blend(background,accent,.4),blend(background,accent,.28)),activeGradient:gradient(blend(accent,'FFFFFF',.1),blend(accent,'000000',.06)),shadow:{type:'outer',color:'000000',opacity:.16,blur:3,offset:2,angle:90}};
  const reference=p.progressStyleReference;
  if(reference?.layout===layout&&reference.theme===p.selectedTheme){
    Object.assign(style,reference.appearance);
    const box=reference.box;
    if(Array.isArray(box)&&box.length===4&&box.every(Number.isFinite)&&box[0]>=0&&box[1]>=0&&box[2]>=.2&&box[3]>0&&box[0]+box[2]<=1.001&&box[1]+box[3]<=.35){
      // Use the same preview for placement and appearance. Keep the compact,
      // readable native row centered on its observed outline, across all pages.
      style.x=box[0]*1600;style.w=box[2]*1600;
      const height=progressRowMetrics(sections.map(s=>({text:s.title})),style).h;
      style.y=Math.max(0,(box[1]+box[3]/2)*900-height/2);
      style.referenceIndex=reference.index;
    }
  }
  style.h=progressRowMetrics(sections.map(s=>({text:s.title})),style).h;
  p.rebuildPresentation={version:1,signature,theme:p.selectedTheme,progress:style,footer:footerStyle(p,style),preparedAt:new Date().toISOString()};
  return p.rebuildPresentation;
}

export function rebuildProgressRegion(p,index){
  if(p?.rebuildPresentation?.version!==1||!navigationTexts(p,index).length)return null;
  const style=p.rebuildPresentation.progress;
  return {x:0,y:0,w:1600,h:Math.max(68,style.y+style.h+12)};
}

export const rebuildProgressAuditRule='预览图中的页顶进度条不在拆解范围内：导航文字、箭形、气泡、轨道、端点和导航装饰均不输出、不抠图、不重绘。程序直接插入已选的原生动画横列并补齐章节文字；仅审计正文、主副标题、登记图片和内容视觉元素，不得因忽略导航而遗漏同名正文。'+footerPageRule;

// Old audits may contain anonymous header shapes or OCR labels. Remove these
// before validation/asset creation, but preserve canonical content and originals.
export function stripRebuildProgress(p,index,elements){
  if(p?.rebuildPresentation?.version!==1)return elements;
  const region=rebuildProgressRegion(p,index);
  const contentIds=new Set(initialElements(p.slides[index]).map(n=>n.id));
  const contentTexts=elements.filter(e=>e?.type==='text'&&contentIds.has(e.nodeId));
  return elements.filter(e=>{
    if(!e)return true;
    if(isFooterElement(e))return false;
    if(e.key?.startsWith('nf-progress-')||e.nodeId?.startsWith('navigation-')||e.role==='navigation'||e.managed==='progress')return false;
    if(!region||e.type==='image'&&!e.implementation||e.type==='text'&&contentIds.has(e.nodeId))return true;
    // A title/body carrier can overlap the header region. Navigation filtering
    // must never erase explicitly inventoried frames or their content carriers.
    if(e.frameKind||['carrier','frame'].includes(e.role)||['rect','ellipse','shape','svg'].includes(e.type)&&contentTexts.some(t=>Number.isFinite(e.x)&&Number.isFinite(e.y)&&e.x<=t.x+t.w/2&&e.x+e.w>=t.x+t.w/2&&e.y<=t.y+t.h/2&&e.y+e.h>=t.y+t.h/2))return true;
    return !(Number.isFinite(e.y)&&Number.isFinite(e.h)&&e.y>=0&&e.y+e.h<=region.h);
  });
}

export function normalizeRebuildProgress(p,index,elements){
  if(p?.rebuildPresentation?.version!==1)return elements;
  const texts=navigationTexts(p,index),style=p.rebuildPresentation.progress;
  const clean=stripRebuildProgress(p,index,elements);
  return [...clean,...(texts.length?progressArrowRow(texts,style):[]),...footerPageElements(p,index)];
}

export function deliveryMotionSettings(raw={}){
  if(raw.enabled!==undefined&&typeof raw.enabled!=='boolean')throw Error('动画开关无效');
  const fadeSeconds=Number(raw.fadeSeconds??.55),progressSeconds=Number(raw.progressSeconds??.55);
  if(![fadeSeconds,progressSeconds].every(n=>Number.isFinite(n)&&n>=.2&&n<=1.5))throw Error('动画时长须为 0.2–1.5 秒');
  const progressLayout=raw.progressLayout??'chevron';if(!['chevron','bubble'].includes(progressLayout))throw Error('进度条版式无效');
  return {enabled:raw.enabled!==false,fadeSeconds,progressSeconds,progressLayout};
}

export const rebuildPresentationStamp=p=>crypto.createHash('sha256').update(JSON.stringify({version:12,progress:p.rebuildPresentation?.progress,...(p.pageNumbers===true?{footer:p.rebuildPresentation?.footer}:{}),motion:deliveryMotionSettings(p.deliveryMotion)})).digest('hex');

export function deliveryMotionPlan(p){
  const settings=deliveryMotionSettings(p.deliveryMotion),pages=[];let previous=null;
  for(const [index,page]of p.reconstruction.slides.entries()){
    const indicator=page.elements.find(e=>e.key==='nf-progress-indicator');
    const matchTitle=pageTitleMatcher(p,index),titles=page.elements.filter(e=>!e.part&&matchTitle(e));
    // Match a single main title only; headings and split title fragments fade.
    const title=titles.length===1?{key:titles[0].key,kind:'text'}:null;
    const canTitleMorph=!!(settings.enabled&&title&&previous?.title?.kind===title.kind);
    const canProgressMorph=!!(settings.enabled&&indicator&&previous?.indicator);
    const footer=footerPageElements(p,index).length>0,canFooterMorph=!!(settings.enabled&&footer&&previous?.footer);
    const canMorph=canTitleMorph||canProgressMorph||canFooterMorph;
    const slide={index,fade:settings.enabled,duration:settings.fadeSeconds,title,titleMorph:canTitleMorph,footer,footerMorph:canFooterMorph};
    slide.transition={type:canMorph?'morph':settings.enabled?'fade':'none',duration:canProgressMorph?Math.max(settings.fadeSeconds,settings.progressSeconds):settings.fadeSeconds,startDelay:0};
    if(canProgressMorph){
      const labels=page.elements.filter(e=>e.key?.startsWith('nf-progress-label-'));
      slide.labelChanges=labels.flatMap(label=>{const old=previous.labels.find(e=>e.key===label.key);return old&&(old.size!==label.size||old.bold!==label.bold||old.color!==label.color)?[{key:label.key,fromSize:old.size,toSize:label.size,fromBold:!!old.bold,toBold:!!label.bold,fromColor:old.color,toColor:label.color}]:[];});
      if(Math.abs(indicator.x-previous.indicator.x)>.1)slide.progress={key:indicator.key,fromX:previous.indicator.x,toX:indicator.x,offset:(previous.indicator.x-indicator.x)/1600,duration:slide.transition.duration,startDelay:0,...(indicator.progressGeometry?{deformation:{kind:'left-inset-only',from:previous.indicator.progressGeometry?.leftTip??0,to:indicator.progressGeometry.leftTip,fixedEdges:['right','top','bottom']}}:{})};
    }
    pages.push(slide);previous={indicator,title,footer,labels:page.elements.filter(e=>e.key?.startsWith('nf-progress-label-'))};
  }
  return {version:4,settings:{...settings,pageNumbers:p.pageNumbers===true},pages};
}
