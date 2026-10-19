import {colorAdjustmentSVG} from './color-adjustment.mjs';
import {visualGradient,gradientSVG} from './visual-gradient.mjs';
import {nativeTextLines} from './native-text-lines.mjs';
import {nativeEffects,nativeEffectDefs,nativeLineAttributes,nativeTransform} from './native-effects.mjs';
import crypto from 'node:crypto';
import {visualColor,visualOpacity} from './visual-color.mjs';
import {visualTextStyle} from './visual-text-style.mjs';
import {nativeShapeKinds,nativeShapeGeometry} from './native-shapes.mjs';
import {initialElements,orderedElements,tableCellTexts} from './elements.mjs';
import {pageDesignState,pageDesignStamp} from './page-design.mjs';
import {navigationTexts} from './design-rules.mjs';
import {themeAssetForPage} from './theme-assets.mjs';
import {expectedRebuildText} from './rebuild-text-parts.mjs';
import {imageMayStretch} from './image-geometry.mjs';
export const digest=v=>crypto.createHash('sha256').update(typeof v==='string'||Buffer.isBuffer(v)?v:JSON.stringify(v)).digest('hex');
export const confirmedPages=p=>p.slides.map((s,i)=>i).filter(i=>pageDesignState(p,i)?.approvedCurrent);
export const pageStamp=(p,i,theme=p.selectedTheme)=>digest({design:pageDesignStamp(p,i),markdown:pageDesignState(p,i)?.markdown,theme:p.concepts.find(c=>c.id===theme)?.style,styleRegistrationId:p.concepts.find(c=>c.id===theme)?.styleRegistrationId,themeAsset:themeAssetForPage(p,i,theme)?.previewHash});
export const fullPageCurrent=(p,i)=>!!p.visualPages?.[i]&&p.visualPages[i].stamp===pageStamp(p,i)&&!!pageDesignState(p,i)?.approvedCurrent;
export const visualStamp=p=>digest({pages:p.slides.map((s,i)=>({stamp:pageStamp(p,i),preview:p.visualPages?.[i]?.previewHash})),theme:p.selectedTheme});
export const rebuiltCurrent=p=>p.reconstruction?.mode==='free'&&p.reconstruction.stamp===visualStamp(p)&&p.reconstruction.slides.length===p.slides.length&&p.reconstruction.slides.every((page,i)=>{const base=themeAssetForPage(p,i,p.selectedTheme);return !base||(page.background?.id===base.materialId&&page.background?.sha256===base.previewHash);});
export const releaseCurrent=p=>!!p.output?.release?.passed&&p.output.version===p.version&&p.output.stamp===visualStamp(p)&&p.approvals.preview===p.version&&rebuiltCurrent(p);
export const canonicalTexts=(s,p,index)=>[...orderedElements(initialElements(s)).flatMap(n=>n.type==='table'?tableCellTexts(n):(n.type==='text'&&n.text?.trim())||n.type==='group'?[{nodeId:n.id,text:n.type==='group'?n.label:n.text,parentId:n.parentId,role:n.type==='group'?'heading':n.role||'heading'}]:[]),...(p?navigationTexts(p,index):[])];
export const plannedImages=s=>orderedElements(initialElements(s)).filter(n=>n.type==='image'&&n.materialId).map(n=>({nodeId:n.id,id:n.materialId}));
export function box(e){const line=e?.type==='line';if(!e||!['x','y','w','h'].every(k=>typeof e[k]==='number'&&Number.isFinite(e[k]))||e.x<0||e.y<0||(line?e.w<0||e.h<0||e.w===0&&e.h===0:e.w<=0||e.h<=0)||e.x+e.w>1600.1||e.y+e.h>900.1)throw Error('视觉元素坐标必须位于 1600×900 逻辑画布内（'+String(e?.key||e?.type||'未命名元素').slice(0,80)+'：x='+e?.x+'，y='+e?.y+'，w='+e?.w+'，h='+e?.h+'；须满足x+w≤1600、y+h≤900，水平/竖直line允许单轴为0）');return {x:e.x,y:e.y,w:e.w,h:e.h};}
export function validateImagePlan(raw,s){const images=plannedImages(s);if(!Array.isArray(raw)||raw.length!==images.length||new Set(raw.map(e=>e.nodeId)).size!==images.length)throw Error('图片计划必须包含所有已登记图片节点');const result=raw.map(e=>{const source=images.find(n=>n.nodeId===e.nodeId);if(!source||source.id!==e.id)throw Error('图片计划不得替换材料身份');return {...source,...box(e)};});if(result.some((e,i)=>result.slice(i+1).some(other=>overlaps(e,other)>0)))throw Error('登记图片预留区不能相互覆盖');return result;}
function overlaps(a,b){return Math.max(0,Math.min(a.x+a.w,b.x+b.w)-Math.max(a.x,b.x))*Math.max(0,Math.min(a.y+a.h,b.y+b.h)-Math.max(a.y,b.y));}
export function validateAudit(raw,s,imagePlan,p,index,{requireSeparatedNumbers=true,allowPartial=false}={}){
  if(!Array.isArray(raw)||raw.length<1||raw.length>220)throw Error('元素审计须返回 1–220 个独立元素');
  const keys=new Set(),textMap=new Map(),images=new Set(),allowed=new Set(['text','rect','ellipse','line','shape','svg','crop','generate','cutout','image']);
  const result=raw.map(e=>{
    if(typeof e.key!=='string'||!/^[a-zA-Z0-9_-]{1,64}$/.test(e.key)||keys.has(e.key)||!allowed.has(e.type))throw Error('元素编号重复或类型无效');keys.add(e.key);
    const out={key:e.key,type:e.type,...box(e),description:String(e.description||'').slice(0,700)};
    if(e.type==='text'){
      let expectation;try{expectation=expectedRebuildText(e,canonicalTexts(s,p,index),p,index,{requireSeparatedNumbers});}catch(error){throw Error(`必须逐条保留准确文字与小标题，不得改写、合并或遗漏（元素 ${e.key} · nodeId ${String(e.nodeId).slice(0,80)} · ${error.message}）`);}
      const {node:n,text,part,synthetic}=expectation,parts=textMap.get(n.nodeId)||new Set();if(e.text!==text||parts.has(part)||parts.has('whole')||part==='whole'&&parts.size)throw Error(`必须逐条保留准确文字与小标题，不得改写、合并或遗漏（元素 ${e.key} · nodeId ${n.nodeId} · ${parts.has(part)?'节点重复':'文字与准确文案不一致'}）`);parts.add(part);textMap.set(n.nodeId,parts);
      if(n.role==='navigation'&&e.y+e.h>Math.max(100,(p?.rebuildPresentation?.progress?.y||0)+(p?.rebuildPresentation?.progress?.h||0)+4))throw Error('章节进度导航必须保留在页面顶部');
      const style=visualTextStyle(e,n.role),ink=visualColor(e.color,'272727',{key:e.key,field:'color'});Object.assign(out,{nodeId:n.nodeId,text,...style,color:ink.color,align:['left','center','right'].includes(e.align)?e.align:'left'});if(part!=='whole')Object.assign(out,{part,sourceText:n.text});if(synthetic)Object.assign(out,{role:'toc-number',forNodeId:e.forNodeId});if(ink.alpha!==1||e.opacity!==undefined)out.opacity=ink.alpha*visualOpacity(e.opacity);
    }else if(e.type==='image'){
      const plan=imagePlan.find(n=>n.nodeId===e.nodeId);if(!plan||plan.id!==e.id||images.has(plan.nodeId))throw Error('必须使用图片计划中的登记原件');
      if(['x','y','w','h'].some(k=>Math.abs(e[k]-plan[k])>1))throw Error('原图位置须保持批准后的图片计划');images.add(plan.nodeId);Object.assign(out,{id:plan.id,nodeId:plan.nodeId,...box(plan)});
      if(imageMayStretch(plan))Object.assign(out,{imageFit:'fill',aspect:plan.aspect,aspectAdjustment:Math.abs(plan.w/plan.h/plan.aspect-1)});
    }else if(['rect','ellipse','line','shape'].includes(e.type)){if(e.type==='shape'){if(!nativeShapeKinds.includes(e.shape))throw Error('不支持的原生图形，请用登记的shape类型或SVG');out.shape=e.shape;}const fill=visualColor(e.fill,'EEEEEE',{key:e.key,field:'fill'}),ink=visualColor(e.color,e.fill??'272727',{key:e.key,field:'color'});out.fill=fill.color;out.color=ink.color;out.strokeWidth=Number(e.strokeWidth??(e.type==='line'?1:0));if(!Number.isFinite(out.strokeWidth)||out.strokeWidth<0||out.strokeWidth>20)throw Error('线宽无效');out.opacity=visualOpacity(e.opacity??1);if(fill.alpha!==1)out.fillOpacity=fill.alpha;if(ink.alpha!==1)out.colorOpacity=ink.alpha;}
    else if(e.type==='svg'){if(typeof e.svg!=='string'||e.svg.length>180000)throw Error('缺少局部 SVG');out.svg=e.svg;}
    else if(e.type==='crop'||e.type==='cutout'){
      out.sourceBox=box({...e.sourceBox,key:e.key+':sourceBox',type:'rect'});if(out.sourceBox.w*out.sourceBox.h>1600*900*.35)throw Error('禁止把整页底稿或大面积排版裁成图片');
      if(e.mask!==undefined){if(!Array.isArray(e.mask)||e.mask.length<3||e.mask.length>200||e.mask.some(p=>!Array.isArray(p)||p.length!==2||p.some(v=>typeof v!=='number'||!Number.isFinite(v)||v<0||v>1)))throw Error('局部素材轮廓无效');out.mask=e.mask;}
      if(e.type==='cutout'){if(typeof e.prompt!=='string'||e.prompt.trim().length<10||e.prompt.length>6000||e.nonFactual!==true)throw Error('图生图抠图仅限独立非事实复杂元素，并须给出简短抠图要求');out.prompt=e.prompt;out.nonFactual=true;}
    }else if(e.type==='generate'){if(typeof e.prompt!=='string'||e.prompt.trim().length<10||e.prompt.length>6000||e.nonFactual!==true)throw Error('新增生图素材仅限非事实装饰，并须提供提示词');out.prompt=e.prompt;out.nonFactual=true;}
    if(e.gradient!==undefined&&e.gradient!==null){
      if(!['text','rect','ellipse','shape','line'].includes(e.type))throw Error('仅文字、原生色块和线条可使用gradient，其他复杂元素按原方法重建');
      out.gradient=visualGradient(e.gradient,{key:e.key});
      if(e.type==='text'){out.color=out.gradient.stops[0].color;out.opacity=visualOpacity(e.opacity);}
      else if(e.type==='line'){out.color=out.gradient.stops[0].color;out.colorOpacity=1;}
      else{out.fill=out.gradient.stops[0].color;out.fillOpacity=visualOpacity(e.fillOpacity);}
    }
    Object.assign(out,nativeEffects(e));
    return out;
  });
  const missingTexts=canonicalTexts(s,p,index).filter(n=>{const parts=textMap.get(n.nodeId);return !parts||!parts.has('whole')&&!(parts.has('number')&&parts.has('label'));}),missingImages=imagePlan.filter(n=>!images.has(n.nodeId));if(!allowPartial&&(missingTexts.length||missingImages.length))throw Error('审计遗漏准确文字、小标题、页顶导航或登记原图：'+[...missingTexts,...missingImages].map(n=>n.nodeId).join('、'));
  const protectedAreas=result.filter(e=>['text','image'].includes(e.type));
  const cropConflicts=result.filter(e=>e.type==='crop'||e.type==='cutout').flatMap(e=>protectedAreas.filter(a=>overlaps(e.sourceBox,a)>0).map(a=>({element:e.key,sourceBox:e.sourceBox,protectedElement:a.key,protectedType:a.type,protectedBox:{x:a.x,y:a.y,w:a.w,h:a.h}})));
  if(cropConflicts.length)throw Error('局部裁剪不能包含文字、图表或登记原图区域；请缩小或移动sourceBox以避开列出的区域，无法避开时改用 SVG 重绘。冲突：'+JSON.stringify(cropConflicts.slice(0,12)));
  return result;
}
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function nativeSVG(elements,imageURL,background){
  const defs=elements.map((e,i)=>(e.gradient?gradientSVG(e.gradient,'native-gradient-'+i,e):'')+nativeEffectDefs(e,i)+colorAdjustmentSVG(e.type==='image'&&e.implementation==='cutout'?e.colorAdjustment:undefined,'native-color-'+i)).join('')+colorAdjustmentSVG(background?.colorAdjustment,'native-background-color');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080" viewBox="0 0 1600 900">${defs?'<defs>'+defs+'</defs>':''}${background?`<image href="${esc(imageURL(background.id))}" x="0" y="0" width="1600" height="900" preserveAspectRatio="none"${background.colorAdjustment?' filter="url(#native-background-color)"':''}/>`:''}${elements.map((e,i)=>{
    const fill=e.gradient?'url(#native-gradient-'+i+')':'#'+(e.type==='text'?e.color:e.fill),transform=nativeTransform(e);
    let content;
    if(e.type==='text'){
      const lines=e.noWrap||e.role==='navigation'?[String(e.text).replace(/\s*\n\s*/g,' ')]:nativeTextLines(e.text,e.w,e.size,e.charSpacing??0),tx=e.x+(e.align==='center'?e.w/2:e.align==='right'?e.w:0),ty=e.valign==='mid'?e.y+(e.h-(e.size+Math.max(0,lines.length-1)*(e.lineSpacing??e.size*1.2)))/2+e.size:e.y+e.size;
      content=`<text x="${tx}" y="${ty}" font-family="${esc(e.fontFace||'Microsoft YaHei')}" font-style="${e.italic?'italic':'normal'}" font-size="${e.size}" letter-spacing="${e.charSpacing??0}" font-weight="${e.bold?700:400}" fill="${fill}"${e.outline?` stroke="#${e.outline.color}" stroke-width="${e.outline.width}" stroke-opacity="${e.outline.opacity}" stroke-linejoin="round" paint-order="stroke fill"`:''}${e.shadow?` filter="url(#native-shadow-${i})"`:''} opacity="${e.opacity??1}" text-anchor="${e.align==='center'?'middle':e.align==='right'?'end':'start'}">${lines.map((t,j)=>`<tspan x="${tx}" dy="${j?(e.lineSpacing??e.size*1.2):0}">${esc(t)}</tspan>`).join('')}</text>`;
    }else if(['rect','ellipse','shape'].includes(e.type)){
      const geometry=e.type==='rect'?`rect x="${e.x}" y="${e.y}" width="${e.w}" height="${e.h}"`:e.type==='ellipse'?`ellipse cx="${e.x+e.w/2}" cy="${e.y+e.h/2}" rx="${e.w/2}" ry="${e.h/2}"`:nativeShapeGeometry(e);
      content=`<${geometry} fill="${fill}" fill-opacity="${e.fillOpacity??1}" stroke="#${e.color??e.fill}" stroke-width="${e.strokeWidth??0}" stroke-opacity="${e.colorOpacity??1}" opacity="${e.opacity??1}"${nativeLineAttributes(e,i)}/>`;
    }else if(e.type==='line')content=`<line x1="${e.x}" y1="${e.y}" x2="${e.x+e.w}" y2="${e.y+e.h}" stroke="${e.gradient?'url(#native-gradient-'+i+')':'#'+e.color}" stroke-width="${e.strokeWidth}" stroke-opacity="${e.colorOpacity??1}" opacity="${e.opacity??1}"${nativeLineAttributes(e,i)}/>`;
    else content=`<image href="${esc(imageURL(e.id))}" x="${e.x}" y="${e.y}" width="${e.w}" height="${e.h}" preserveAspectRatio="${imageMayStretch(e)?'none':'xMidYMid meet'}"/>`;
    if(e.type!=='text'&&e.shadow)content=`<g filter="url(#native-shadow-${i})">${content}</g>`;
    if(e.type==='image'&&e.implementation==='cutout'&&e.colorAdjustment)content=`<g filter="url(#native-color-${i})">${content}</g>`;
    return transform?`<g transform="${transform}">${content}</g>`:content;
  }).join('')}</svg>`;
}
